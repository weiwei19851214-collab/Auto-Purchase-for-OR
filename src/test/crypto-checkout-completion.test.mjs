import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readCheckoutState, confirmOkxWalletPayment, continueOkxRiskWarning} from '../automation/crypto_recharge_openrouter_cdp.mjs';

const successfulText = 'Your payment of 10.50 USDC was successful';

test('risk continuation completes before the final Confirm and never retries the final click', async () => {
  const events = [];
  const wallet = {close() { events.push('close'); }};
  await confirmOkxWalletPayment({confirmWalletPayment: true}, '10.50', 'USDC', 'Arbitrum One', {}, {
    acquire: async () => ({wallet, state: {stage: 'risk_warning'}}),
    continueRisk: async () => {
      events.push('risk-resolved');
      return {wallet, state: {stage: 'confirm_send', hasAmount: true, hasNetwork: true, network: 'arbitrum one'}};
    },
    click: async (_wallet, stage, label) => { events.push(stage + ':' + label); },
    inspect: async () => ({stage: 'unknown'}),
  });
  assert.deepEqual(events, ['risk-resolved', 'confirm_send:Confirm', 'close']);
});

test('risk continuation without explicit wallet permission never inspects or clicks', async () => {
  await assert.rejects(continueOkxRiskWarning({}, {}, {}, {
    targets() { assert.fail('must not inspect browser'); },
  }), /confirmation_not_authorized/);
});

test('risk continuation rebinds a replaced popup and does not click its confirmation page', async () => {
  const closed = [];
  const old = {wallet: {close() { closed.push('old'); }}, target: {id: 'old'}};
  const replacement = {async send(method) { assert.equal(method, 'Runtime.enable'); }, close() { closed.push('new'); }};
  const target = {id: 'new', type: 'page', url: 'chrome-extension://mcohilncbfahbmgdjkbpemcciiolgcge/notification.html', webSocketDebuggerUrl: 'ws://new'};
  const result = await continueOkxRiskWarning({confirmWalletPayment: true}, old, {}, {
    targets: () => [target],
    connect: async url => { assert.equal(url, 'ws://new'); return replacement; },
    inspect: async () => ({stage: 'confirm_send', originOk: true, hasAmount: true, hasNetwork: true}),
  });
  assert.equal(result.wallet, replacement);
  assert.equal(result.state.targetId, 'new');
  assert.deepEqual(closed, ['old']);
});

test('diagnostic write failure preserves the blocker and closes a replacement wallet connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'risk-diagnostic-failure-'));
  const file = join(dir, 'file');
  writeFileSync(file, 'not a directory');
  const closed = [];
  try {
    const initial = {wallet: {close() { closed.push('old'); }}, target: {id: 'old'}};
    await assert.rejects(continueOkxRiskWarning({confirmWalletPayment: true, confirmationDebugDir: join(file, 'logs')}, initial, {}, {
      targets: () => [{id: 'new', type: 'page', url: 'chrome-extension://mcohilncbfahbmgdjkbpemcciiolgcge/notification.html', webSocketDebuggerUrl: 'ws://new'}],
      connect: async () => ({async send() { return {}; }, close() { closed.push('new'); }}),
      inspect: async () => ({stage: 'unknown', originOk: true}),
    }), error => {
      assert.match(error.message, /manual_security_blocker: crypto_wallet_transaction_page_changed/);
      assert.equal(error.evidenceFailures, 2);
      return true;
    });
    assert.deepEqual(closed, ['old', 'new']);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

function fixture(origin = 'https://payments.coinbase.com') {
  const state = {origin, pathname: '/payment-sessions/test', text: successfulText, reads: 0};
  const checkout = {async send(method, params) {
    assert.equal(method, 'Runtime.evaluate');
    state.reads++;
    return {result: {value: runInNewContext(params.expression, {
      document: {body: {innerText: state.text}}, location: state,
    })}};
  }};
  return {state, checkout};
}

test('actual Coinbase success wording is persisted before automatic redirect and reused afterward', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coinbase-evidence-'));
  try {
    const {state, checkout} = fixture();
    const completed = await readCheckoutState(checkout, {confirmationDebugDir: dir});
    assert.equal(completed.paymentCompleted, true);
    assert.equal(JSON.parse(readFileSync(join(dir, 'crypto-coinbase-payment-completed.json'), 'utf8')).paymentCompleted, true);
    state.origin = 'https://openrouter.ai';
    state.pathname = '/settings/credits';
    state.text = 'Credits';
    const afterRedirect = await readCheckoutState(checkout);
    assert.equal(afterRedirect, completed);
    assert.equal(state.reads, 1);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('same success wording on foreign origin does not verify payment', async () => {
  const {checkout} = fixture('https://example.test');
  assert.equal((await readCheckoutState(checkout, {timeoutMs: 1})).paymentCompleted, false);
});

test('Coinbase success wording outside payment session path does not verify payment', async () => {
  const {state, checkout} = fixture();
  state.pathname = '/unrelated';
  assert.equal((await readCheckoutState(checkout, {timeoutMs: 1})).paymentCompleted, false);
});

for (const scenario of ['timeout', 'failure', 'read_error']) {
  test(`payment verification records a safe final ${scenario} snapshot`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinbase-unverified-'));
    try {
      const {state, checkout} = fixture();
      state.text = scenario === 'failure' ? 'Insufficient funds SECRET 123456' : 'Processing SECRET 123456';
      const options = {timeoutMs: 1, requirePaymentCompleted: true, confirmationDebugDir: dir};
      if (scenario === 'read_error') {
        checkout.send = async () => { throw new Error('SECRET 123456'); };
        await assert.rejects(readCheckoutState(checkout, options), /^Error: purchase_unverified: Coinbase completion read unavailable$/);
      } else {
        const result = await readCheckoutState(checkout, options);
        assert.equal(result.paymentCompleted, false);
      }
      const raw = readFileSync(join(dir, 'crypto-coinbase-payment-unverified.json'), 'utf8');
      const saved = JSON.parse(raw);
      assert.equal(saved.reason, scenario);
      assert.equal(saved.paymentCompleted, false);
      assert.doesNotMatch(raw, /SECRET|123456/);
      if (scenario !== 'read_error') assert.equal(saved.url, 'https://payments.coinbase.com/payment-sessions/test');
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
}

test('already redirected Credits page cannot become completed without a Coinbase receipt', async () => {
  const {state, checkout} = fixture('https://openrouter.ai');
  state.pathname = '/settings/credits';
  state.text = 'TOTAL AVAILABLE $10.00';
  assert.equal((await readCheckoutState(checkout, {timeoutMs: 1, requirePaymentCompleted: true})).paymentCompleted, false);
});

for (const observationFails of [false, true]) {
  test(`Confirm is clicked once and observed read-only even when observation fails=${observationFails}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wallet-confirm-observation-'));
    let clicks = 0;
    let reads = 0;
    let closes = 0;
    try {
      const result = await confirmOkxWalletPayment({confirmationDebugDir: dir}, '10.50', 'USDC', 'Arbitrum One', {}, {
        acquire: async () => ({wallet: {close() { closes++; }}, state: {stage: 'confirm_send', network: 'Arbitrum One', hasAmount: true, hasNetwork: true}}),
        click: async () => { clicks++; },
        inspect: async () => {
          reads++;
          if (observationFails) throw new Error('SECRET 123456');
          return {stage: 'confirm_send', originOk: true, hasAmount: true, hasNetwork: true, buttonCount: 1, confirmationStep: 1, confirmationTotal: 2, text: 'SECRET 123456'};
        },
      });
      assert.equal(result.confirmationClicked, true);
      assert.equal(clicks, 1);
      assert.equal(reads, 1);
      assert.equal(closes, 1);
      const raw = readFileSync(join(dir, 'crypto-wallet-after-confirm-click.json'), 'utf8');
      const saved = JSON.parse(raw);
      assert.equal(saved.paymentCompleted, false);
      assert.equal(saved.confirmationClicked, true);
      assert.equal(saved.readError, observationFails);
      assert.equal(saved.observationTiming, 'immediate');
      assert.ok(Number.isFinite(Date.parse(saved.observedAt)));
      if (!observationFails) {
        assert.equal(saved.confirmationStep, 1);
        assert.equal(saved.confirmationTotal, 2);
      }
      assert.doesNotMatch(raw, /SECRET|123456/);
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
}
