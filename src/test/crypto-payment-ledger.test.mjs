import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {beginCryptoPayment, getCryptoPayment, isCryptoAccountBlocked, updateCryptoPayment} from '../server/crypto-payment-ledger.mjs';
import {prepareOkxWallet, continueOkxRiskWarning} from '../automation/crypto_recharge_openrouter_cdp.mjs';

test('durable crypto guard blocks overlapping jobs and uncertain retries across cycles', () => {
  const db = new DatabaseSync(':memory:');
  beginCryptoPayment(db, 'account', 'job1', 'row1', 'cycle1');
  assert.equal(isCryptoAccountBlocked(db, 'account'), true);
  assert.throws(() => beginCryptoPayment(db, 'account', 'job2', 'row2', 'cycle2'), /requires reconciliation/);
  updateCryptoPayment(db, 'account', 'credited', {balanceBefore: '-2', balanceAfter: '148', purchaseAmount: '150', walletPassword: 'must-not-persist'});
  assert.equal(isCryptoAccountBlocked(db, 'account'), true);
  assert.equal(getCryptoPayment(db, 'account').details_json.includes('must-not-persist'), false);
  updateCryptoPayment(db, 'account', 'completed');
  assert.throws(() => beginCryptoPayment(db, 'account', 'job2', 'row2', 'cycle1'), /already completed/);
  beginCryptoPayment(db, 'account', 'job2', 'row2', 'cycle2');
  updateCryptoPayment(db, 'account', 'not_paid');
  assert.equal(isCryptoAccountBlocked(db, 'account'), false);
  db.close();
});

for (const stage of ['welcome', 'method', 'words', 'password_choice', 'password_setup', 'post_password_welcome']) {
  test(`scheduled wallet never imports or initializes at ${stage}`, async () => {
    let calls = 0;
    await assert.rejects(prepareOkxWallet({cryptoScheduled: true, walletPassword: 'fixture-only'}, {
      acquireStage: async () => ({state: {stage}, wallet: {close() {}, send() { calls++; }}}),
    }), /scheduled_crypto_requires_initialized_wallet/);
    assert.equal(calls, 0);
  });
}

test('risk warning is a human blocker even with payment authorization', async () => {
  await assert.rejects(continueOkxRiskWarning({confirmWalletPayment: true}, {}, {}, {
    inspect: () => { throw new Error('must never inspect or click'); },
  }), /manual_security_blocker/);
});

test('worker retries only OPOM after verified credit, preserving password solely in memory', async () => {
  const {mkdtempSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {openDatabase, getJob} = await import('../server/db.mjs');
  const {createJob, dryRunPayload} = await import('../server/jobs.mjs');
  const {JobWorker} = await import('../server/worker.mjs');
  const {holdWalletPasswords, clearWalletSeeds} = await import('../server/crypto-wallet-secrets.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'crypto-ledger-worker-'));
  const db = openDatabase(join(dir, 'test.sqlite'));
  let jobId;
  try {
    const csvText = 'status,ID,username,amount,card_number,exp_month,exp_year,cvv,postal_code,auto_topup_threshold,auto_topup_amount\n,1415,fixture@example.com,10,5257970000000001,06,28,456,97001,2,25\n';
    const dry = await dryRunPayload({fileName: 'fixture.csv', csvText});
    const created = await createJob(db, {fileName: 'fixture.csv', csvText, liveConfirmationToken: dry.liveConfirmationToken});
    jobId = created.job.id;
    db.prepare('UPDATE jobs SET options_json=? WHERE id=?').run(JSON.stringify({rechargeMode: 'crypto', cryptoScheduled: true, confirmWalletPayment: true, opomWriteback: true}), jobId);
    db.prepare('UPDATE job_rows SET opom_account_id=? WHERE job_id=?').run('account-fixture', jobId);
    holdWalletPasswords(jobId, ['fixture-private-password']);
    db.prepare("INSERT INTO scheduler_state(id,enabled,updated_at) VALUES('auto-recharge:crypto',1,?)").run(new Date().toISOString());
    let purchases = 0, writes = 0;
    const worker = new JobWorker(db, {
      executeRowFn: async (_csv, _index, options) => {
        purchases++;
        assert.equal(options.runtimeWalletPassword, 'fixture-private-password');
        assert.equal(options.runtimeSeedPhrase, '');
        assert.equal(getCryptoPayment(db, 'account-fixture').phase, 'executing');
        return {status: 'completed', safeToContinue: true, details: {
          purchaseStatus: 'verified', purchaseAmount: '150', balanceBefore: '-2', balanceAfter: '148',
        }};
      },
      writeRowResultFn: async () => { if (++writes === 1) throw new Error('simulated outage'); return {resultStatus: 'written'}; },
    });
    await worker.runJob(jobId);
    assert.equal(getCryptoPayment(db, 'account-fixture').phase, 'credited');
    assert.notEqual(getJob(db, jobId).status, 'blocked');
    db.prepare("UPDATE job_rows SET status='queued' WHERE job_id=?").run(jobId);
    db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(jobId);
    await worker.runJob(jobId);
    assert.equal(purchases, 1);
    assert.equal(writes, 2);
    assert.equal(getCryptoPayment(db, 'account-fixture').phase, 'completed');
    assert.equal(getJob(db, jobId).options_json.includes('fixture-private-password'), false);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM crypto_payment_ledger').all()).includes('fixture-private-password'), false);
    db.prepare("UPDATE job_rows SET opom_account_id='timeout-account',status='queued' WHERE job_id=?").run(jobId);
    db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(jobId);
    const timeoutWorker = new JobWorker(db, {cryptoTaskTimeoutMs: 5, executeRowFn: () => new Promise(() => {})});
    await timeoutWorker.runJob(jobId);
    assert.notEqual(getJob(db, jobId).status, 'blocked');
    assert.equal(getCryptoPayment(db, 'timeout-account').phase, 'unverified');
    assert.equal(db.prepare('SELECT status FROM job_rows WHERE job_id=?').get(jobId).status, 'purchase_unverified');
    db.prepare("UPDATE job_rows SET opom_account_id='disabled-account',status='queued' WHERE job_id=?").run(jobId);
    db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(jobId);
    db.prepare("UPDATE scheduler_state SET enabled=0 WHERE id='auto-recharge:crypto'").run();
    await worker.runJob(jobId);
    assert.equal(getJob(db, jobId).error, 'crypto_schedule_paused');
    assert.equal(getCryptoPayment(db, 'disabled-account'), null);
    assert.equal(purchases, 1);
    assert.equal(db.prepare('SELECT status FROM job_rows WHERE job_id=?').get(jobId).status, 'queued');
    db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(jobId);
    db.prepare("UPDATE scheduler_state SET enabled=1 WHERE id='auto-recharge:crypto'").run();
    clearWalletSeeds(jobId);
    await worker.runJob(jobId);
    assert.equal(getJob(db, jobId).error, 'crypto_schedule_paused');
    assert.equal(purchases, 1);
    holdWalletPasswords(jobId, ['fixture-private-password']);
    db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(jobId);
    const unpaidWorker = new JobWorker(db, {executeRowFn: async () => ({status: 'failed',
      message: 'AdsPower profile is being used by another user', details: {cryptoPaymentNotStarted: true}, safeToContinue: false})});
    await unpaidWorker.runJob(jobId);
    assert.equal(getCryptoPayment(db, 'disabled-account').phase, 'not_paid');
    assert.notEqual(getJob(db, jobId).status, 'blocked');
    db.prepare("UPDATE job_rows SET opom_account_id='confirmed-insufficient',status='queued' WHERE job_id=?").run(jobId);
    db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(jobId);
    const confirmedWorker = new JobWorker(db, {executeRowFn: async () => ({status: 'failed', errorCode: 'crypto_insufficient_funds',
      details: {cryptoPaymentNotStarted: true, cryptoPurchase: {walletPaymentConfirmation: {confirmed: true, confirmationClicked: true}}}, safeToContinue: true})});
    await confirmedWorker.runJob(jobId);
    assert.equal(getCryptoPayment(db, 'confirmed-insufficient').phase, 'unverified');
    assert.equal(getJob(db, jobId).status, 'blocked');




  } finally {
    if (jobId) clearWalletSeeds(jobId);
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('aborting a crypto executor kills pending automation before its next action', async () => {
  const {mkdtempSync, rmSync, writeFileSync, existsSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {runClosedLoopChildAsync} = await import('../server/automation-adapter.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'crypto-abort-'));
  try {
    const script = join(dir, 'child.mjs'), marker = join(dir, 'would-pay');
    writeFileSync(script, `import {writeFileSync} from 'node:fs'; process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'unsafe'), 150));`);
    const controller = new AbortController();
    const outcome = runClosedLoopChildAsync(script, {}, {rechargeMode: 'crypto', rowTimeoutMs: 5000, runtimeAbortSignal: controller.signal}, {parseChildJson: () => null}, {redact: value => value});
    setTimeout(() => controller.abort(), 35);
    assert.equal((await outcome).ok, false);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(existsSync(marker), false);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

for (const scenario of ['ordinary', 'security', 'uncertain', 'exception', 'writeback-network', 'insufficient', 'unstructured-insufficient']) {
  test(`scheduled worker isolates ${scenario} failures and only insufficient funds stops subsequent accounts`, async () => {
    const {mkdtempSync, rmSync} = await import('node:fs');
    const {tmpdir} = await import('node:os');
    const {join} = await import('node:path');
    const {openDatabase, getJob} = await import('../server/db.mjs');
    const {createJob, dryRunPayload} = await import('../server/jobs.mjs');
    const {JobWorker} = await import('../server/worker.mjs');
    const {holdWalletPasswords, clearWalletSeeds} = await import('../server/crypto-wallet-secrets.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'crypto-continue-'));
    const db = openDatabase(join(dir, 'test.sqlite'));
    let jobId;
    try {
      const csvText = 'status,ID,username,amount,card_number,exp_month,exp_year,cvv,postal_code,auto_topup_threshold,auto_topup_amount\n,1415,first@example.com,10,5257970000000001,06,28,456,97001,2,25\n,1416,second@example.com,10,5257970000000002,06,28,456,97001,2,25\n';
      const dry = await dryRunPayload({fileName: 'fixture.csv', csvText});
      const created = await createJob(db, {fileName: 'fixture.csv', csvText, liveConfirmationToken: dry.liveConfirmationToken});
      jobId = created.job.id;
      db.prepare('UPDATE jobs SET options_json=? WHERE id=?').run(JSON.stringify({rechargeMode: 'crypto', cryptoScheduled: true, confirmWalletPayment: true, opomWriteback: true}), jobId);
      const rows = db.prepare('SELECT id FROM job_rows WHERE job_id=? ORDER BY raw_index').all(jobId);
      rows.forEach((row, i) => db.prepare('UPDATE job_rows SET opom_account_id=? WHERE id=?').run('fixture-' + i, row.id));
      holdWalletPasswords(jobId, ['fixture-password', 'fixture-password']);
      db.prepare("INSERT INTO scheduler_state(id,enabled,updated_at) VALUES('auto-recharge:crypto',1,?)").run(new Date().toISOString());
      const calls = [];
      const worker = new JobWorker(db, {
        executeRowFn: async (_csv, index) => {
          calls.push(index);
          if (index === 0) {
            if (scenario === 'exception') throw new Error('unexpected executor exit');
            if (scenario !== 'writeback-network') return {
              status: scenario === 'security' ? 'manual_security_blocker' : scenario === 'uncertain' ? 'purchase_unverified' : 'failed',
              errorCode: scenario === 'insufficient' ? 'crypto_insufficient_funds' : scenario === 'unstructured-insufficient' ? '' : 'fixture_error',
              message: scenario === 'unstructured-insufficient' ? '可能余额不足，需要核验' : 'fixture failure', safeToContinue: false, stopProfile: false,
              details: {cryptoPaymentNotStarted: !['uncertain', 'security'].includes(scenario)},
            };
          }
          return {status: 'completed', safeToContinue: true, details: {balanceBefore: '0', balanceAfter: '150', purchaseAmount: '150'}};
        },
        writeRowResultFn: async (_options, row) => {
          if (scenario === 'writeback-network' && row.opom_account_id === 'fixture-0') throw new Error('OPOM network failed at fixture: UND_ERR_SOCKET');
          return {resultStatus: 'written'};
        },
      });
      await worker.runJob(jobId);
      assert.deepEqual(calls, scenario === 'insufficient' ? [0] : [0, 1]);
      assert.equal(getJob(db, jobId).status === 'blocked', scenario === 'insufficient');
      assert.equal(getCryptoPayment(db, 'fixture-0').phase, scenario === 'writeback-network' ? 'credited' : ['uncertain', 'security', 'exception'].includes(scenario) ? 'unverified' : 'not_paid');
      if (scenario === 'unstructured-insufficient') assert.equal(db.prepare('SELECT error_code FROM job_rows WHERE id=?').get(rows[0].id).error_code, 'crypto_row_failed');
      if (scenario === 'writeback-network') {
        const failed = db.prepare('SELECT error_code,error_detail FROM job_rows WHERE id=?').get(rows[0].id);
        assert.equal(failed.error_code, 'opom_writeback_network_failed');
        assert.match(failed.error_detail, /UND_ERR_SOCKET/);
      }
      assert.equal(db.prepare("SELECT enabled FROM scheduler_state WHERE id='auto-recharge:crypto'").get().enabled, 1);
    } finally {
      if (jobId) clearWalletSeeds(jobId);
      db.close();
      rmSync(dir, {recursive: true, force: true});
    }
  });
}
