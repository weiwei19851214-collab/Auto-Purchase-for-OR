import assert from 'node:assert/strict';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openDatabase, getJob, recoverInterruptedWork} from '../server/db.mjs';
import {createJob, dryRunPayload, jobDetails} from '../server/jobs.mjs';
import {JobWorker} from '../server/worker.mjs';
import {cleanupJobUpload} from '../server/automation-adapter.mjs';

const TWO_ROW_CSV = `status,ID,username,amount,card_number,exp_month,exp_year,cvv,postal_code,auto_topup_threshold,auto_topup_amount
,1415,first@example.com,10,5257970000000001,06,28,456,97001,2,25
,1416,second@example.com,10,5257970000000002,06,28,456,97001,2,25
`;

const ADSPOWER_STATUS_CSV = `status,ads_power_user_id,ads_power_serial_number,login_email,amount,card_number,exp_month,exp_year,cvv,postal_code,auto_topup_threshold,auto_topup_amount
,profile_ok,1415,first@example.com,10,5257970000000001,06,28,456,97001,2,25
`;

const OPOM_STATUS_CSV = `status,opom_account_id,login_email,ads_power_user_id,ads_power_serial_number,ads_match_status,order_no,card_no,exp_month,exp_year,cvv,amount,postal_code,auto_topup_threshold,auto_topup_amount
,acct_1,first@example.com,profile_ok,1415,matched,order_1,5257970000000001,06,28,456,10,97001,2,25
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

test('worker records row exceptions and continues safe batches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-worker-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const dryRun = await dryRunPayload({fileName: 'account.csv', csvText: TWO_ROW_CSV});
    const created = await createJob(db, {
      fileName: 'account.csv',
      csvText: TWO_ROW_CSV,
      liveConfirmationToken: dryRun.liveConfirmationToken,
    });
    const calls = [];
    const worker = new JobWorker(db, {
      heartbeatMs: 1000,
      executeRowFn: async (_csvText, rawIndex) => {
        calls.push(rawIndex);
        if (rawIndex === 0) throw new Error('simulated browser process exited');
        return {
          status: 'completed',
          stage: 'closed_loop.complete',
          message: 'completed',
          details: {
            purchaseStatus: 'verified',
            purchaseAmount: '10',
            balanceBefore: '20',
            balanceAfter: '30',
            cardLast4: '0002',
            autoTopupStatus: 'updated',
            autoTopupThreshold: '2',
            autoTopupAmount: '25',
          },
          safeToContinue: true,
          stopProfile: true,
          profileStop: {attempted: false},
        };
      },
    });

    await worker.runJob(created.job.id);
    const details = jobDetails(db, created.job.id);
    assert.deepEqual(calls, [0, 1]);
    assert.equal(details.job.status, 'completed');
    assert.equal(details.rows[0].status, 'failed');
    assert.equal(details.rows[0].stage, 'automation');
    assert.match(details.rows[0].message, /simulated browser process exited/);
    assert.equal(details.rows[1].status, 'completed');
    assert.equal(details.events.some((event) => event.type === 'row.error'), true);
    assert.equal(existsSync(getJob(db, created.job.id).result_csv_path), true);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('worker writes OPOM failure result when an unexpected row exception occurs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-worker-opom-failure-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const options = {
      opomWriteback: true,
      opomBaseUrl: 'http://opom.local',
      opomRechargeToken: 'opom-token',
    };
    const dryRun = await dryRunPayload({fileName: 'opom.csv', csvText: OPOM_STATUS_CSV, options});
    const created = await createJob(db, {
      fileName: 'opom.csv',
      csvText: OPOM_STATUS_CSV,
      options,
      liveConfirmationToken: dryRun.liveConfirmationToken,
    });
    const calls = [];
    await withFetch(async (url, requestOptions = {}) => {
      calls.push({url: String(url), body: JSON.parse(requestOptions.body || '{}')});
      return Response.json({data: {auditLogId: 'audit_1'}}, {status: 201});
    }, async () => {
      const worker = new JobWorker(db, {
        heartbeatMs: 1000,
        executeRowFn: async () => {
          throw new Error('simulated crash card_number=5257970000000001 cvv=456 token=secret');
        },
      });
      await worker.runJob(created.job.id);
    });

    const details = jobDetails(db, created.job.id);
    assert.equal(details.rows[0].status, 'failed');
    assert.equal(details.rows[0].opomResultWritebackStatus, 'written');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `http://opom.local/api/v1/recharge/runs/${created.job.id}/results`);
    assert.equal(calls[0].body.opomAccountId, 'acct_1');
    assert.equal(calls[0].body.status, 'failed');
    assert.equal(calls[0].body.errorCode, 'failed');
    assert.match(calls[0].body.idempotencyKey, new RegExp(`^recharge_result:${created.job.id}:2:1$`));
    assert.doesNotMatch(JSON.stringify(calls[0].body), /5257970000000001|cvv=456|token=secret/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('worker writes AdsPower status through injected fetch after row completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-adspower-status-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const options = {
      adspowerStatusMode: 'group_move',
      adspowerSuccessGroupId: 'group_success',
    };
    const dryRun = await dryRunPayload({fileName: 'account.csv', csvText: ADSPOWER_STATUS_CSV, options});
    const created = await createJob(db, {
      fileName: 'account.csv',
      csvText: ADSPOWER_STATUS_CSV,
      options,
      liveConfirmationToken: dryRun.liveConfirmationToken,
    });
    const calls = [];
    const worker = new JobWorker(db, {
      heartbeatMs: 1000,
      adsPowerStatusFetch: async (url, requestOptions) => {
        calls.push({url, requestOptions});
        return {
          ok: true,
          status: 200,
          json: async () => ({code: 0, msg: 'ok'}),
        };
      },
      executeRowFn: async () => ({
        status: 'completed',
        stage: 'closed_loop.complete',
        message: 'completed',
        details: {
          purchaseStatus: 'verified',
          purchaseAmount: '10',
          balanceBefore: '20',
          balanceAfter: '30',
          cardLast4: '0001',
          autoTopupStatus: 'updated',
          autoTopupThreshold: '2',
          autoTopupAmount: '25',
        },
        safeToContinue: true,
        stopProfile: true,
        profileStop: {attempted: false},
      }),
    });

    await worker.runJob(created.job.id);
    const details = jobDetails(db, created.job.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:50325/api/v1/user/regroup');
    assert.deepEqual(JSON.parse(calls[0].requestOptions.body), {
      user_ids: ['profile_ok'],
      group_id: 'group_success',
    });
    assert.equal(details.rows[0].adspowerTagStatus, 'completed');
    assert.equal(details.rows[0].adspowerStatusMode, 'group_move');
    assert.equal(details.rows[0].adspowerStatusTarget, 'group:success:group_success');
    assert.equal(details.rows[0].adspowerStatusReason, '');
    assert.equal(details.events.some((event) => event.type === 'adspower.status'), true);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('recovery blocks interrupted running work and rewrites sanitized result CSV', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-recovery-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const dryRun = await dryRunPayload({fileName: 'account.csv', csvText: TWO_ROW_CSV});
    const created = await createJob(db, {
      fileName: 'account.csv',
      csvText: TWO_ROW_CSV,
      liveConfirmationToken: dryRun.liveConfirmationToken,
    });
    const firstRow = jobDetails(db, created.job.id).rows[0];
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(created.job.id);
    db.prepare(`
      UPDATE job_rows
      SET status = 'running',
        stage = 'worker.running',
        message = 'in progress with card_number=5257970000000001 cvv=456'
      WHERE id = ?
    `).run(firstRow.id);

    const recovered = recoverInterruptedWork(db);
    assert.deepEqual(recovered, [created.job.id]);

    const worker = new JobWorker(db, {heartbeatMs: 1000});
    await worker.writeCurrentResult(created.job.id);
    cleanupJobUpload(getJob(db, created.job.id));

    const details = jobDetails(db, created.job.id);
    assert.equal(details.job.status, 'blocked');
    assert.equal(details.rows[0].status, 'purchase_unverified');
    assert.equal(details.rows[0].stage, 'worker.interrupted');
    assert.match(details.rows[0].message, /server restarted during row execution/);
    assert.equal(details.events.some((event) => event.type === 'row.interrupted'), true);
    assert.equal(details.events.some((event) => event.type === 'job.recovered_blocked'), true);

    const job = getJob(db, created.job.id);
    assert.equal(existsSync(job.csv_path), false);
    assert.equal(existsSync(job.result_csv_path), true);
    const resultCsv = readFileSync(job.result_csv_path, 'utf8');
    assert.match(resultCsv, /purchase_unverified/);
    assert.match(resultCsv, /server restarted during row execution/);
    assert.doesNotMatch(resultCsv, /,456,|card_number|cvv/i);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
