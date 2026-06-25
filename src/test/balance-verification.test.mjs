import assert from 'node:assert/strict';
import test from 'node:test';
import {isRechargeBalanceIncreaseVerified} from '../automation/lib/balance-verification.mjs';
import {readFileSync} from 'node:fs';

test('recharge balance verification accepts any net balance increase', () => {
  assert.equal(isRechargeBalanceIncreaseVerified(20, 40), true);
});

test('recharge balance verification rejects flat or lower balances', () => {
  assert.equal(isRechargeBalanceIncreaseVerified(20, 20), false);
  assert.equal(isRechargeBalanceIncreaseVerified(20, 19.99), false);
});

test('recharge balance verification rejects missing numeric values', () => {
  assert.equal(isRechargeBalanceIncreaseVerified(Number.NaN, 40), false);
  assert.equal(isRechargeBalanceIncreaseVerified(20, Number.NaN), false);
});

test('purchase verification can fall back to recent transaction amount evidence', () => {
  const source = readFileSync(new URL('../automation/bind_openrouter_card_cdp.mjs', import.meta.url), 'utf8');
  assert.match(source, /verificationRule: 'recent_transaction_amount'/);
  assert.match(source, /Recent Transactions\|History/);
});

test('Stripe Link opt-in cleanup accepts absent checkbox as inactive', () => {
  const source = readFileSync(new URL('../automation/bind_openrouter_card_cdp.mjs', import.meta.url), 'utf8');
  assert.match(source, /lastState\.found === false \|\| lastState\.checked === false/);
});

test('Stripe card entry skips Link checkbox cleanup after switching a non-US country to United States', () => {
  const source = readFileSync(new URL('../automation/bind_openrouter_card_cdp.mjs', import.meta.url), 'utf8');
  assert.match(source, /changedFromNonUs/);
  assert.match(source, /country_changed_to_united_states_before_save/);
  assert.match(source, /: await ensureStripeLinkUnchecked\(payment\)/);
});

test('CDP navigation has retry and location fallback for slow AdsPower pages', () => {
  const source = readFileSync(new URL('../automation/bind_openrouter_card_cdp.mjs', import.meta.url), 'utf8');
  assert.match(source, /DEFAULT_NAVIGATION_COMMAND_TIMEOUT_MS = 60000/);
  assert.match(source, /DEFAULT_NAVIGATION_RETRIES = 3/);
  assert.match(source, /Page\.stopLoading/);
  assert.match(source, /location\.href =/);
});
