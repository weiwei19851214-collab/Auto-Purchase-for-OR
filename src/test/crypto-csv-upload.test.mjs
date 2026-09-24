import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {parsePlan} from '../server/automation-adapter.mjs';

const appSource = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
const phrase = Array(12).fill('notawalletword').join(' ');
const header = 'login_email,ads_power_serial_number,ads_power_user_id,seed_phrase';
const csvLines = (...lines) => lines.join(String.fromCharCode(10));

function clientCsvFunctions() {
  const signatures = ['parseCsv', 'csvEscape', 'looseKey', 'valueFrom', 'objectFromRow', 'hasSelectorHeader',
    'noHeaderObject', 'normalizeSourceRow', 'rowsFromCsv'];
  const code = signatures.map((name) => {
    const start = appSource.indexOf('  function ' + name + '(');
    assert.ok(start >= 0, name);
    return appSource.slice(start, appSource.indexOf(String.fromCharCode(10) + '  }', start) + 4);
  }).join(String.fromCharCode(10));
  const context = {CANONICAL_HEADER: ['status', 'login_email', 'ads_power_serial_number', 'ads_power_user_id', 'recharge_mode']};
  runInNewContext(code, context);
  return context;
}

test('crypto CSV strips the phrase before creating normalized task rows', () => {
  const {rowsFromCsv} = clientCsvFunctions();
  const seeds = new Map();
  const rows = rowsFromCsv(csvLines(header, 'user@example.com,1234,abcd1234,' + phrase), true, seeds);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].login_email, 'user@example.com');
  assert.equal(rows[0].ads_power_serial_number, '1234');
  assert.equal(rows[0].ads_power_user_id, 'abcd1234');
  assert.equal(JSON.stringify(rows).includes(phrase), false);
  assert.equal('seed_phrase' in rows[0], false);
  assert.equal(seeds.get('user@example.com'), phrase);
});

test('crypto CSV requires headers, twelve words, and unique accounts', () => {
  const {rowsFromCsv} = clientCsvFunctions();
  assert.throws(() => rowsFromCsv(csvLines('login_email,ads_power_user_id', 'user@example.com,abcd1234'), true), /表头/);
  assert.throws(() => rowsFromCsv(csvLines(header + ',extra', 'user@example.com,1234,abcd1234,' + phrase + ',x'), true), /表头/);
  assert.throws(() => rowsFromCsv(csvLines(header, 'user@example.com,1234,abcd1234,short'), true), /第 2 行 seed_phrase/);
  assert.throws(() => rowsFromCsv(csvLines(header, 'user@example.com,1234,abcd1234,' + phrase,
    'user@example.com,5678,efgh5678,' + phrase), true), /账号或 AdsPower 浏览器重复/);
  assert.throws(() => rowsFromCsv(csvLines(header, 'user@example.com,1234,abcd1234,' + phrase,
    'other@example.com,1234,abcd1234,' + phrase), true), /账号或 AdsPower 浏览器重复/);
  assert.throws(() => rowsFromCsv(csvLines(header, 'user@example.com,1234,abcd1234,' + phrase,
    'other@example.com,1234,efgh5678,' + phrase), true), /账号或 AdsPower 浏览器重复/);
  assert.throws(() => rowsFromCsv(csvLines(header, ',1234,abcd1234,' + phrase), true), /缺少邮箱/);
});

test('bank card selector CSV retains its existing header contract', () => {
  const {rowsFromCsv} = clientCsvFunctions();
  assert.equal(rowsFromCsv(csvLines('login_email,ads_power_user_id', 'user@example.com,abcd1234')).length, 1);
});

test('server refuses raw seed_phrase before a job can persist the CSV', async () => {
  await assert.rejects(parsePlan(csvLines(header, 'user@example.com,1234,abcd1234,' + phrase), {
    rechargeMode: 'crypto', scopeBillingAddress: false, scopePaymentMethod: false,
    scopePurchase: true, scopeAutoTopup: false, confirmPurchase: false,
  }), (error) => error.message.includes('seed_phrase') && !error.message.includes(phrase));
});

test('sanitized crypto CSV still reaches the existing recharge dry-run', async () => {
  const {rowsFromCsv} = clientCsvFunctions();
  const [row] = rowsFromCsv(csvLines(header, 'user@example.com,1234,abcd1234,' + phrase), true);
  const taskHeader = ['status', 'login_email', 'ads_power_serial_number', 'ads_power_user_id',
    'balance_threshold', 'amount_below_threshold', 'amount_at_or_above_threshold'];
  const taskCsv = csvLines(taskHeader.join(','), taskHeader.map((key) => ({
    ...row, balance_threshold: '145', amount_below_threshold: '150', amount_at_or_above_threshold: '20',
  })[key] || '').join(','));
  assert.equal(taskCsv.includes(phrase), false);
  const result = await parsePlan(taskCsv, {
    rechargeMode: 'crypto', scopeBillingAddress: false, scopePaymentMethod: false,
    scopePurchase: true, scopeAutoTopup: false, confirmPurchase: false, skipAdsPowerMatch: true,
  });
  assert.equal(result.rows[0].status, 'ready');
  assert.equal(result.args.rechargeMode, 'crypto');
});
