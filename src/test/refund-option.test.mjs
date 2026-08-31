import assert from 'node:assert/strict';
import test from 'node:test';

import {executeRowWithAdapters, parsePlan, runnerArgs} from '../server/automation-adapter.mjs';
import {buildClosedLoopTask} from '../automation/lib/recharge-plan.mjs';

const REFUND_CSV = `status,login_email,ads_power_user_id,opom_card_status
,refund-test@example.com,profile-refund,INACTIVE
`;

const REFUND_OPTIONS = {
  refundOnly: true,
  scopeBillingAddress: false,
  scopePaymentMethod: false,
  scopePurchase: false,
  scopeAutoTopup: false,
  skipAdsPowerMatch: true,
  opomWriteback: false,
};

test('refund is explicit, default-off, and can be the only execution scope', async () => {
  assert.equal(runnerArgs({}).refundOnly, false);
  assert.equal(runnerArgs(REFUND_OPTIONS).refundOnly, true);

  const parsed = await parsePlan(REFUND_CSV, REFUND_OPTIONS);
  assert.equal(parsed.rows[0].status, 'ready');
  assert.equal(parsed.rows[0].executionScope, 'refund');

  const task = buildClosedLoopTask({
    login_email: 'refund-test@example.com',
    ads_power_user_id: 'profile-refund',
  }, runnerArgs(REFUND_OPTIONS));
  assert.equal(task.refundOnly, true);
  assert.equal(task.purchase.confirmed, false);
  assert.equal(task.autoTopup.enabled, false);
  assert.equal(task.card.number, '');
});

test('refund cannot be combined with recharge scopes', async () => {
  const parsed = await parsePlan(REFUND_CSV, {
    ...REFUND_OPTIONS,
    scopePurchase: true,
    confirmPurchase: true,
  });
  assert.equal(parsed.rows[0].status, 'missing_fields');
  assert.ok(parsed.rows[0].missing.includes('execution_scope:refund_must_run_alone'));
});

test('refund-only bypasses OPOM card status and requires verified refund results', async () => {
  let stopped = false;
  const result = await executeRowWithAdapters(REFUND_CSV, 0, REFUND_OPTIONS, {
    runClosedLoopChildAsync: async (_bindScript, task) => {
      assert.equal(task.refundOnly, true);
      return {
        ok: true,
        result: {
          ok: true,
          status: 'refund_completed',
          refund: {verified: true, status: 'refunded', refundableCount: 2, refundedCount: 2},
          paymentMethodAction: 'refunded_2_transactions',
        },
      };
    },
    adspower: {
      stopProfile: async () => {
        stopped = true;
        return {attempted: true, ok: true};
      },
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.stage, 'closed_loop.complete');
  assert.equal(result.details.paymentMethodAction, 'refunded_2_transactions');
  assert.equal(result.details.purchaseStatus, 'skipped');
  assert.equal(result.details.autoTopupStatus, 'skipped');
  assert.equal(stopped, true);
});

test('refund-only does not complete without browser verification', async () => {
  const result = await executeRowWithAdapters(REFUND_CSV, 0, REFUND_OPTIONS, {
    runClosedLoopChildAsync: async () => ({
      ok: true,
      result: {ok: true, refund: {verified: false, refundedCount: 1}},
    }),
    adspower: {
      stopProfile: async () => ({attempted: true, ok: true}),
    },
  });

  assert.equal(result.status, 'purchase_unverified');
  assert.equal(result.stage, 'scope.verify');
});
