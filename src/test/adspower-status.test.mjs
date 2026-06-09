import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADSPOWER_GROUP_ROLES,
  ADSPOWER_STATUS_MODES,
  adsPowerGroupRoleForStatus,
  safeAdsPowerRemark,
  writeAdsPowerStatus,
} from '../server/adspower-status.mjs';

test('disabled mode is the default and does not call fetch', async () => {
  let called = false;
  const result = await writeAdsPowerStatus(
    {ads_power_user_id: 'u-1'},
    {status: 'completed'},
    {
      fetch: async () => {
        called = true;
        throw new Error('should not be called');
      },
    },
  );

  assert.equal(called, false);
  assert.equal(result.ok, true);
  assert.equal(result.attempted, false);
  assert.equal(result.status, 'skipped_user_waived');
  assert.equal(result.mode, 'disabled');
  assert.equal(result.target, 'waived_by_user');
  assert.equal(result.reason, 'user_waived_status_writeback');
});

test('non-disabled modes require an injected fetch adapter', async () => {
  const result = await writeAdsPowerStatus(
    {ads_power_user_id: 'u-1'},
    {status: 'completed'},
    {
      mode: ADSPOWER_STATUS_MODES.GROUP_MOVE,
      successGroupId: 'g-success',
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.attempted, false);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'missing_fetch_adapter');
  assert.equal(result.mode, ADSPOWER_STATUS_MODES.GROUP_MOVE);
});

test('group_move maps completed rows to the success group', async () => {
  const calls = [];
  const result = await writeAdsPowerStatus(
    {ads_power_user_id: 'u-1', username: 'person@example.com'},
    {status: 'completed', message: 'completed'},
    {
      mode: ADSPOWER_STATUS_MODES.GROUP_MOVE,
      adspowerApiBase: 'http://adspower.local',
      adspowerApiKey: 'secret-token',
      successGroupId: 'g-success',
      fetch: fakeAdsPowerFetch(calls),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.groupRole, ADSPOWER_GROUP_ROLES.SUCCESS);
  assert.equal(result.groupId, 'g-success');
  assert.equal(result.target, 'group:success:g-success');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://adspower.local/api/v1/user/regroup');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    user_ids: ['u-1'],
    group_id: 'g-success',
  });
  assert.doesNotMatch(calls[0].options.body, /person@example.com/);
});

test('group_move resolves name-prefixed group targets before regrouping', async () => {
  const calls = [];
  const result = await writeAdsPowerStatus(
    {ads_power_user_id: 'u-name'},
    {status: 'completed'},
    {
      mode: ADSPOWER_STATUS_MODES.GROUP_MOVE,
      adspowerApiBase: 'http://adspower.local',
      successGroupId: 'name:Recharge Success',
      fetch: async (url, options) => {
        calls.push({url, options});
        if (String(url).includes('/api/v1/group/list')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: 0,
              data: {
                list: [
                  {group_id: 'g-success-name', group_name: 'Recharge Success'},
                ],
              },
              msg: 'success',
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({code: 0, data: {}, msg: 'success'}),
        };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.groupId, 'g-success-name');
  assert.equal(result.target, 'group:success:g-success-name');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/api\/v1\/group\/list\?group_name=Recharge\+Success/);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].url, 'http://adspower.local/api/v1/user/regroup');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    user_ids: ['u-name'],
    group_id: 'g-success-name',
  });
});

test('group_move does not treat unresolved group names as ids', async () => {
  const calls = [];
  const result = await writeAdsPowerStatus(
    {ads_power_user_id: 'u-missing-name'},
    {status: 'completed'},
    {
      mode: ADSPOWER_STATUS_MODES.GROUP_MOVE,
      successGroupId: 'name:Missing Success',
      fetch: async (url, options) => {
        calls.push({url, options});
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: {list: []},
            msg: 'success',
          }),
        };
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.match(result.message, /group_name_not_found/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/v1\/group\/list/);
});

test('group_move maps manual security blockers to the blocker group', async () => {
  const calls = [];
  const result = await writeAdsPowerStatus(
    {adsPowerUserId: 'u-2'},
    {status: 'manual_security_blocker'},
    {
      mode: ADSPOWER_STATUS_MODES.GROUP_MOVE,
      groups: {blocker: 'g-blocker'},
      fetch: fakeAdsPowerFetch(calls),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.groupRole, ADSPOWER_GROUP_ROLES.BLOCKER);
  assert.equal(result.target, 'group:blocker:g-blocker');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    user_ids: ['u-2'],
    group_id: 'g-blocker',
  });
});

test('group_move maps failure statuses to the failure group', async () => {
  const calls = [];
  const result = await writeAdsPowerStatus(
    {user_id: 'u-3'},
    {status: 'payment_issue_card_declined'},
    {
      mode: ADSPOWER_STATUS_MODES.GROUP_MOVE,
      failureGroupId: 'g-failure',
      fetch: fakeAdsPowerFetch(calls),
    },
  );

  assert.equal(adsPowerGroupRoleForStatus('failed'), ADSPOWER_GROUP_ROLES.FAILURE);
  assert.equal(result.ok, true);
  assert.equal(result.groupRole, ADSPOWER_GROUP_ROLES.FAILURE);
  assert.equal(result.target, 'group:failure:g-failure');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    user_ids: ['u-3'],
    group_id: 'g-failure',
  });
});

test('group_move skips rows without a user_id or mapped group', async () => {
  let calls = 0;
  const missingUser = await writeAdsPowerStatus(
    {ads_power_serial_number: '1415'},
    {status: 'completed'},
    {
      mode: ADSPOWER_STATUS_MODES.GROUP_MOVE,
      successGroupId: 'g-success',
      fetch: async () => {
        calls += 1;
      },
    },
  );
  const missingGroup = await writeAdsPowerStatus(
    {ads_power_user_id: 'u-4'},
    {status: 'completed'},
    {
      mode: ADSPOWER_STATUS_MODES.GROUP_MOVE,
      fetch: async () => {
        calls += 1;
      },
    },
  );

  assert.equal(calls, 0);
  assert.equal(missingUser.status, 'skipped');
  assert.equal(missingUser.reason, 'missing_ads_power_user_id');
  assert.equal(missingGroup.status, 'skipped');
  assert.equal(missingGroup.reason, 'missing_success_group_id');
});

test('remark_append writes only sanitized status text through fake fetch', async () => {
  const calls = [];
  const result = await writeAdsPowerStatus(
    {
      ads_power_user_id: 'u-5',
      username: 'sensitive@example.com',
      remark: 'previous note',
    },
    {
      status: 'failed',
      stage: 'purchase.submit',
      message: 'card_number=5257970000000001 cvv=456 token=abc person@example.com',
    },
    {
      mode: ADSPOWER_STATUS_MODES.REMARK_APPEND,
      adspowerApiBase: 'http://adspower.local/',
      fetch: fakeAdsPowerFetch(calls),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.target, 'remark:v1');
  assert.equal(calls[0].url, 'http://adspower.local/api/v1/user/update');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.user_id, 'u-5');
  assert.match(body.remark, /previous note/);
  assert.match(body.remark, /OpenRouter recharge \| failed \| purchase\.submit/);
  assert.doesNotMatch(body.remark, /sensitive@example.com|person@example.com|5257970000000001|456|abc/);
});

test('remark_append_v2 uses the browser-profile update endpoint and profile_id', async () => {
  const calls = [];
  const result = await writeAdsPowerStatus(
    {
      ads_power_user_id: 'u-v2',
      remark: 'existing',
    },
    {
      status: 'completed',
      stage: 'opom.writeback',
    },
    {
      mode: ADSPOWER_STATUS_MODES.REMARK_APPEND_V2,
      adspowerApiBase: 'http://adspower.local/',
      fetch: fakeAdsPowerFetch(calls),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.mode, ADSPOWER_STATUS_MODES.REMARK_APPEND_V2);
  assert.equal(result.target, 'remark:v2');
  assert.equal(calls[0].url, 'http://adspower.local/api/v2/browser-profile/update');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.profile_id, 'u-v2');
  assert.equal(body.user_id, undefined);
  assert.match(body.remark, /existing/);
  assert.match(body.remark, /OpenRouter recharge \| completed \| opom\.writeback/);
});

test('AdsPower API errors return sanitized short messages', async () => {
  const result = await writeAdsPowerStatus(
    {ads_power_user_id: 'u-6'},
    {status: 'completed'},
    {
      mode: ADSPOWER_STATUS_MODES.GROUP_MOVE,
      successGroupId: 'g-success',
      fetch: async () => ({
        ok: false,
        status: 500,
        json: async () => ({
          code: -1,
          msg: 'failed for username=person@example.com card_number=123456781234 fallback=5257970000000001 cvv=456 token=secret with long detail',
        }),
      }),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.match(result.message, /HTTP 500 code -1/);
  assert.doesNotMatch(result.message, /person@example.com|123456781234|5257970000000001|456|secret/);
  assert.ok(result.message.length <= 200);
});

test('safeAdsPowerRemark ignores account and raw error details', () => {
  const remark = safeAdsPowerRemark({
    status: 'failed',
    stage: 'identity.account',
    message: 'expected person@example.com got other@example.com card_number=5257970000000001',
  });

  assert.match(remark, /OpenRouter recharge \| failed \| identity\.account/);
  assert.doesNotMatch(remark, /person@example.com|other@example.com|5257970000000001/);
});

function fakeAdsPowerFetch(calls, body = {code: 0, msg: 'ok'}) {
  return async (url, options) => {
    calls.push({url, options});
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  };
}
