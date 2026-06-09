import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import * as csv from '../automation/lib/csv.mjs';
import {matchAdsPowerPayload} from '../server/adspower-match.mjs';
import {allocateCardsToRows} from '../server/card-allocation.mjs';
import {openDatabase, getJob} from '../server/db.mjs';
import {createJob, dryRunPayload, jobDetails} from '../server/jobs.mjs';
import {readyToRechargePayload} from '../server/opom-orchestrator.mjs';
import {writeCompletedRow} from '../server/opom-client.mjs';
import {JobWorker} from '../server/worker.mjs';

function csvRow(csvText, rawIndex) {
  const parsed = csv.parseCsv(csvText);
  return csv.rowObject(parsed[0], parsed[rawIndex + 1]);
}

function withFetch(fakeFetch, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

test('fake E2E closes OPOM to AdsPower to EJH allocation to writeback loop without sensitive CSV output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-fake-e2e-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const opomCalls = [];
    const adsPowerMatchCalls = [];
    const adsPowerStatusCalls = [];

    await withFetch(async (url, options = {}) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/v1/recharge/accounts') {
        opomCalls.push({type: 'ready', url: String(url), options});
        return Response.json({
          data: [{
            opomAccountId: 'acct_1',
            loginEmail: 'user@example.com',
            group: 'recharge',
            currentBalanceUsd: 20,
            version: 'v1',
            adsPower: {userId: 'profile_ok', serialNumber: '1415', groupName: 'recharge'},
            rechargePolicy: {
              amountUsd: '10',
              autoTopupThreshold: '2',
              autoTopupAmount: '25',
            },
          }],
          nextCursor: null,
        });
      }
      if (target.pathname === '/api/v1/user/list') {
        adsPowerMatchCalls.push({url: String(url), options});
        return Response.json({
          code: 0,
          data: {
            list: [{
              user_id: 'profile_ok',
              serial_number: '1415',
              username: 'user@example.com',
              group_name: 'recharge',
            }],
          },
          msg: 'Success',
        });
      }
      if (target.pathname.endsWith('/card-binding')) {
        opomCalls.push({type: 'card-binding', url: String(url), body: JSON.parse(options.body)});
        return Response.json({data: {cardBinding: {panLast4: '0001'}, idempotent: false}});
      }
      if (/\/api\/v1\/recharge\/runs\/[^/]+\/results$/.test(target.pathname)) {
        opomCalls.push({type: 'run-result', url: String(url), body: JSON.parse(options.body)});
        return Response.json({data: {auditLogId: 'audit_1', idempotent: false}}, {status: 201});
      }
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const ready = await readyToRechargePayload({
        group: 'recharge',
        opomBaseUrl: 'http://opom.local',
        opomRechargeToken: 'opom-token',
        defaults: {
          holderName: 'Test User',
          country: 'US',
          postalCode: '97001',
          addressLine1: '1 Main St',
          city: 'Portland',
          state: 'OR',
        },
      });
      assert.equal(ready.count, 1);
      assert.equal(ready.rows[0].ads_match_status, 'not_verified');

      const match = await matchAdsPowerPayload({
        rows: ready.rows,
        options: {adspowerApiBase: 'http://adspower.local'},
      });
      assert.equal(match.matched, 1);
      ready.rows[0].ads_match_status = match.results[0].status;
      ready.rows[0].ads_power_user_id = match.results[0].profile.userId;
      ready.rows[0].ads_power_serial_number = match.results[0].profile.serialNumber;
      ready.rows[0].ads_power_group_name = match.results[0].profile.groupName;

      const cardCsv = `card_batch_id,row_number,card_provider,open_status,order_no,card_no,expiry_month,expiry_year,cvv,pan_last4
batch_1,1,EJH,completed,order_1,5257970000000001,06,2028,456,0001
`;
      const allocation = allocateCardsToRows(ready.rows, cardCsv);
      assert.equal(allocation.summary.allocated, 1);

      const options = {
        opomWriteback: true,
        opomBaseUrl: 'http://opom.local',
        opomRechargeToken: 'opom-token',
        adspowerStatusMode: 'group_move',
        adspowerSuccessGroupId: 'group_success',
      };
      const dryRun = await dryRunPayload({fileName: 'opom-recharge.csv', csvText: allocation.csvText, options});
      assert.equal(dryRun.ready, 1);
      const created = await createJob(db, {
        fileName: 'opom-recharge.csv',
        csvText: allocation.csvText,
        options,
        liveConfirmationToken: dryRun.liveConfirmationToken,
      });

      const worker = new JobWorker(db, {
        heartbeatMs: 1000,
        adsPowerStatusFetch: async (url, requestOptions) => {
          adsPowerStatusCalls.push({url, requestOptions});
          return {
            ok: true,
            status: 200,
            json: async () => ({code: 0, msg: 'ok'}),
          };
        },
        executeRowFn: async (csvText, rawIndex, rowOptions) => {
          const row = csvRow(csvText, rawIndex);
          const details = {
            purchaseStatus: 'verified',
            purchaseAmount: '10',
            balanceBefore: '20',
            balanceAfter: '30',
            cardLast4: '0001',
            autoTopupStatus: 'updated',
            autoTopupThreshold: '2',
            autoTopupAmount: '25',
          };
          const writeback = await writeCompletedRow(rowOptions, row, details, {rowNumber: rawIndex + 2});
          details.opomCardWritebackStatus = writeback.cardStatus;
          details.opomResultWritebackStatus = writeback.resultStatus;
          return {
            status: 'completed',
            stage: 'closed_loop.complete',
            message: 'completed',
            details,
            safeToContinue: true,
            stopProfile: true,
            profileStop: {attempted: false},
          };
        },
      });

      await worker.runJob(created.job.id);
      const details = jobDetails(db, created.job.id);
      assert.equal(details.job.status, 'completed');
      assert.equal(details.rows[0].status, 'completed');
      assert.equal(details.rows[0].opomCardWritebackStatus, 'written');
      assert.equal(details.rows[0].opomResultWritebackStatus, 'written');
      assert.equal(details.rows[0].adspowerTagStatus, 'completed');
      assert.equal(details.rows[0].adspowerStatusMode, 'group_move');

      const cardBinding = opomCalls.find((call) => call.type === 'card-binding');
      assert.ok(cardBinding);
      assert.match(cardBinding.body.idempotencyKey, /^card_binding:acct_1:order_1$/);
      assert.equal(cardBinding.body.card.orderNo, 'order_1');
      assert.equal(cardBinding.body.card.cvvPresent, true);
      assert.equal(JSON.stringify(cardBinding.body).includes('456'), false);

      const runResult = opomCalls.find((call) => call.type === 'run-result');
      assert.ok(runResult);
      assert.match(runResult.body.idempotencyKey, /^recharge_result:/);
      assert.equal(runResult.body.status, 'completed');
      assert.deepEqual(runResult.body.card, {orderNo: 'order_1', panLast4: '0001'});

      assert.equal(adsPowerMatchCalls.length, 1);
      assert.equal(adsPowerStatusCalls.length, 1);
      assert.equal(adsPowerStatusCalls[0].url, 'http://127.0.0.1:50325/api/v1/user/regroup');
      assert.deepEqual(JSON.parse(adsPowerStatusCalls[0].requestOptions.body), {
        user_ids: ['profile_ok'],
        group_id: 'group_success',
      });

      const job = getJob(db, created.job.id);
      assert.equal(existsSync(job.result_csv_path), true);
      const resultCsv = readFileSync(job.result_csv_path, 'utf8');
      assert.match(resultCsv, /completed/);
      assert.match(resultCsv, /written/);
      assert.match(resultCsv, /group_move/);
      assert.doesNotMatch(resultCsv, /,456,|cvv/);
    });
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
