import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openDatabase} from '../server/db.mjs';
import {JobWorker} from '../server/worker.mjs';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {automationLogDirForRow} from '../server/automation-adapter.mjs';
import {beginCryptoAccountingAttempt, cryptoAmountsWithCheckpoint} from '../automation/lib/crypto-amount-fields.mjs';

const ACCOUNTING = {
  crypto_credit_amount: 'cryptoCreditAmount',
  crypto_payment_amount: 'cryptoPaymentAmount',
  crypto_payment_asset: 'cryptoPaymentAsset',
  crypto_payment_amount_source: 'cryptoPaymentAmountSource',
  crypto_network_fee_amount: 'cryptoNetworkFeeAmount',
  crypto_network_fee_asset: 'cryptoNetworkFeeAsset',
  crypto_network_fee_usd: 'cryptoNetworkFeeUsd',
  crypto_network_fee_display: 'cryptoNetworkFeeDisplay',
  crypto_network_fee_status: 'cryptoNetworkFeeStatus',
  crypto_network_fee_source: 'cryptoNetworkFeeSource',
};

function fixture(jobId = 'job') {
  const dir = mkdtempSync(join(tmpdir(), 'or-crypto-accounting-'));
  const path = join(dir, 'test.sqlite');
  const db = openDatabase(path);
  const csvPath = join(dir, 'source.csv');
  writeFileSync(csvPath, 'status,ID,username,amount\n,1415,test@example.com,10\n');
  db.prepare(`INSERT INTO jobs (id, file_name, csv_path, result_csv_path, status, created_at, updated_at)
    VALUES (?, 'source.csv', ?, ?, 'queued', 'now', 'now')`).run(jobId, csvPath, join(dir, 'result.csv'));
  db.prepare(`INSERT INTO job_rows (id, job_id, row_number, raw_index, status, purchase_amount, updated_at)
    VALUES ('row', ?, 2, 0, 'queued', '10', 'now')`).run(jobId);
  return {dir, path, db};
}

function assertAmounts(db, details) {
  const row = db.prepare("SELECT * FROM job_rows WHERE id = 'row'").get();
  for (const [column, key] of Object.entries(ACCOUNTING)) {
    assert.equal(row[column], String(details[key] ?? ''), key);
  }
}

test('new databases include empty text accounting fields without inferred amounts', () => {
  const {dir, db} = fixture();
  try {
    const schema = db.prepare('PRAGMA table_info(job_rows)').all();
    for (const column of Object.keys(ACCOUNTING)) {
      assert.equal(schema.find((item) => item.name === column)?.type, 'TEXT');
    }
    assertAmounts(db, {});
  } finally {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('legacy databases gain empty accounting fields and migration is idempotent', () => {
  const {dir, path, db} = fixture();
  let reopened;
  try {
    for (const column of Object.keys(ACCOUNTING)) db.exec(`ALTER TABLE job_rows DROP COLUMN ${column}`);
    db.close();
    reopened = openDatabase(path);
    assertAmounts(reopened, {});
    assert.equal(reopened.prepare("SELECT purchase_amount FROM job_rows WHERE id = 'row'").get().purchase_amount, '10');
    reopened.close();
    reopened = openDatabase(path);
    assertAmounts(reopened, {});
  } finally {
    if (reopened?.isOpen) reopened.close();
    if (db.isOpen) db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

for (const [name, status, details] of [
  ['exact amounts and zero fee', 'completed', {
    cryptoCreditAmount: '10', cryptoPaymentAmount: '10.50', cryptoPaymentAsset: 'USDC',
    cryptoPaymentAmountSource: 'coinbase_checkout', cryptoNetworkFeeAmount: 0,
    cryptoNetworkFeeAsset: 'ETH', cryptoNetworkFeeUsd: 0, cryptoNetworkFeeDisplay: '$0.00',
    cryptoNetworkFeeStatus: 'observed', cryptoNetworkFeeSource: 'okx_confirmation',
  }],
  ['displayed sub-cent fee estimate on failed verification', 'purchase_unverified', {
    cryptoCreditAmount: '10', cryptoPaymentAmount: '10.50', cryptoPaymentAsset: 'USDC',
    cryptoPaymentAmountSource: 'coinbase_checkout', cryptoNetworkFeeDisplay: '<$0.01',
    cryptoNetworkFeeAmount: '0.01', cryptoNetworkFeeUsd: '0.01', cryptoNetworkFeeStatus: 'observed',
    cryptoNetworkFeeSource: 'okx_confirmation',
  }],
  ['asset fee estimate preserving the original display', 'failed', {
    cryptoCreditAmount: '10', cryptoPaymentAmount: '10.50', cryptoPaymentAsset: 'USDC',
    cryptoPaymentAmountSource: 'coinbase_checkout', cryptoNetworkFeeAsset: 'ETH',
    cryptoNetworkFeeDisplay: '<0.000001 ETH', cryptoNetworkFeeAmount: '0.000001',
    cryptoNetworkFeeStatus: 'observed', cryptoNetworkFeeSource: 'okx_confirmation',
  }],
  ['missing observations never fall back to purchase amount', 'failed', {}],
]) {
  test(`worker persists ${name}`, async () => {
    const {dir, db} = fixture();
    try {
      const worker = new JobWorker(db, {
        executeRowFn: async () => ({status, stage: 'crypto.test', message: status, details,
          safeToContinue: status === 'completed', stopProfile: false}),
      });
      await worker.runJob('job');
      assert.equal(db.prepare("SELECT status FROM job_rows WHERE id = 'row'").get().status, status);
      assertAmounts(db, details);
    } finally {
      db.close();
      rmSync(dir, {recursive: true, force: true});
    }
  });
}

test('accounting attempts retain worker ID and exclude checkpoints from other attempts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-crypto-checkpoint-'));
  try {
    const task = {confirmationDebugDir: dir, cryptoAccountingAttemptId: 'worker-attempt'};
    beginCryptoAccountingAttempt(task);
    assert.equal(task.cryptoAccountingAttemptId, 'worker-attempt');
    writeFileSync(join(dir, 'crypto-financials.json'), JSON.stringify({
      attemptId: 'previous-attempt', cryptoAmounts: {cryptoPaymentAmount: '99'},
    }));
    assert.deepEqual(cryptoAmountsWithCheckpoint(task), {});
    writeFileSync(join(dir, 'crypto-financials.json'), JSON.stringify({
      attemptId: 'worker-attempt', cryptoAmounts: {cryptoPaymentAmount: '10.50', cryptoNetworkFeeUsd: 0, unrelated: 'ignored'},
    }));
    assert.deepEqual(cryptoAmountsWithCheckpoint(task), {cryptoPaymentAmount: '10.50', cryptoNetworkFeeUsd: '0'});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

for (const matchingAttempt of [true, false]) {
  test(`outer worker timeout ${matchingAttempt ? 'recovers current' : 'rejects old'} accounting checkpoint`, async t => {
    const jobId = `test-crypto-timeout-${randomUUID()}`;
    const {dir, db} = fixture(jobId);
    const logDir = automationLogDirForRow({jobId, rowId: 'row', rowNumber: 2}, 0);
    const originalNow = Date.now.bind(Date);
    const amounts = {cryptoCreditAmount: '10', cryptoPaymentAmount: '10.50',
      cryptoPaymentAsset: 'USDC', cryptoNetworkFeeUsd: '0.01', cryptoNetworkFeeDisplay: '<$0.01'};
    try {
      db.prepare('UPDATE jobs SET options_json = ? WHERE id = ?').run(JSON.stringify({rechargeMode: 'crypto'}), jobId);
      t.mock.method(globalThis, 'fetch', async () => {throw new Error('external access forbidden');});
      const worker = new JobWorker(db, {
        executeRowFn: async (_csv, _index, options) => {
          assert.ok(options.cryptoAccountingAttemptId);
          mkdirSync(logDir, {recursive: true});
          writeFileSync(join(logDir, 'crypto-financials.json'), JSON.stringify({
            attemptId: matchingAttempt ? options.cryptoAccountingAttemptId : 'previous-attempt',
            cryptoAmounts: {...amounts, password: 'must-not-be-copied'},
          }));
          // Force the existing four-minute budget to expire without waiting or changing production timeouts.
          t.mock.method(Date, 'now', () => originalNow() + 240001);
          return new Promise(() => {});
        },
      });
      await worker.runJob(jobId);
      const row = db.prepare("SELECT * FROM job_rows WHERE id = 'row'").get();
      assert.equal(row.error_code, 'crypto_task_timeout');
      assertAmounts(db, matchingAttempt ? amounts : {});
    } finally {
      t.mock.restoreAll();
      db.close();
      rmSync(dir, {recursive: true, force: true});
      // This random per-test log directory is the only production-path fixture touched by the test.
      rmSync(dirname(logDir), {recursive: true, force: true});
    }
  });
}
