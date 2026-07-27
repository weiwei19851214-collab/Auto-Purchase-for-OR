import assert from 'node:assert/strict';
import test from 'node:test';

import {executeRowWithAdapters, parsePlan, runnerArgs} from '../server/automation-adapter.mjs';
import {buildClosedLoopTask} from '../automation/lib/recharge-plan.mjs';

const ZDR_ONLY_CSV = `status,login_email,ads_power_user_id,opom_card_status
,zdr-test@example.com,profile-zdr,INACTIVE
`;

const ZDR_ONLY_OPTIONS = {
  disableZdr: true,
  scopeBillingAddress: false,
  scopePaymentMethod: false,
  scopePurchase: false,
  scopeAutoTopup: false,
  skipAdsPowerMatch: true,
  opomWriteback: false,
};

test('runnerArgs keeps ZDR opt-in and default-off', () => {
  assert.equal(runnerArgs({}).disableZdr, false);
  assert.equal(runnerArgs({}).enableZdr, false);
  assert.equal(runnerArgs({disableZdr: true}).disableZdr, true);
  assert.equal(runnerArgs({enableZdr: true}).enableZdr, true);
});

test('ZDR enable can be the only selected execution scope', async () => {
  const options = {...ZDR_ONLY_OPTIONS, disableZdr: false, enableZdr: true};
  const parsed = await parsePlan(ZDR_ONLY_CSV, options);
  assert.equal(parsed.rows[0].status, 'ready');
  assert.equal(parsed.rows[0].executionScope, 'zdr');

  const task = buildClosedLoopTask({
    status: '',
    login_email: 'zdr-test@example.com',
    ads_power_user_id: 'profile-zdr',
  }, runnerArgs(options));
  assert.equal(task.disableZdr, false);
  assert.equal(task.enableZdr, true);
  assert.equal(task.zdrOnly, true);
});

test('ZDR can be the only selected execution scope', async () => {
  const parsed = await parsePlan(ZDR_ONLY_CSV, ZDR_ONLY_OPTIONS);
  assert.equal(parsed.rows[0].status, 'ready');
  assert.equal(parsed.rows[0].executionScope, 'zdr');

  const task = buildClosedLoopTask({
    status: '',
    login_email: 'zdr-test@example.com',
    ads_power_user_id: 'profile-zdr',
  }, runnerArgs(ZDR_ONLY_OPTIONS));
  assert.equal(task.disableZdr, true);
  assert.equal(task.zdrOnly, true);
  assert.equal(task.purchase.confirmed, false);
  assert.equal(task.autoTopup.enabled, false);
});

test('ZDR enable-only completion accepts an enabled result without a balance read', async () => {
  const options = {...ZDR_ONLY_OPTIONS, disableZdr: false, enableZdr: true};
  const result = await executeRowWithAdapters(ZDR_ONLY_CSV, 0, options, {
    runClosedLoopChildAsync: async (_bindScript, task) => {
      assert.equal(task.enableZdr, true);
      assert.equal(task.zdrOnly, true);
      return {
        ok: true,
        result: {
          ok: true,
          status: 'zdr_enabled',
          zdr: {configured: true, status: 'enabled', changed: true},
        },
      };
    },
    adspower: {
      stopProfile: async () => ({attempted: true, ok: true}),
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.details.zdrStatus, 'enabled');
  assert.equal(result.details.purchaseStatus, 'skipped');
  assert.equal(result.details.autoTopupStatus, 'skipped');
  assert.equal(result.details.balanceBefore, '');
});

test('ZDR-only completion does not require a balance result', async () => {
  const result = await executeRowWithAdapters(ZDR_ONLY_CSV, 0, ZDR_ONLY_OPTIONS, {
    runClosedLoopChildAsync: async (_bindScript, task) => {
      assert.equal(task.zdrOnly, true);
      return {
        ok: true,
        result: {
          ok: true,
          status: 'zdr_disabled',
          zdr: {
            configured: true,
            status: 'disabled',
            changed: true,
          },
        },
      };
    },
    adspower: {
      stopProfile: async () => ({attempted: true, ok: true}),
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.stage, 'closed_loop.complete');
  assert.equal(result.details.purchaseStatus, 'skipped');
  assert.equal(result.details.autoTopupStatus, 'skipped');
  assert.equal(result.details.zdrStatus, 'disabled');
  assert.equal(result.details.zdrChanged, 'true');
  assert.equal(result.details.balanceBefore, '');
  assert.equal(result.details.balanceAfter, '');
});
