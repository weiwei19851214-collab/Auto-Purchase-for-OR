import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {promisify} from 'node:util';
import {mkdtempSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {getJob, openDatabase} from '../server/db.mjs';
import {cancelJob, createJob, defaultRechargeJobName, dryRunPayload, jobDetails, repairOpomWriteback, resumeJob, resumePreview} from '../server/jobs.mjs';
import {executeRowWithAdapters, parsePlan, runnerArgs, writeResultCsv} from '../server/automation-adapter.mjs';
import {readFileSync, existsSync} from 'node:fs';
import * as rechargePlan from '../automation/lib/recharge-plan.mjs';
import * as csv from '../automation/lib/csv.mjs';

const execFileAsync = promisify(execFile);

const VALID_CSV = `status,ID,username,amount,card_number,exp_month,exp_year,cvv,postal_code,auto_topup_threshold,auto_topup_amount
,1415,user@example.com,10,5257970000000001,06,28,456,97001,2,25
`;

const THREE_ROW_CSV = `status,ID,username,amount,card_number,exp_month,exp_year,cvv,postal_code,auto_topup_threshold,auto_topup_amount
,1415,first@example.com,10,5257970000000001,06,28,456,97001,2,25
,1416,second@example.com,10,5257970000000002,06,28,456,97001,2,25
,1417,third@example.com,10,5257970000000003,06,28,456,97001,2,25
`;

const MISSING_CSV = `status,ID,username,amount,card_number,exp_month,exp_year,cvv,postal_code,auto_topup_threshold,auto_topup_amount
,1415,user@example.com,,5257970000000001,06,28,456,97001,2,25
`;

const BASE_CSV = `status,ID,username
,1415,user@example.com
`;

const PURCHASE_ONLY_CSV = `status,ID,username,amount
,1415,user@example.com,10
`;

const BALANCE_RULE_PURCHASE_CSV = `status,ID,username,balance_threshold,amount_below_threshold,amount_at_or_above_threshold
,1415,user@example.com,200,200,10
`;

const CARD_ONLY_CSV = `status,ID,username,card_number,exp_month,exp_year,cvv,postal_code
,1415,user@example.com,5257970000000001,06,28,456,97001
`;

const AUTO_TOPUP_ONLY_CSV = `status,ID,username,auto_topup_threshold,auto_topup_amount
,1415,user@example.com,200,200
`;

const BILLING_ONLY_CSV = `status,ID,username,holder_name,country,postal_code,address_line1,city,state
,1415,user@example.com,Test User,US,97001,1 Main St,Antelope,OR
`;

const OPOM_CANONICAL_CSV = `status,opom_account_id,login_email,ads_power_user_id,ads_power_serial_number,opom_health_status,opom_health_reason,ads_match_status,order_no,amount,card_no,exp_month,exp_year,cvv,postal_code,auto_topup_threshold,auto_topup_amount
,acct_1,finance.owner@example.com,ads-user-1,1415,ok,,matched,ejh_order_1,10,5257970000000001,06,28,456,97001,2,25
`;

test('parsePlan returns ready rows with full card number for reconciliation', async () => {
  const plan = await parsePlan(VALID_CSV);
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].status, 'ready');
  assert.equal(plan.rows[0].cardNo, '5257970000000001');
  assert.equal(plan.rows[0].cardLast4, '0001');
});

test('runnerArgs supports no-purchase test mode', () => {
  const args = runnerArgs({confirmPurchase: false, preparePurchaseOnly: true});
  assert.equal(args.confirmPurchase, false);
  assert.equal(args.preparePurchaseOnly, true);
});

test('runnerArgs clamps concurrency to a safe local range', () => {
  assert.equal(runnerArgs({concurrency: 2}).concurrency, 2);
  assert.equal(runnerArgs({concurrency: 0}).concurrency, 1);
  assert.equal(runnerArgs({concurrency: 99}).concurrency, 5);
  assert.equal(runnerArgs({concurrency: 'bad'}).concurrency, 1);
});

test('runnerArgs disables purchase confirmation when purchase scope is off', () => {
  const args = runnerArgs({scopePurchase: false, confirmPurchase: true, preparePurchaseOnly: true});
  assert.equal(args.scopePurchase, false);
  assert.equal(args.confirmPurchase, false);
  assert.equal(args.preparePurchaseOnly, false);
});

test('parsePlan validates execution scopes independently', async () => {
  const autoTopup = await parsePlan(AUTO_TOPUP_ONLY_CSV, {
    scopeBillingAddress: false,
    scopePaymentMethod: false,
    scopePurchase: false,
    scopeAutoTopup: true,
  });
  assert.equal(autoTopup.rows[0].status, 'ready');
  assert.equal(autoTopup.rows[0].executionScope, 'auto_topup');

  const purchase = await parsePlan(PURCHASE_ONLY_CSV, {
    scopeBillingAddress: false,
    scopePaymentMethod: false,
    scopePurchase: true,
    scopeAutoTopup: false,
  });
  assert.equal(purchase.rows[0].status, 'ready');
  assert.equal(purchase.rows[0].executionScope, 'purchase');

  const balanceRulePurchase = await parsePlan(BALANCE_RULE_PURCHASE_CSV, {
    scopeBillingAddress: false,
    scopePaymentMethod: false,
    scopePurchase: true,
    scopeAutoTopup: false,
  });
  assert.equal(balanceRulePurchase.rows[0].status, 'ready');
  assert.equal(balanceRulePurchase.rows[0].purchasePlan, 'balance_rule');
  assert.equal(balanceRulePurchase.rows[0].executionScope, 'purchase');

  const card = await parsePlan(CARD_ONLY_CSV, {
    scopeBillingAddress: false,
    scopePaymentMethod: true,
    scopePurchase: false,
    scopeAutoTopup: false,
  });
  assert.equal(card.rows[0].status, 'ready');
  assert.equal(card.rows[0].executionScope, 'payment_method');

  const billing = await parsePlan(BILLING_ONLY_CSV, {
    scopeBillingAddress: true,
    scopePaymentMethod: false,
    scopePurchase: false,
    scopeAutoTopup: false,
  });
  assert.equal(billing.rows[0].status, 'ready');
  assert.equal(billing.rows[0].executionScope, 'billing_address');
});

test('parsePlan rejects empty execution scope', async () => {
  const result = await parsePlan(BASE_CSV, {
    scopeBillingAddress: false,
    scopePaymentMethod: false,
    scopePurchase: false,
    scopeAutoTopup: false,
  });
  assert.equal(result.rows[0].status, 'missing_fields');
  assert.deepEqual(result.rows[0].missing, ['execution_scope']);
});

test('buildClosedLoopTask maps scoped purchase without card to purchaseOnly mode', () => {
  const row = {
    ID: '1415',
    username: 'user@example.com',
    amount: '10',
    auto_topup_threshold: '200',
    auto_topup_amount: '200',
  };
  const task = rechargePlan.buildClosedLoopTask(row, runnerArgs({
    scopeBillingAddress: false,
    scopePaymentMethod: false,
    scopePurchase: true,
    scopeAutoTopup: true,
  }));
  assert.equal(task.purchaseOnly, true);
  assert.equal(task.autoTopup.enabled, true);
  assert.equal(task.removeExistingPaymentMethod, false);
  assert.equal(task.card.number || '', '');
});

test('billing-address-only browser path refuses Add Credits fallback', () => {
  const script = readFileSync(join(process.cwd(), 'src/automation/bind_openrouter_card_cdp.mjs'), 'utf8');
  assert.match(script, /requireAddPaymentMethod:\s*input\.billingAddressOnly/);
  assert.match(script, /refusing Add Credits fallback/);
  assert.match(script, /async function clickAddPaymentMethod/);
});

test('dryRunPayload reports row-level missing fields', async () => {
  const result = await dryRunPayload({fileName: 'missing.csv', csvText: MISSING_CSV});
  assert.equal(result.ok, true);
  assert.equal(result.ready, 0);
  assert.equal(result.blocked, 1);
  assert.deepEqual(result.rows[0].missing, ['amount']);
});

test('defaultRechargeJobName uses China time and recharge count', () => {
  const name = defaultRechargeJobName(55, new Date('2026-06-09T02:27:00.000Z'));
  assert.equal(name, '20260609-1027-55');
});

test('createJob stores queued row summaries in sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const dryRun = await dryRunPayload({fileName: 'account.csv', csvText: VALID_CSV});
    const result = await createJob(db, {
      fileName: 'account.csv',
      csvText: VALID_CSV,
      liveConfirmationToken: dryRun.liveConfirmationToken,
    });
    assert.equal(result.job.status, 'queued');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].status, 'queued');
    assert.equal(result.rows[0].username, 'user@example.com');
    assert.equal(result.rows[0].cardNo, '5257970000000001');
    assert.match(result.job.fileName, /^\d{8}-\d{4}-1$/);
    assert.notEqual(result.job.fileName, 'account.csv');
    assert.doesNotMatch(JSON.stringify(result), /card_number|"cvv"|cvv=/i);
    assert.equal(jobDetails(db, result.job.id).job.readyRows, 1);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('createJob defaults OPOM writeback runId to job id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-opom-runid-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const options = {opomWriteback: true};
    const dryRun = await dryRunPayload({fileName: 'account.csv', csvText: VALID_CSV, options});
    const result = await createJob(db, {
      fileName: 'account.csv',
      csvText: VALID_CSV,
      options,
      liveConfirmationToken: dryRun.liveConfirmationToken,
    });
    const stored = JSON.parse(getJob(db, result.job.id).options_json);
    assert.equal(stored.runId, result.job.id);
    assert.equal(result.job.options.opomWriteback, true);
    assert.equal(result.job.options.runId, result.job.id);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('createJob rejects live execution without dry-run confirmation token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-token-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    await assert.rejects(
      () => createJob(db, {fileName: 'account.csv', csvText: VALID_CSV}),
      /dry-run confirmation token/i,
    );
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('createJob allows all-blocked dry-run result without live confirmation token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-blocked-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const result = await createJob(db, {fileName: 'missing.csv', csvText: MISSING_CSV});
    const job = getJob(db, result.job.id);
    assert.equal(result.job.status, 'completed');
    assert.equal(result.job.readyRows, 0);
    assert.equal(result.rows[0].status, 'missing_fields');
    assert.equal(existsSync(job.csv_path), true);
    assert.equal(existsSync(job.result_csv_path), true);
    const text = readFileSync(job.result_csv_path, 'utf8');
    assert.match(text, /missing_fields/);
    assert.match(text, new RegExp(result.job.id));
    assert.match(text, /5257970000000001/);
    assert.doesNotMatch(text, /,456,|card_number|cvv/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('createJob rejects stale dry-run confirmation when options change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-stale-token-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const dryRun = await dryRunPayload({
      fileName: 'account.csv',
      csvText: VALID_CSV,
      options: {removeExisting: true},
    });
    await assert.rejects(
      () => createJob(db, {
        fileName: 'account.csv',
        csvText: VALID_CSV,
        options: {removeExisting: false},
        liveConfirmationToken: dryRun.liveConfirmationToken,
      }),
      /CSV or options changed after dry-run/i,
    );
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('createJob rejects dry-run confirmation when purchase submission mode changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-purchase-mode-token-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const noPurchaseOptions = {confirmPurchase: false, preparePurchaseOnly: true};
    const dryRun = await dryRunPayload({
      fileName: 'account.csv',
      csvText: VALID_CSV,
      options: noPurchaseOptions,
    });
    await assert.rejects(
      () => createJob(db, {
        fileName: 'account.csv',
        csvText: VALID_CSV,
        options: {confirmPurchase: true, preparePurchaseOnly: false},
        liveConfirmationToken: dryRun.liveConfirmationToken,
      }),
      /CSV or options changed after dry-run/i,
    );
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('executeRow marks verified purchase as failed when OPOM completed writeback fails', async () => {
  const failedResults = [];
  const result = await executeRowWithAdapters(OPOM_CANONICAL_CSV, 0, {
    opomWriteback: true,
    opomBaseUrl: 'http://opom.local',
    opomRechargeToken: 'opom-token',
    stopProfiles: false,
  }, {
    runClosedLoopChildAsync: async () => ({
      ok: true,
      result: {
        ok: true,
        purchase: {
          amount: '10',
          balanceVerification: {
            verified: true,
            beforeBalance: '20',
            afterBalance: '30',
          },
        },
        card: {last4: '0001'},
        autoTopup: {
          configured: true,
          changed: true,
          requested: {threshold: '2', amount: '25'},
        },
      },
    }),
    opom: {
      writeCompletedRow: async () => {
        const error = new Error('OPOM writeback outage token=secret card_number=5257970000000001');
        error.opomCardWritebackStatus = 'written';
        error.opomResultWritebackStatus = 'failed';
        throw error;
      },
      writeRowResult: async (args, row, details, context) => {
        failedResults.push({
          runId: args.runId,
          opomAccountId: row.opom_account_id,
          details,
          context,
        });
        return {resultStatus: 'written'};
      },
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'opom.writeback');
  assert.equal(result.details.purchaseStatus, 'verified');
  assert.equal(result.details.opomCardWritebackStatus, 'written');
  assert.equal(result.details.opomResultWritebackStatus, 'written');
  assert.equal(result.safeToContinue, true);
  assert.equal(failedResults.length, 1);
  assert.equal(failedResults[0].context.stage, 'opom.writeback');
  assert.equal(failedResults[0].context.errorCode, 'opom_writeback_failed');
  assert.doesNotMatch(result.message, /token=secret|5257970000000001/);
  assert.doesNotMatch(JSON.stringify(failedResults), /token=secret|456/);
});

test('writeResultCsv appends result columns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-csv-'));
  try {
    const csvPath = join(dir, 'input.csv');
    const resultPath = join(dir, 'result.csv');
    await import('node:fs').then((fs) => fs.writeFileSync(csvPath, VALID_CSV, 'utf8'));
    await writeResultCsv({
      csvPath,
      resultCsvPath: resultPath,
      runId: 'run_csv_1',
      rowsByRawIndex: [{
        rawIndex: 0,
        status: 'completed',
        message: 'completed',
        details: {
          purchaseStatus: 'verified',
          purchaseAmount: '10',
          balanceBefore: 20,
          balanceAfter: 30,
          cardLast4: '0001',
          autoTopupStatus: 'updated',
          autoTopupThreshold: '2',
          autoTopupAmount: '25',
          adspowerTagStatus: 'completed',
          adspowerStatusMode: 'group_move',
          adspowerStatusTarget: 'group:success:g-success',
          adspowerStatusReason: '',
        },
      }],
    });
    assert.equal(existsSync(resultPath), true);
    const text = readFileSync(resultPath, 'utf8');
    const parsed = csv.parseCsv(text);
    const header = parsed[0];
    const firstRow = csv.rowObject(header, parsed[1]);
    assert.match(text, /task_status/);
    assert.match(text, /completed/);
    assert.match(text, /verified/);
    assert.match(text, /adspower_status_mode/);
    assert.match(text, /group_move/);
    assert.equal(firstRow.run_id, 'run_csv_1');
    assert.equal(firstRow.adspower_status_target, 'group:success:g-success');
    assert.equal(firstRow.completion_evidence_status, 'production_complete');
    assert.equal(firstRow.completion_evidence_missing, '');
    assert.equal(firstRow.cardno, '5257970000000001');
    assert.doesNotMatch(text, /,456,|card_number|cvv/);
    assert.match(text, /username/);
    assert.match(text, /login_email/);
    assert.doesNotMatch(text, /username_masked|login_email_masked/);
    assert.equal(new Set(header).size, header.length);
    for (const column of [
      'run_id',
      'row_number',
      'opom_account_id',
      'ads_power_user_id',
      'ads_power_serial_number',
      'opom_health_status',
      'opom_health_reason',
      'username',
      'login_email',
      'ejh_order_no',
      'cardno',
      'task_status',
      'opom_card_writeback_status',
      'opom_result_writeback_status',
      'adspower_tag_status',
      'adspower_status_mode',
      'adspower_status_target',
      'adspower_status_reason',
      'completion_evidence_status',
      'completion_evidence_missing',
    ]) {
      assert.ok(header.includes(column), `${column} should be present`);
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('writeResultCsv preserves source metadata when outcome details omit it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-csv-metadata-'));
  try {
    const csvPath = join(dir, 'input.csv');
    const resultPath = join(dir, 'result.csv');
    await import('node:fs').then((fs) => fs.writeFileSync(csvPath, OPOM_CANONICAL_CSV, 'utf8'));
    await writeResultCsv({
      csvPath,
      resultCsvPath: resultPath,
      runId: 'run_metadata_1',
      rowsByRawIndex: [{
        rawIndex: 0,
        status: 'completed',
        message: 'completed',
        details: {
          purchaseStatus: 'verified',
          purchaseAmount: '10',
          balanceBefore: 20,
          balanceAfter: 30,
          cardLast4: '0001',
          autoTopupStatus: 'updated',
          autoTopupThreshold: '2',
          autoTopupAmount: '25',
        },
      }],
    });
    const parsed = csv.parseCsv(readFileSync(resultPath, 'utf8'));
    const firstRow = csv.rowObject(parsed[0], parsed[1]);
    assert.equal(firstRow.run_id, 'run_metadata_1');
    assert.equal(firstRow.opom_account_id, 'acct_1');
    assert.equal(firstRow.ads_power_user_id, 'ads-user-1');
    assert.equal(firstRow.ads_power_serial_number, '1415');
    assert.equal(firstRow.opom_health_status, 'ok');
    assert.equal(firstRow.opom_health_reason, '');
    assert.equal(firstRow.ads_match_status, 'matched');
    assert.equal(firstRow.ejh_order_no, 'ejh_order_1');
    assert.equal(firstRow.login_email, 'finance.owner@example.com');
    assert.equal(firstRow.username, 'finance.owner@example.com');
    assert.equal(firstRow.purchase_status, 'verified');
    assert.equal(firstRow.card_last4, '0001');
    assert.equal(firstRow.cardno, '5257970000000001');
    assert.equal(firstRow.completion_evidence_status, 'incomplete');
    assert.match(firstRow.completion_evidence_missing, /opom_card_writeback_status/);
    assert.match(firstRow.completion_evidence_missing, /opom_result_writeback_status/);
    assert.equal(firstRow.adspower_tag_status, 'skipped_user_waived');
    assert.equal(firstRow.adspower_status_target, 'waived_by_user');
    assert.doesNotMatch(firstRow.completion_evidence_missing, /adspower_tag_status/);
    assert.doesNotMatch(firstRow.completion_evidence_missing, /adspower_status_target/);
    assert.doesNotMatch(readFileSync(resultPath, 'utf8'), /,456,|card_number|cvv/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('writeResultCsv distinguishes no-purchase rehearsal from production completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-csv-evidence-test-mode-'));
  try {
    const csvPath = join(dir, 'input.csv');
    const resultPath = join(dir, 'result.csv');
    writeFileSync(csvPath, VALID_CSV, 'utf8');
    await writeResultCsv({
      csvPath,
      resultCsvPath: resultPath,
      runId: 'run_test_mode_1',
      rowsByRawIndex: [{
        rawIndex: 0,
        status: 'completed',
        message: 'prepared without submission',
        details: {
          purchaseStatus: 'prepared_without_submission',
          cardLast4: '0001',
          autoTopupStatus: 'updated',
          autoTopupThreshold: '2',
          autoTopupAmount: '25',
        },
      }],
    });

    const parsed = csv.parseCsv(readFileSync(resultPath, 'utf8'));
    const row = csv.rowObject(parsed[0], parsed[1]);
    assert.equal(row.task_status, 'completed');
    assert.equal(row.purchase_status, 'prepared_without_submission');
    assert.equal(row.completion_evidence_status, 'test_mode_complete');
    assert.equal(row.completion_evidence_missing, 'purchase_not_submitted');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('writeResultCsv requires Auto top-up readback for production completion evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-csv-evidence-autotopup-'));
  try {
    const csvPath = join(dir, 'input.csv');
    const resultPath = join(dir, 'result.csv');
    writeFileSync(csvPath, VALID_CSV, 'utf8');
    await writeResultCsv({
      csvPath,
      resultCsvPath: resultPath,
      runId: 'run_missing_autotopup_1',
      rowsByRawIndex: [{
        rawIndex: 0,
        status: 'completed',
        message: 'purchase verified but auto top-up skipped',
        details: {
          purchaseStatus: 'verified',
          purchaseAmount: '10',
          balanceBefore: 20,
          balanceAfter: 30,
          cardLast4: '0001',
          autoTopupStatus: 'skipped',
          adspowerTagStatus: 'completed',
          adspowerStatusMode: 'remark_append_v2',
          adspowerStatusTarget: 'remark:v2',
        },
      }],
    });

    const parsed = csv.parseCsv(readFileSync(resultPath, 'utf8'));
    const row = csv.rowObject(parsed[0], parsed[1]);
    assert.equal(row.task_status, 'completed');
    assert.equal(row.purchase_status, 'verified');
    assert.equal(row.completion_evidence_status, 'incomplete');
    assert.equal(row.completion_evidence_missing, 'auto_topup_status');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('writeResultCsv accepts user-waived AdsPower status evidence for production completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-csv-evidence-adspower-'));
  try {
    const csvPath = join(dir, 'input.csv');
    const resultPath = join(dir, 'result.csv');
    writeFileSync(csvPath, VALID_CSV, 'utf8');
    await writeResultCsv({
      csvPath,
      resultCsvPath: resultPath,
      runId: 'run_missing_adspower_1',
      rowsByRawIndex: [{
        rawIndex: 0,
        status: 'completed',
        message: 'purchase verified and AdsPower status writeback was waived',
        details: {
          purchaseStatus: 'verified',
          purchaseAmount: '10',
          balanceBefore: 20,
          balanceAfter: 30,
          cardLast4: '0001',
          autoTopupStatus: 'updated',
          autoTopupThreshold: '2',
          autoTopupAmount: '25',
          adspowerTagStatus: 'skipped_user_waived',
          adspowerStatusMode: 'disabled',
          adspowerStatusTarget: 'waived_by_user',
          adspowerStatusReason: 'user_waived_status_writeback',
        },
      }],
    });

    const parsed = csv.parseCsv(readFileSync(resultPath, 'utf8'));
    const row = csv.rowObject(parsed[0], parsed[1]);
    assert.equal(row.task_status, 'completed');
    assert.equal(row.purchase_status, 'verified');
    assert.equal(row.adspower_tag_status, 'skipped_user_waived');
    assert.equal(row.adspower_status_target, 'waived_by_user');
    assert.equal(row.completion_evidence_status, 'production_complete');
    assert.equal(row.completion_evidence_missing, '');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('writeResultCsv does not convert skipped prior rows into completed evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-csv-skipped-'));
  try {
    const csvPath = join(dir, 'input.csv');
    const resultPath = join(dir, 'result.csv');
    writeFileSync(csvPath, `status,ID,username,amount,card_number,exp_month,exp_year,cvv,postal_code,auto_topup_threshold,auto_topup_amount
completed,1415,old@example.com,10,5257970000000001,06,28,456,97001,2,25
`, 'utf8');

    await writeResultCsv({
      csvPath,
      resultCsvPath: resultPath,
      runId: 'run_skipped_1',
      rowsByRawIndex: [{
        rawIndex: 0,
        status: 'skipped',
        message: 'row is already completed or not eligible',
        details: {},
      }],
    });

    const parsed = csv.parseCsv(readFileSync(resultPath, 'utf8'));
    const row = csv.rowObject(parsed[0], parsed[1]);
    assert.equal(row.run_id, 'run_skipped_1');
    assert.equal(row.task_status, 'skipped');
    assert.equal(row.purchase_status, '');
    assert.match(row.task_message, /no new charge attempted|already completed/i);
    assert.notEqual(row.task_status, 'completed');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('writeResultCsv escapes formula-like cells for spreadsheet handoff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-csv-formula-'));
  try {
    const csvPath = join(dir, 'input.csv');
    const resultPath = join(dir, 'result.csv');
    await import('node:fs').then((fs) => fs.writeFileSync(
      csvPath,
      `status,ID,username,amount,card_number,exp_month,exp_year,cvv,postal_code,auto_topup_threshold,auto_topup_amount,opom_health_reason
,1415,user@example.com,10,5257970000000001,06,28,456,97001,2,25,=IMPORTXML("http://example.invalid")
`,
      'utf8',
    ));
    await writeResultCsv({
      csvPath,
      resultCsvPath: resultPath,
      runId: 'run_formula_1',
      rowsByRawIndex: [{
        rawIndex: 0,
        status: 'failed',
        message: '+formula-like failure',
        details: {
          purchaseStatus: 'failed',
          adspowerTagStatus: 'failed',
          adspowerStatusMode: 'disabled',
        },
      }],
    });
    const text = readFileSync(resultPath, 'utf8');
    assert.match(text, /'=IMPORTXML/);
    assert.match(text, /'\+formula-like failure/);
    assert.doesNotMatch(text, /(^|,|\r?\n)"?[=+\-@][^,\r\n"]*/);
    assert.doesNotMatch(text, /,456,|card_number|cvv/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('cancelJob writes sanitized result and preserves queued raw upload for resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-cancel-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const dryRun = await dryRunPayload({fileName: 'account.csv', csvText: VALID_CSV});
    const created = await createJob(db, {
      fileName: 'account.csv',
      csvText: VALID_CSV,
      liveConfirmationToken: dryRun.liveConfirmationToken,
    });
    const job = getJob(db, created.job.id);
    assert.equal(existsSync(job.csv_path), true);
    const canceled = await cancelJob(db, created.job.id);
    assert.equal(canceled.job.status, 'canceled');
    assert.equal(existsSync(job.csv_path), true);
    assert.equal(existsSync(job.result_csv_path), true);
    const text = readFileSync(job.result_csv_path, 'utf8');
    assert.match(text, /failed/);
    assert.match(text, /job canceled before execution/);
    assert.match(text, new RegExp(created.job.id));
    assert.doesNotMatch(text, /,456,|card_number|cvv/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('resumeJob queues failed rows from selected row and skips completed rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-resume-mid-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const dryRun = await dryRunPayload({fileName: 'account.csv', csvText: THREE_ROW_CSV});
    const created = await createJob(db, {
      fileName: 'account.csv',
      csvText: THREE_ROW_CSV,
      liveConfirmationToken: dryRun.liveConfirmationToken,
    });
    const rows = jobDetails(db, created.job.id).rows;
    db.prepare(`
      UPDATE job_rows
      SET status = ?, stage = ?, message = ?, purchase_status = ?, purchase_amount = ?, balance_before = ?, balance_after = ?, finished_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run('completed', 'closed_loop.complete', 'completed', 'verified', '10', '20', '30', rows[0].id);
    db.prepare(`
      UPDATE job_rows
      SET status = ?, stage = ?, message = ?, purchase_status = ?, purchase_amount = ?, balance_before = ?, balance_after = ?, finished_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run('failed', 'automation', 'old failure', 'failed', '10', '20', '20', rows[1].id);
    db.prepare(`
      UPDATE job_rows
      SET status = ?, stage = ?, message = ?, purchase_status = ?, purchase_amount = ?, balance_before = ?, balance_after = ?, finished_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run('canceled', 'canceled', 'old canceled', 'canceled', '10', '20', '20', rows[2].id);
    db.prepare("UPDATE jobs SET status = 'blocked', cancel_requested = 1, error = 'old error', finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(created.job.id);

    const preview = await resumePreview(db, created.job.id, {startRowNumber: 3});
    assert.deepEqual(preview.queuedRows.map((row) => row.rowNumber), [3, 4]);
    assert.deepEqual(preview.skippedCompletedRows.map((row) => row.rowNumber), []);

    const resumed = await resumeJob(db, created.job.id, {startRowNumber: 2});
    assert.equal(resumed.job.status, 'queued');
    assert.equal(resumed.job.cancelRequested, false);
    assert.equal(resumed.job.error, '');
    const details = jobDetails(db, created.job.id);
    assert.equal(details.rows[0].status, 'completed');
    assert.equal(details.rows[1].status, 'queued');
    assert.equal(details.rows[1].message, 'queued for resume');
    assert.equal(details.rows[1].purchaseStatus, '');
    assert.equal(details.rows[1].balanceBefore, '');
    assert.equal(details.rows[2].status, 'queued');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('resumeJob skips risky rows by default and includes them only with confirmation flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-resume-risky-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const dryRun = await dryRunPayload({fileName: 'account.csv', csvText: THREE_ROW_CSV});
    const created = await createJob(db, {
      fileName: 'account.csv',
      csvText: THREE_ROW_CSV,
      liveConfirmationToken: dryRun.liveConfirmationToken,
    });
    const rows = jobDetails(db, created.job.id).rows;
    db.prepare("UPDATE job_rows SET status = 'purchase_unverified', stage = 'worker.interrupted', message = 'needs review' WHERE id = ?").run(rows[0].id);
    db.prepare("UPDATE job_rows SET status = 'manual_security_blocker', stage = 'security', message = 'manual check' WHERE id = ?").run(rows[1].id);
    db.prepare("UPDATE job_rows SET status = 'failed', stage = 'automation', message = 'ordinary failure' WHERE id = ?").run(rows[2].id);
    db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(created.job.id);

    const preview = await resumePreview(db, created.job.id, {startRowNumber: 2});
    assert.deepEqual(preview.queuedRows.map((row) => row.rowNumber), [4]);
    assert.deepEqual(preview.skippedRiskyRows.map((row) => row.rowNumber), [2, 3]);

    await resumeJob(db, created.job.id, {startRowNumber: 2});
    let details = jobDetails(db, created.job.id);
    assert.equal(details.rows[0].status, 'purchase_unverified');
    assert.equal(details.rows[1].status, 'manual_security_blocker');
    assert.equal(details.rows[2].status, 'queued');

    db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(created.job.id);
    await resumeJob(db, created.job.id, {startRowNumber: 2, includeRiskyRows: true});
    details = jobDetails(db, created.job.id);
    assert.equal(details.rows[0].status, 'queued');
    assert.equal(details.rows[1].status, 'queued');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('resumeJob rejects old jobs when only an insufficient result CSV remains', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-resume-missing-csv-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const dryRun = await dryRunPayload({fileName: 'account.csv', csvText: VALID_CSV});
    const created = await createJob(db, {
      fileName: 'account.csv',
      csvText: VALID_CSV,
      liveConfirmationToken: dryRun.liveConfirmationToken,
    });
    const job = getJob(db, created.job.id);
    unlinkSync(job.csv_path);
    writeFileSync(job.result_csv_path, 'run_id,row_number,status,message\nrun,2,failed,old failure\n');
    db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(created.job.id);
    db.prepare("UPDATE job_rows SET status = 'failed', message = 'old failure' WHERE job_id = ?").run(created.job.id);

    await assert.rejects(
      () => resumeJob(db, created.job.id, {startRowNumber: 2}),
      /CSV cannot be used for resume/,
    );
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('resumeJob rewrites result CSV without old failure results for requeued rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-resume-result-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const dryRun = await dryRunPayload({fileName: 'account.csv', csvText: VALID_CSV});
    const created = await createJob(db, {
      fileName: 'account.csv',
      csvText: VALID_CSV,
      liveConfirmationToken: dryRun.liveConfirmationToken,
    });
    const row = jobDetails(db, created.job.id).rows[0];
    db.prepare("UPDATE job_rows SET status = 'failed', stage = 'automation', message = 'old failure', purchase_status = 'failed' WHERE id = ?").run(row.id);
    db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(created.job.id);
    await writeResultCsv({
      csvPath: getJob(db, created.job.id).csv_path,
      resultCsvPath: getJob(db, created.job.id).result_csv_path,
      runId: created.job.id,
      rowsByRawIndex: [{rawIndex: 0, status: 'failed', message: 'old failure'}],
    });
    assert.match(readFileSync(getJob(db, created.job.id).result_csv_path, 'utf8'), /old failure/);

    await resumeJob(db, created.job.id, {startRowNumber: 2});
    const text = readFileSync(getJob(db, created.job.id).result_csv_path, 'utf8');
    assert.doesNotMatch(text, /old failure/);
    assert.doesNotMatch(text, /failed/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('repairOpomWriteback completes verified opom writeback failures without rerunning purchase', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-opom-repair-'));
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({url: String(url), body: JSON.parse(options.body)});
      return Response.json({data: {ok: true}});
    };
    const db = openDatabase(join(dir, 'test.sqlite'));
    const options = {
      opomWriteback: true,
      opomBaseUrl: 'http://opom.local',
      opomRechargeToken: 'test-token',
    };
    const dryRun = await dryRunPayload({fileName: 'account.csv', csvText: OPOM_CANONICAL_CSV, options});
    const created = await createJob(db, {
      fileName: 'account.csv',
      csvText: OPOM_CANONICAL_CSV,
      options,
      liveConfirmationToken: dryRun.liveConfirmationToken,
    });
    const row = jobDetails(db, created.job.id).rows[0];
    db.prepare(`
      UPDATE job_rows
      SET status = 'failed',
        stage = 'opom.writeback',
        message = 'OPOM request failed',
        purchase_status = 'verified',
        purchase_amount = '10',
        balance_before = '20',
        balance_after = '30',
        card_last4 = '0001',
        opom_card_writeback_status = 'failed',
        opom_result_writeback_status = 'written'
      WHERE id = ?
    `).run(row.id);
    db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(created.job.id);

    const repaired = await repairOpomWriteback(db, created.job.id, {rowNumber: 2});

    assert.equal(repaired.rows[0].status, 'completed');
    assert.equal(repaired.rows[0].stage, 'closed_loop.complete');
    assert.equal(repaired.rows[0].opomCardWritebackStatus, 'written');
    assert.equal(repaired.rows[0].opomResultWritebackStatus, 'written');
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/card-binding$/);
    assert.match(calls[1].url, /\/results$/);
    assert.equal(calls[0].body.card.orderNo, 'ejh_order_1');
    assert.equal(calls[0].body.card.cardNo, '5257970000000001');
    assert.equal(calls[0].body.card.cvv, undefined);
    assert.doesNotMatch(JSON.stringify(calls), /"cvv"\s*:/i);
    const resultCsv = readFileSync(getJob(db, created.job.id).result_csv_path, 'utf8');
    assert.match(resultCsv, /completed/);
    assert.match(resultCsv, /OPOM writeback repaired without rerunning purchase/);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, {recursive: true, force: true});
  }
});

test('repairOpomWriteback rejects ordinary failures without verified purchase evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-opom-repair-reject-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const options = {
      opomWriteback: true,
      opomBaseUrl: 'http://opom.local',
      opomRechargeToken: 'test-token',
    };
    const dryRun = await dryRunPayload({fileName: 'account.csv', csvText: OPOM_CANONICAL_CSV, options});
    const created = await createJob(db, {
      fileName: 'account.csv',
      csvText: OPOM_CANONICAL_CSV,
      options,
      liveConfirmationToken: dryRun.liveConfirmationToken,
    });
    const row = jobDetails(db, created.job.id).rows[0];
    db.prepare("UPDATE job_rows SET status = 'failed', stage = 'automation', message = 'ordinary failure' WHERE id = ?").run(row.id);
    db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(created.job.id);

    await assert.rejects(
      () => repairOpomWriteback(db, created.job.id, {rowNumber: 2}),
      /Only failed opom\.writeback rows can be repaired/,
    );
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('server runtime does not depend on the Codex skill directory', () => {
  const files = [
    'src/server/config.mjs',
    'src/server/automation-adapter.mjs',
    'src/server/preflight.mjs',
    'src/server/worker.mjs',
    'src/server/jobs.mjs',
  ];
  const source = files.map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(source, /\.codex\/skills|OPENROUTER_RECHARGE_SKILL_DIR|SKILL_DIR|pathToFileURL/);
});

test('production preflight has a read-only local development mode', () => {
  const output = execFileSync('node', [
    'scripts/production-preflight.mjs',
    '--no-opom',
    '--no-ejh',
    '--no-ads',
    '--json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      OPOM_BASE_URL: '',
      OPOM_API_BASE: '',
      OPOM_RECHARGE_TOKEN: '',
      EJH_APP_KEY: '',
      EJH_APP_SECRET: '',
      ADSPOWER_STATUS_MODE: 'disabled',
    },
  });
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.equal(result.failed, 0);
  assert.ok(result.checks.some((check) => check.label === 'operator console HTML' && check.ok));
  assert.ok(result.checks.some((check) => check.label === 'operator console app script' && check.ok));
    assert.ok(result.checks.some((check) => check.label === 'Production write boundary'));
    assert.ok(result.checks.some((check) => check.label === 'OpenRouter live purchase boundary'));
    assert.ok(result.checks.some((check) => check.label === 'AdsPower native tag API' && /not documented/.test(check.status)));
});

test('readiness audit records disabled AdsPower writeback as user-waived', () => {
  const output = execFileSync('node', [
    'scripts/readiness-audit.mjs',
    '--json',
    '--opom-repo',
    '/Users/weiwei/project/manager-openrouter',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      ADSPOWER_STATUS_MODE: 'disabled',
      ADSPOWER_SUCCESS_GROUP_ID: '',
      ADSPOWER_FAILURE_GROUP_ID: '',
      ADSPOWER_BLOCKER_GROUP_ID: '',
      ADSPOWER_SUCCESS_GROUP_NAME: '',
      ADSPOWER_FAILURE_GROUP_NAME: '',
      ADSPOWER_BLOCKER_GROUP_NAME: '',
      OPOM_PRODUCTION_RECHARGE_API_VERIFIED: '',
      OPOM_PRODUCTION_PREFLIGHT_PASSED_AT: '',
      OPOM_API_BASE: '',
      OPOM_BASE_URL: '',
      OPOM_RECHARGE_TOKEN: '',
    },
  });
  const result = JSON.parse(output);
  const statusItem = result.items.find((item) => item.id === '8-adspower-status');
  const opomDeployItem = result.items.find((item) => item.id === '7a-opom-production-deploy');
  assert.equal(result.ok, true);
  assert.equal(statusItem.status, 'ready_user_waived');
  assert.match(statusItem.evidence.join('\n'), /waived AdsPower status writeback/i);
  assert.equal(opomDeployItem.status, 'pending_opom_production_deploy');
  assert.match(opomDeployItem.next, /deploy OPOM changes/);
});

test('readiness audit accepts configured AdsPower group_move as an operational marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-preflight-marker-'));
  const markerPath = join(dir, 'production-preflight-marker.json');
  writeFileSync(markerPath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: true,
    opomReadVerified: true,
    opomBaseUrl: 'https://opom.example.internal',
    opomGroup: 'recharge',
    checks: [],
  }));
  const output = execFileSync('node', [
    'scripts/readiness-audit.mjs',
    '--json',
    '--opom-repo',
    '/Users/weiwei/project/manager-openrouter',
    '--preflight-marker',
    markerPath,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      ADSPOWER_STATUS_MODE: 'group_move',
      ADSPOWER_SUCCESS_GROUP_ID: 'id:g-success',
      ADSPOWER_FAILURE_GROUP_NAME: 'Recharge Failed',
      ADSPOWER_BLOCKER_GROUP_ID: 'id:g-blocker',
      OPOM_PRODUCTION_RECHARGE_API_VERIFIED: 'true',
      OPOM_PRODUCTION_PREFLIGHT_PASSED_AT: '',
      OPOM_API_BASE: '',
      OPOM_RECHARGE_TOKEN: '',
    },
  });
  try {
    const result = JSON.parse(output);
    const statusItem = result.items.find((item) => item.id === '8-adspower-status');
    const opomDeployItem = result.items.find((item) => item.id === '7a-opom-production-deploy');
    assert.equal(result.ok, true);
    assert.equal(statusItem.status, 'ready_operational_marker');
    assert.match(statusItem.evidence.join('\n'), /group_move/);
    assert.equal(opomDeployItem.status, 'ready_production_verified');
    assert.match(opomDeployItem.evidence.join('\n'), /production-preflight-marker\.json/);
    assert.equal(result.complete, false);
    assert.ok(result.items.some((item) => item.id === '0-manual-prep' && item.status === 'pending_manual_ops'));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('readiness audit keeps OPOM production pending without recent preflight evidence', () => {
  const output = execFileSync('node', [
    'scripts/readiness-audit.mjs',
    '--json',
    '--opom-repo',
    '/Users/weiwei/project/manager-openrouter',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      ADSPOWER_STATUS_MODE: 'disabled',
      OPOM_PRODUCTION_RECHARGE_API_VERIFIED: 'true',
      OPOM_PRODUCTION_PREFLIGHT_PASSED_AT: '',
      OPOM_API_BASE: 'https://opom.example.internal',
      OPOM_RECHARGE_TOKEN: 'test-token',
    },
  });
  const result = JSON.parse(output);
  const opomDeployItem = result.items.find((item) => item.id === '7a-opom-production-deploy');
  assert.equal(result.ok, true);
  assert.equal(opomDeployItem.status, 'pending_opom_production_deploy');
  assert.match(opomDeployItem.evidence.join('\n'), /missing a recent OPOM_PRODUCTION_PREFLIGHT_PASSED_AT/);
});

test('launch checklist treats AdsPower status writeback as waived by default', () => {
  const output = execFileSync('node', [
    'scripts/launch-checklist.mjs',
    '--json',
    '--opom-repo',
    '/Users/weiwei/project/manager-openrouter',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      ADSPOWER_STATUS_MODE: 'disabled',
      OPOM_PRODUCTION_RECHARGE_API_VERIFIED: '',
      OPOM_PRODUCTION_PREFLIGHT_PASSED_AT: '',
      OPOM_API_BASE: '',
      OPOM_BASE_URL: '',
      OPOM_RECHARGE_TOKEN: '',
    },
  });
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.equal(result.launchReadyWithAuthorization, true);
  assert.equal(result.pendingItems.some((item) => item.id === '8-adspower-status'), false);
  assert.equal(result.requiredCommands.includes('npm run adspower:status-targets -- --json'), false);
  assert.ok(result.requiredCommands.includes('npm run preflight:production -- --with-opom-read --marker-file ./var/production-preflight-marker.json'));
  assert.ok(result.requiredCommands.includes('npm run audit:completion -- --preflight-marker ./var/production-preflight-marker.json'));
  assert.ok(result.firstOperationalSequence.some((step) => /waived AdsPower status evidence/.test(step)));
  assert.ok(result.firstOperationalSequence.some((step) => /production completion evidence/.test(step)));
});

test('production preflight can opt into OPOM recharge queue read check without leaking token', async () => {
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-opom-read-marker-'));
  const markerPath = join(dir, 'marker.json');
  const server = createServer((req, res) => {
    calls.push({
      url: req.url,
      token: req.headers['x-recharge-api-token'],
    });
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({data: [], nextCursor: null}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const {port} = server.address();
    const token = 'test-opom-token-secret';
    const {stdout} = await execFileAsync('node', [
      'scripts/production-preflight.mjs',
      '--no-ejh',
      '--no-ads',
      '--with-opom-read',
      '--json',
      '--marker-file',
      markerPath,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        OPOM_BASE_URL: `http://127.0.0.1:${port}`,
        OPOM_API_BASE: '',
        OPOM_RECHARGE_TOKEN: token,
        EJH_APP_KEY: '',
        EJH_APP_SECRET: '',
        ADSPOWER_STATUS_MODE: 'disabled',
      },
    });
    const result = JSON.parse(stdout);
    const opomCheck = result.checks.find((check) => check.label === 'OPOM recharge queue read');
    const opomMarker = result.checks.find((check) => check.label === 'OPOM production verification marker');
    const tagCheck = result.checks.find((check) => check.label === 'AdsPower native tag API');
    assert.equal(result.ok, true);
    assert.equal(opomCheck.status, 'ok_rows_0');
    assert.match(opomMarker.status, /OPOM_PRODUCTION_RECHARGE_API_VERIFIED=true/);
    assert.match(opomMarker.status, /OPOM_PRODUCTION_PREFLIGHT_PASSED_AT=/);
    assert.match(tagCheck.status, /not documented/);
    assert.ok(result.checks.some((check) => check.label === 'Production preflight marker file' && check.ok));
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/v1\/recharge\/accounts\?group=recharge&status=needs_recharge&limit=1/);
    assert.equal(calls[0].token, token);
    assert.doesNotMatch(stdout, new RegExp(token));
    assert.equal(existsSync(markerPath), true);
    const markerText = readFileSync(markerPath, 'utf8');
    assert.doesNotMatch(markerText, new RegExp(token));
    const marker = JSON.parse(markerText);
    assert.equal(marker.ok, true);
    assert.equal(marker.opomReadVerified, true);
    assert.equal(marker.opomGroup, 'recharge');
    assert.equal(marker.opomBaseUrl, `http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, {recursive: true, force: true});
  }
});

test('production preflight resolves AdsPower group_move name targets read-only', async () => {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization || '',
    });
    if (req.url === '/status') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({code: 0, msg: 'ok'}));
      return;
    }
    if (req.url?.startsWith('/api/v1/group/list')) {
      const url = new URL(req.url, 'http://127.0.0.1');
      const groupName = url.searchParams.get('group_name');
      const list = groupName
        ? [{group_id: groupName === 'Recharge Success' ? 'g-success-name' : 'g-failure-name', group_name: groupName}]
        : [
          {group_id: 'g-success-name', group_name: 'Recharge Success'},
          {group_id: 'g-failure-name', group_name: 'Recharge Failure'},
        ];
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({
        code: 0,
        data: {list},
        msg: 'success',
      }));
      return;
    }
    res.writeHead(404, {'content-type': 'application/json'});
    res.end(JSON.stringify({code: -1, msg: 'not found'}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const {port} = server.address();
    const {stdout} = await execFileAsync('node', [
      'scripts/production-preflight.mjs',
      '--no-opom',
      '--no-ejh',
      '--json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        OPOM_BASE_URL: '',
        OPOM_API_BASE: '',
        OPOM_RECHARGE_TOKEN: '',
        EJH_APP_KEY: '',
        EJH_APP_SECRET: '',
        ADSPOWER_API_BASE: `http://127.0.0.1:${port}`,
        ADSPOWER_API_KEY: 'fixture',
        ADSPOWER_STATUS_MODE: 'group_move',
        ADSPOWER_SUCCESS_GROUP_ID: 'name:Recharge Success',
        ADSPOWER_FAILURE_GROUP_NAME: 'Recharge Failure',
        ADSPOWER_BLOCKER_GROUP_ID: 'id:g-blocker',
      },
    });
    const result = JSON.parse(stdout);
    const successLookup = result.checks.find((check) => check.label === 'AdsPower success group target lookup');
    const failureLookup = result.checks.find((check) => check.label === 'AdsPower failure group target lookup');
    const blockerLookup = result.checks.find((check) => check.label === 'AdsPower blocker group target lookup');
    assert.equal(result.ok, true);
    assert.equal(successLookup.status, 'name_resolved:g-success-name');
    assert.equal(failureLookup.status, 'name_resolved:g-failure-name');
    assert.equal(blockerLookup.status, 'id_present:g-blocker');
    assert.equal(calls.some((call) => /\/api\/v1\/user\/regroup|\/api\/v1\/user\/update|\/api\/v2\/browser-profile\/update/.test(call.url)), false);
    assert.ok(calls.filter((call) => call.url.startsWith('/api/v1/group/list')).every((call) => call.authorization === 'Bearer fixture'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('AdsPower status target discovery lists groups and suggestions read-only', async () => {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization || '',
    });
    if (req.url?.startsWith('/api/v1/group/list')) {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({
        code: 0,
        data: {
          list: [
            {group_id: 'g-success', group_name: 'Recharge Success'},
            {group_id: 'g-failure', group_name: 'Recharge Failed'},
            {group_id: 'g-blocker', group_name: 'Recharge Blocked'},
          ],
        },
        msg: 'success',
      }));
      return;
    }
    res.writeHead(404, {'content-type': 'application/json'});
    res.end(JSON.stringify({code: -1, msg: 'not found'}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const {port} = server.address();
    const {stdout} = await execFileAsync('npm', ['run', 'adspower:status-targets', '--', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        ADSPOWER_API_BASE: `http://127.0.0.1:${port}`,
        ADSPOWER_API_KEY: 'fixture',
        ADSPOWER_SUCCESS_GROUP_ID: 'name:Recharge Success',
        ADSPOWER_FAILURE_GROUP_NAME: 'Recharge Failed',
        ADSPOWER_BLOCKER_GROUP_ID: 'id:g-blocker',
      },
    });
    const result = JSON.parse(stdout.slice(stdout.indexOf('{')));
    assert.equal(result.ok, true);
    assert.equal(result.groups.length, 3);
    assert.equal(result.targets.success.status, 'name_resolved');
    assert.equal(result.targets.success.groupId, 'g-success');
    assert.equal(result.targets.failure.status, 'name_resolved');
    assert.equal(result.targets.blocker.status, 'id_found');
    assert.ok(result.suggestedEnv.includes('export ADSPOWER_SUCCESS_GROUP_ID="g-success"'));
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^\/api\/v1\/group\/list\?/);
    assert.equal(calls[0].authorization, 'Bearer fixture');
    assert.equal(calls.some((call) => /\/api\/v1\/user\/regroup|\/api\/v1\/user\/update|\/api\/v2\/browser-profile\/update/.test(call.url)), false);
    assert.doesNotMatch(stdout, /5257970000000001|cvv|password|cookie|session/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('production preflight validates a candidate CSV contract without leaking sensitive values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-preflight-csv-'));
  try {
    const csvPath = join(dir, 'candidate.csv');
    writeFileSync(csvPath, VALID_CSV, 'utf8');
    const output = execFileSync('node', [
      'scripts/production-preflight.mjs',
      '--no-opom',
      '--no-ejh',
      '--no-ads',
      '--csv',
      csvPath,
      '--json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        OPOM_BASE_URL: '',
        OPOM_API_BASE: '',
        OPOM_RECHARGE_TOKEN: '',
        EJH_APP_KEY: '',
        EJH_APP_SECRET: '',
        ADSPOWER_STATUS_MODE: 'disabled',
      },
    });
    const result = JSON.parse(output);
    const csvContract = result.checks.find((check) => check.label === 'CSV dry-run contract');
    assert.equal(result.ok, true);
    assert.equal(csvContract.status, 'ready=1 blocked=0 skipped=0');
    assert.doesNotMatch(output, /,456,|card_number|cvv/i);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('production preflight rejects EJH raw diagnostic columns without printing raw payloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-preflight-raw-csv-'));
  try {
    const csvPath = join(dir, 'candidate.csv');
    writeFileSync(
      csvPath,
      `status,ID,username,amount,card_number,exp_month,exp_year,cvv,postal_code,auto_topup_threshold,auto_topup_amount,requestPayload
,1415,user@example.com,10,5257970000000001,06,28,456,97001,2,25,"{""card"":""5257970000000001"",""cvv"":""456""}"
`,
      'utf8',
    );
    let stdout = '';
    let exitCode = 0;
    try {
      const result = await execFileAsync('node', [
        'scripts/production-preflight.mjs',
        '--no-opom',
        '--no-ejh',
        '--no-ads',
        '--csv',
        csvPath,
        '--json',
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          OPOM_BASE_URL: '',
          OPOM_API_BASE: '',
          OPOM_RECHARGE_TOKEN: '',
          EJH_APP_KEY: '',
          EJH_APP_SECRET: '',
          ADSPOWER_STATUS_MODE: 'disabled',
        },
      });
      stdout = result.stdout;
    } catch (error) {
      stdout = error.stdout;
      exitCode = error.code;
    }
    const result = JSON.parse(stdout);
    const diagnostic = result.checks.find((check) => check.label === 'CSV EJH raw diagnostic fields');
    assert.equal(exitCode, 1);
    assert.equal(result.ok, false);
    assert.equal(diagnostic.ok, false);
    assert.match(diagnostic.status, /requestPayload/);
    assert.doesNotMatch(stdout, /,456,|"cvv":"456"/i);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
