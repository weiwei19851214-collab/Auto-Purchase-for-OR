import {spawn} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {BIND_SCRIPT, RESULT_DIR, UPLOAD_DIR, LOG_DIR, DEFAULT_ROW_TIMEOUT_MS, AUTOMATION_LOG_RETENTION_HOURS} from './config.mjs';
import {newId, nowIso} from './ids.mjs';
import * as adspower from '../automation/lib/adspower.mjs';
import * as childRunner from '../automation/lib/child-runner.mjs';
import * as common from '../automation/lib/common.mjs';
import * as csv from '../automation/lib/csv.mjs';
import * as plan from '../automation/lib/recharge-plan.mjs';
import * as status from '../automation/lib/status-contract.mjs';
import * as opom from './opom-client.mjs';

const CHILD_OUTPUT_LIMIT = 10 * 1024 * 1024;
let lastAutomationLogCleanupAt = 0;

const BASE_INPUT_COLUMNS = [
  'status',
];

const OPTIONAL_COLUMNS = [
  'ID',
  'username',
  'opom_account_id',
  'login_email',
  'ads_power_user_id',
  'ads_power_serial_number',
  'ads_power_group_name',
  'opom_health_status',
  'opom_health_reason',
  'order_no',
  'ejh_order_no',
  'card_no',
  'holder_name',
  'country',
  'address_line1',
  'city',
  'state',
  'balance_threshold',
  'amount_below_threshold',
  'amount_at_or_above_threshold',
  'auto_topup_threshold',
  'auto_topup_amount',
];

export function safeFileName(name) {
  const safe = basename(String(name || 'account.csv')).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return safe.endsWith('.csv') ? safe : `${safe}.csv`;
}

export function runnerArgs(options = {}) {
  const scopePurchase = options.scopePurchase !== false;
  const concurrency = Math.min(5, Math.max(1, Math.floor(Number(options.concurrency || 1) || 1)));
  return {
    removeExisting: options.removeExisting !== false,
    stopProfiles: options.stopProfiles !== false,
    concurrency,
    confirmPurchase: scopePurchase && options.confirmPurchase !== false,
    preparePurchaseOnly: scopePurchase && options.preparePurchaseOnly !== false,
    scopeBillingAddress: options.scopeBillingAddress !== false,
    scopePaymentMethod: options.scopePaymentMethod !== false,
    scopePurchase,
    scopeAutoTopup: options.scopeAutoTopup !== false,
    autoTopupThreshold: options.autoTopupThreshold || '',
    autoTopupAmount: options.autoTopupAmount || '',
    rowTimeoutMs: Number(options.rowTimeoutMs || DEFAULT_ROW_TIMEOUT_MS),
    verbose: !!options.verbose,
    adspowerApiBase: options.adspowerApiBase || process.env.ADSPOWER_API_BASE || 'http://127.0.0.1:50325',
    adspowerApiKey: options.adspowerApiKey || process.env.ADSPOWER_API_KEY || '',
    adspowerStartTimeoutMs: options.adspowerStartTimeoutMs || process.env.ADSPOWER_START_TIMEOUT_MS || '',
    opomWriteback: !!options.opomWriteback,
    opomBaseUrl: options.opomBaseUrl || process.env.OPOM_BASE_URL || process.env.OPOM_API_BASE || '',
    opomRechargeToken: options.opomRechargeToken || process.env.OPOM_RECHARGE_TOKEN || '',
    opomRequestTimeoutMs: options.opomRequestTimeoutMs || process.env.OPOM_REQUEST_TIMEOUT_MS || '',
    opomRequestRetries: options.opomRequestRetries || process.env.OPOM_REQUEST_RETRIES || '',
    opomWritebackRetries: options.opomWritebackRetries || process.env.OPOM_WRITEBACK_RETRIES || '',
    opomRetryDelayMs: options.opomRetryDelayMs || process.env.OPOM_RETRY_DELAY_MS || '',
    runId: options.runId || '',
    adspowerStatusMode: options.adspowerStatusMode || process.env.ADSPOWER_STATUS_MODE || 'disabled',
    adspowerSuccessGroupId: options.adspowerSuccessGroupId || process.env.ADSPOWER_SUCCESS_GROUP_ID || '',
    adspowerFailureGroupId: options.adspowerFailureGroupId || process.env.ADSPOWER_FAILURE_GROUP_ID || '',
    adspowerBlockerGroupId: options.adspowerBlockerGroupId || process.env.ADSPOWER_BLOCKER_GROUP_ID || '',
    adspowerSuccessGroupName: options.adspowerSuccessGroupName || process.env.ADSPOWER_SUCCESS_GROUP_NAME || '',
    adspowerFailureGroupName: options.adspowerFailureGroupName || process.env.ADSPOWER_FAILURE_GROUP_NAME || '',
    adspowerBlockerGroupName: options.adspowerBlockerGroupName || process.env.ADSPOWER_BLOCKER_GROUP_NAME || '',
  };
}

function requiredInputColumns(args) {
  const scope = plan.executionScope(args);
  const required = [...BASE_INPUT_COLUMNS];
  if (scope.paymentMethod) required.push('exp_month', 'exp_year', 'cvv', 'postal_code');
  if (scope.autoTopup) required.push('auto_topup_threshold', 'auto_topup_amount');
  if (scope.billingAddress && !scope.paymentMethod) {
    required.push('holder_name', 'country', 'postal_code', 'address_line1', 'city', 'state');
  }
  return [...new Set(required)];
}

export async function parsePlan(csvText, options = {}) {
  const parsedRows = csv.parseCsv(csvText);
  if (parsedRows.length < 1) throw new Error('CSV is empty');

  const args = runnerArgs(options);
  const header = [...parsedRows[0]];
  const missingHeader = requiredInputColumns(args).filter((key) => !header.includes(key));
  if (missingHeader.length) throw new Error(`CSV missing required columns: ${missingHeader.join(', ')}`);
  for (const key of OPTIONAL_COLUMNS) {
    if (!header.includes(key)) header.push(key);
  }
  csv.ensureColumns(header, plan.resultColumns());

  const dataRows = parsedRows.slice(1).map((row) => {
    const next = [...row];
    csv.padRows([next], header.length);
    return next;
  });

  const rows = [];
  for (let index = 0; index < dataRows.length; index += 1) {
    const row = csv.rowObject(header, dataRows[index]);
    if (!plan.isEligible(row)) {
      rows.push({
        rawIndex: index,
        rowNumber: index + 2,
        eligible: false,
        status: 'skipped',
        message: 'row is already completed or not eligible',
        ...plan.baseRowResult(index + 2, row),
      });
      continue;
    }
    const dryRun = plan.dryRunResult(index + 2, row, args);
    rows.push({
      rawIndex: index,
      rowNumber: index + 2,
      eligible: true,
      status: dryRun.ready ? 'ready' : 'missing_fields',
      message: dryRun.ready ? 'ready' : dryRun.missing.join(','),
      missing: dryRun.missing,
      ...dryRun,
    });
  }

  return {header, dataRows, rows, args};
}

export async function makeJobFiles(jobId, fileName, csvText) {
  mkdirSync(UPLOAD_DIR, {recursive: true});
  mkdirSync(RESULT_DIR, {recursive: true});
  const uploadName = `${jobId}-${safeFileName(fileName)}`;
  const csvPath = join(UPLOAD_DIR, uploadName);
  const resultCsvPath = join(RESULT_DIR, `${uploadName.replace(/\.csv$/i, '')}.result.csv`);
  writeFileSync(csvPath, csvText, {encoding: 'utf8', mode: 0o600});
  chmodSync(csvPath, 0o600);
  return {csvPath, resultCsvPath};
}

export function rowInsertFromDryRun(jobId, row) {
  return {
    id: newId('row'),
    jobId,
    rowNumber: row.rowNumber,
    rawIndex: row.rawIndex,
    profileId: row.id || '',
    opomAccountId: row.opomAccountId || '',
    usernameMasked: row.username || '',
    loginEmailMasked: row.loginEmail || row.loginEmailMasked || row.username || '',
    adsPowerUserId: row.adsPowerUserId || '',
    adsPowerSerialNumber: row.adsPowerSerialNumber || '',
    adsMatchStatus: row.adsMatchStatus || 'not_verified',
    ejhOrderNo: row.ejhOrderNo || '',
    cardNo: row.cardNo || '',
    cardLast4: row.cardLast4 || '',
    purchasePlan: row.purchasePlan || '',
    amount: row.amount || '',
    status: row.status === 'ready' ? 'queued' : row.status,
    stage: row.status === 'ready' ? 'queued' : 'input.missing_fields',
    message: row.message || '',
    missingJson: JSON.stringify(row.missing || []),
    updatedAt: nowIso(),
  };
}

export function publicJob(row) {
  if (!row) return null;
  const options = JSON.parse(row.options_json || '{}');
  const args = runnerArgs(options);
  return {
    id: row.id,
    fileName: row.file_name,
    status: row.status,
    dryRunStatus: row.dry_run_status,
    resultCsvReady: existsSync(row.result_csv_path),
    options: {
      removeExisting: args.removeExisting,
      stopProfiles: args.stopProfiles,
      concurrency: args.concurrency,
      confirmPurchase: args.confirmPurchase,
      preparePurchaseOnly: args.preparePurchaseOnly,
      rowTimeoutMs: args.rowTimeoutMs,
      adspowerStartTimeoutMs: args.adspowerStartTimeoutMs,
      hasAdspowerApiKey: !!args.adspowerApiKey,
      executionScope: plan.scopeSummary(args),
      scopeBillingAddress: args.scopeBillingAddress,
      scopePaymentMethod: args.scopePaymentMethod,
      scopePurchase: args.scopePurchase,
      scopeAutoTopup: args.scopeAutoTopup,
      opomWriteback: args.opomWriteback,
      hasOpomRechargeToken: !!args.opomRechargeToken,
      opomBaseUrl: args.opomBaseUrl,
      opomRequestTimeoutMs: args.opomRequestTimeoutMs,
      opomRequestRetries: args.opomRequestRetries,
      opomWritebackRetries: args.opomWritebackRetries,
      opomRetryDelayMs: args.opomRetryDelayMs,
      runId: args.runId,
      adspowerStatusMode: args.adspowerStatusMode,
      hasAdspowerSuccessGroupTarget: !!(args.adspowerSuccessGroupId || args.adspowerSuccessGroupName),
      hasAdspowerFailureGroupTarget: !!(args.adspowerFailureGroupId || args.adspowerFailureGroupName),
      hasAdspowerBlockerGroupTarget: !!(args.adspowerBlockerGroupId || args.adspowerBlockerGroupName),
    },
    totalRows: row.total_rows,
    readyRows: row.ready_rows,
    completedRows: row.completed_rows,
    failedRows: row.failed_rows,
    blockedRows: row.blocked_rows,
    skippedRows: row.skipped_rows,
    cancelRequested: !!row.cancel_requested,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function publicRow(row) {
  return {
    id: row.id,
    rowNumber: row.row_number,
    profileId: row.profile_id,
    opomAccountId: row.opom_account_id,
    username: row.username_masked,
    loginEmail: row.login_email_masked,
    loginEmailMasked: row.login_email_masked,
    adsPowerUserId: row.ads_power_user_id,
    adsPowerSerialNumber: row.ads_power_serial_number,
    adsMatchStatus: row.ads_match_status,
    ejhOrderNo: row.ejh_order_no,
    cardNo: row.card_no,
    cardLast4: row.card_last4,
    purchasePlan: row.purchase_plan,
    amount: row.amount,
    status: row.status,
    stage: row.stage,
    message: row.message,
    missing: JSON.parse(row.missing_json || '[]'),
    purchaseStatus: row.purchase_status,
    purchaseAmount: row.purchase_amount,
    balanceBefore: row.balance_before,
    balanceAfter: row.balance_after,
    autoTopupStatus: row.auto_topup_status,
    autoTopupThreshold: row.auto_topup_threshold,
    autoTopupAmount: row.auto_topup_amount,
    opomCardWritebackStatus: row.opom_card_writeback_status,
    opomResultWritebackStatus: row.opom_result_writeback_status,
    adspowerTagStatus: row.adspower_tag_status,
    adspowerStatusMode: row.adspower_status_mode,
    adspowerStatusTarget: row.adspower_status_target,
    adspowerStatusReason: row.adspower_status_reason,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

export async function writeResultCsv({csvPath, resultCsvPath, rowsByRawIndex, runId = ''}) {
  const text = readFileSync(csvPath, 'utf8');
  const parsedRows = csv.parseCsv(text);
  const sourceHeader = [...parsedRows[0]];
  for (const key of OPTIONAL_COLUMNS) {
    if (!sourceHeader.includes(key)) sourceHeader.push(key);
  }
  const sourceRows = parsedRows.slice(1).map((row) => {
    const next = [...row];
    csv.padRows([next], sourceHeader.length);
    return next;
  });

  const outputHeader = uniqueColumns([
    'run_id',
    'row_number',
    'opom_account_id',
    'profile_id',
    'ads_power_user_id',
    'ads_power_serial_number',
    'username',
    'login_email',
    'opom_health_status',
    'opom_health_reason',
    'ejh_order_no',
    'cardno',
    'purchase_plan',
    'amount',
    'balance_threshold',
    'amount_below_threshold',
    'amount_at_or_above_threshold',
    'auto_topup_threshold',
    'auto_topup_amount',
    ...plan.resultColumns(),
  ]);
  const outcomeByRawIndex = new Map(rowsByRawIndex.map((item) => [item.rawIndex, item]));
  const outputRows = sourceRows.map((row, index) => {
    const source = csv.rowObject(sourceHeader, row);
    const metadata = plan.rowMetadata(source);
    const output = [
      runId,
      String(index + 2),
      metadata.opomAccountId,
      plan.profileDisplayId(source),
      metadata.adsPowerUserId,
      metadata.adsPowerSerialNumber,
      metadata.username,
      metadata.loginEmail,
      metadata.opomHealthStatus,
      metadata.opomHealthReason,
      metadata.ejhOrderNo,
      metadata.cardNo,
      plan.safePurchasePlan(source).mode || '',
      source.amount || '',
      source.balance_threshold || '',
      source.amount_below_threshold || '',
      source.amount_at_or_above_threshold || '',
      source.auto_topup_threshold || '',
      source.auto_topup_amount || '',
    ];
    const outcome = outcomeByRawIndex.get(index);
    if (outcome) {
      const normalized = normalizeCsvOutcome(outcome);
      const details = outcome.details || {};
      plan.writeOutcome(outputHeader, output, normalized.status, normalized.message, outcomeDetailsWithMetadata(details, metadata, runId));
    }
    return output;
  });

  const tmpPath = `${resultCsvPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, csv.stringifyCsv([outputHeader, ...outputRows]), {encoding: 'utf8', mode: 0o600});
    renameSync(tmpPath, resultCsvPath);
    chmodSync(resultCsvPath, 0o600);
  } catch (error) {
    if (existsSync(tmpPath)) {
      try {
        rmSync(tmpPath, {force: true});
      } catch {}
    }
    throw error;
  }
}

function uniqueColumns(columns) {
  return columns.filter((column, index) => columns.indexOf(column) === index);
}

function outcomeDetailsWithMetadata(details, metadata, runId) {
  return {
    ...details,
    runId: firstPresent(details.runId, runId),
    opomAccountId: firstPresent(details.opomAccountId, metadata.opomAccountId),
    username: firstPresent(details.username, metadata.username),
    loginEmail: firstPresent(details.loginEmail, metadata.loginEmail),
    loginEmailMasked: firstPresent(details.loginEmailMasked, metadata.loginEmailMasked),
    adsPowerUserId: firstPresent(details.adsPowerUserId, metadata.adsPowerUserId),
    adsPowerSerialNumber: firstPresent(details.adsPowerSerialNumber, metadata.adsPowerSerialNumber),
    opomHealthStatus: firstPresent(details.opomHealthStatus, metadata.opomHealthStatus),
    opomHealthReason: firstPresent(details.opomHealthReason, metadata.opomHealthReason),
    adsMatchStatus: firstPresent(details.adsMatchStatus, metadata.adsMatchStatus),
    ejhOrderNo: firstPresent(details.ejhOrderNo, metadata.ejhOrderNo),
    cardNo: firstPresent(details.cardNo, metadata.cardNo),
    opomCardWritebackStatus: firstPresent(details.opomCardWritebackStatus, metadata.opomCardWritebackStatus),
    opomResultWritebackStatus: firstPresent(details.opomResultWritebackStatus, metadata.opomResultWritebackStatus),
    adspowerTagStatus: firstPresent(details.adspowerTagStatus, metadata.adspowerTagStatus),
    adspowerStatusMode: firstPresent(details.adspowerStatusMode, metadata.adspowerStatusMode),
    adspowerStatusTarget: firstPresent(details.adspowerStatusTarget, metadata.adspowerStatusTarget),
    adspowerStatusReason: firstPresent(details.adspowerStatusReason, metadata.adspowerStatusReason),
  };
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value) !== '') return value;
  }
  return '';
}

export function cleanupJobUpload(job) {
  if (!job?.csv_path || !existsSync(job.csv_path)) return false;
  rmSync(job.csv_path, {force: true});
  return true;
}

export async function executeRow(csvText, rawIndex, options = {}) {
  return executeRowWithAdapters(csvText, rawIndex, options, {
    bindScript: BIND_SCRIPT,
    childRunner,
    common,
    adspower,
    opom,
  });
}

export async function executeRowWithAdapters(csvText, rawIndex, options = {}, adapters = {}) {
  const bindScript = adapters.bindScript || BIND_SCRIPT;
  const childRunnerAdapter = adapters.childRunner || childRunner;
  const commonAdapter = adapters.common || common;
  const adspowerAdapter = adapters.adspower || adspower;
  const opomAdapter = adapters.opom || opom;
  const parsed = csv.parseCsv(csvText);
  const header = [...parsed[0]];
  for (const key of OPTIONAL_COLUMNS) {
    if (!header.includes(key)) header.push(key);
  }
  csv.ensureColumns(header, plan.resultColumns());
  const dataRows = parsed.slice(1).map((row) => {
    const next = [...row];
    csv.padRows([next], header.length);
    return next;
  });
  const row = csv.rowObject(header, dataRows[rawIndex]);
  const args = runnerArgs(options);
  const automationLogDir = ensureAutomationLogDir(options.runtimeLog, rawIndex);
  const missing = plan.validateRow(row, args);
  if (missing.length) {
    const details = {...plan.rowMetadata(row), automationLogDir, cardLast4: commonAdapter.cardLast4(plan.cardNumber(row))};
    await writeNonCompletedOpomResult(opomAdapter, args, row, details, {
      rowNumber: rawIndex + 2,
      status: status.STATUSES.MISSING_FIELDS,
      message: missing.join(','),
      errorCode: status.STATUSES.MISSING_FIELDS,
    });
    return {
      status: status.STATUSES.MISSING_FIELDS,
      stage: 'input.missing_fields',
      message: missing.join(','),
      details,
      safeToContinue: true,
      stopProfile: true,
    };
  }

  const task = plan.buildClosedLoopTask(row, args);
  task.adspowerApiBase = args.adspowerApiBase;
  task.adspowerApiKey = args.adspowerApiKey;
  task.adspowerStartTimeoutMs = args.adspowerStartTimeoutMs;
  task.confirmationDebugDir ||= automationLogDir;
  if (!args.scopePurchase || !args.confirmPurchase) {
    task.purchase.confirmed = false;
    task.preparePurchaseOnly = args.scopePurchase && args.preparePurchaseOnly;
  }
  const outcome = adapters.runClosedLoopChildAsync
    ? await adapters.runClosedLoopChildAsync(bindScript, task, args)
    : await runClosedLoopChildAsync(bindScript, task, args, childRunnerAdapter, commonAdapter);
  let profileStop = {attempted: false};
  if (outcome.ok) {
    const details = args.confirmPurchase
      ? plan.successDetails(row, outcome.result, args)
      : testModeSuccessDetails(row, outcome.result, args, plan, commonAdapter);
    details.automationLogDir = automationLogDir;
    const purchaseOk = !args.scopePurchase
      || (args.confirmPurchase ? /^(verified|skipped_by_balance_rule)$/.test(details.purchaseStatus) : details.purchaseStatus === 'prepared_without_submission');
    const autoTopupOk = !args.scopeAutoTopup || /^(updated|unchanged)$/.test(details.autoTopupStatus);
    let completed = purchaseOk && autoTopupOk;
    if (completed && args.opomWriteback && args.confirmPurchase) {
      try {
        const writeback = await opomAdapter.writeCompletedRow(args, row, details, {rowNumber: rawIndex + 2});
        details.opomCardWritebackStatus = writeback.cardStatus;
        details.opomResultWritebackStatus = writeback.resultStatus;
      } catch (error) {
        completed = false;
        details.opomCardWritebackStatus = error.opomCardWritebackStatus || details.opomCardWritebackStatus || 'failed';
        details.opomResultWritebackStatus = error.opomResultWritebackStatus || details.opomResultWritebackStatus || 'failed';
        await writeNonCompletedOpomResult(opomAdapter, args, row, details, {
          rowNumber: rawIndex + 2,
          status: status.STATUSES.FAILED,
          stage: 'opom.writeback',
          message: commonAdapter.redact(error.message || 'OPOM writeback failed after verified purchase'),
          errorCode: 'opom_writeback_failed',
        });
        if (args.stopProfiles) profileStop = await adspowerAdapter.stopProfile(args, plan.adsPowerProfileIdentifier(row));
        return {
          status: status.STATUSES.FAILED,
          stage: 'opom.writeback',
          message: commonAdapter.redact(error.message || 'OPOM writeback failed after verified purchase'),
          details,
          safeToContinue: true,
          stopProfile: true,
          profileStop,
        };
      }
    }
    if (args.stopProfiles) profileStop = await adspowerAdapter.stopProfile(args, plan.adsPowerProfileIdentifier(row));
    return {
      status: completed ? status.STATUSES.COMPLETED : status.STATUSES.PURCHASE_UNVERIFIED,
      stage: completed ? 'closed_loop.complete' : 'scope.verify',
      message: completed
        ? completionMessage(args)
        : 'selected execution scope was not fully verified',
      details,
      safeToContinue: true,
      stopProfile: true,
      profileStop,
    };
  }

  const contract = status.classifyError(outcome.error);
  const failureDetails = {...plan.rowMetadata(row), automationLogDir, cardLast4: commonAdapter.cardLast4(plan.cardNumber(row))};
  await writeNonCompletedOpomResult(opomAdapter, args, row, failureDetails, {
    rowNumber: rawIndex + 2,
    status: contract.status,
    message: commonAdapter.redact(outcome.error),
    errorCode: contract.status,
  });
  if (args.stopProfiles && contract.stopProfile) {
    profileStop = await adspowerAdapter.stopProfile(args, plan.adsPowerProfileIdentifier(row));
  }
  return {
    status: contract.status,
    stage: contract.stage,
    message: commonAdapter.redact(outcome.error),
    details: failureDetails,
    safeToContinue: contract.safeToContinueBatch,
    stopProfile: contract.stopProfile,
    profileStop,
  };
}

async function writeNonCompletedOpomResult(opomAdapter, args, row, details, context) {
  if (!args.opomWriteback || !plan.opomAccountId(row)) return;
  try {
    await opomAdapter.writeRowResult(args, row, details, context);
    details.opomResultWritebackStatus = 'written';
  } catch {
    details.opomResultWritebackStatus = 'failed';
  }
}

function ensureAutomationLogDir(runtimeLog = {}, rawIndex = 0) {
  cleanupOldAutomationLogs();
  const jobId = String(runtimeLog.jobId || 'manual').replace(/[^a-zA-Z0-9._-]+/g, '_');
  const rowNumber = String(runtimeLog.rowNumber || rawIndex + 2).replace(/[^a-zA-Z0-9._-]+/g, '_');
  const rowId = String(runtimeLog.rowId || '').replace(/[^a-zA-Z0-9._-]+/g, '_');
  const dir = join(LOG_DIR, jobId, `row-${rowNumber}${rowId ? `-${rowId}` : ''}`);
  mkdirSync(dir, {recursive: true});
  return dir;
}

function cleanupOldAutomationLogs() {
  const retentionHours = Number.isFinite(AUTOMATION_LOG_RETENTION_HOURS) ? AUTOMATION_LOG_RETENTION_HOURS : 48;
  if (retentionHours <= 0) return;
  const now = Date.now();
  if (now - lastAutomationLogCleanupAt < 60 * 60 * 1000) return;
  lastAutomationLogCleanupAt = now;
  if (!existsSync(LOG_DIR)) return;
  const cutoff = now - retentionHours * 60 * 60 * 1000;
  for (const entry of readdirSync(LOG_DIR, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const path = join(LOG_DIR, entry.name);
    try {
      const stat = statSync(path);
      if (stat.mtimeMs < cutoff) rmSync(path, {recursive: true, force: true});
    } catch {
      // Log cleanup is best effort; never block a recharge row.
    }
  }
}

function normalizeCsvOutcome(outcome) {
  if (outcome.status === 'canceled') {
    return {
      status: 'failed',
      message: outcome.message || 'canceled before execution',
    };
  }
  if (outcome.status === 'skipped') {
    return {
      status: 'skipped',
      message: outcome.message || 'row was already completed or not eligible; no new charge attempted',
    };
  }
  return {
    status: outcome.status,
    message: outcome.message || '',
  };
}

function testModeSuccessDetails(row, result, args, planModule, commonModule = common) {
  const requestedAutoTopup = args.scopeAutoTopup
    ? (result.autoTopup?.requested || planModule.autoTopupPlan(row, args))
    : {threshold: '', amount: ''};
  return {
    ...planModule.rowMetadata(row),
    purchaseStatus: !args.scopePurchase
      ? 'skipped'
      : result.purchase?.mode === 'prepared_without_submission'
      ? 'prepared_without_submission'
      : 'not_submitted_test_mode',
    purchaseAmount: result.purchase?.amount || result.purchase?.ruleDecision?.selectedAmount || '',
    balanceBefore: result.purchase?.beforeBalance?.balance ?? '',
    balanceAfter: '',
    cardLast4: result.card?.last4 || commonModule.cardLast4(planModule.cardNumber(row)),
    autoTopupStatus: !args.scopeAutoTopup
      ? 'skipped'
      : result.autoTopup?.configured
      ? (result.autoTopup.changed ? 'updated' : 'unchanged')
      : 'not_configured',
    autoTopupThreshold: requestedAutoTopup.threshold || '',
    autoTopupAmount: requestedAutoTopup.amount || '',
  };
}

function completionMessage(args) {
  if (!args.scopePurchase) return `completed selected scope: ${plan.scopeSummary(args)}`;
  if (!args.confirmPurchase) return 'completed without purchase submission (test mode)';
  return 'completed';
}

async function runClosedLoopChildAsync(bindScript, task, args, childRunner, common) {
  const childArgs = [bindScript, '--stdin'];
  if (args.scopeAutoTopup) childArgs.push('--configure-auto-topup');
  if (args.scopePurchase && args.confirmPurchase) childArgs.push('--confirm-purchase');
  if (args.scopePaymentMethod && args.removeExisting) childArgs.push('--remove-existing');

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    const child = spawn(process.execPath, childArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ADSPOWER_API_BASE: args.adspowerApiBase || process.env.ADSPOWER_API_BASE || '',
        ADSPOWER_API_KEY: args.adspowerApiKey || process.env.ADSPOWER_API_KEY || '',
        ADSPOWER_START_TIMEOUT_MS: args.adspowerStartTimeoutMs || process.env.ADSPOWER_START_TIMEOUT_MS || '',
      },
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref?.();
    }, args.rowTimeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    const capture = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      return next.length > CHILD_OUTPUT_LIMIT ? next.slice(-CHILD_OUTPUT_LIMIT) : next;
    };

    child.stdout.on('data', (chunk) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = capture(stderr, chunk);
    });
    child.on('error', (error) => {
      finish({ok: false, error: error.message});
    });
    child.on('close', (code) => {
      const parsed = childRunner.parseChildJson(stdout, stderr);
      if (code === 0 && parsed?.ok) {
        finish({ok: true, result: parsed});
        return;
      }
      if (timedOut) {
        finish({
          ok: false,
          error: `bind script timed out after ${args.rowTimeoutMs}ms`,
          child: args.verbose ? {stdout: common.redact(stdout), stderr: common.redact(stderr)} : undefined,
        });
        return;
      }
      const message = parsed?.error || stderr || stdout || `bind script exited ${code}`;
      finish({
        ok: false,
        error: message,
        child: args.verbose ? {stdout: common.redact(stdout), stderr: common.redact(stderr)} : undefined,
      });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(task));
  });
}
