import assert from 'node:assert/strict';
import test from 'node:test';

import {executeRowWithAdapters, parsePlan, runnerArgs} from '../server/automation-adapter.mjs';
import {buildClosedLoopTask} from '../automation/lib/recharge-plan.mjs';

const DATA_TRAINING_CSV = `status,login_email,ads_power_user_id,opom_card_status
,training-test@example.com,profile-training,INACTIVE
`;

const DATA_TRAINING_OPTIONS = {
  enableDataTraining: true,
  scopeBillingAddress: false,
  scopePaymentMethod: false,
  scopePurchase: false,
  scopeAutoTopup: false,
  skipAdsPowerMatch: true,
  opomWriteback: false,
};

test('Data Training is explicit, default-off, and can be the only execution scope', async () => {
  assert.equal(runnerArgs({}).enableDataTraining, false);
  assert.equal(runnerArgs(DATA_TRAINING_OPTIONS).enableDataTraining, true);

  const parsed = await parsePlan(DATA_TRAINING_CSV, DATA_TRAINING_OPTIONS);
  assert.equal(parsed.rows[0].status, 'ready');
  assert.equal(parsed.rows[0].executionScope, 'data_training');

  const task = buildClosedLoopTask({
    login_email: 'training-test@example.com',
    ads_power_user_id: 'profile-training',
  }, runnerArgs(DATA_TRAINING_OPTIONS));
  assert.equal(task.enableDataTraining, true);
  assert.equal(task.dataTrainingOnly, true);
  assert.equal(task.purchase.confirmed, false);
  assert.equal(task.autoTopup.enabled, false);
});

test('Data Training cannot be combined with recharge scopes', async () => {
  const parsed = await parsePlan(DATA_TRAINING_CSV, {
    ...DATA_TRAINING_OPTIONS,
    scopePurchase: true,
    confirmPurchase: true,
  });
  assert.equal(parsed.rows[0].status, 'missing_fields');
  assert.ok(parsed.rows[0].missing.includes('execution_scope:data_training_must_run_alone'));
});

test('Data Training-only bypasses OPOM card status and requires verified switch results', async () => {
  const result = await executeRowWithAdapters(DATA_TRAINING_CSV, 0, DATA_TRAINING_OPTIONS, {
    runClosedLoopChildAsync: async (_bindScript, task) => {
      assert.equal(task.dataTrainingOnly, true);
      assert.equal(task.card.number, '');
      return {
        ok: true,
        result: {
          ok: true,
          status: 'data_training_enabled',
          dataTraining: {configured: true, status: 'enabled', changed: true},
        },
      };
    },
    adspower: {
      stopProfile: async () => ({attempted: true, ok: true}),
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.stage, 'closed_loop.complete');
  assert.equal(result.details.dataTrainingStatus, 'enabled');
  assert.equal(result.details.dataTrainingChanged, 'true');
  assert.equal(result.details.purchaseStatus, 'skipped');
  assert.equal(result.details.autoTopupStatus, 'skipped');
});

test('Data Training-only does not complete when browser verification is missing', async () => {
  const result = await executeRowWithAdapters(DATA_TRAINING_CSV, 0, DATA_TRAINING_OPTIONS, {
    runClosedLoopChildAsync: async () => ({
      ok: true,
      result: {ok: true, dataTraining: {configured: false, status: 'not_configured'}},
    }),
    adspower: {
      stopProfile: async () => ({attempted: true, ok: true}),
    },
  });

  assert.equal(result.status, 'purchase_unverified');
  assert.equal(result.stage, 'scope.verify');
  assert.equal(result.details.dataTrainingStatus, 'not_configured');
});
