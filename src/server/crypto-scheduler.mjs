import {holdWalletPasswords} from './crypto-wallet-secrets.mjs';
import {isCryptoAccountBlocked, initializeCryptoPaymentLedger} from './crypto-payment-ledger.mjs';
import {readyToRechargePayload, canonicalCsvFromRows} from './opom-orchestrator.mjs';
import {matchAdsPowerPayload} from './adspower-match.mjs';
import {createJob, dryRunPayload} from './jobs.mjs';
import {runnerArgs} from './automation-adapter.mjs';
import {newId, nowIso} from './ids.mjs';
import {httpError} from './http-utils.mjs';
import {redact} from './redact.mjs';

const ID = 'auto-recharge:crypto';
const STATUSES = ['card_switch', 'overdue'];
const CONNECTION_KEYS = ['opomBaseUrl', 'opomRechargeToken', 'opomSecondaryBaseUrl', 'opomSecondaryRechargeToken', 'opomRequestTimeoutMs', 'opomRequestRetries', 'opomWritebackRetries', 'opomRetryDelayMs', 'adspowerApiBase', 'adspowerApiKey'];
const ROW_KEYS = ['opom_account_id', 'login_email', 'ads_power_user_id', 'ads_power_serial_number', 'ads_power_group_name', 'opom_account_status', 'opom_health_status', 'opom_health_reason'];

export function normalizeCryptoSchedule(input = {}) {
  const scheduleType = input.scheduleType || 'interval';
  if (!['interval', 'daily', 'hourly'].includes(scheduleType)) throw httpError(400, '无效的定时类型');
  const intervalMinutes = Number(input.intervalMinutes ?? 30);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 525600) throw httpError(400, '间隔必须为 1 至 525600 分钟');
  const amount = Number(input.amount ?? 150);
  if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, '固定充值金额必须大于 0');
  if (input.dailyTimes !== undefined && !Array.isArray(input.dailyTimes)) throw httpError(400, '每日时间必须为列表');
  if (input.hourlyMinutes !== undefined && !Array.isArray(input.hourlyMinutes)) throw httpError(400, '每小时分钟必须为列表');
  const dailyTimes = [...new Set(input.dailyTimes || [])].sort();
  const hourlyMinutes = [...new Set((input.hourlyMinutes || []).map(Number))].sort((a,b) => a-b);
  if (dailyTimes.some((s) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s))) throw httpError(400, '每日时间必须为 HH:mm');
  if (hourlyMinutes.some((n) => !Number.isInteger(n) || n < 0 || n > 59)) throw httpError(400, '每小时分钟必须为 0 至 59');
  if (scheduleType === 'daily' && !dailyTimes.length) throw httpError(400, '至少设置一个每日时间');
  if (scheduleType === 'hourly' && !hourlyMinutes.length) throw httpError(400, '至少设置一个每小时分钟');
  return {scheduleType, intervalMinutes, dailyTimes, hourlyMinutes, amount, rechargeMode: 'crypto'};
}

export function nextCryptoRun(settings, date = new Date()) {
  if (settings.scheduleType === 'interval') {
    const period = settings.intervalMinutes * 60000;
    const anchor = Date.parse(settings.enabledAt || '');
    return new Date(Number.isFinite(anchor) ? anchor + (Math.max(0, Math.floor((date.getTime()-anchor)/period))+1)*period : date.getTime()+period);
  }
  const local = new Date(date.getTime() + 8 * 3600000);
  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 8 * 3600000;
  const offsets = settings.scheduleType === 'daily'
    ? settings.dailyTimes.map((s) => { const [h,m] = s.split(':').map(Number); return (h*60+m)*60000; })
    : Array.from({length:24}, (_,h) => settings.hourlyMinutes.map((m) => (h*60+m)*60000)).flat();
  return new Date(offsets.map((n) => start+n).find((n) => n > date.getTime()) ?? start+86400000+offsets[0]);
}

export async function fetchCryptoSnapshot(fetchPage, options = {}) {
  const accounts = new Map();
  for (const status of STATUSES) {
    let cursor = '';
    const seen = new Set();
    do {
      const page = await fetchPage({...options, group:'VIP', status, limit:50, cursor, ignoreCardBinding:true, strictResponse:true});
      if (!page || page.ok === false || !Array.isArray(page.rows)) throw new Error('OPOM 分页响应无效');
      for (const row of page.rows) {
        if (!row.opom_account_id) throw new Error('OPOM 返回账号缺少 ID');
        // OPOM owns status filtering; its recharge DTO need not include account status.
        accounts.set(String(row.opom_account_id), Object.fromEntries(ROW_KEYS.map((key) => [key, row[key] || ''])));
      }
      const next = page.nextCursor;
      if (next !== null && next !== undefined && typeof next !== 'string' && typeof next !== 'number') throw new Error('OPOM nextCursor 无效');
      cursor = next === null || next === undefined ? '' : String(next);
      if (cursor && seen.has(cursor)) throw new Error('OPOM 返回重复分页游标');
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  return [...accounts.values()];
}

export class CryptoScheduler {
  constructor(db, dependencies = {}) {
    this.db = db;
    initializeCryptoPaymentLedger(db);
    this.password = '';
    this.busy = false;
    this.generation = 0;
    this.deps = {isAccountBlocked:isCryptoAccountBlocked,fetchPage:readyToRechargePayload, match:matchAdsPowerPayload, dryRun:dryRunPayload, createJob, now:() => new Date(), ...dependencies};
    // Preserve the last known state on upgrade; older overwritten events cannot be reconstructed.
    const previous = this.read();
    if (previous.updated_at && !this.db.prepare('SELECT id FROM crypto_scheduler_history LIMIT 1').get()) {
      this.db.prepare('INSERT INTO crypto_scheduler_history (created_at,status,message) VALUES (?,?,?)')
        .run(previous.updated_at,previous.status,redact(`升级前最后状态：${previous.message || ''}`));
    }
    // An old preparation-only authorization is never payment authorization; secrets do not survive restart.
    if (this.read().enabled) this.write({enabled:0, status:'paused_restart', next_run_at:'', message:'服务已重启，请重新输入钱包密码并启用计划。'});
  }
  read() {
    return this.db.prepare('SELECT * FROM scheduler_state WHERE id=?').get(ID) || {enabled:0,settings_json:'{}',status:'disabled',message:'虚拟币自动充值计划未启用。'};
  }
  write(values) {
    const previous = this.read();
    const row = {...previous, ...values};
    row.message = redact(String(row.message || '').split(this.password || '\0').join('[REDACTED]'));
    this.db.prepare(`INSERT INTO scheduler_state (id, enabled, settings_json, last_slot, last_run_at, next_run_at, status, message, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, settings_json=excluded.settings_json,
      last_slot=excluded.last_slot,last_run_at=excluded.last_run_at,next_run_at=excluded.next_run_at,status=excluded.status,message=excluded.message,updated_at=excluded.updated_at`)
      .run(ID,row.enabled,row.settings_json,row.last_slot||'',row.last_run_at||'',row.next_run_at||'',row.status,row.message||'',nowIso());
    if (row.status !== previous.status || row.message !== previous.message || row.last_run_at !== previous.last_run_at) {
      this.db.prepare('INSERT INTO crypto_scheduler_history (created_at,status,message,cycle_id) VALUES (?,?,?,?)')
        .run(nowIso(),row.status,row.message,this.currentCycleId || '');
    }
  }
  getHistory() {
    const events = this.db.prepare('SELECT id,created_at AS createdAt,status,message,cycle_id AS cycleId FROM crypto_scheduler_history ORDER BY id DESC LIMIT 50').all();
    const rounds = this.db.prepare(`SELECT id,created_at AS createdAt,updated_at AS updatedAt,status,
      total_count AS totalCount,processed_count AS processedCount FROM crypto_scheduler_cycles ORDER BY created_at DESC,rowid DESC LIMIT 20`).all();
    for (const round of rounds) {
      round.batchCount = this.db.prepare('SELECT COUNT(*) AS n FROM crypto_scheduler_batches WHERE cycle_id=?').get(round.id).n;
      round.batches = this.db.prepare(`SELECT batch_index AS batchIndex,status,job_id AS jobId,
        json_array_length(rows_json) AS accountCount FROM crypto_scheduler_batches WHERE cycle_id=? ORDER BY batch_index LIMIT 100`).all(round.id);
    }
    return {events,rounds,eventLimit:50,roundLimit:20,batchLimit:100};
  }
  getState() {
    const row = this.read();
    const stored = JSON.parse(row.settings_json || '{}');
    const settings = normalizeCryptoSchedule(stored);
    const cycle = this.db.prepare('SELECT * FROM crypto_scheduler_cycles ORDER BY created_at DESC LIMIT 1').get();
    const batches = cycle ? this.db.prepare('SELECT * FROM crypto_scheduler_batches WHERE cycle_id=? ORDER BY batch_index').all(cycle.id) : [];
    const issues = cycle ? this.db.prepare("SELECT account_id AS accountId,status,message FROM crypto_scheduler_accounts WHERE cycle_id=? AND status NOT IN ('pending','queued','completed')").all(cycle.id) : [];
    const active = batches.find((b) => !['completed','skipped'].includes(b.status));
    return {ok:true,enabled:!!row.enabled,status:row.status,message:row.message||'',history:this.getHistory(),settings:{...settings,group:'VIP',limit:50,opomWriteback:true,confirmPurchase:true},
      schedule:settings.scheduleType==='interval'?`每隔 ${settings.intervalMinutes} 分钟`:settings.scheduleType==='daily'?`每天 ${settings.dailyTimes.join('、')}（北京时间）`:`每小时 ${settings.hourlyMinutes.join('、')} 分（北京时间）`,
      hasWalletPassword:!!this.password,walletPasswordConfigured:!!this.password,lastSlot:row.last_slot||'',lastRunAt:row.last_run_at||'',nextRunAt:row.next_run_at||'',updatedAt:row.updated_at||'',
      round:cycle?{id:cycle.id,status:cycle.status,batchIndex:active?.batch_index || batches.length,batchCount:batches.length,processedCount:cycle.processed_count,totalCount:cycle.total_count,issueCount:issues.length,issues}:null};
  }
  update(payload = {}) {
    const action = payload.action || (payload.enabled ? 'enable' : 'disable');
    if (!['save','enable','disable'].includes(action)) throw httpError(400,'无效的计划操作');
    if (action === 'disable') {
      this.generation += 1;
      this.write({enabled:0,status:'disabled',next_run_at:'',message:'计划已停用，已提交的付款继续核验和写回。'});
      return this.getState();
    }
    const stored = JSON.parse(this.read().settings_json || '{}');
    const settings = normalizeCryptoSchedule({...stored,...(payload.settings||{})});
    const connections = {};
    const incomingConnections = {...stored.options, ...payload.runtimeConfig, ...payload, ...payload.options};
    for (const key of CONNECTION_KEYS) if (incomingConnections[key] !== undefined) connections[key] = incomingConnections[key];
    if (payload.walletPassword !== undefined && typeof payload.walletPassword !== 'string') throw httpError(400,'钱包密码必须为文本');
    const password = payload.walletPassword || this.password;
    if (action === 'enable') {
      if (payload.confirmAutomaticPurchase !== true) throw httpError(409,'启用需明确确认持续自动付款与 OPOM 写回');
      if (!password) throw httpError(409,'请重新输入钱包密码');
      const args = runnerArgs(connections);
      if (!args.opomBaseUrl || !args.opomRechargeToken || !args.adspowerApiBase || !args.adspowerApiKey) throw httpError(409,'请配置 OPOM 和 AdsPower 地址及凭据');
      // Persisted jobs retain their own payment parameters. New consent must not silently
      // release an older queued amount or send it to a different OPOM/browser endpoint.
      const unfinishedJobs=this.db.prepare(`SELECT id,options_json FROM jobs WHERE status IN ('queued','running','blocked')
        AND json_extract(options_json,'$.cryptoScheduled')=1
        AND (EXISTS (SELECT 1 FROM job_rows WHERE job_id=jobs.id AND status IN ('ready','queued','running'))
          OR NOT EXISTS (SELECT 1 FROM job_rows WHERE job_id=jobs.id))`).all();
      const endpoint=(value)=>String(value || '').trim().replace(/\/+$/,'');
      for (const job of unfinishedJobs) {
        const previous=runnerArgs(JSON.parse(job.options_json));
        if (Number(previous.cryptoFixedAmount)!==settings.amount
          || endpoint(previous.opomBaseUrl)!==endpoint(args.opomBaseUrl)
          || endpoint(previous.adspowerApiBase)!==endpoint(args.adspowerApiBase)) {
          throw httpError(409,`未完成批次 ${job.id} 的原充值金额为 ${previous.cryptoFixedAmount || '未知'} 美元，或连接地址与新配置不同；请使用原配置完成或取消该任务后再启用。`);
        }
      }
    }
    this.generation += 1;
    if (payload.walletPassword) this.password = payload.walletPassword;
    // Saving is separate from enabling: a changed amount cannot inherit old payment consent.
    this.write({settings_json:JSON.stringify({...settings,enabledAt:action==='enable'?this.deps.now().toISOString():stored.enabledAt,options:connections}),enabled:action==='enable'?1:0,
      status:action==='enable'?'enabled':'saved',message:action==='enable'?'虚拟币自动充值计划已启用。':'配置已保存，启用后才会执行。',
      next_run_at:action==='enable'?nextCryptoRun(settings,this.deps.now()).toISOString():''});
    if (action === 'enable') {
      const resumable=this.db.prepare("SELECT id FROM jobs WHERE status='blocked' AND error IN ('crypto_schedule_paused','server restarted during job execution','crypto_insufficient_funds') AND json_extract(options_json,'$.cryptoScheduled')=1").all();
      for (const job of resumable) {
        const rows=this.db.prepare('SELECT raw_index,opom_account_id,status FROM job_rows WHERE job_id=? ORDER BY raw_index').all(job.id);
        if (rows.some((row)=>row.status==='running' || (['queued','ready'].includes(row.status) && this.deps.isAccountBlocked?.(this.db,row.opom_account_id)))) continue;
        if (!rows.some((row)=>['queued','ready'].includes(row.status))) {
          const status=rows.every((row)=>['completed','skipped'].includes(row.status))?'completed':'failed';
          this.db.prepare("UPDATE jobs SET status=?,error='',finished_at=?,updated_at=? WHERE id=?").run(status,nowIso(),nowIso(),job.id);
          continue;
        }
        const passwords=Array.from({length:Math.max(-1,...rows.map((r)=>r.raw_index))+1},()=>this.password);
        holdWalletPasswords(job.id,passwords);
        this.db.prepare("UPDATE jobs SET status='queued',error='',finished_at=NULL,updated_at=? WHERE id=?").run(nowIso(),job.id);
      }
    }
    return this.getState();
  }
  async prepareNow() {
    if (!this.read().enabled) throw httpError(409,'请先启用虚拟币自动充值计划');
    await this.tick(this.deps.now(), true);
    return this.getState();
  }
  async tick(date = new Date(), force = false) {
    if (this.busy || !this.read().enabled) return;
    this.busy = true;
    const generation = this.generation;
    try { await this.advance(date,force); }
    catch (error) {
      if (generation !== this.generation) return;
      const network = error.opomNetworkFailure || /OPOM network failed|UND_ERR_SOCKET/.test(error.message || '');
      const settings = JSON.parse(this.read().settings_json);
      const failedAt = new Date(Math.max(date.getTime(),this.deps.now().getTime()));
      this.write({status:network?'retry_wait':'failed',
        next_run_at:network?new Date(failedAt.getTime()+5*60000).toISOString():nextCryptoRun(settings,failedAt).toISOString(),
        message:`${error.message || '虚拟币计划失败'}；${network?'5 分钟后重试':'保留计划，下个执行时间重试'}`,
        last_run_at:date.toISOString()});
    }
    finally { this.busy = false; this.currentCycleId = ''; }
  }
  retryWriteback(date) {
    const due = this.db.prepare(`SELECT r.id,r.job_id,r.raw_index FROM job_rows r
      JOIN jobs j ON j.id=r.job_id JOIN crypto_payment_ledger p ON p.row_id=r.id
      WHERE r.status='failed' AND r.error_code='opom_writeback_network_failed'
        AND p.phase='credited' AND json_extract(j.options_json,'$.cryptoScheduled')=1
        AND julianday(r.updated_at)<=julianday(?)
      ORDER BY r.updated_at LIMIT 1`).get(new Date(date.getTime()-5*60000).toISOString());
    if (!due) return false;
    holdWalletPasswords(due.job_id,Array.from({length:due.raw_index+1},()=>this.password));
    this.db.prepare("UPDATE job_rows SET status='queued',updated_at=? WHERE id=?").run(nowIso(),due.id);
    this.db.prepare("UPDATE jobs SET status='queued',error='',finished_at=NULL,updated_at=? WHERE id=?").run(nowIso(),due.job_id);
    this.write({message:'OPOM 网络写回失败已等待 5 分钟，仅重试已到账账号的写回，不再付款。'});
    return true;
  }
  async advance(date,force) {
    const generation = this.generation;
    const stillEnabled = () => this.read().enabled && this.generation === generation;
    let state = this.read();
    const settings = JSON.parse(state.settings_json);
    if (!this.password) { this.write({enabled:0,status:'paused_restart',next_run_at:'',message:'请重新输入钱包密码并启用。'}); return; }
    let cycle = this.db.prepare("SELECT * FROM crypto_scheduler_cycles WHERE status='active' ORDER BY created_at LIMIT 1").get();
    this.currentCycleId = cycle?.id || '';
    if (this.db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running') LIMIT 1").get()) {
      if (['retry_wait','failed'].includes(state.status)) return;
      this.write({status:'waiting_busy',message:'已有充值任务，等待完成后继续本轮。'}); return;
    }
    if (this.retryWriteback(date)) return;
    if (['retry_wait','failed'].includes(state.status) && state.next_run_at && date < new Date(state.next_run_at)) return;
    if (!cycle && !force && (!state.next_run_at || date < new Date(state.next_run_at))) return;
    if (!cycle) {
      const slot = force ? `manual-${date.toISOString()}` : state.next_run_at;
      if (this.db.prepare('SELECT id FROM crypto_scheduler_cycles WHERE slot=?').get(slot)) return;
      const rows = await fetchCryptoSnapshot(this.deps.fetchPage,settings.options);
      if (!stillEnabled()) return;
      const id = newId('crypto_cycle');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('INSERT INTO crypto_scheduler_cycles VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run(id,slot,rows.length?'active':'completed',JSON.stringify(rows),rows.length,date.toISOString(),date.toISOString());
        for (let i=0;i<rows.length;i+=50) {
          const batchId = newId('crypto_batch'); const batchRows=rows.slice(i,i+50);
          this.db.prepare('INSERT INTO crypto_scheduler_batches (id,cycle_id,batch_index,rows_json) VALUES (?,?,?,?)').run(batchId,id,i/50+1,JSON.stringify(batchRows));
          for (const row of batchRows) this.db.prepare('INSERT INTO crypto_scheduler_accounts (cycle_id,account_id,batch_id) VALUES (?,?,?)').run(id,row.opom_account_id,batchId);
        }
        this.db.exec('COMMIT');
      } catch(error) {this.db.exec('ROLLBACK');throw error;}
      this.currentCycleId = id;
      this.write({last_slot:slot,last_run_at:date.toISOString(),next_run_at:nextCryptoRun(settings,date).toISOString(),status:rows.length?'running':'idle_no_rows',message:`本轮读取 ${rows.length} 个 VIP 账号。`});
      cycle=this.db.prepare('SELECT * FROM crypto_scheduler_cycles WHERE id=?').get(id);
      if (!rows.length) return;
    }
    // Recover the narrow crash window between durable job creation and batch linkage.
    const unlinked=this.db.prepare("SELECT * FROM crypto_scheduler_batches WHERE cycle_id=? AND status='pending'").all(cycle.id);
    for (const pending of unlinked) {
      const existing=this.db.prepare("SELECT id FROM jobs WHERE json_extract(options_json,'$.cryptoBatchId')=? LIMIT 1").get(pending.id);
      if (existing) this.db.prepare("UPDATE crypto_scheduler_batches SET status='queued',job_id=? WHERE id=?").run(existing.id,pending.id);
    }
    const batches=this.db.prepare('SELECT * FROM crypto_scheduler_batches WHERE cycle_id=? ORDER BY batch_index').all(cycle.id);
    for (const batch of batches.filter((b)=>b.status==='queued')) {
      const job=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(batch.job_id);
      const unfinished=this.db.prepare("SELECT COUNT(*) AS n FROM job_rows WHERE job_id=? AND status IN ('ready','queued','running')").get(batch.job_id);
      const insufficient = this.db.prepare("SELECT id FROM job_rows WHERE job_id=? AND error_code='crypto_insufficient_funds' LIMIT 1").get(batch.job_id);
      if (insufficient && job?.status==='blocked') {this.write({enabled:0,status:'paused_insufficient_funds',next_run_at:'',message:'钱包余额不足，停止后续账号并暂停自动计划。'});return;}
      if (job && ['queued','running'].includes(job.status)) return;
      const results=this.db.prepare('SELECT opom_account_id,status,message FROM job_rows WHERE job_id=?').all(batch.job_id);
      for (const result of results) this.recordAccount(cycle.id,result.opom_account_id,
        ['ready','queued','running'].includes(result.status)?'failed':result.status,
        ['ready','queued','running'].includes(result.status)?'原任务异常停止，本行未执行；后续轮次重新获取':result.message);
      if (!job || job.status==='blocked' || unfinished.n) {
        this.write({status:'running',message:`批次 ${batch.batch_index} 异常已记录，继续后续批次。`});
      }
      this.db.prepare("UPDATE crypto_scheduler_batches SET status='completed' WHERE id=?").run(batch.id);
      this.db.prepare('UPDATE crypto_scheduler_cycles SET processed_count=processed_count+?,updated_at=? WHERE id=?').run(JSON.parse(batch.rows_json).length,date.toISOString(),cycle.id);
    }
    const batch=this.db.prepare("SELECT * FROM crypto_scheduler_batches WHERE cycle_id=? AND status='pending' ORDER BY batch_index LIMIT 1").get(cycle.id);
    if (!batch) {
      this.db.prepare("UPDATE crypto_scheduler_cycles SET status='completed',updated_at=? WHERE id=?").run(date.toISOString(),cycle.id);
      this.write({status:'completed',message:'本轮所有批次处理完成。',next_run_at:nextCryptoRun(settings,date).toISOString()});return;
    }
    // Re-read the filtered queue before each batch; never infer current eligibility from the earlier snapshot.
    const current=new Map((await fetchCryptoSnapshot(this.deps.fetchPage,settings.options)).map((r)=>[r.opom_account_id,r]));
    if (!stillEnabled()) return;
    let rows=[];
    for (const original of JSON.parse(batch.rows_json)) {
      const row=current.get(original.opom_account_id);
      if (!row) this.recordAccount(cycle.id,original.opom_account_id,'skipped','账号已不在 VIP 待换卡或低余额队列中');
      else if (this.deps.isAccountBlocked?.(this.db,row.opom_account_id)) this.recordAccount(cycle.id,row.opom_account_id,'quarantined','历史付款待核验或待写回，禁止再次付款');
      else rows.push(row);
    }
    const options={...settings.options,rechargeMode:'crypto',cryptoScheduled:true,cryptoCycleId:cycle.id,cryptoBatchId:batch.id,
      concurrency:1,confirmWalletPayment:true,confirmPurchase:true,opomWriteback:true,preparePurchaseOnly:false,scopePurchase:true,
      scopeBillingAddress:false,scopePaymentMethod:false,scopeAutoTopup:false,cryptoRechargeRuleMode:'fixed_amount',cryptoFixedAmount:String(settings.amount)};
    if (rows.length) {
      const matched=await this.deps.match({rows:rows.map((r)=>({loginEmail:r.login_email,ads_power_user_id:r.ads_power_user_id,ads_power_serial_number:r.ads_power_serial_number})),options});
      if (!stillEnabled()) return;
      rows=rows.flatMap((r,index)=>{
        const match=matched.results?.find((m)=>Number(m.index)===index);
        if (match?.status!=='matched') this.recordAccount(cycle.id,r.opom_account_id,'match_failed',match?.message||match?.reason||'AdsPower 未唯一匹配');
        return match?.status==='matched' ? [{...r,ads_match_status:'matched',ads_power_user_id:match.profile?.userId||r.ads_power_user_id,ads_power_serial_number:match.profile?.serialNumber||r.ads_power_serial_number,amount:String(settings.amount),idempotency_key:`${cycle.id}:${r.opom_account_id}`}] : [];
      });
    }
    if (!stillEnabled()) return;
    if (!rows.length) {this.finishSkipped(batch,cycle,date);return;}
    const csvText=canonicalCsvFromRows(rows); const fileName=`${batch.id}.csv`;
    const dry=await this.deps.dryRun({csvText,fileName,options});
    if (!stillEnabled()) return;
    for (const row of dry.rows || []) if (row.status!=='ready') this.recordAccount(cycle.id,row.opomAccountId,row.status||'preflight_failed',row.message||'账号未通过预检');
    if (!dry.ready || !dry.liveConfirmationToken) {this.finishSkipped(batch,cycle,date);return;}
    if (!stillEnabled()) return;
    const created=await this.deps.createJob(this.db,{csvText,fileName,options,liveConfirmationToken:dry.liveConfirmationToken,
      runtimeWalletPasswords:rows.map(()=>this.password),shouldDispatch:stillEnabled,jobName:`crypto-${cycle.id}-${batch.batch_index}`});
    this.db.prepare("UPDATE crypto_scheduler_batches SET status='queued',job_id=? WHERE id=?").run(created.job.id,batch.id);
    for (const row of rows) {
      const result=dry.rows?.find((r)=>r.opomAccountId===row.opom_account_id);
      if (!result || result.status==='ready') this.recordAccount(cycle.id,row.opom_account_id,'queued','已通过预检并排队');
    }
    this.write({status:'queued',message:`第 ${batch.batch_index}/${batches.length} 批已排队，${rows.length} 个账号。`});
  }
  recordAccount(cycleId,accountId,status,message='') {
    this.db.prepare('UPDATE crypto_scheduler_accounts SET status=?,message=? WHERE cycle_id=? AND account_id=?')
      .run(status,redact(String(message)),cycleId,String(accountId));
  }
  finishSkipped(batch,cycle,date) {
    this.db.prepare("UPDATE crypto_scheduler_batches SET status='skipped' WHERE id=?").run(batch.id);
    this.db.prepare('UPDATE crypto_scheduler_cycles SET processed_count=processed_count+?,updated_at=? WHERE id=?').run(JSON.parse(batch.rows_json).length,date.toISOString(),cycle.id);
    this.write({status:'skipped',message:`第 ${batch.batch_index} 批无符合当前状态与预检要求的账号。`});
  }
}
