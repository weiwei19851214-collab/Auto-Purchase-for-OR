import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../server/db.mjs';
import {CryptoScheduler, normalizeCryptoSchedule, nextCryptoRun, fetchCryptoSnapshot} from '../server/crypto-scheduler.mjs';

const now = new Date('2026-10-15T08:00:00+08:00');
const connections={opomBaseUrl:'http://opom.test',opomRechargeToken:'test-opom',adspowerApiBase:'http://ads.test',adspowerApiKey:'test-ads'};
const row=(i,status='CARD_SWITCH')=>({opom_account_id:`a${i}`,login_email:`a${i}@example.com`,opom_account_status:status,ads_power_user_id:`profile${i}`});

test('history persists failures before snapshot, redacts passwords and survives restart',async()=>{
  const f=fixture();f.enable();
  f.scheduler.deps.fetchPage=async()=>{throw new Error('UND_ERR_SOCKET private-wallet-password');};
  await f.scheduler.tick(new Date(now.getTime()+30*60000));
  const history=f.scheduler.getState().history;
  assert.equal(history.rounds.length,0);
  assert.equal(history.events[0].status,'retry_wait');
  assert.match(history.events[0].message,/UND_ERR_SOCKET/);
  assert.equal(history.events[0].cycleId,'');
  assert.equal(JSON.stringify(history).includes('private-wallet-password'),false);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM crypto_scheduler_history').all()).includes('private-wallet-password'),false);
  await f.scheduler.tick(new Date(now.getTime()+31*60000));
  assert.deepEqual(f.scheduler.getState().history,history);
  const restarted=new CryptoScheduler(f.db,f.deps);
  assert.ok(restarted.getState().history.events.some((e)=>e.status==='retry_wait'));
  f.db.close();
});

test('history exposes bounded rounds and batch job links without snapshot credentials',async()=>{
  const f=fixture(51);f.enable();
  await f.scheduler.tick(new Date(now.getTime()+30*60000));
  const history=f.scheduler.getState().history;
  assert.equal(history.rounds[0].totalCount,51);
  assert.equal(history.rounds[0].batchCount,2);
  assert.equal(history.rounds[0].batches[0].jobId,'j1');
  assert.equal(history.rounds[0].batches[0].accountCount,50);
  assert.equal(history.events[0].cycleId,history.rounds[0].id);
  assert.equal(JSON.stringify(history).includes('test-opom'),false);
  for(let i=0;i<60;i++) f.scheduler.write({status:'failed',message:`test ${i}`});
  assert.equal(f.scheduler.getState().history.events.length,50);
  f.db.close();
});

test('history upgrade imports only the last persisted state once',()=>{
  const f=fixture();
  f.scheduler.write({status:'failed',message:'OPOM network failed: UND_ERR_SOCKET'});
  f.db.prepare('DELETE FROM crypto_scheduler_history').run();
  const upgraded=new CryptoScheduler(f.db,f.deps);
  assert.equal(upgraded.getState().history.events.length,1);
  assert.match(upgraded.getState().history.events[0].message,/升级前最后状态/);
  new CryptoScheduler(f.db,f.deps);
  assert.equal(upgraded.getState().history.events.length,1);
  f.db.close();
});
function fixture(count=1) {
  const db=openDatabase(':memory:'); const payloads=[]; let liveRows=Array.from({length:count},(_,i)=>row(i));
  const deps={now:()=>now,fetchPage:async({status,cursor,limit})=>{
    const selected=liveRows.filter((r)=>r.opom_account_status.toLowerCase()===status);const index=Number(cursor||0);
    return {rows:selected.slice(index,index+limit),nextCursor:index+limit<selected.length?String(index+limit):null};
  },match:async({rows})=>({results:rows.map((r,index)=>({index,status:'matched',profile:{userId:r.ads_power_user_id}}))}),
  dryRun:async({csvText})=>({ready:csvText.trim().split('\n').length-1,liveConfirmationToken:'test-confirmation'}),
  createJob:async(db,payload)=>{
    payloads.push(payload); const id=`j${payloads.length}`;
    db.prepare(`INSERT INTO jobs (id,file_name,csv_path,result_csv_path,options_json,status,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?)`).run(id,'test.csv','','',JSON.stringify(payload.options),now.toISOString(),now.toISOString());
    return {job:{id}};
  }};
  const scheduler=new CryptoScheduler(db,deps);
  function enable(settings={}) {return scheduler.update({action:'enable',settings,walletPassword:'private-wallet-password',options:connections,confirmAutomaticPurchase:true});}
  return {db,scheduler,payloads,deps,enable,setRows:(rows)=>{liveRows=rows;},finish:()=>db.prepare("UPDATE jobs SET status='completed'").run()};
}

test('schedule calculations use Beijing time and interval starts from enable time',()=>{
  const daily=normalizeCryptoSchedule({scheduleType:'daily',dailyTimes:['00:10','18:45']});
  assert.equal(nextCryptoRun(daily,new Date('2026-10-15T23:59:00+08:00')).toISOString(),'2026-10-15T16:10:00.000Z');
  const hourly=normalizeCryptoSchedule({scheduleType:'hourly',hourlyMinutes:[45,15,15]});
  assert.deepEqual(hourly.hourlyMinutes,[15,45]);
  assert.equal(nextCryptoRun(hourly,new Date('2026-10-15T23:46:00+08:00')).toISOString(),'2026-10-15T16:15:00.000Z');
  assert.equal(nextCryptoRun(normalizeCryptoSchedule(),now).toISOString(),'2026-10-15T00:30:00.000Z');
  assert.throws(()=>normalizeCryptoSchedule({scheduleType:'daily',dailyTimes:['24:00']}));
  assert.throws(()=>normalizeCryptoSchedule({scheduleType:'hourly',hourlyMinutes:[]}));
  assert.throws(()=>normalizeCryptoSchedule({intervalMinutes:0}));
});

test('save is separate from consent; password stays in memory and restart pauses',()=>{
  const f=fixture();
  assert.throws(()=>f.scheduler.update({action:'enable',walletPassword:'secret',confirmAutomaticPreparation:true}),/明确确认/);
  let state=f.scheduler.update({action:'save',walletPassword:'private-wallet-password',settings:{amount:170},options:connections});
  assert.equal(state.enabled,false);assert.equal(state.settings.amount,170);assert.equal(state.hasWalletPassword,true);
  state=f.scheduler.update({action:'enable',confirmAutomaticPurchase:true});assert.equal(state.enabled,true);
  assert.equal(JSON.stringify(state).includes('private-wallet-password'),false);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM scheduler_state').all()).includes('private-wallet-password'),false);
  const restarted=new CryptoScheduler(f.db,f.deps);
  assert.equal(restarted.getState().enabled,false);assert.equal(restarted.getState().hasWalletPassword,false);
  assert.equal(restarted.getState().status,'paused_restart');f.db.close();
});

for (const count of [0,50,51,120]) test(`snapshot ${count} accounts is paginated and dispatched sequentially in batches of 50`,async()=>{
  const f=fixture(count);f.enable();
  const date=new Date(now.getTime()+30*60000);
  await f.scheduler.tick(date);
  assert.equal(f.db.prepare('SELECT total_count FROM crypto_scheduler_cycles').get().total_count,count);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM crypto_scheduler_batches').get().n,Math.ceil(count/50));
  if(count) {
    assert.equal(f.payloads.length,1);await f.scheduler.tick(date);assert.equal(f.payloads.length,1);
    for(let i=1;i<Math.ceil(count/50);i++){f.finish();await f.scheduler.tick(date);assert.equal(f.payloads.length,i+1);}
    f.finish();await f.scheduler.tick(date);
    assert.equal(f.scheduler.getState().round.processedCount,count);
    for(const payload of f.payloads){
      assert.ok(payload.runtimeWalletPasswords.length<=50);assert.equal(payload.options.cryptoFixedAmount,'150');
      assert.equal(payload.options.cryptoRechargeRuleMode,'fixed_amount');assert.equal(payload.options.confirmWalletPayment,true);
      assert.equal(payload.options.opomWriteback,true);assert.equal(payload.csvText.includes('private-wallet-password'),false);
    }
  }
  await f.scheduler.tick(date);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM crypto_scheduler_cycles').get().n,1);
  f.db.close();
});

test('snapshot de-duplicates IDs across two statuses and rejects cyclic cursors and request failures',async()=>{
  const rows=await fetchCryptoSnapshot(async({status})=>({rows:[row(1,status.toUpperCase())],nextCursor:null}));assert.equal(rows.length,1);
  await assert.rejects(fetchCryptoSnapshot(async()=>({rows:[row(1)],nextCursor:'repeat'})),/重复分页/);
  await assert.rejects(fetchCryptoSnapshot(async()=>{throw new Error('401 Unauthorized');}),/401/);
});

test('snapshot trusts OPOM filtering without requiring or validating returned account status',async()=>{
  const requests=[];
  const rows=await fetchCryptoSnapshot(async(input)=>{
    requests.push(input);
    const account=row(input.status==='card_switch'?1:2,'NORMAL');
    if(input.status==='card_switch')delete account.opom_account_status;
    return {rows:[account],nextCursor:null};
  });
  assert.equal(rows.length,2);
  assert.deepEqual(requests.map(({group,status,limit})=>({group,status,limit})),[
    {group:'VIP',status:'card_switch',limit:50},{group:'VIP',status:'overdue',limit:50},
  ]);
});

test('existing jobs defer due round; status changes skip later batch; disable stops dispatch',async()=>{
  const f=fixture(51);f.enable();await f.scheduler.tick(new Date(now.getTime()+30*60000));
  f.setRows([]);f.finish();await f.scheduler.tick(new Date(now.getTime()+31*60000));
  assert.equal(f.payloads.length,1);assert.equal(f.scheduler.getState().status,'skipped');
  f.scheduler.update({action:'disable'});await f.scheduler.tick(new Date(now.getTime()+90*60000));
  assert.equal(f.payloads.length,1);f.db.close();
});

test('uncertain account does not stop later batches or duplicate recovered job',async()=>{
  const f=fixture(51);f.enable();await f.scheduler.tick(new Date(now.getTime()+30*60000));f.finish();
  f.db.prepare(`INSERT INTO job_rows (id,job_id,row_number,raw_index,status,updated_at) VALUES ('r','j1',1,0,'purchase_unverified',?)`).run(now.toISOString());
  // Simulate crash after createJob but before scheduler persisted linkage.
  f.db.prepare("UPDATE crypto_scheduler_batches SET status='pending',job_id='' WHERE job_id='j1'").run();
  await f.scheduler.tick(new Date(now.getTime()+31*60000));assert.equal(f.scheduler.getState().enabled,true);
  assert.equal(f.payloads.length,2);f.db.close();
});

test('failed pagination does not persist a partial candidate snapshot or create payment jobs',async()=>{
  const f=fixture();f.scheduler.deps.fetchPage=async({status})=>{if(status==='overdue')throw new Error('401 Unauthorized');return {rows:[row(1)]};};f.enable();
  await f.scheduler.tick(new Date(now.getTime()+30*60000));assert.equal(f.payloads.length,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM crypto_scheduler_cycles').get().n,0);
  assert.equal(f.scheduler.getState().enabled,true);f.db.close();
});

test('OPOM network retry waits five minutes across repeated ticks, force calls and active cycles',async()=>{
  for(const active of [false,true]) {
    const f=fixture(51);f.enable();const start=new Date(now.getTime()+30*60000);
    if(active){await f.scheduler.tick(start);f.finish();}
    const original=f.scheduler.deps.fetchPage;let calls=0;
    f.scheduler.deps.fetchPage=async()=>{calls++;throw Object.assign(new Error('OPOM network failed: UND_ERR_SOCKET'),{opomNetworkFailure:true});};
    await f.scheduler.tick(start);assert.equal(f.scheduler.getState().enabled,true);
    assert.equal(f.scheduler.getState().status,'retry_wait');
    assert.equal(f.scheduler.getState().nextRunAt,new Date(start.getTime()+300000).toISOString());
    await f.scheduler.tick(new Date(start.getTime()+299999),true);assert.equal(calls,1);
    f.scheduler.deps.fetchPage=original;
    await f.scheduler.tick(new Date(start.getTime()+300000));
    assert.equal(f.payloads.length,active?2:1);f.db.close();
  }
});

test('explicit insufficient funds stops subsequent batches and disables schedule',async()=>{
  const f=fixture(51);f.enable();await f.scheduler.tick(new Date(now.getTime()+30*60000));
  f.db.prepare("UPDATE jobs SET status='blocked',error='crypto_insufficient_funds'").run();
  f.db.prepare(`INSERT INTO job_rows (id,job_id,row_number,raw_index,status,error_code,updated_at) VALUES ('funds','j1',1,0,'failed','crypto_insufficient_funds',?)`).run(now.toISOString());
  await f.scheduler.tick(new Date(now.getTime()+31*60000));
  assert.equal(f.scheduler.getState().enabled,false);assert.equal(f.scheduler.getState().status,'paused_insufficient_funds');
  assert.equal(f.payloads.length,1);
  f.db.prepare(`INSERT INTO job_rows (id,job_id,row_number,raw_index,opom_account_id,status,updated_at) VALUES ('remaining','j1',2,1,'a1','queued',?)`).run(now.toISOString());
  f.enable();assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id='j1'").get().status,'queued');
  f.db.prepare("UPDATE job_rows SET status='completed' WHERE id='remaining'").run();f.finish();
  await f.scheduler.tick(new Date(now.getTime()+32*60000));
  assert.equal(f.scheduler.getState().enabled,true);assert.equal(f.payloads.length,2);f.db.close();
});

test('network writeback retries only the credited original row after five minutes',async()=>{
  const f=fixture();f.enable();const start=new Date(now.getTime()+30*60000);
  await f.scheduler.tick(start);f.finish();
  f.db.prepare(`INSERT INTO job_rows (id,job_id,row_number,raw_index,opom_account_id,status,error_code,updated_at) VALUES ('credited','j1',1,0,'a0','failed','opom_writeback_network_failed',?)`).run(start.toISOString());
  f.db.prepare(`INSERT INTO crypto_payment_ledger(account_id,job_id,row_id,phase,updated_at) VALUES ('a0','j1','credited','credited',?)`).run(start.toISOString());
  await f.scheduler.tick(new Date(start.getTime()+299999));
  assert.equal(f.db.prepare("SELECT status FROM job_rows WHERE id='credited'").get().status,'failed');
  await f.scheduler.tick(new Date(start.getTime()+300000));
  assert.equal(f.db.prepare("SELECT status FROM job_rows WHERE id='credited'").get().status,'queued');
  assert.equal(f.db.prepare('SELECT phase FROM crypto_payment_ledger').get().phase,'credited');
  assert.equal(f.payloads.length,1);f.db.close();
});

test('top-level UI connection config is accepted and interval retains enable anchor after slow cycle',async()=>{
  const f=fixture();
  f.scheduler.update({action:'enable',walletPassword:'secret',confirmAutomaticPurchase:true,...connections});
  await f.scheduler.tick(new Date(now.getTime()+30*60000));f.finish();
  await f.scheduler.tick(new Date(now.getTime()+41*60000));
  assert.equal(f.scheduler.getState().nextRunAt,new Date(now.getTime()+60*60000).toISOString());f.db.close();
});

test('save and re-enable while a fetch is pending cannot dispatch using stale settings',async()=>{
  const f=fixture();f.enable();const original=f.scheduler.deps.fetchPage;let release;let started;
  const waiting=new Promise((resolve)=>{started=resolve;});
  f.scheduler.deps.fetchPage=async(payload)=>{started();await new Promise((resolve)=>{release=resolve;});f.scheduler.deps.fetchPage=original;return original(payload);};
  const running=f.scheduler.tick(new Date(now.getTime()+30*60000));await waiting;
  f.scheduler.update({action:'save',settings:{amount:200}});f.scheduler.update({action:'enable',confirmAutomaticPurchase:true});release();
  // fetchCryptoSnapshot captures the function; the second page also passes the gate.
  await new Promise((resolve)=>setImmediate(resolve));release();await running;
  assert.equal(f.payloads.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM crypto_scheduler_cycles').get().n,0);f.db.close();
});

test('legacy blocked batch records pending rows as failures and continues later batches',async()=>{
  const f=fixture(51);f.enable();await f.scheduler.tick(new Date(now.getTime()+30*60000));
  f.db.prepare("UPDATE jobs SET status='blocked'").run();
  f.db.prepare(`INSERT INTO job_rows (id,job_id,row_number,raw_index,status,updated_at) VALUES ('pending','j1',1,0,'queued',?)`).run(now.toISOString());
  await f.scheduler.tick(new Date(now.getTime()+31*60000));assert.equal(f.scheduler.getState().enabled,true);
  assert.equal(f.scheduler.getState().round.processedCount,50);assert.equal(f.payloads.length,2);f.db.close();
});

test('match failures and quarantined accounts have inspectable reasons',async()=>{
  const f=fixture(2);f.enable();f.scheduler.deps.isAccountBlocked=(_db,id)=>id==='a0';
  f.scheduler.deps.match=async()=>({results:[{index:0,status:'failed',message:'profile occupied'}]});
  await f.scheduler.tick(new Date(now.getTime()+30*60000));const issues=f.scheduler.getState().round.issues;
  assert.equal(issues.length,2);assert.equal(issues[0].status,'quarantined');assert.equal(issues[1].message,'profile occupied');
  assert.equal(f.payloads.length,0);f.db.close();
});

test('real dry-run and job creation accept scheduler fixed crypto rows without wallet secrets in CSV or DB',async()=>{
  const {dryRunPayload,createJob}=await import('../server/jobs.mjs');
  const {walletPasswordForRow}=await import('../server/crypto-wallet-secrets.mjs');
  const {readFileSync,rmSync}=await import('node:fs');
  const f=fixture();f.scheduler.deps.dryRun=dryRunPayload;f.scheduler.deps.createJob=createJob;f.enable();
  try {
    await f.scheduler.tick(new Date(now.getTime()+30*60000));
    const job=f.db.prepare('SELECT * FROM jobs').get();
    assert.ok(job, f.scheduler.getState().message);
    assert.equal(JSON.parse(job.options_json).cryptoFixedAmount,'150');
    assert.equal(walletPasswordForRow(job.id,0),'private-wallet-password');
    assert.equal(readFileSync(job.csv_path,'utf8').includes('private-wallet-password'),false);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM job_rows').all()).includes('private-wallet-password'),false);
    assert.equal(job.options_json.includes('private-wallet-password'),false);
  } finally {
    for(const job of f.db.prepare('SELECT * FROM jobs').all()) {
      for(const path of [job.csv_path,job.result_csv_path]) if(path)rmSync(path,{force:true});
    }
    f.db.close();
  }
});

test('enable resumes only paused unpaid jobs and replenishes runtime password without releasing quarantine',async()=>{
  const {walletPasswordForRow}=await import('../server/crypto-wallet-secrets.mjs');
  const f=fixture(1);f.enable();await f.scheduler.tick(new Date(now.getTime()+30*60000));
  f.db.prepare("UPDATE jobs SET status='blocked',error='crypto_schedule_paused'").run();
  f.db.prepare(`INSERT INTO job_rows (id,job_id,row_number,raw_index,opom_account_id,status,updated_at) VALUES ('paused','j1',1,0,'a0','queued',?)`).run(now.toISOString());
  f.scheduler.update({action:'disable'});f.scheduler.deps.isAccountBlocked=()=>true;
  f.scheduler.update({action:'enable',confirmAutomaticPurchase:true});
  assert.equal(f.db.prepare('SELECT status FROM jobs').get().status,'blocked');
  f.scheduler.deps.isAccountBlocked=()=>false;
  f.scheduler.update({action:'enable',confirmAutomaticPurchase:true});
  assert.equal(f.db.prepare('SELECT status FROM jobs').get().status,'queued');
  assert.equal(walletPasswordForRow('j1',0),'private-wallet-password');f.db.close();
});

test('restart recovery with confirmed completed rows resumes pending rows only after enable',async()=>{
  const f=fixture(2);f.enable();await f.scheduler.tick(new Date(now.getTime()+30*60000));
  f.db.prepare("UPDATE jobs SET status='blocked',error='server restarted during job execution'").run();
  for (const [index,status] of ['completed','queued'].entries()) f.db.prepare(`INSERT INTO job_rows (id,job_id,row_number,raw_index,opom_account_id,status,updated_at) VALUES (?,'j1',?,?,?,?,?)`).run(`restart${index}`,index+1,index,`a${index}`,status,now.toISOString());
  const restarted=new CryptoScheduler(f.db,f.deps);
  restarted.update({action:'enable',confirmAutomaticPurchase:true,walletPassword:'new-runtime-password'});
  assert.equal(f.db.prepare('SELECT status FROM jobs').get().status,'queued');
  assert.deepEqual(f.db.prepare('SELECT status FROM job_rows ORDER BY raw_index').all().map((r)=>r.status),['completed','queued']);f.db.close();
});

test('dispatch callback closes stop race inside createJob and preserves disabled state',async()=>{
  const f=fixture();f.enable();
  f.scheduler.deps.createJob=async(_db,payload)=>{
    assert.equal(!!payload.shouldDispatch(),true);
    f.scheduler.update({action:'disable'});
    assert.equal(!!payload.shouldDispatch(),false);
    throw new Error('schedule was disabled during preparation');
  };
  await f.scheduler.tick(new Date(now.getTime()+30*60000));
  assert.equal(f.scheduler.getState().status,'disabled');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0);f.db.close();
});

for (const jobStatus of ['queued','running','blocked']) test(`new consent cannot release old amount or endpoints from ${jobStatus} jobs`,async()=>{
  const f=fixture();f.enable();await f.scheduler.tick(new Date(now.getTime()+30*60000));
  f.db.prepare("UPDATE jobs SET status=?,error='crypto_schedule_paused'").run(jobStatus);
  f.db.prepare(`INSERT INTO job_rows (id,job_id,row_number,raw_index,opom_account_id,status,updated_at) VALUES ('remaining','j1',1,0,'a0','queued',?)`).run(now.toISOString());
  f.scheduler.update({action:'disable'});f.scheduler.update({action:'save',settings:{amount:10}});
  const before=f.scheduler.read();const password=f.scheduler.password;
  assert.throws(()=>f.scheduler.update({action:'enable',confirmAutomaticPurchase:true,walletPassword:'replacement'}),/原充值金额为 150/);
  assert.deepEqual(f.scheduler.read(),before);assert.equal(f.scheduler.password,password);
  for (const key of ['opomBaseUrl','adspowerApiBase']) {
    assert.throws(()=>f.scheduler.update({action:'enable',settings:{amount:150},[key]:'http://changed.example',confirmAutomaticPurchase:true}),/连接地址/);
    assert.deepEqual(f.scheduler.read(),before);
  }
  const state=f.scheduler.update({action:'enable',settings:{amount:150},confirmAutomaticPurchase:true});
  assert.equal(state.enabled,true);f.db.close();
});

test('saving settings drops undeclared legacy options',()=>{
  const f=fixture();f.enable();
  const stored=JSON.parse(f.scheduler.read().settings_json);stored.options.runtimeWalletPassword='legacy-sensitive-value';stored.options.scopeAutoTopup=true;
  f.db.prepare('UPDATE scheduler_state SET settings_json=?').run(JSON.stringify(stored));
  f.scheduler.update({action:'save'});
  const clean=JSON.parse(f.scheduler.read().settings_json);
  assert.equal('runtimeWalletPassword' in clean.options,false);assert.equal('scopeAutoTopup' in clean.options,false);
  assert.equal(clean.options.opomBaseUrl,connections.opomBaseUrl);f.db.close();
});
