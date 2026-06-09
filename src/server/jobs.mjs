import {readFileSync} from 'node:fs';
import {newId, nowIso} from './ids.mjs';
import {
  cleanupJobUpload,
  makeJobFiles,
  parsePlan,
  publicJob,
  publicRow,
  rowInsertFromDryRun,
  runnerArgs,
  writeResultCsv,
} from './automation-adapter.mjs';
import {addEvent, getJob, listEvents, listJobs, listRows, updateJobCounts} from './db.mjs';
import {createLiveConfirmation, verifyLiveConfirmation} from './safety.mjs';

export async function dryRunPayload(payload) {
  const csvText = String(payload.csvText || '');
  if (!csvText.trim()) throw new Error('csvText is required');
  const options = payload.options || {};
  const plan = await parsePlan(csvText, options);
  const ready = plan.rows.filter((row) => row.status === 'ready').length;
  const confirmation = ready > 0
    ? createLiveConfirmation({csvText, options, ready})
    : null;
  return {
    ok: true,
    fileName: payload.fileName || 'account.csv',
    planned: plan.rows.filter((row) => row.eligible).length,
    ready,
    blocked: plan.rows.filter((row) => row.status === 'missing_fields').length,
    skipped: plan.rows.filter((row) => row.status === 'skipped').length,
    liveConfirmationToken: confirmation?.token || '',
    liveConfirmationExpiresAt: confirmation?.expiresAt || '',
    rows: plan.rows.map((row) => ({
      rowNumber: row.rowNumber,
      profileId: row.id,
      username: row.username,
      opomAccountId: row.opomAccountId,
      loginEmail: row.loginEmail || row.username,
      loginEmailMasked: row.loginEmail || row.loginEmailMasked,
      adsPowerUserId: row.adsPowerUserId,
      adsPowerSerialNumber: row.adsPowerSerialNumber,
      adsMatchStatus: row.adsMatchStatus,
      ejhOrderNo: row.ejhOrderNo,
      cardLast4: row.cardLast4,
      executionScope: row.executionScope,
      purchasePlan: row.purchasePlan,
      amount: row.amount,
      autoTopup: row.autoTopup,
      ready: row.ready,
      status: row.status,
      message: row.message,
      missing: row.missing || [],
    })),
  };
}

export async function createJob(db, payload) {
  const csvText = String(payload.csvText || '');
  if (!csvText.trim()) throw new Error('csvText is required');
  const fileName = payload.fileName || 'account.csv';
  const options = payload.options || {};
  const plan = await parsePlan(csvText, options);
  const readyCount = plan.rows.filter((row) => row.status === 'ready').length;
  if (readyCount > 0) verifyLiveConfirmation(payload.liveConfirmationToken, {csvText, options});
  const jobId = newId('job');
  const jobOptions = {
    ...options,
    runId: options.runId || (runnerArgs(options).opomWriteback ? jobId : ''),
  };
  const {csvPath, resultCsvPath} = await makeJobFiles(jobId, fileName, csvText);
  const now = nowIso();

  const insertJob = db.prepare(`
    INSERT INTO jobs (
      id, file_name, csv_path, result_csv_path, options_json, status, dry_run_status,
      total_rows, ready_rows, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertJob.run(
    jobId,
    fileName,
    csvPath,
    resultCsvPath,
    JSON.stringify(jobOptions),
    readyCount > 0 ? 'queued' : 'completed',
    'passed',
    plan.rows.length,
    readyCount,
    now,
    now,
  );

  const insertRow = db.prepare(`
    INSERT INTO job_rows (
      id, job_id, row_number, raw_index, profile_id, opom_account_id,
      username_masked, login_email_masked, ads_power_user_id, ads_power_serial_number,
      ads_match_status, ejh_order_no, card_last4, purchase_plan, amount,
      status, stage, message, missing_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of plan.rows) {
    const item = rowInsertFromDryRun(jobId, row);
    insertRow.run(
      item.id,
      item.jobId,
      item.rowNumber,
      item.rawIndex,
      item.profileId,
      item.opomAccountId,
      item.usernameMasked,
      item.loginEmailMasked,
      item.adsPowerUserId,
      item.adsPowerSerialNumber,
      item.adsMatchStatus,
      item.ejhOrderNo,
      item.cardLast4,
      item.purchasePlan,
      item.amount,
      item.status,
      item.stage,
      item.message,
      item.missingJson,
      item.updatedAt,
    );
  }
  updateJobCounts(db, jobId);
  await writeResultCsv({
    csvPath,
    resultCsvPath,
    runId: jobOptions.runId || jobId,
    rowsByRawIndex: plan.rows
      .filter((row) => row.status !== 'ready')
      .map((row) => ({
        rawIndex: row.rawIndex,
        status: row.status,
        message: row.message,
      details: {
          cardLast4: row.cardLast4,
          cardNoLast4: row.cardNoLast4 || row.cardLast4,
          opomAccountId: row.opomAccountId,
          username: row.username,
          loginEmail: row.loginEmail || row.username,
          loginEmailMasked: row.loginEmail || row.loginEmailMasked,
          adsPowerUserId: row.adsPowerUserId,
          adsPowerSerialNumber: row.adsPowerSerialNumber,
          adsMatchStatus: row.adsMatchStatus,
          ejhOrderNo: row.ejhOrderNo,
          adspowerTagStatus: 'skipped_user_waived',
          adspowerStatusMode: 'disabled',
          adspowerStatusTarget: 'waived_by_user',
          adspowerStatusReason: 'user_waived_status_writeback',
        },
      })),
  });
  addEvent(db, jobId, 'job.created', 'job queued from uploaded CSV', {
    fileName,
    options: publicOptions(jobOptions),
    liveConfirmation: readyCount > 0 ? 'verified' : 'not_required_no_ready_rows',
  });
  if (readyCount === 0) {
    addEvent(db, jobId, 'job.completed', 'no executable rows');
    cleanupJobUpload(getJob(db, jobId));
  }
  return jobDetails(db, jobId);
}

function publicOptions(options) {
  const args = runnerArgs(options);
  return {
    removeExisting: args.removeExisting,
    stopProfiles: args.stopProfiles,
    confirmPurchase: args.confirmPurchase,
    preparePurchaseOnly: !args.confirmPurchase && args.preparePurchaseOnly,
    executionScope: runnerScope(args),
    scopeBillingAddress: args.scopeBillingAddress,
    scopePaymentMethod: args.scopePaymentMethod,
    scopePurchase: args.scopePurchase,
    scopeAutoTopup: args.scopeAutoTopup,
    autoTopupThreshold: args.autoTopupThreshold,
    autoTopupAmount: args.autoTopupAmount,
    rowTimeoutMs: args.rowTimeoutMs,
    adspowerApiBase: args.adspowerApiBase,
    hasAdspowerApiKey: !!args.adspowerApiKey,
    opomWriteback: args.opomWriteback,
    opomBaseUrl: args.opomBaseUrl,
    hasOpomRechargeToken: !!args.opomRechargeToken,
    runId: args.runId,
    adspowerStatusMode: args.adspowerStatusMode,
    hasAdspowerSuccessGroupTarget: !!(args.adspowerSuccessGroupId || args.adspowerSuccessGroupName),
    hasAdspowerFailureGroupTarget: !!(args.adspowerFailureGroupId || args.adspowerFailureGroupName),
    hasAdspowerBlockerGroupTarget: !!(args.adspowerBlockerGroupId || args.adspowerBlockerGroupName),
  };
}

function runnerScope(args) {
  const labels = [];
  if (args.scopeBillingAddress) labels.push('billing_address');
  if (args.scopePaymentMethod) labels.push('payment_method');
  if (args.scopePurchase) labels.push(args.confirmPurchase ? 'purchase' : 'purchase_prepare');
  if (args.scopeAutoTopup) labels.push('auto_topup');
  return labels.join('+') || 'none';
}

export function jobDetails(db, jobId) {
  const job = getJob(db, jobId);
  if (!job) return null;
  return {
    job: publicJob(job),
    rows: listRows(db, jobId).map(publicRow),
    events: listEvents(db, jobId).map((event) => ({
      id: event.id,
      rowId: event.row_id,
      type: event.type,
      message: event.message,
      data: JSON.parse(event.data_json || '{}'),
      createdAt: event.created_at,
    })),
  };
}

export function jobsList(db) {
  return listJobs(db).map(publicJob);
}

export async function cancelJob(db, jobId) {
  const job = getJob(db, jobId);
  if (!job) return null;
  const now = nowIso();
  db.prepare(`
    UPDATE jobs
    SET cancel_requested = 1, status = CASE WHEN status = 'queued' THEN 'canceled' ELSE status END, updated_at = ?
    WHERE id = ?
  `).run(now, jobId);
  db.prepare(`
    UPDATE job_rows
    SET status = 'canceled', message = 'job canceled before execution', updated_at = ?
    WHERE job_id = ? AND status = 'queued'
  `).run(now, jobId);
  addEvent(db, jobId, 'job.cancel_requested', 'cancel requested by operator');
  updateJobCounts(db, jobId);
  if (job.status === 'queued') {
    const rows = listRows(db, jobId)
      .filter((row) => !['queued', 'running', 'ready'].includes(row.status) || row.status === 'canceled')
      .map((row) => ({
        rawIndex: row.raw_index,
        status: row.status,
        message: row.message,
        details: {
          cardLast4: row.card_last4,
          cardNoLast4: row.card_last4,
          opomAccountId: row.opom_account_id,
          username: row.username_masked,
          loginEmail: row.login_email_masked,
          loginEmailMasked: row.login_email_masked,
          adsPowerUserId: row.ads_power_user_id,
          adsPowerSerialNumber: row.ads_power_serial_number,
          adsMatchStatus: row.ads_match_status,
          ejhOrderNo: row.ejh_order_no,
          opomCardWritebackStatus: row.opom_card_writeback_status,
          opomResultWritebackStatus: row.opom_result_writeback_status,
          adspowerTagStatus: row.adspower_tag_status,
          adspowerStatusMode: row.adspower_status_mode,
          adspowerStatusTarget: row.adspower_status_target,
          adspowerStatusReason: row.adspower_status_reason,
        },
      }));
    const options = JSON.parse(job.options_json || '{}');
    await writeResultCsv({
      csvPath: job.csv_path,
      resultCsvPath: job.result_csv_path,
      rowsByRawIndex: rows,
      runId: options.runId || job.id,
    });
    cleanupJobUpload(job);
  }
  return jobDetails(db, jobId);
}

export function readJobCsv(job) {
  return readFileSync(job.csv_path, 'utf8');
}
