import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeRowWithAdapters, publicRow, runClosedLoopChildAsync, writeResultCsv} from '../server/automation-adapter.mjs';
import {CRYPTO_AMOUNT_FIELDS, cryptoAmountsFromResult, cryptoAmountsWithCheckpoint, beginCryptoAccountingAttempt} from '../automation/lib/crypto-amount-fields.mjs';
import {runClosedLoopChild, parseChildJson} from '../automation/lib/child-runner.mjs';
import * as csv from '../automation/lib/csv.mjs';

const INPUT = 'status,ID,username,amount\n,1415,user@example.com,10\n';
const OPTIONS = {rechargeMode: 'crypto', cryptoRechargeRuleMode: 'fixed_amount', cryptoFixedAmount: '10', stopProfiles: false,
  scopePaymentMethod: false, scopeBillingAddress: false, scopeAutoTopup: false};
const AMOUNTS = {
  cryptoCreditAmount: '10', cryptoPaymentAmount: '10.50', cryptoPaymentAsset: 'USDC',
  cryptoPaymentAmountSource: 'coinbase_total', cryptoNetworkFeeAmount: '0.00000001',
  cryptoNetworkFeeAsset: 'ETH', cryptoNetworkFeeUsd: '0.01',
  cryptoNetworkFeeDisplay: '<$0.01', cryptoNetworkFeeStatus: 'observed', cryptoNetworkFeeSource: 'okx',
};

async function execute(outcome, extra = {}) {
  return executeRowWithAdapters(INPUT, 0, {...OPTIONS, ...extra}, {
    runClosedLoopChildAsync: async () => outcome,
    opom: {writeRowResult: async (_args, _row, details) => {
      assert.equal(details.cryptoPaymentAmount, undefined, 'local fields must not reach OPOM');
    }},
  });
}

test('crypto completed and incomplete outcomes keep observed financials, preserving credit amount semantics', async () => {
  for (const completed of [true, false]) {
    const result = await execute({ok: true, result: {cryptoPurchase: {
      amount: '10', financials: AMOUNTS, paymentCompleted: completed,
      walletPaymentConfirmation: {confirmed: completed},
    }}});
    assert.equal(result.details.purchaseAmount, '10');
    for (const [key, value] of Object.entries(AMOUNTS)) assert.equal(result.details[key], value);
    assert.equal(result.status, completed ? 'completed' : 'purchase_unverified');
  }
});

test('crypto failure retains partial local financials without deriving payment from credit or forwarding secrets', async () => {
  const result = await execute({ok: false, error: 'crypto_wallet_transaction_page_unverified', result: {
    cryptoAmounts: {cryptoCreditAmount: '10', cryptoNetworkFeeAmount: 0, secret: 'discard-me'},
  }}, {opomWriteback: true});
  assert.equal(result.details.cryptoCreditAmount, '10');
  assert.equal(result.details.cryptoNetworkFeeAmount, '0');
  assert.equal(result.details.cryptoPaymentAmount, undefined);
  assert.equal(result.details.secret, undefined);
});

test('CSV and public row expose all local accounting values as exact strings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypto-accounting-csv-'));
  try {
    const csvPath = join(dir, 'input.csv');
    const resultCsvPath = join(dir, 'result.csv');
    writeFileSync(csvPath, INPUT);
    await writeResultCsv({csvPath, resultCsvPath, rowsByRawIndex: [{rawIndex: 0, status: 'failed', details: AMOUNTS}]});
    const [header, values] = csv.parseCsv(readFileSync(resultCsvPath, 'utf8'));
    const row = csv.rowObject(header, values);
    const apiRow = publicRow({...row, row_number: 2});
    for (const [key, column] of Object.entries(CRYPTO_AMOUNT_FIELDS)) {
      assert.equal(row[column], AMOUNTS[key]);
      assert.equal(apiRow[key], AMOUNTS[key]);
    }
    assert.equal(publicRow({row_number: 2, crypto_network_fee_usd: 0}).cryptoNetworkFeeUsd, 0);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('child failure propagates only whitelisted accounting fields from both result contracts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypto-accounting-child-'));
  try {
    const script = join(dir, 'fake.mjs');
    writeFileSync(script, `process.stdin.resume(); process.stdin.on('end', () => { console.log(JSON.stringify(${JSON.stringify({
      ok: false, error: 'synthetic failure', password: 'not-forwarded',
      cryptoPurchase: {financials: {...AMOUNTS, seed_phrase: 'not-forwarded'}},
      cryptoAmounts: {cryptoNetworkFeeUsd: 0, session: 'not-forwarded'},
    })})); process.exitCode = 1; });`);
    const result = await runClosedLoopChildAsync(script, {}, {...OPTIONS, rowTimeoutMs: 5000}, {
      parseChildJson: (stdout) => JSON.parse(stdout),
    }, {redact: (value) => value});
    assert.equal(result.ok, false);
    assert.deepEqual(result.result, {cryptoAmounts: {...AMOUNTS, cryptoNetworkFeeUsd: '0'}});
    assert.equal(JSON.stringify(result.result).includes('not-forwarded'), false);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('accounting whitelist rejects object and non-finite inputs without inventing defaults', () => {
  assert.deepEqual(cryptoAmountsFromResult({cryptoAmounts: {
    cryptoPaymentAmount: NaN, cryptoNetworkFeeAmount: {value: 1}, password: 'discard',
  }}), {});
});

test('checkpoint uses only the exact task directory and nonempty parsed values override observations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypto-accounting-checkpoint-'));
  try {
    writeFileSync(join(dir, 'crypto-financials.json'), JSON.stringify({cryptoAmounts: {...AMOUNTS, password: 'discard'}, cookie: 'discard'}));
    const observed = cryptoAmountsWithCheckpoint({confirmationDebugDir: dir}, {cryptoAmounts: {
      cryptoPaymentAmount: '', cryptoNetworkFeeUsd: 0, session: 'discard',
    }});
    assert.deepEqual(observed, {...AMOUNTS, cryptoNetworkFeeUsd: '0'});
    assert.deepEqual(cryptoAmountsWithCheckpoint({}), {});
    writeFileSync(join(dir, 'crypto-financials.json'), '{');
    assert.deepEqual(cryptoAmountsWithCheckpoint({confirmationDebugDir: dir}), {});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('async and sync killed children retain observed checkpoint values without arbitrary JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypto-accounting-timeout-'));
  try {
    const script = join(dir, 'fake-timeout.mjs');
    writeFileSync(script, `import {writeFileSync} from 'node:fs';
      let input = ''; process.stdin.on('data', chunk => {input += chunk}); process.stdin.on('end', () => {
        writeFileSync(${JSON.stringify(join(dir, 'crypto-financials.json'))}, JSON.stringify({...${JSON.stringify({cryptoAmounts: {...AMOUNTS, seed_phrase: 'discard'}, cookie: 'discard'})}, attemptId: JSON.parse(input).cryptoAccountingAttemptId}));
        setInterval(() => {}, 1000);
      });`);
    const task = {confirmationDebugDir: dir};
    const args = {...OPTIONS, rowTimeoutMs: 300};
    const asyncResult = await runClosedLoopChildAsync(script, task, args, {parseChildJson}, {redact: (value) => value});
    const syncResult = runClosedLoopChild(script, task, args);
    for (const result of [asyncResult, syncResult]) {
      assert.equal(result.ok, false);
      assert.match(result.error, /timed out/);
      assert.deepEqual(result.result, {cryptoAmounts: AMOUNTS});
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('new crypto attempts reject previous checkpoints including early import failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypto-accounting-attempt-'));
  try {
    const path = join(dir, 'crypto-financials.json');
    const task = {confirmationDebugDir: dir};
    writeFileSync(path, JSON.stringify({attemptId: 'old', cryptoAmounts: AMOUNTS}));
    beginCryptoAccountingAttempt(task);
    assert.equal(typeof task.cryptoAccountingAttemptId, 'string');
    assert.deepEqual(cryptoAmountsWithCheckpoint(task), {});
    // Even if an old writer replaces the file after initialization, it cannot pass the new ID.
    writeFileSync(path, JSON.stringify({attemptId: 'old', cryptoAmounts: AMOUNTS}));
    assert.deepEqual(cryptoAmountsWithCheckpoint(task), {});
    writeFileSync(path, JSON.stringify({attemptId: task.cryptoAccountingAttemptId, cryptoAmounts: AMOUNTS}));
    assert.deepEqual(cryptoAmountsWithCheckpoint(task), AMOUNTS);

    const script = join(dir, 'fake-import-failure.mjs');
    writeFileSync(script, "import './missing-dependency.mjs';");
    const args = {...OPTIONS, rowTimeoutMs: 1000};
    for (const run of [
      (nextTask) => runClosedLoopChildAsync(script, nextTask, args, {parseChildJson}, {redact: value => value}),
      (nextTask) => runClosedLoopChild(script, nextTask, args),
    ]) {
      writeFileSync(path, JSON.stringify({attemptId: 'old', cryptoAmounts: AMOUNTS}));
      const nextTask = {confirmationDebugDir: dir};
      const result = await run(nextTask);
      assert.equal(result.ok, false);
      assert.deepEqual(result.result, {cryptoAmounts: {}});
      assert.notEqual(nextTask.cryptoAccountingAttemptId, task.cryptoAccountingAttemptId);
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('confirmed payment cannot become insufficient-funds retryable despite stale checkout text', async () => {
  const result = await execute({ok: true, result: {cryptoPurchase: {
    amount: '150', insufficientFunds: true, paymentNotSubmitted: true,
    checkoutState: {insufficientFunds: true}, walletPaymentConfirmation: {confirmed: true, confirmationClicked: true},
  }}});
  assert.equal(result.status, 'purchase_unverified');
  assert.equal(result.details.cryptoPaymentNotStarted, false);
  assert.equal(result.safeToContinue, false);
  assert.equal(result.stopProfile, false);
});
