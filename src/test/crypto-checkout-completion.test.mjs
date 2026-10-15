import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readCheckoutState} from '../automation/crypto_recharge_openrouter_cdp.mjs';

const successfulText = 'Your payment of 10.50 USDC was successful';
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
