import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {readCryptoAccountPassword} from '../automation/lib/crypto-account-password.mjs';
import {fillCryptoVerificationPassword, continueCryptoVerification, cryptoPasswordRejected} from '../automation/crypto_recharge_openrouter_cdp.mjs';
import {classifyError} from '../automation/lib/status-contract.mjs';
import {matchAdsPowerPayload} from '../server/adspower-match.mjs';

const account = {profileId: 'profile1', expectedAccount: 'fixture@example.com'};
const options = {adspowerApiBase: 'http://fixture.local'};
const reply = (profiles) => async () => ({ok: true, json: async () => ({code: 0, data: {list: profiles}})});

test('Continue is scoped to the OpenRouter password dialog and never retries other controls', async () => {
  for (const valid of [true, false]) {
    let clicks = 0;
    const button = {innerText: valid ? 'Continue' : 'Confirm', disabled: false,
      getAttribute: () => null, getBoundingClientRect: () => ({width: 100, height: 40}), click: () => {clicks += 1;}};
    const dialog = {innerText: 'Verification required Enter your current password',
      getBoundingClientRect: button.getBoundingClientRect, querySelectorAll: () => [button]};
    const page = {async send(method, params) {
      assert.equal(method, 'Runtime.evaluate');
      return {result: {value: runInNewContext(params.expression, {
        location: {origin: 'https://openrouter.ai', pathname: '/settings/credits'},
        document: {querySelectorAll: () => [dialog]},
      })}};
    }};
    if (valid) assert.deepEqual(await continueCryptoVerification(page), {clicked: true});
    else await assert.rejects(continueCryptoVerification(page), /continue_unavailable/);
    assert.equal(clicks, valid ? 1 : 0);
  }
});

test('Invalid credentials in the visible Credits password dialog stops after one Continue', async () => {
  let clicks = 0;
  const dialog = {
    innerText: 'Verification required Enter your current password',
    getBoundingClientRect: () => ({width: 360, height: 300}),
    querySelectorAll: () => [button],
  };
  const button = {innerText: 'Continue', disabled: false, getAttribute: () => null,
    getBoundingClientRect: () => ({width: 200, height: 40}),
    click() { clicks += 1; dialog.innerText += ' Invalid credentials'; }};
  const page = {async send(method, params) {
    assert.equal(method, 'Runtime.evaluate');
    return {result: {value: runInNewContext(params.expression, {
      location: {origin: 'https://openrouter.ai', pathname: '/settings/credits'},
      document: {querySelectorAll: () => [dialog]},
    })}};
  }};
  assert.equal(await cryptoPasswordRejected(page), false);
  assert.deepEqual(await continueCryptoVerification(page), {clicked: true});
  assert.equal(await cryptoPasswordRejected(page), true);
  const error = classifyError('manual_security_blocker: crypto_password_invalid_credentials');
  assert.equal(error.status, 'manual_security_blocker');
  assert.equal(error.stage, 'crypto.password_verification');
  assert.equal(error.safeToContinueBatch, false);
  assert.equal(error.stopProfile, false);
  assert.equal(clicks, 1);
  const source = readFileSync(new URL('../automation/crypto_recharge_openrouter_cdp.mjs', import.meta.url), 'utf8');
  const checkout = source.slice(source.indexOf('async function openCheckout('), source.indexOf('async function selectOkxWallet('));
  assert.ok(checkout.indexOf('cryptoPasswordRejected(page)') < checkout.indexOf('const targets = getTargets(input.debugPort)'));
  assert.ok(checkout.includes('if (verification && verificationSubmitted)'));
});

test('password rejection is scoped to a visible OpenRouter dialog', async () => {
  for (const origin of ['https://other.example', 'https://openrouter.ai']) {
    const dialog = {innerText: 'Verification required Enter your current password Invalid credentials',
      getBoundingClientRect: () => ({width: 0, height: 0})};
    const page = {async send(_method, params) {
      return {result: {value: runInNewContext(params.expression, {
        location: {origin, pathname: '/settings/credits'}, document: {querySelectorAll: () => [dialog]},
      })}};
    }};
    assert.equal(await cryptoPasswordRejected(page), false);
  }
});

test('crypto password is bound to exact AdsPower id and platform username, never remark or proxy password', async () => {
  const secret = randomUUID();
  const valid = {user_id: 'profile1', username: account.expectedAccount, password: secret};
  assert.equal(await readCryptoAccountPassword(options, account, reply([valid])), secret);
  for (const profiles of [[], [valid, valid], [{...valid, user_id: 'other'}], [{...valid, username: 'other@example.com', remark: account.expectedAccount}]]) {
    await assert.rejects(readCryptoAccountPassword(options, account, reply(profiles)), /identity_unverified/);
  }
  for (const password of [undefined, '', '******', '••••••']) {
    await assert.rejects(readCryptoAccountPassword(options, account, reply([{...valid, password, proxy_config: {proxy_password: secret}}])), /password_unavailable/);
  }
  await assert.rejects(readCryptoAccountPassword(options, account, async () => { throw new Error(secret); }), (error) => !error.message.includes(secret));
});

test('only an explicit crypto page request returns plaintext; scheduler and bank matching do not', async (t) => {
  const secret = randomUUID();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return reply([{user_id: 'profile1', username: account.expectedAccount, password: secret}])();
  });
  for (const [rechargeMode, includeAccountPassword] of [['bank_card', false], ['bank_card', true], ['crypto', false], ['crypto', true]]) {
    calls = 0;
    const result = await matchAdsPowerPayload({includeAccountPassword, rows: [{loginEmail: account.expectedAccount, ads_power_user_id: account.profileId}], options: {...options, rechargeMode}});
    assert.equal(result.matched, 1);
    assert.equal(result.results[0].passwordStatus, rechargeMode === 'crypto' ? 'available' : undefined);
    assert.equal(calls, 1);
    assert.equal(result.results[0].accountPassword, rechargeMode === 'crypto' && includeAccountPassword ? secret : undefined);
    assert.equal(JSON.stringify(result).includes(secret), rechargeMode === 'crypto' && includeAccountPassword);
  }
});

test('crypto email scan gets password without a second query', async (t) => {
  let calls = 0;
  const secret = randomUUID();
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return reply([{user_id: 'profile1', username: account.expectedAccount, password: secret}])();
  });
  const result = await matchAdsPowerPayload({rows: [{loginEmail: account.expectedAccount}], options: {...options, rechargeMode: 'crypto'}, includeAccountPassword: true});
  assert.equal(calls, 1);
  assert.equal(result.results[0].accountPassword === secret, true);
});

test('crypto plaintext display is identity-bound, escaped and excluded from task rows and CSV', () => {
  const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
  const extract = (name) => {
    const start = source.indexOf('  function ' + name + '(');
    assert.ok(start >= 0);
    return source.slice(start, source.indexOf('\n  }', start) + 4);
  };
  const context = {state: {rechargeMode: 'crypto'}, cryptoPasswords: new Map()};
  runInNewContext(extract('cryptoPasswordKey') + extract('cryptoPasswordText') + extract('escapeHtml'), context);
  const secret = randomUUID() + '<>&"';
  const row = {ads_power_user_id: 'profile1', login_email: account.expectedAccount, crypto_password_status: 'available'};
  context.cryptoPasswords.set(context.cryptoPasswordKey(row), secret);
  assert.equal(context.cryptoPasswordText(row), secret);
  assert.equal(context.cryptoPasswordText({...row, ads_power_user_id: 'other'}), '待重新匹配');
  assert.equal(context.cryptoPasswordText({...row, login_email: 'other@example.com'}), '待重新匹配');
  assert.ok(context.escapeHtml(context.cryptoPasswordText(row)).endsWith('&lt;&gt;&amp;&quot;'));
  assert.equal(JSON.stringify(row).includes(secret), false);
  context.state.rechargeMode = 'bank_card';
  assert.equal(context.cryptoPasswordText(row), '');
  const header = source.slice(source.indexOf('const CANONICAL_HEADER'), source.indexOf('const CONFIG_FIELDS'));
  assert.equal(/accountPassword|crypto_password|cryptoPasswords/.test(header), false);
  assert.equal(source.includes('escapeHtml(cryptoPasswordText(row))'), true);
  context.cryptoPasswords.clear();
  context.state.rechargeMode = 'crypto';
  assert.equal(context.cryptoPasswordText(row), '待重新匹配');
});

function verificationPage({origin = 'https://openrouter.ai', email = account.expectedAccount, title = 'Verification required Enter your current password'} = {}) {
  const events = [];
  let cursor = 0;
  const field = {
    value: '', disabled: false, marked: false,
    getBoundingClientRect: () => ({width: 300, height: 40}),
    setAttribute() { this.marked = true; }, removeAttribute() { this.marked = false; },
    focus() { document.activeElement = this; },
  };
  const dialog = {innerText: title, getBoundingClientRect: field.getBoundingClientRect, querySelectorAll: () => [field]};
  const document = {
    body: {innerText: email}, activeElement: null,
    querySelectorAll: () => [dialog], querySelector: () => field.marked ? field : null,
  };
  const page = {async send(method, params) {
    if (method === 'Runtime.evaluate') return {result: {value: runInNewContext(params.expression, {document, location: {origin, pathname: '/settings/credits'}})}};
    assert.equal(method, 'Input.dispatchKeyEvent');
    events.push(params);
    if (params.type === 'rawKeyDown') {
      if (params.key === 'End') cursor = field.value.length;
      if (params.key === 'Backspace' && cursor > 0) {field.value = field.value.slice(0, --cursor);}
      if (params.key === 'Tab') document.activeElement = null;
    }
    if (params.type === 'char') {field.value += params.text; cursor += params.text.length;}
    return {};
  }};
  return {page, field, events};
}

test('crypto verification types symbols once, blurs and returns no password without submitting Continue', async () => {
  const secret = randomUUID() + '!@#Aa.';
  const {page, field, events} = verificationPage();
  const result = await fillCryptoVerificationPassword(account, page, async () => secret);
  assert.deepEqual(result, {filled: true});
  assert.equal(field.value, secret);
  assert.equal(field.marked, false);
  assert.equal(events.filter((event) => event.text).map((event) => event.text).join(''), secret);
  assert.equal(events.some((event) => event.key === 'Enter'), false);
});

test('crypto refuses other origins, accounts or verification methods before reading any password', async () => {
  for (const options of [{origin: 'https://other.example'}, {email: 'other@example.com'}, {title: 'Enter verification code'}]) {
    let requested = false;
    const {page} = verificationPage(options);
    await assert.rejects(fillCryptoVerificationPassword(account, page, async () => {requested = true; return randomUUID();}), /identity_unverified/);
    assert.equal(requested, false);
  }
});

test('crypto password failures are sanitized and preserve browser for human verification', async () => {
  const secret = randomUUID();
  await assert.rejects(fillCryptoVerificationPassword(account, verificationPage().page, async () => {throw new Error(secret);}), (error) => {
    assert.equal(error.message.includes(secret), false);
    const result = classifyError(error.message);
    assert.equal(result.status, 'manual_security_blocker');
    assert.equal(result.stopProfile, false);
    assert.equal(result.safeToContinueBatch, false);
    return true;
  });
});
