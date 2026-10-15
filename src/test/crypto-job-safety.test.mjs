import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync, rmSync} from 'node:fs';
import {openDatabase, getJob, recoverInterruptedWork} from '../server/db.mjs';
import {createJob, dryRunPayload, resumePreview, resumeJob, repairOpomWriteback} from '../server/jobs.mjs';
import {beginCryptoPayment, updateCryptoPayment, getCryptoPayment} from '../server/crypto-payment-ledger.mjs';
import {walletPasswordForRow, clearWalletSeeds} from '../server/crypto-wallet-secrets.mjs';
import {buildCryptoCallbackPayload} from '../server/crypto-callback.mjs';
import {writeCryptoCompletedRow} from '../server/opom-client.mjs';

const csvText = 'status,opom_account_id,login_email,ads_power_user_id,ads_match_status,amount\n,acct_crypto_guard,user@example.com,profile1,matched,150\n';
const options = {
  rechargeMode: 'crypto', cryptoRechargeRuleMode: 'fixed_amount', cryptoFixedAmount: '150',
  scopeBillingAddress: false, scopePaymentMethod: false, scopePurchase: true, scopeAutoTopup: false,
  confirmPurchase: false, confirmWalletPayment: true, opomWriteback: true,
  opomBaseUrl: 'http://opom.test', opomRechargeToken: 'fixture-token', opomWritebackRetries: 1,
};

async function fixture(t, overrides = {}) {
  const db = openDatabase(':memory:');
  t.after(() => {
    for (const job of db.prepare('SELECT * FROM jobs').all()) {
      clearWalletSeeds(job.id);
      rmSync(job.csv_path, {force: true});
      rmSync(job.result_csv_path, {force: true});
    }
    db.close();
  });
  const opts = {...options, ...overrides};
  const dry = await dryRunPayload({csvText, options: opts});
  assert.equal(dry.ready, 1);
  return {db, payload: {csvText, options: opts, liveConfirmationToken: dry.liveConfirmationToken}};
}

test('dry-run binds wallet authorization and fixed crypto amount', async (t) => {
  const {db, payload} = await fixture(t);
  for (const change of [{confirmWalletPayment: false}, {cryptoFixedAmount: '200'}, {cryptoScheduled: true}]) {
    await assert.rejects(createJob(db, {...payload, options: {...options, ...change}}), /changed after dry-run/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
});

test('scheduled password reaches runtime memory only before queue exposure', async (t) => {
  const {db, payload} = await fixture(t, {cryptoScheduled: true});
  const password = 'synthetic-runtime-password';
  const result = await createJob(db, {...payload, runtimeWalletPasswords: [password]});
  const stored = getJob(db, result.job.id);
  assert.equal(walletPasswordForRow(stored.id, 0), password);
  for (const value of [JSON.stringify(result), stored.options_json, readFileSync(stored.csv_path, 'utf8'), readFileSync(stored.result_csv_path, 'utf8')]) {
    assert.equal(value.includes(password), false);
  }
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM events').all()).includes(password), false);
});

test('runtime credentials cannot be persisted via job options or scheduled CSV', async (t) => {
  const {db, payload} = await fixture(t, {cryptoScheduled: true});
  await assert.rejects(createJob(db, {...payload, options: {...payload.options, runtimeWalletPassword: 'synthetic'}}), /runtime-only/);
  const secretCsv = csvText.trim().split('\n').map((line, index) => line + (index ? ',synthetic' : ',wallet_password')).join('\n');
  await assert.rejects(createJob(db, {...payload, csvText: secretCsv}), /must not contain/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
});

test('uncertain payment blocks new jobs and risky manual resume', async (t) => {
  const {db, payload} = await fixture(t);
  const result = await createJob(db, payload);
  const id = result.job.id;
  const row = db.prepare('SELECT * FROM job_rows WHERE job_id=?').get(id);
  beginCryptoPayment(db, row.opom_account_id, id, row.id);
  updateCryptoPayment(db, row.opom_account_id, 'uncertain');
  db.prepare("UPDATE jobs SET status='blocked' WHERE id=?").run(id);
  db.prepare("UPDATE job_rows SET status='purchase_unverified' WHERE id=?").run(row.id);
  await assert.rejects(createJob(db, payload), /previous crypto payment/);
  const preview = await resumePreview(db, id, {startRowNumber: 2, includeRiskyRows: true});
  assert.equal(preview.canResume, false);
  assert.equal(preview.skippedRiskyRows.length, 1);
  await assert.rejects(resumeJob(db, id, {startRowNumber: 2, includeRiskyRows: true}), /No rows/);
});

test('verified crypto repair writes only OPOM result and preserves local accounting', async (t) => {
  const {db, payload} = await fixture(t);
  const result = await createJob(db, payload);
  const id = result.job.id;
  const row = db.prepare('SELECT * FROM job_rows WHERE job_id=?').get(id);
  beginCryptoPayment(db, row.opom_account_id, id, row.id);
  updateCryptoPayment(db, row.opom_account_id, 'credited', {purchaseStatus: 'verified', purchaseAmount: '150', balanceBefore: '-2', balanceAfter: '148', cryptoPaymentAmount: '155', cryptoPaymentAsset: 'USDC', cryptoNetworkFeeUsd: '0.2'});
  db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(id);
  db.prepare("UPDATE job_rows SET status='failed',stage='opom.writeback',purchase_status='verified',purchase_amount='150',balance_before='-2',balance_after='148',crypto_payment_amount='155',crypto_network_fee_amount='0.2' WHERE id=?").run(row.id);
  const preview = await resumePreview(db, id, {startRowNumber: 2});
  assert.equal(preview.canResume, false);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({url: String(url), body: JSON.parse(init.body)});
    return Response.json(String(url).endsWith('/callback') ? {data: {status: 'STORED', callbackId: 'callback-fixture', providerEventId: JSON.parse(init.body).providerEventId}} : {ok: true});
  });
  const repaired = await repairOpomWriteback(db, id, {rowNumber: 2});
  assert.equal(repaired.rows[0].status, 'completed');
  assert.equal(getCryptoPayment(db, row.opom_account_id).phase, 'completed');
  assert.equal(calls.length, 2);
  assert.equal(calls.shift().body.PaidAmount, '155');
  assert.match(calls[0].url, /\/results$/);
  assert.equal(calls[0].body.balanceBeforeUsd, -2);
  assert.equal(calls[0].body.card, undefined);
  assert.equal(calls[0].body.adsPower.userId, 'profile1');
  assert.match(readFileSync(getJob(db, id).result_csv_path, 'utf8'), /155/);
});

test('crypto writeback rejects HTTP-200 failure and never strips negative balance', async (t) => {
  const details = {purchaseStatus: 'verified', purchaseAmount: '150', balanceBefore: '-2', balanceAfter: '148', cryptoPaymentAmount: '155', cryptoPaymentAsset: 'USDC', cryptoNetworkFeeUsd: '0.2'};
  const callbackPayload = buildCryptoCallbackPayload({opom_account_id: 'account'}, details, {idempotencyKey: 'event', providerEventId: 'event', occurredAt: '2026-10-15T10:00:00Z'});
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return Response.json(String(_url).endsWith('/callback') ? {data: {status: 'STORED', callbackId: 'cb', providerEventId: 'event'}} : {success: false});
  });
  await assert.rejects(writeCryptoCompletedRow({...options, runId: 'stable'}, {opom_account_id: 'account'}, details, {callbackPayload}), /unsuccessful/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].balanceBeforeUsd, -2);
});

for (const phase of ['credited', 'completed']) test(`restart restores ${phase} evidence before row persistence`, async (t) => {
  const {db, payload} = await fixture(t);
  const result = await createJob(db, payload);
  const id = result.job.id;
  const row = db.prepare('SELECT * FROM job_rows WHERE job_id=?').get(id);
  beginCryptoPayment(db, row.opom_account_id, id, row.id);
  updateCryptoPayment(db, row.opom_account_id, phase, {
    purchaseStatus: 'verified', purchaseAmount: '150', balanceBefore: '-2', balanceAfter: '148', cryptoPaymentAmount: '155', cryptoPaymentAsset: 'USDC', cryptoNetworkFeeUsd: '0.2',
  });
  db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);
  db.prepare("UPDATE job_rows SET status='running' WHERE id=?").run(row.id);
  recoverInterruptedWork(db);
  const recovered = db.prepare('SELECT * FROM job_rows WHERE id=?').get(row.id);
  assert.equal(recovered.status, phase === 'credited' ? 'failed' : 'completed');
  assert.equal(recovered.purchase_status, 'verified');
  assert.equal(recovered.balance_before, '-2');
  assert.equal(recovered.crypto_payment_amount, '155');
  if (phase === 'credited') {
    let writes = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => { writes++; return Response.json(String(url).endsWith('/callback') ? {data: {status: 'STORED', callbackId: 'cb', providerEventId: JSON.parse(init.body).providerEventId}} : {ok: true}); });
    await repairOpomWriteback(db, id, {rowNumber: 2});
    assert.equal(writes, 2);
    assert.equal(getJob(db, id).status, 'completed');
  }
});

test('dispatch rechecks plan cancellation after asynchronous job preparation', async (t) => {
  const {db, payload} = await fixture(t, {cryptoScheduled: true});
  await assert.rejects(createJob(db, {...payload, shouldDispatch: () => false}), /plan changed/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
});
