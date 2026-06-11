import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {newId, nowIso} from './ids.mjs';
import {
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
import {httpError} from './http-utils.mjs';

export function defaultRechargeJobName(rechargeCount, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  const datePart = `${parts.year}${parts.month}${parts.day}`;
  const timePart = `${parts.hour}${parts.minute}`;
  return `${datePart}-${timePart}-${Number(rechargeCount || 0)}`;
}

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
      cardNo: row.cardNo,
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
  const sourceFileName = payload.fileName || 'account.csv';
  const options = payload.options || {};
  const plan = await parsePlan(csvText, options);
  const readyCount = plan.rows.filter((row) => row.status === 'ready').length;
  if (readyCount > 0) verifyLiveConfirmation(payload.liveConfirmationToken, {csvText, options});
  const jobId = newId('job');
  const jobOptions = {
    ...options,
    runId: options.runId || (runnerArgs(options).opomWriteback ? jobId : ''),
  };
  const jobName = payload.jobName || defaultRechargeJobName(readyCount);
  const {csvPath, resultCsvPath} = await makeJobFiles(jobId, sourceFileName, csvText);
  const now = nowIso();

  const insertJob = db.prepare(`
    INSERT INTO jobs (
      id, file_name, csv_path, result_csv_path, options_json, status, dry_run_status,
      total_rows, ready_rows, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertJob.run(
    jobId,
    jobName,
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
      ads_match_status, ejh_order_no, card_no, card_last4, purchase_plan, amount,
      status, stage, message, missing_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      item.cardNo,
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
          cardNo: row.cardNo,
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
    fileName: sourceFileName,
    jobName,
    options: publicOptions(jobOptions),
    liveConfirmation: readyCount > 0 ? 'verified' : 'not_required_no_ready_rows',
  });
  if (readyCount === 0) {
    addEvent(db, jobId, 'job.completed', 'no executable rows');
  }
  return jobDetails(db, jobId);
}

function publicOptions(options) {
  const args = runnerArgs(options);
  return {
    removeExisting: args.removeExisting,
    stopProfiles: args.stopProfiles,
    concurrency: args.concurrency,
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
          cardNo: row.card_no,
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
  }
  return jobDetails(db, jobId);
}

export function readJobCsv(job) {
  return readFileSync(job.csv_path, 'utf8');
}

const RERUNNABLE_STATUSES = new Set([
  'missing_fields',
  'login_required',
  'identity_mismatch',
  'payment_issue_card_declined',
  'failed',
  'canceled',
]);

const RISKY_STATUSES = new Set([
  'running',
  'purchase_unverified',
  'manual_security_blocker',
]);

const NEVER_RERUN_STATUSES = new Set([
  'completed',
  'skipped',
]);

function resumeRowDecision(row, includeRiskyRows = false) {
  if (NEVER_RERUN_STATUSES.has(row.status)) return {action: 'skip_completed'};
  if (RERUNNABLE_STATUSES.has(row.status)) return {action: 'queue'};
  if (RISKY_STATUSES.has(row.status)) {
    return includeRiskyRows ? {action: 'queue', risky: true} : {action: 'skip_risky', risky: true};
  }
  if (row.status === 'queued') return {action: 'already_queued'};
  return {action: 'skip_unsupported', reason: `unsupported status: ${row.status}`};
}

function previewRows(rows, startRowNumber, includeRiskyRows = false) {
  const candidates = rows.filter((row) => row.row_number >= startRowNumber);
  const output = {
    startRowNumber,
    includeRiskyRows: !!includeRiskyRows,
    totalCandidateRows: candidates.length,
    queuedRows: [],
    alreadyQueuedRows: [],
    skippedCompletedRows: [],
    skippedRiskyRows: [],
    unsupportedRows: [],
  };
  for (const row of candidates) {
    const decision = resumeRowDecision(row, includeRiskyRows);
    const item = {
      rowId: row.id,
      rowNumber: row.row_number,
      profileId: row.profile_id,
      status: row.status,
      message: row.message,
      risky: !!decision.risky,
      reason: decision.reason || '',
    };
    if (decision.action === 'queue') output.queuedRows.push(item);
    else if (decision.action === 'already_queued') output.alreadyQueuedRows.push(item);
    else if (decision.action === 'skip_completed') output.skippedCompletedRows.push(item);
    else if (decision.action === 'skip_risky') output.skippedRiskyRows.push(item);
    else output.unsupportedRows.push(item);
  }
  output.canResume = output.queuedRows.length > 0 || output.alreadyQueuedRows.length > 0;
  return output;
}

async function validateResumeCsv(text, options) {
  try {
    await parsePlan(text, options);
    return {ok: true};
  } catch (error) {
    return {ok: false, reason: `CSV cannot be used for resume: ${error.message}`};
  }
}

async function ensureJobCsvAvailable(job) {
  const options = JSON.parse(job.options_json || '{}');
  if (existsSync(job.csv_path)) {
    const text = readFileSync(job.csv_path, 'utf8');
    const validation = await validateResumeCsv(text, options);
    if (!validation.ok) return {...validation, source: 'canonical_csv'};
    return {ok: true, source: 'canonical_csv', csvPath: job.csv_path};
  }
  if (existsSync(job.result_csv_path)) {
    const text = readFileSync(job.result_csv_path, 'utf8');
    if (!text.trim()) {
      return {ok: false, source: 'result_csv', reason: 'result CSV is empty'};
    }
    const validation = await validateResumeCsv(text, options);
    if (!validation.ok) return {...validation, source: 'result_csv'};
    writeFileSync(job.csv_path, text, {encoding: 'utf8', mode: 0o600});
    return {ok: true, source: 'recovered_from_result_csv', csvPath: job.csv_path};
  }
  return {ok: false, source: 'missing', reason: '旧任务缺少原始执行 CSV，不能续跑'};
}

export async function resumePreview(db, jobId, payload = {}) {
  const job = getJob(db, jobId);
  if (!job) throw httpError(404, 'Job not found');
  const startRowNumber = Number(payload.startRowNumber || 0);
  if (!Number.isInteger(startRowNumber) || startRowNumber < 2) {
    throw httpError(400, 'startRowNumber must be an executable CSV row number');
  }
  const csvAvailability = await ensureJobCsvAvailable(job);
  const rows = listRows(db, jobId);
  const rowExists = rows.some((row) => row.row_number === startRowNumber);
  if (!rowExists) throw httpError(400, `row ${startRowNumber} does not exist in this job`);
  return {
    ok: true,
    job: publicJob(getJob(db, jobId)),
    csvAvailability,
    ...previewRows(rows, startRowNumber, !!payload.includeRiskyRows),
  };
}

export async function resumeJob(db, jobId, payload = {}) {
  const job = getJob(db, jobId);
  if (!job) throw httpError(404, 'Job not found');
  if (['queued', 'running'].includes(job.status)) {
    throw httpError(409, 'Job is already queued or running');
  }
  const startRowNumber = Number(payload.startRowNumber || 0);
  if (!Number.isInteger(startRowNumber) || startRowNumber < 2) {
    throw httpError(400, 'startRowNumber must be an executable CSV row number');
  }
  const csvAvailability = await ensureJobCsvAvailable(job);
  if (!csvAvailability.ok) throw httpError(409, csvAvailability.reason);
  const rows = listRows(db, jobId);
  const preview = previewRows(rows, startRowNumber, !!payload.includeRiskyRows);
  if (!rows.some((row) => row.row_number === startRowNumber)) {
    throw httpError(400, `row ${startRowNumber} does not exist in this job`);
  }
  if (!preview.queuedRows.length && !preview.alreadyQueuedRows.length) {
    throw httpError(409, 'No rows are eligible to resume from the selected row');
  }

  const now = nowIso();
  const queueIds = preview.queuedRows.map((row) => row.rowId);
  const resetRow = db.prepare(`
    UPDATE job_rows
    SET status = 'queued',
      stage = 'queued',
      message = 'queued for resume',
      missing_json = '[]',
      purchase_status = '',
      purchase_amount = '',
      balance_before = '',
      balance_after = '',
      auto_topup_status = '',
      auto_topup_threshold = '',
      auto_topup_amount = '',
      opom_card_writeback_status = '',
      opom_result_writeback_status = '',
      adspower_tag_status = '',
      adspower_status_mode = '',
      adspower_status_target = '',
      adspower_status_reason = '',
      started_at = NULL,
      finished_at = NULL,
      updated_at = ?
    WHERE id = ?
  `);
  for (const rowId of queueIds) resetRow.run(now, rowId);
  db.prepare(`
    UPDATE jobs
    SET status = 'queued',
      cancel_requested = 0,
      error = '',
      finished_at = NULL,
      updated_at = ?
    WHERE id = ?
  `).run(now, jobId);
  addEvent(db, jobId, 'job.resume_requested', `resume from row ${startRowNumber}`, {
    startRowNumber,
    includeRiskyRows: !!payload.includeRiskyRows,
    queuedRows: preview.queuedRows.map((row) => row.rowNumber),
    alreadyQueuedRows: preview.alreadyQueuedRows.map((row) => row.rowNumber),
    skippedCompletedRows: preview.skippedCompletedRows.map((row) => row.rowNumber),
    skippedRiskyRows: preview.skippedRiskyRows.map((row) => row.rowNumber),
    csvSource: csvAvailability.source,
  });
  for (const row of preview.queuedRows) {
    addEvent(db, jobId, 'row.resume_queued', `row ${row.rowNumber} queued for resume`, {
      previousStatus: row.status,
      risky: row.risky,
    }, row.rowId);
  }
  updateJobCounts(db, jobId);
  await rewriteResumeResult(db, jobId);
  return {
    ok: true,
    csvAvailability,
    resume: await resumePreview(db, jobId, {startRowNumber, includeRiskyRows: !!payload.includeRiskyRows}),
    ...jobDetails(db, jobId),
  };
}

async function rewriteResumeResult(db, jobId) {
  const job = getJob(db, jobId);
  const rows = listRows(db, jobId)
    .filter((row) => !['queued', 'running', 'ready'].includes(row.status))
    .map((row) => ({
      rawIndex: row.raw_index,
      status: row.status,
      message: row.message,
      details: {
        purchaseStatus: row.purchase_status,
        purchaseAmount: row.purchase_amount,
        balanceBefore: row.balance_before,
        balanceAfter: row.balance_after,
        cardLast4: row.card_last4,
        cardNo: row.card_no,
        autoTopupStatus: row.auto_topup_status,
        autoTopupThreshold: row.auto_topup_threshold,
        autoTopupAmount: row.auto_topup_amount,
        opomAccountId: row.opom_account_id,
        username: row.username_masked || row.login_email_masked,
        loginEmail: row.login_email_masked || row.username_masked,
        loginEmailMasked: row.login_email_masked || row.username_masked,
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
  await writeResultCsv({
    csvPath: job.csv_path,
    resultCsvPath: job.result_csv_path,
    rowsByRawIndex: rows,
    runId: JSON.parse(job.options_json || '{}').runId || job.id,
  });
}
