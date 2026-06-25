import {mkdirSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {fetchRechargeAccounts, opomDefaults} from './opom-client.mjs';
import {newId, nowIso} from './ids.mjs';
import {redact} from './redact.mjs';

const DEFAULT_POLL_INTERVAL_MINUTES = 18;
const DEFAULT_GROUP = 'recharge';
const DEFAULT_STATUS = 'needs_recharge';
const DEFAULT_LIMIT = 50;
const MIN_CARD_AMOUNT = 150;
const MAX_CARD_AMOUNT = 10000;
const CARD_AMOUNT_STEP = 150;

export function replacementDefaults(now = new Date()) {
  const dateDir = chinaDateString(now);
  const artifactDir = join(homedir(), 'Desktop', dateDir);
  return {
    pollIntervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
    autoExecuteOnFound: false,
    autoCreateEjhCards: false,
    autoBindInAdsPowerAfterCardCreate: false,
    group: DEFAULT_GROUP,
    status: DEFAULT_STATUS,
    limit: DEFAULT_LIMIT,
    artifactDir,
    logRootDir: join(artifactDir, 'logs'),
    cardType: '',
    supportedMccGroup: 'trv',
    cardExpiryDays: '3',
  };
}

export function resolveReplacementDirs(options = {}, now = new Date()) {
  const defaults = replacementDefaults(now);
  const dateDir = chinaDateString(now);
  const artifactInput = String(options.replacementArtifactDir || options.artifactDir || '').trim();
  const artifactDir = artifactInput
    ? resolveDatedDir(artifactInput, dateDir)
    : defaults.artifactDir;
  const logInput = String(options.replacementLogRootDir || options.logRootDir || '').trim();
  const logRootDir = logInput
    ? resolveDatedDir(logInput, dateDir)
    : join(artifactDir, 'logs');
  return {artifactDir, logRootDir};
}

export async function replacementQueuePayload(payload = {}) {
  const defaults = replacementDefaults();
  const group = String(payload.group || defaults.group).trim() || defaults.group;
  const status = String(payload.status || defaults.status).trim() || defaults.status;
  const limit = clampInteger(payload.limit || defaults.limit, 1, 200, defaults.limit);
  const cursor = String(payload.cursor || '').trim();
  const envOpom = opomDefaults();
  const opomArgs = {
    ...envOpom,
    opomBaseUrl: payload.opomBaseUrl || envOpom.opomBaseUrl,
    opomRechargeToken: payload.opomRechargeToken || envOpom.opomRechargeToken,
    opomRequestTimeoutMs: payload.opomRequestTimeoutMs,
    opomRequestRetries: payload.opomRequestRetries,
    opomRetryDelayMs: payload.opomRetryDelayMs,
  };
  const result = await fetchRechargeAccounts(opomArgs, {group, status, limit, cursor});
  const rows = result.accounts.map((account, index) => replacementRowFromAccount(account, index));
  return {
    ok: true,
    source: `${group}/${status}`,
    count: rows.length,
    nextCursor: result.nextCursor || '',
    rows,
    defaults,
  };
}

export function replacementRowFromAccount(account = {}, index = 0) {
  const ads = account.adsPower || {};
  const health = account.health || {};
  const usage = Array.isArray(account.usageLast3Days) ? account.usageLast3Days : [];
  const usageValues = usage
    .map((item) => Number(item?.costUsd ?? item?.cost ?? 0))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const total3d = usageValues.reduce((sum, value) => sum + value, 0);
  const avgDailySpend3d = usageValues.length ? total3d / usageValues.length : 0;
  const maxDailySpend3d = usageValues.length ? Math.max(...usageValues) : 0;
  const suggestedCardAmount = suggestedReplacementCardAmount(avgDailySpend3d);
  const eligible = health.eligible !== false && (health.status || 'ok') === 'ok' && usageValues.length > 0;
  return {
    rowNumber: index + 1,
    opomAccountId: account.opomAccountId || account.id || '',
    loginEmail: account.loginEmail || account.username || '',
    adsPowerUserId: ads.userId || '',
    adsPowerSerialNumber: ads.serialNumber || '',
    adsPowerGroupName: ads.groupName || '',
    currentBalanceUsd: account.currentBalanceUsd ?? '',
    healthStatus: health.status || (health.eligible === false ? 'not_eligible' : 'ok'),
    healthReason: health.reason || '',
    eligible,
    usageLast3Days: usage,
    avgDailySpend3d: roundMoney(avgDailySpend3d),
    maxDailySpend3d: roundMoney(maxDailySpend3d),
    amountStrategy: 'avg_daily_spend_3d_x5_round_150',
    suggestedCardAmount,
    stage: eligible ? 'card_amount_planned' : 'blocked',
    message: eligible ? '' : (health.reason || 'usageLast3Days missing or account not eligible'),
  };
}

export function suggestedReplacementCardAmount(avgDailySpend3d) {
  const raw = Number(avgDailySpend3d || 0) * 5;
  const rounded = Math.ceil(raw / CARD_AMOUNT_STEP) * CARD_AMOUNT_STEP;
  return Math.min(Math.max(rounded || MIN_CARD_AMOUNT, MIN_CARD_AMOUNT), MAX_CARD_AMOUNT);
}

export function createExceptionCard(db, payload = {}) {
  const {artifactDir} = resolveReplacementDirs(payload);
  mkdirSync(artifactDir, {recursive: true});
  const createdAt = nowIso();
  const id = newId('exception_card');
  const cardNo = String(payload.cardNo || payload.card_no || '').replace(/\s+/g, '');
  const cardLast4 = String(payload.cardLast4 || payload.card_last4 || cardNo.replace(/\D/g, '').slice(-4) || '').trim();
  const record = {
    id,
    opomAccountId: String(payload.opomAccountId || payload.opom_account_id || '').trim(),
    loginEmail: String(payload.loginEmail || payload.login_email || '').trim(),
    adsPowerUserId: String(payload.adsPowerUserId || payload.ads_power_user_id || '').trim(),
    adsPowerSerialNumber: String(payload.adsPowerSerialNumber || payload.ads_power_serial_number || '').trim(),
    ejhOrderNo: String(payload.ejhOrderNo || payload.order_no || payload.ejh_order_no || '').trim(),
    cardNo,
    cardLast4,
    expMonth: String(payload.expMonth || payload.exp_month || '').trim(),
    expYear: String(payload.expYear || payload.exp_year || '').trim(),
    sourceJobId: String(payload.sourceJobId || payload.source_job_id || '').trim(),
    sourceRowNumber: String(payload.sourceRowNumber || payload.source_row_number || '').trim(),
    reason: redact(payload.reason || payload.message || 'exception card recorded'),
    createdAt,
  };
  const csvPath = join(artifactDir, exceptionCardFileName(record, createdAt));
  const row = exceptionCardCsvRow({...record, csvPath});
  writeFileSync(csvPath, csvText([EXCEPTION_CARD_HEADER, row]), 'utf8');
  db.prepare(`
    INSERT INTO exception_cards (
      id, opom_account_id, login_email, ads_power_user_id, ads_power_serial_number,
      ejh_order_no, card_no, card_last4, exp_month, exp_year, source_job_id,
      source_row_number, reason, csv_path, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.opomAccountId,
    record.loginEmail,
    record.adsPowerUserId,
    record.adsPowerSerialNumber,
    record.ejhOrderNo,
    record.cardNo,
    record.cardLast4,
    record.expMonth,
    record.expYear,
    record.sourceJobId,
    record.sourceRowNumber,
    record.reason,
    csvPath,
    record.createdAt,
  );
  return {ok: true, card: publicExceptionCard({...record, csvPath}), csvPath};
}

export function listExceptionCards(db) {
  const rows = db.prepare(`
    SELECT * FROM exception_cards
    ORDER BY created_at DESC
    LIMIT 500
  `).all();
  return rows.map(exceptionCardFromDbRow);
}

export function exceptionCardsCsv(db) {
  const rows = listExceptionCards(db).map(exceptionCardCsvRow);
  return csvText([EXCEPTION_CARD_HEADER, ...rows]);
}

function exceptionCardFromDbRow(row) {
  return publicExceptionCard({
    id: row.id,
    opomAccountId: row.opom_account_id,
    loginEmail: row.login_email,
    adsPowerUserId: row.ads_power_user_id,
    adsPowerSerialNumber: row.ads_power_serial_number,
    ejhOrderNo: row.ejh_order_no,
    cardNo: row.card_no,
    cardLast4: row.card_last4,
    expMonth: row.exp_month,
    expYear: row.exp_year,
    sourceJobId: row.source_job_id,
    sourceRowNumber: row.source_row_number,
    reason: row.reason,
    csvPath: row.csv_path,
    createdAt: row.created_at,
  });
}

function publicExceptionCard(record) {
  return {
    id: record.id,
    opomAccountId: record.opomAccountId,
    loginEmail: record.loginEmail,
    adsPowerUserId: record.adsPowerUserId,
    adsPowerSerialNumber: record.adsPowerSerialNumber,
    ejhOrderNo: record.ejhOrderNo,
    cardNo: record.cardNo,
    cardLast4: record.cardLast4,
    expMonth: record.expMonth,
    expYear: record.expYear,
    sourceJobId: record.sourceJobId,
    sourceRowNumber: record.sourceRowNumber,
    reason: record.reason,
    csvPath: record.csvPath,
    createdAt: record.createdAt,
    reusableForOriginalAccount: false,
  };
}

const EXCEPTION_CARD_HEADER = [
  'exception_card_id',
  'created_at',
  'opom_account_id',
  'login_email',
  'ads_power_user_id',
  'ads_power_serial_number',
  'ejh_order_no',
  'card_no',
  'card_last4',
  'exp_month',
  'exp_year',
  'source_job_id',
  'source_row_number',
  'reason',
  'csv_path',
  'reusable_for_original_account',
];

function exceptionCardCsvRow(record) {
  return [
    record.id,
    record.createdAt,
    record.opomAccountId,
    record.loginEmail,
    record.adsPowerUserId,
    record.adsPowerSerialNumber,
    record.ejhOrderNo,
    record.cardNo,
    record.cardLast4,
    record.expMonth,
    record.expYear,
    record.sourceJobId,
    record.sourceRowNumber,
    record.reason,
    record.csvPath,
    'false',
  ];
}

function exceptionCardFileName(record, createdAt) {
  const stamp = compactChinaTimestamp(createdAt);
  const account = safeFilePart(record.opomAccountId || record.loginEmail || record.sourceRowNumber || 'unknown');
  const card = safeFilePart(record.ejhOrderNo || record.cardLast4 || 'card');
  return `exception_card_${stamp}_${account}_${card}.csv`;
}

function csvText(rows) {
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')}\r\n`;
}

function csvEscape(value) {
  const text = String(value ?? '');
  const escaped = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(escaped) ? `"${escaped.replace(/"/g, '""')}"` : escaped;
}

function chinaDateString(value = new Date()) {
  const parts = chinaParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function compactChinaTimestamp(value = new Date()) {
  const parts = chinaParts(value);
  return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
}

function chinaParts(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(value)).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
}

function safeFilePart(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'unknown';
}

function resolveDatedDir(input, dateDir) {
  const resolved = resolve(expandHome(input));
  if (new RegExp(`(^|/)${dateDir}(/|$)`).test(resolved)) return resolved;
  return join(resolved, dateDir);
}

function expandHome(input) {
  const text = String(input || '').trim();
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return join(homedir(), text.slice(2));
  return text;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function roundMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return Math.round(number * 1000) / 1000;
}
