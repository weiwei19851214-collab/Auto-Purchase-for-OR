import assert from 'node:assert/strict';
import test from 'node:test';
import {executeRow, executeRowWithAdapters, parsePlan, runnerArgs, writeResultCsv} from '../server/automation-adapter.mjs';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readyToRechargePayload, resolveOpomAccountsPayload} from '../server/opom-orchestrator.mjs';
import {matchAdsPowerPayload} from '../server/adspower-match.mjs';
import {writeCompletedRow} from '../server/opom-client.mjs';
import {allocateCardsPayload, allocateCardsToRows, parseSafeCardCsv} from '../server/card-allocation.mjs';
import * as rechargePlan from '../automation/lib/recharge-plan.mjs';

const CANONICAL_CSV = `status,opom_account_id,login_email,ads_power_user_id,ads_power_serial_number,order_no,card_no,exp_month,exp_year,cvv,amount,postal_code,balance_threshold,amount_below_threshold,amount_at_or_above_threshold,auto_topup_threshold,auto_topup_amount
,acct_1,user@example.com,k1d7abc,1415,ejh_order_1,5257970000000001,06,28,456,,97001,100,10,5,2,25
`;

function withFetch(fakeFetch, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

test('parsePlan accepts canonical OPOM fields and maps profile id into closed-loop task', async () => {
  const parsed = await parsePlan(CANONICAL_CSV, {opomWriteback: true});
  assert.equal(parsed.rows[0].status, 'ready');
  assert.equal(parsed.rows[0].opomAccountId, 'acct_1');
  assert.equal(parsed.rows[0].adsPowerUserId, 'k1d7abc');
  assert.equal(parsed.rows[0].adsPowerSerialNumber, '1415');
  assert.equal(parsed.rows[0].ejhOrderNo, 'ejh_order_1');
  assert.equal(parsed.rows[0].cardNo, '5257970000000001');
  assert.doesNotMatch(JSON.stringify(parsed.rows[0]), /456/);

  const row = {
    opom_account_id: 'acct_1',
    login_email: 'user@example.com',
    ads_power_user_id: 'k1d7abc',
    ads_power_serial_number: '1415',
    card_no: '5257970000000001',
    exp_month: '06',
    exp_year: '28',
    cvv: '456',
    postal_code: '97001',
    amount: '10',
    auto_topup_threshold: '2',
    auto_topup_amount: '25',
  };
  const task = rechargePlan.buildClosedLoopTask(row, runnerArgs({opomWriteback: true}));
  assert.equal(task.profileId, 'k1d7abc');
  assert.equal(task.profileNo, '1415');
  assert.equal(task.expectedAccount, 'user@example.com');
  assert.equal(task.card.number, '5257970000000001');
});

test('readyToRechargePayload converts OPOM accounts into canonical CSV without credentials', async () => {
  await withFetch(async (url, options) => {
    assert.match(String(url), /\/api\/v1\/recharge\/accounts/);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return Response.json({
      data: [{
        opomAccountId: 'acct_1',
        loginEmail: 'user@example.com',
        group: 'recharge',
        currentBalanceUsd: 20,
        version: 7,
        adsPower: {userId: 'k1d7abc', serialNumber: '1415', groupName: 'recharge'},
        health: {status: 'ok', eligible: true},
        rechargePolicy: {
          balanceThreshold: '100',
          amountBelowThreshold: '10',
          amountAtOrAboveThreshold: '5',
          autoTopupThreshold: '2',
          autoTopupAmount: '25',
        },
      }],
      nextCursor: null,
    });
  }, async () => {
    const result = await readyToRechargePayload({
      group: 'recharge',
      opomBaseUrl: 'http://opom.local',
      opomRechargeToken: 'test-token',
    });
    assert.equal(result.count, 1);
    assert.equal(result.rows[0].opom_health_status, 'ok');
    assert.equal(result.rows[0].ads_match_status, 'not_verified');
    assert.match(result.csvText, /opom_account_id,login_email/);
    assert.match(result.csvText, /acct_1,user@example.com,k1d7abc,1415/);
    assert.match(result.csvText, /not_verified/);
    assert.doesNotMatch(result.csvText, /cvvPassword|encryptedParam|rawResponse|sk-or-v1/);
  });
});

test('readyToRechargePayload applies recharge defaults and billing address mapping CSV', async () => {
  await withFetch(async () => Response.json({
    data: [{
      opomAccountId: 'acct_1',
      loginEmail: 'user@example.com',
      version: 8,
      adsPower: {userId: 'profile_1', serialNumber: '1415'},
      rechargePolicy: {},
    }],
  }), async () => {
    const result = await readyToRechargePayload({
      group: 'recharge',
      opomBaseUrl: 'http://opom.local',
      opomRechargeToken: 'test-token',
      defaults: {
        amount: '10',
        autoTopupThreshold: '2',
        autoTopupAmount: '25',
        holderName: 'Default User',
        country: 'US',
        postalCode: '97001',
        addressLine1: '1 Default St',
        city: 'Portland',
        state: 'OR',
      },
      addressCsvText: `login_email,holder_name,country,postal_code,address_line1,city,state
user@example.com,Mapped User,US,10001,99 Mapping Ave,New York,NY
`,
    });
    assert.equal(result.addressMappingCount, 1);
    assert.equal(result.rows[0].amount, '10');
    assert.equal(result.rows[0].holder_name, 'Mapped User');
    assert.equal(result.rows[0].postal_code, '10001');
    assert.match(result.csvText, /amount,postal_code,holder_name/);
    assert.match(result.csvText, /Mapped User/);
  });
});

test('readyToRechargePayload maps uploaded address pool CSV sequentially and ignores last name and phone', async () => {
  await withFetch(async () => Response.json({
    data: [
      {opomAccountId: 'acct_1', loginEmail: 'one@example.com', rechargePolicy: {}},
      {opomAccountId: 'acct_2', loginEmail: 'two@example.com', rechargePolicy: {}},
    ],
  }), async () => {
    const result = await readyToRechargePayload({
      group: 'recharge',
      opomBaseUrl: 'http://opom.local',
      opomRechargeToken: 'test-token',
      addressCsvText: `LastName,FirstName,Street,City,State,Zip,PhoneNumber
IgnoredLast,First One,1 Sequential St,Bend,OR,97111,5551112222
IgnoredLast2,First Two,2 Sequential St,Burns,OR,97222,5551113333
`,
    });

    assert.equal(result.addressMappingCount, 2);
    assert.equal(result.rows[0].holder_name, 'First One');
    assert.equal(result.rows[0].address_line1, '1 Sequential St');
    assert.equal(result.rows[0].postal_code, '97111');
    assert.equal(result.rows[0].country, 'US');
    assert.equal(result.rows[1].holder_name, 'First Two');
    assert.doesNotMatch(result.csvText, /IgnoredLast|5551112222|PhoneNumber/);
  });
});

test('readyToRechargePayload forwards explicit OPOM queue status', async () => {
  await withFetch(async (url) => {
    assert.match(String(url), /group=recharge/);
    assert.match(String(url), /status=failed_retryable/);
    assert.match(String(url), /limit=25/);
    return Response.json({data: [], nextCursor: null});
  }, async () => {
    const result = await readyToRechargePayload({
      group: 'recharge',
      status: 'failed_retryable',
      limit: 25,
      opomBaseUrl: 'http://opom.local',
      opomRechargeToken: 'test-token',
    });
    assert.equal(result.count, 0);
    assert.equal(result.group, 'recharge');
  });
});

test('readyToRechargePayload forwards cursor and returns nextCursor for pagination', async () => {
  await withFetch(async (url) => {
    assert.match(String(url), /cursor=acct_001/);
    return Response.json({
      data: [{
        opomAccountId: 'acct_002',
        loginEmail: 'next@example.com',
        health: {status: 'ok', eligible: true, reason: ''},
        adsPower: {userId: 'profile_next', serialNumber: '1416'},
        rechargePolicy: {amount: '10', autoTopupThreshold: '2', autoTopupAmount: '25'},
        version: '2026-06-07T10:00:00.000Z',
      }],
      nextCursor: 'acct_002',
    });
  }, async () => {
    const result = await readyToRechargePayload({
      group: 'recharge',
      limit: 1,
      cursor: 'acct_001',
      opomBaseUrl: 'http://opom.local',
      opomRechargeToken: 'test-token',
    });
    assert.equal(result.count, 1);
    assert.equal(result.nextCursor, 'acct_002');
    assert.match(result.csvText, /opom_health_status,opom_health_reason/);
    assert.match(result.csvText, /acct_002/);
  });
});

test('readyToRechargePayload clamps OPOM queue limit to API maximum', async () => {
  await withFetch(async (url) => {
    assert.match(String(url), /limit=200/);
    assert.doesNotMatch(String(url), /limit=500/);
    return Response.json({data: [], nextCursor: null});
  }, async () => {
    const result = await readyToRechargePayload({
      group: 'recharge',
      limit: 500,
      opomBaseUrl: 'http://opom.local',
      opomRechargeToken: 'test-token',
    });
    assert.equal(result.count, 0);
  });
});

test('parsePlan blocks OPOM rows marked unhealthy by OPOM', async () => {
  const unhealthyCsv = `status,opom_account_id,login_email,ads_power_user_id,ads_power_serial_number,opom_health_status,opom_health_reason,ads_match_status,order_no,card_no,exp_month,exp_year,cvv,amount,postal_code,auto_topup_threshold,auto_topup_amount
,acct_1,user@example.com,profile_ok,1415,credits_401_blocked,Credits 401,matched,ejh_order_1,5257970000000001,06,28,456,10,97001,2,25
`;
  const blocked = await parsePlan(unhealthyCsv);

  assert.equal(blocked.rows[0].status, 'missing_fields');
  assert.ok(blocked.rows[0].missing.includes('opom_health_status:credits_401_blocked'));
});

test('parsePlan blocks selector rows until AdsPower match is confirmed', async () => {
  const selectorCsv = `status,login_email,ads_power_serial_number,opom_health_status,ads_match_status,order_no,card_no,exp_month,exp_year,cvv,amount,postal_code,holder_name,country,address_line1,city,state,auto_topup_threshold,auto_topup_amount
,selector@example.com,1415,local_selector,not_verified,ejh_order_1,5257970000000001,06,28,456,10,97001,Selector,US,1 Selector St,Portland,OR,2,25
`;
  const blocked = await parsePlan(selectorCsv);
  assert.equal(blocked.rows[0].status, 'missing_fields');
  assert.ok(blocked.rows[0].missing.includes('ads_match_status:not_verified'));
});

test('resolveOpomAccountsPayload matches local selector rows to OPOM account ids without overriding UI rules', async () => {
  const seenUrls = [];
  await withFetch(async (url) => {
    seenUrls.push(String(url));
    assert.match(String(url), /group=all/);
    assert.match(String(url), /status=all/);
    return Response.json({
      data: [{
        opomAccountId: 'acct_resolved',
        loginEmail: 'selector@example.com',
        health: {status: 'ok', eligible: true, reason: ''},
        adsPower: {userId: 'profile_from_opom', serialNumber: '1415'},
        rechargePolicy: {
          balanceThreshold: '999',
          amountBelowThreshold: '888',
          amountAtOrAboveThreshold: '777',
          autoTopupThreshold: '666',
          autoTopupAmount: '555',
        },
        version: 'v-resolved',
      }],
      nextCursor: null,
    });
  }, async () => {
    const result = await resolveOpomAccountsPayload({
      opomBaseUrl: 'http://opom.local',
      opomRechargeToken: 'test-token',
      rows: [{
        login_email: 'selector@example.com',
        ads_power_serial_number: '1415',
        opom_health_status: 'local_selector',
        amount: '0',
        balance_threshold: '100',
        amount_below_threshold: '10',
        amount_at_or_above_threshold: '5',
        auto_topup_threshold: '100',
        auto_topup_amount: '100',
        holder_name: 'UI Address',
        postal_code: '97173',
      }],
    });

    assert.equal(result.matched, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.rows[0].opom_account_id, 'acct_resolved');
    assert.equal(result.rows[0].ads_power_user_id, 'profile_from_opom');
    assert.equal(result.rows[0].opom_health_status, 'ok');
    assert.equal(result.rows[0].balance_threshold, '100');
    assert.equal(result.rows[0].amount_below_threshold, '10');
    assert.equal(result.rows[0].auto_topup_amount, '100');
    assert.equal(result.rows[0].holder_name, 'UI Address');
    assert.match(result.csvText, /acct_resolved,selector@example.com,profile_from_opom,1415/);
  });
  assert.equal(seenUrls.length, 1);
});

test('writeResultCsv carries OPOM health metadata for blocked handoff rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opom-health-result-'));
  try {
    const csvPath = join(dir, 'input.csv');
    const resultPath = join(dir, 'result.csv');
    const unhealthyCsv = `status,opom_account_id,login_email,ads_power_user_id,ads_power_serial_number,opom_health_status,opom_health_reason,ads_match_status,amount,auto_topup_threshold,auto_topup_amount
,acct_1,user@example.com,profile_ok,1415,credits_401_blocked,Credits 401 while collecting balance,matched,10,2,25
`;
    writeFileSync(csvPath, unhealthyCsv, 'utf8');
    await writeResultCsv({
      csvPath,
      resultCsvPath: resultPath,
      runId: 'run_health_1',
      rowsByRawIndex: [{
        rawIndex: 0,
        status: 'missing_fields',
        message: 'opom_health_status:credits_401_blocked',
        details: {},
      }],
    });

    const text = readFileSync(resultPath, 'utf8');
    assert.match(text, /opom_health_status/);
    assert.match(text, /credits_401_blocked/);
    assert.match(text, /Credits 401 while collecting balance/);
    assert.doesNotMatch(text, /card_number|cvv|5257970000000001/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('matchAdsPowerPayload reports matched and identity mismatch rows from Local API responses', async () => {
  let call = 0;
  await withFetch(async () => {
    call += 1;
    return Response.json({
      code: 0,
      data: {
        list: [{
          user_id: call === 1 ? 'profile_ok' : 'profile_bad',
          serial_number: call === 1 ? '1415' : '1416',
          username: call === 1 ? 'user@example.com' : 'other@example.com',
          group_name: 'recharge',
        }],
      },
      msg: 'Success',
    });
  }, async () => {
    const result = await matchAdsPowerPayload({
      rows: [
        {loginEmail: 'user@example.com', ads_power_user_id: 'profile_ok'},
        {loginEmail: 'user@example.com', ads_power_user_id: 'profile_bad'},
      ],
    });
    assert.equal(result.total, 2);
    assert.equal(result.results[0].status, 'matched');
    assert.equal(result.results[1].status, 'identity_mismatch');
  });
});

test('matchAdsPowerPayload detects inconsistent AdsPower user id and serial number', async () => {
  await withFetch(async () => Response.json({
    code: 0,
    data: {
      list: [{
        user_id: 'profile_ok',
        serial_number: '9999',
        username: 'user@example.com',
        group_name: 'recharge',
      }],
    },
    msg: 'Success',
  }), async () => {
    const result = await matchAdsPowerPayload({
      rows: [{
        loginEmail: 'user@example.com',
        ads_power_user_id: 'profile_ok',
        ads_power_serial_number: '1415',
      }],
    });

    assert.equal(result.matched, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.results[0].status, 'identifier_mismatch');
    assert.equal(result.results[0].mismatchField, 'serial_number');
  });
});

test('matchAdsPowerPayload accepts AdsPower platform account identity fields', async () => {
  let call = 0;
  await withFetch(async () => {
    call += 1;
    return Response.json({
      code: 0,
      data: {
        list: [call === 1
          ? {
              user_id: 'profile_platform',
              serial_number: '1417',
              username: '',
              platform_account: 'user@example.com',
              group_name: 'recharge',
            }
          : {
              user_id: 'profile_nested_platform',
              serial_number: '1418',
              username: '',
              platforms: [{platform: 'OpenRouter', username: 'nested@example.com'}],
              group_name: 'recharge',
            }],
      },
      msg: 'Success',
    });
  }, async () => {
    const result = await matchAdsPowerPayload({
      rows: [
        {loginEmail: 'user@example.com', ads_power_user_id: 'profile_platform'},
        {loginEmail: 'nested@example.com', ads_power_user_id: 'profile_nested_platform'},
      ],
    });

    assert.equal(result.total, 2);
    assert.equal(result.matched, 2);
    assert.equal(result.results[0].status, 'matched');
    assert.equal(result.results[1].status, 'matched');
  });
});

test('matchAdsPowerPayload builds one email index for historical OPOM rows without AdsPower ids', async () => {
  let calls = 0;
  await withFetch(async (url) => {
    calls += 1;
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('page'), '1');
    assert.equal(parsed.searchParams.get('page_size'), '100');
    assert.equal(parsed.searchParams.get('user_id'), null);
    assert.equal(parsed.searchParams.get('serial_number'), null);
    return Response.json({
      code: 0,
      data: {
        list: [
          {
            user_id: 'profile_one',
            serial_number: '1424',
            username: 'one@example.com',
            group_name: 'recharge',
          },
          {
            user_id: 'profile_two',
            serial_number: '1425',
            platform_account: 'two@example.com',
            group_name: 'recharge',
          },
        ],
      },
      msg: 'Success',
    });
  }, async () => {
    const result = await matchAdsPowerPayload({
      rows: [
        {loginEmail: 'one@example.com'},
        {loginEmail: 'two@example.com'},
      ],
      matchOptions: {scanDelayMs: 0},
    });

    assert.equal(calls, 1);
    assert.equal(result.total, 2);
    assert.equal(result.matched, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.results[0].matchSource, 'email_index');
    assert.equal(result.results[0].profile.serialNumber, '1424');
    assert.equal(result.results[1].profile.serialNumber, '1425');
  });
});

test('parsePlan blocks OPOM rows until AdsPower match status is matched', async () => {
  const notVerifiedCsv = `status,opom_account_id,login_email,ads_power_user_id,ads_power_serial_number,ads_match_status,order_no,card_no,exp_month,exp_year,cvv,amount,postal_code,auto_topup_threshold,auto_topup_amount
,acct_1,user@example.com,profile_ok,1415,not_verified,ejh_order_1,5257970000000001,06,28,456,10,97001,2,25
`;
  const matchedCsv = notVerifiedCsv.replace(',not_verified,', ',matched,');
  const blocked = await parsePlan(notVerifiedCsv, {opomWriteback: true});
  const ready = await parsePlan(matchedCsv, {opomWriteback: true});

  assert.equal(blocked.rows[0].status, 'missing_fields');
  assert.deepEqual(blocked.rows[0].missing, ['ads_match_status:not_verified']);
  assert.equal(ready.rows[0].status, 'ready');
});

test('parsePlan requires OPOM writeback for confirmed purchase on OPOM rows', async () => {
  const matchedCsv = `status,opom_account_id,login_email,ads_power_user_id,ads_power_serial_number,ads_match_status,order_no,card_no,exp_month,exp_year,cvv,amount,postal_code,auto_topup_threshold,auto_topup_amount
,acct_1,user@example.com,profile_ok,1415,matched,ejh_order_1,5257970000000001,06,28,456,10,97001,2,25
`;
  const blocked = await parsePlan(matchedCsv, {opomWriteback: false, confirmPurchase: true});
  const readyWithWriteback = await parsePlan(matchedCsv, {opomWriteback: true, confirmPurchase: true});
  const readyNoPurchase = await parsePlan(matchedCsv, {
    opomWriteback: false,
    confirmPurchase: false,
    preparePurchaseOnly: true,
  });

  assert.equal(blocked.rows[0].status, 'missing_fields');
  assert.ok(blocked.rows[0].missing.includes('opom_writeback'));
  assert.equal(readyWithWriteback.rows[0].status, 'ready');
  assert.equal(readyNoPurchase.rows[0].status, 'ready');
});

test('parsePlan requires EJH card identifiers before confirmed OPOM writeback purchase', async () => {
  const missingOrderCsv = `status,opom_account_id,login_email,ads_power_user_id,ads_power_serial_number,ads_match_status,card_no,exp_month,exp_year,cvv,amount,postal_code,auto_topup_threshold,auto_topup_amount
,acct_1,user@example.com,profile_ok,1415,matched,5257970000000001,06,28,456,10,97001,2,25
`;
  const blocked = await parsePlan(missingOrderCsv, {opomWriteback: true, confirmPurchase: true});
  const preparedOnly = await parsePlan(missingOrderCsv, {
    opomWriteback: true,
    confirmPurchase: false,
    preparePurchaseOnly: true,
  });

  assert.equal(blocked.rows[0].status, 'missing_fields');
  assert.ok(blocked.rows[0].missing.includes('order_no'));
  assert.equal(preparedOnly.rows[0].status, 'ready');
});

test('parsePlan requires card number before confirmed OPOM writeback purchase', async () => {
  const missingCardCsv = `status,opom_account_id,login_email,ads_power_user_id,ads_power_serial_number,ads_match_status,order_no,exp_month,exp_year,cvv,amount,postal_code,auto_topup_threshold,auto_topup_amount
,acct_1,user@example.com,profile_ok,1415,matched,ejh_order_1,06,28,456,10,97001,2,25
`;
  const blocked = await parsePlan(missingCardCsv, {
    opomWriteback: true,
    confirmPurchase: true,
  });

  assert.equal(blocked.rows[0].status, 'missing_fields');
  assert.ok(blocked.rows[0].missing.includes('card_number'));
});

test('parsePlan requires card expiration before confirmed OPOM writeback even without card replacement scope', async () => {
  const missingExpiryCsv = `status,opom_account_id,login_email,ads_power_user_id,ads_power_serial_number,ads_match_status,order_no,card_no,amount,auto_topup_threshold,auto_topup_amount
,acct_1,user@example.com,profile_ok,1415,matched,ejh_order_1,5257970000000001,10,2,25
`;
  const blocked = await parsePlan(missingExpiryCsv, {
    opomWriteback: true,
    confirmPurchase: true,
    scopeBillingAddress: false,
    scopePaymentMethod: false,
  });

  assert.equal(blocked.rows[0].status, 'missing_fields');
  assert.ok(blocked.rows[0].missing.includes('exp_month'));
  assert.ok(blocked.rows[0].missing.includes('exp_year'));
});

test('writeCompletedRow writes OPOM card binding and result without CVV value', async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    calls.push({url: String(url), body: JSON.parse(options.body)});
    return Response.json({data: {ok: true}});
  }, async () => {
    const row = {
      opom_account_id: 'acct_1',
      login_email: 'user@example.com',
      ads_power_user_id: 'profile_ok',
      ads_power_serial_number: '1415',
      order_no: 'ejh_order_1',
      card_no: '5257970000000001',
      exp_month: '06',
      exp_year: '28',
      cvv: '456',
    };
    const result = await writeCompletedRow({
      opomWriteback: true,
      opomBaseUrl: 'http://opom.local',
      opomRechargeToken: 'test-token',
      runId: 'run_1',
    }, row, {
      purchaseStatus: 'verified',
      purchaseAmount: '10',
      balanceBefore: '20',
      balanceAfter: '30',
      cardLast4: '0001',
      autoTopupStatus: 'updated',
      autoTopupThreshold: '2',
      autoTopupAmount: '25',
    }, {rowNumber: 2});
    assert.deepEqual(result, {cardStatus: 'written', resultStatus: 'written'});
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /card-binding$/);
    assert.equal(calls[0].body.card.cvvPresent, true);
    assert.equal(calls[0].body.card.provider, undefined);
    assert.equal(JSON.stringify(calls).includes('456'), false);
    assert.match(calls[1].url, /\/api\/v1\/recharge\/runs\/run_1\/results$/);
    assert.equal(calls[1].body.loginEmail, 'user@example.com');
    assert.equal(calls[1].body.errorCode, undefined);
    assert.equal(calls[1].body.errorMessage, undefined);
    assert.equal(calls[1].body.stage, undefined);
  });
});

test('writeCompletedRow derives OPOM result card last4 from row card number when worker details omit it', async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).endsWith('/results')) {
      assert.notEqual(body.card?.panLast4, '');
      assert.equal(body.card?.panLast4, '0001');
    }
    calls.push({url: String(url), body});
    return Response.json({data: {ok: true}});
  }, async () => {
    const row = {
      opom_account_id: 'acct_1',
      login_email: 'user@example.com',
      ads_power_user_id: 'profile_ok',
      ads_power_serial_number: '1415',
      order_no: 'ejh_order_1',
      card_no: '5257970000000001',
      exp_month: '06',
      exp_year: '28',
      cvv: '456',
    };
    const result = await writeCompletedRow({
      opomWriteback: true,
      opomBaseUrl: 'http://opom.local',
      opomRechargeToken: 'test-token',
      runId: 'run_1',
    }, row, {
      purchaseStatus: 'verified',
      purchaseAmount: '10',
      balanceBefore: '20',
      balanceAfter: '30',
    }, {rowNumber: 2});

    assert.deepEqual(result, {cardStatus: 'written', resultStatus: 'written'});
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.card.orderNo, 'ejh_order_1');
    assert.equal(JSON.stringify(calls[1]).includes('5257970000000001'), false);
    assert.equal(JSON.stringify(calls[1]).includes('456'), false);
  });
});

test('writeCompletedRow refuses OPOM card writeback without card expiration before fetch', async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    calls.push({url: String(url), body: JSON.parse(options.body)});
    return Response.json({data: {ok: true}});
  }, async () => {
    const row = {
      opom_account_id: 'acct_1',
      login_email: 'user@example.com',
      ads_power_user_id: 'profile_ok',
      ads_power_serial_number: '1415',
      order_no: 'ejh_order_1',
      card_no: '5257970000000001',
      cvv: '456',
    };
    await assert.rejects(
      () => writeCompletedRow({
        opomWriteback: true,
        opomBaseUrl: 'http://opom.local',
        opomRechargeToken: 'test-token',
        runId: 'run_1',
      }, row, {
        purchaseStatus: 'verified',
        purchaseAmount: '10',
        balanceBefore: '20',
        balanceAfter: '30',
        cardLast4: '0001',
      }, {rowNumber: 2}),
      (error) => {
        assert.equal(error.opomCardWritebackStatus, 'failed');
        assert.equal(error.opomResultWritebackStatus, 'skipped');
        assert.match(error.message, /orderNo, cardNo, and expiresAt/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });
});

test('writeCompletedRow preserves partial OPOM writeback status when result write fails', async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    calls.push({url: String(url), body: JSON.parse(options.body)});
    if (String(url).endsWith('/results')) {
      return Response.json({error: 'temporary result writeback outage token=secret'}, {status: 503});
    }
    return Response.json({data: {ok: true}});
  }, async () => {
    const row = {
      opom_account_id: 'acct_1',
      login_email: 'user@example.com',
      ads_power_user_id: 'profile_ok',
      ads_power_serial_number: '1415',
      order_no: 'ejh_order_1',
      card_no: '5257970000000001',
      exp_month: '06',
      exp_year: '28',
      cvv: '456',
    };
    await assert.rejects(
      () => writeCompletedRow({
        opomWriteback: true,
        opomBaseUrl: 'http://opom.local',
        opomRechargeToken: 'test-token',
        runId: 'run_1',
      }, row, {
        purchaseStatus: 'verified',
        purchaseAmount: '10',
        balanceBefore: '20',
        balanceAfter: '30',
        cardLast4: '0001',
      }, {rowNumber: 2}),
      (error) => {
        assert.equal(error.opomCardWritebackStatus, 'written');
        assert.equal(error.opomResultWritebackStatus, 'failed');
        assert.match(error.message, /token=\[secret\]/);
        assert.doesNotMatch(error.message, /token=secret/);
        return true;
      },
    );
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /card-binding$/);
    assert.match(calls[1].url, /\/results$/);
  });
});

test('writeCompletedRow marks result writeback skipped when card binding fails first', async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    calls.push({url: String(url), body: JSON.parse(options.body)});
    return Response.json({error: 'card binding conflict token=secret'}, {status: 409});
  }, async () => {
    const row = {
      opom_account_id: 'acct_1',
      login_email: 'user@example.com',
      ads_power_user_id: 'profile_ok',
      ads_power_serial_number: '1415',
      order_no: 'ejh_order_1',
      card_no: '5257970000000001',
      exp_month: '06',
      exp_year: '28',
      cvv: '456',
    };
    await assert.rejects(
      () => writeCompletedRow({
        opomWriteback: true,
        opomBaseUrl: 'http://opom.local',
        opomRechargeToken: 'test-token',
        runId: 'run_1',
      }, row, {
        purchaseStatus: 'verified',
        purchaseAmount: '10',
        balanceBefore: '20',
        balanceAfter: '30',
        cardLast4: '0001',
      }, {rowNumber: 2}),
      (error) => {
        assert.equal(error.opomCardWritebackStatus, 'failed');
        assert.equal(error.opomResultWritebackStatus, 'skipped');
        assert.match(error.message, /token=\[secret\]/);
        assert.doesNotMatch(error.message, /token=secret/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /card-binding$/);
  });
});

test('executeRow writes missing_fields result to OPOM without launching browser', async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    calls.push({url: String(url), body: JSON.parse(options.body)});
    return Response.json({data: {ok: true}});
  }, async () => {
    const csv = `status,opom_account_id,login_email,ads_power_serial_number,amount,auto_topup_threshold,auto_topup_amount
,acct_1,user@example.com,1415,,2,25
`;
    const result = await executeRow(csv, 0, {
      opomWriteback: true,
      opomBaseUrl: 'http://opom.local',
      opomRechargeToken: 'test-token',
      runId: 'run_1',
    });
    assert.equal(result.status, 'missing_fields');
    assert.equal(result.details.opomResultWritebackStatus, 'written');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/v1\/recharge\/runs\/run_1\/results$/);
    assert.equal(calls[0].body.status, 'missing_fields');
    assert.equal(calls[0].body.opomAccountId, 'acct_1');
    assert.equal(calls[0].body.loginEmail, 'user@example.com');
  });
});

test('executeRow writes failed opom.writeback result after verified purchase writeback failure', async () => {
  const resultCalls = [];
  const csv = `status,opom_account_id,login_email,ads_power_user_id,ads_power_serial_number,ads_match_status,order_no,card_no,exp_month,exp_year,cvv,amount,postal_code,auto_topup_threshold,auto_topup_amount
,acct_1,user@example.com,profile_ok,1415,matched,ejh_order_1,5257970000000001,06,28,456,10,97001,2,25
`;
  const result = await executeRowWithAdapters(csv, 0, {
    opomWriteback: true,
    opomBaseUrl: 'http://opom.local',
    opomRechargeToken: 'test-token',
    runId: 'run_1',
  }, {
    runClosedLoopChildAsync: async () => ({
      ok: true,
      result: {
        purchase: {
          amount: '10',
          balanceVerification: {
            verified: true,
            beforeBalance: '20',
            afterBalance: '30',
          },
        },
        autoTopup: {
          configured: true,
          changed: true,
          requested: {threshold: '2', amount: '25'},
        },
        card: {last4: '0001'},
      },
    }),
    opom: {
      writeCompletedRow: async () => {
        const error = new Error('card binding conflict token=secret');
        error.opomCardWritebackStatus = 'failed';
        error.opomResultWritebackStatus = 'skipped';
        throw error;
      },
      writeRowResult: async (args, row, details, context) => {
        resultCalls.push({
          runId: args.runId,
          opomAccountId: row.opom_account_id,
          details,
          context,
        });
        return {resultStatus: 'written'};
      },
    },
    adspower: {
      stopProfile: async () => ({attempted: true, ok: true}),
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'opom.writeback');
  assert.equal(result.details.purchaseStatus, 'verified');
  assert.equal(result.details.opomResultWritebackStatus, 'written');
  assert.equal(resultCalls.length, 1);
  assert.equal(resultCalls[0].context.status, 'failed');
  assert.equal(resultCalls[0].context.stage, 'opom.writeback');
  assert.equal(resultCalls[0].context.errorCode, 'opom_writeback_failed');
  assert.doesNotMatch(JSON.stringify(resultCalls), /token=secret|456/);
});

test('writeRowResult omits masked login email values from OPOM payload', async () => {
  const {writeRowResult} = await import('../server/opom-client.mjs');
  const calls = [];
  await withFetch(async (url, options) => {
    calls.push({url: String(url), body: JSON.parse(options.body)});
    return Response.json({data: {ok: true}});
  }, async () => {
    await writeRowResult({
      opomWriteback: true,
      opomBaseUrl: 'http://opom.local',
      opomRechargeToken: 'test-token',
      runId: 'run_masked',
    }, {
      opom_account_id: 'acct_1',
      login_email: 'us***@example.com',
    }, {}, {
      rowNumber: 2,
      status: 'failed',
      message: 'masked email should not be sent',
      errorCode: 'failed',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.opomAccountId, 'acct_1');
    assert.equal(calls[0].body.loginEmail, undefined);
  });
});

test('allocateCardsToRows assigns completed EJH safe CSV cards to canonical OPOM rows', () => {
  const cardCsv = `card_batch_id,row_number,card_provider,open_status,order_no,card_no,expiry_month,expiry_year,cvv,pan_last4
batch_1,1,EJH,completed,order_1,5257970000000001,06,2028,456,0001
batch_1,2,EJH,completed,order_2,5257970000000002,07,2029,789,0002
`;
  const result = allocateCardsToRows([
    {opom_account_id: 'acct_1', login_email: 'user1@example.com', ads_match_status: 'matched', postal_code: '97001'},
    {opom_account_id: 'acct_2', login_email: 'user2@example.com', ads_match_status: 'matched'},
  ], cardCsv, {postal_code: '97002'});

  assert.equal(result.summary.allocated, 2);
  assert.equal(result.rows[0].order_no, 'order_1');
  assert.equal(result.rows[0].card_no, '5257970000000001');
  assert.equal(result.rows[0].exp_year, '28');
  assert.equal(result.rows[1].postal_code, '97002');
  assert.match(result.csvText, /opom_account_id,login_email/);
});

test('allocateCardsToRows does not consume EJH cards for unmatched OPOM rows', () => {
  const cardCsv = `card_batch_id,row_number,card_provider,open_status,order_no,card_no,expiry_month,expiry_year,cvv,pan_last4
batch_1,1,EJH,completed,order_1,5257970000000001,06,2028,456,0001
`;
  const result = allocateCardsToRows([
    {opom_account_id: 'acct_1', login_email: 'user1@example.com', ads_match_status: 'profile_not_found'},
    {opom_account_id: 'acct_2', login_email: 'user2@example.com', ads_match_status: 'matched'},
  ], cardCsv);

  assert.equal(result.summary.requestedRows, 2);
  assert.equal(result.summary.eligibleRows, 1);
  assert.equal(result.summary.skippedNotMatched, 1);
  assert.equal(result.summary.allocated, 1);
  assert.equal(result.rows[0].order_no, undefined);
  assert.equal(result.rows[1].order_no, 'order_1');
});

test('parseSafeCardCsv accepts EJH generated CSV while dropping raw diagnostic columns from allocation output', () => {
  const rawCsv = `index,success,code,msg,orderNo,cardNo,validityDate,cvvPassword,cardType,cardAmount,rawResponse,encryptedParam,requestPayload
1,true,000000,请求成功,order_1,5257970000000001,0628,456,MASTER_B1_1,11.00,"{}","secret","{}"
`;
  const cards = parseSafeCardCsv(rawCsv);
  assert.equal(cards[0].completed, true);
  assert.equal(cards[0].orderNo, 'order_1');
  assert.equal(cards[0].expMonth, '06');
  assert.equal(cards[0].expYear, '28');

  const result = allocateCardsToRows([
    {opom_account_id: 'acct_1', login_email: 'user1@example.com', ads_match_status: 'matched'},
  ], rawCsv);
  assert.equal(result.summary.allocated, 1);
  assert.doesNotMatch(result.csvText, /rawResponse|encryptedParam|requestPayload/);
});

test('allocateCardsPayload refuses real EJH creation without explicit confirmation', async () => {
  await assert.rejects(() => allocateCardsPayload({
    rows: [{opom_account_id: 'acct_1', login_email: 'user@example.com'}],
    createCards: true,
    count: 1,
    amount: '10',
    activeDate: '2028-12-31',
    cardholder: 'operator',
  }), /confirmCreateCards=true/);
});
