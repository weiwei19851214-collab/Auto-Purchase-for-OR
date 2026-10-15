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

test('risk warning always blocks automatic continuation and preserves browser state', async () => {
  for (const confirmed of [false, true]) {
    await assert.rejects(continueOkxRiskWarning({confirmWalletPayment: confirmed}, {}, {}, {
      targets() { assert.fail('must not inspect or mutate browser'); },
    }), /manual_security_blocker: crypto_wallet_risk_warning_requires_manual_review/);
  }
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
