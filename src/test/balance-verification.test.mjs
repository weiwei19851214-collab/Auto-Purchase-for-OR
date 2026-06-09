import assert from 'node:assert/strict';
import test from 'node:test';
import {isRechargeBalanceIncreaseVerified} from '../automation/lib/balance-verification.mjs';

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
