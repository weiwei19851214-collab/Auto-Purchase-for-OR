import {redact} from './redact.mjs';
import * as plan from '../automation/lib/recharge-plan.mjs';

const DEFAULT_GROUP = 'recharge';
const DEFAULT_OPOM_REQUEST_TIMEOUT_MS = 45000;
const DEFAULT_OPOM_REQUEST_RETRIES = 3;
const DEFAULT_OPOM_WRITEBACK_RETRIES = 3;
const DEFAULT_OPOM_RETRY_DELAY_MS = 1500;

export function opomDefaults(env = process.env) {
  return {
    opomBaseUrl: env.OPOM_BASE_URL || env.OPOM_API_BASE || '',
    opomRechargeToken: env.OPOM_RECHARGE_TOKEN || '',
  };
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/$/, '');
}

function authHeaders(args) {
  const token = args.opomRechargeToken || '';
  const headers = {'Content-Type': 'application/json'};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['x-recharge-api-token'] = token;
  }
  return headers;
}

function assertConfigured(args) {
  if (!normalizeBaseUrl(args.opomBaseUrl)) throw new Error('OPOM_BASE_URL is not configured');
  if (!args.opomRechargeToken) throw new Error('OPOM_RECHARGE_TOKEN is not configured');
}

async function readJsonResponse(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {raw: text};
  }
}

async function requestJson(args, path, options = {}) {
  assertConfigured(args);
  const baseUrl = normalizeBaseUrl(args.opomBaseUrl);
  const timeoutMs = Number(args.opomRequestTimeoutMs || process.env.OPOM_REQUEST_TIMEOUT_MS || DEFAULT_OPOM_REQUEST_TIMEOUT_MS);
  const method = String(options.method || 'GET').toUpperCase();
  const retryableWrite = options.idempotent === true && /^(POST|PUT|PATCH)$/.test(method);
  const retries = method === 'GET'
    ? Number(args.opomRequestRetries || process.env.OPOM_REQUEST_RETRIES || DEFAULT_OPOM_REQUEST_RETRIES)
    : retryableWrite
      ? Number(args.opomWritebackRetries || process.env.OPOM_WRITEBACK_RETRIES || DEFAULT_OPOM_WRITEBACK_RETRIES)
    : 1;
  const retryDelayMs = Number(args.opomRetryDelayMs || process.env.OPOM_RETRY_DELAY_MS || DEFAULT_OPOM_RETRY_DELAY_MS);
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, retries); attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          ...authHeaders(args),
          ...(options.headers || {}),
        },
      });
      clearTimeout(timeout);
      const body = await readJsonResponse(res);
      if (!res.ok) {
        const message = body?.error?.message || body?.error || body?.message || `OPOM HTTP ${res.status}`;
        if ((method === 'GET' || retryableWrite) && res.status >= 500 && attempt < retries) {
          lastError = new Error(`OPOM request failed: ${message}`);
          await sleep(retryDelayMs * attempt);
          continue;
        }
        const httpError = new Error(redact(`OPOM request failed: ${message}`));
        httpError.nonRetryable = true;
        throw httpError;
      }
      return body;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (error?.nonRetryable) {
        throw error;
      }
      if ((method === 'GET' || retryableWrite) && attempt < retries) {
        await sleep(retryDelayMs * attempt);
        continue;
      }
    }
  }
  const cause = lastError?.name === 'AbortError'
    ? `timeout after ${timeoutMs}ms`
    : (lastError?.cause?.code || lastError?.cause?.message || lastError?.message || 'request failed');
  throw new Error(redact(`OPOM network failed at ${baseUrl}: ${cause}`));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchRechargeAccounts(args, input = {}) {
  const params = new URLSearchParams();
  params.set('group', input.group || DEFAULT_GROUP);
  params.set('status', input.status || 'needs_recharge');
  if (input.limit) params.set('limit', String(input.limit));
  if (input.cursor) params.set('cursor', String(input.cursor));
  if (input.sort) params.set('sort', String(input.sort));
  const body = await requestJson(args, `/api/v1/recharge/accounts?${params.toString()}`);
  return {
    accounts: Array.isArray(body.data) ? body.data : [],
    nextCursor: body.nextCursor || body.data?.nextCursor || null,
  };
}

export function canonicalRowsFromOpomAccounts(accounts, defaults = {}) {
  return accounts.map((account) => {
    const policy = account.rechargePolicy || {};
    const ads = account.adsPower || {};
    const health = account.health || {};
    return {
      status: '',
      opom_account_id: account.opomAccountId || account.id || '',
      login_email: account.loginEmail || account.username || '',
      ads_power_user_id: ads.userId || account.ads_power_user_id || '',
      ads_power_serial_number: ads.serialNumber || account.ads_power_serial_number || '',
      ads_power_group_name: ads.groupName || '',
      opom_health_status: health.status || (health.eligible === false ? 'unknown_blocked' : 'ok'),
      opom_health_reason: health.reason || '',
      ads_match_status: 'not_verified',
      order_no: '',
      card_no: '',
      exp_month: '',
      exp_year: '',
      cvv: '',
      amount: policy.amount || policy.amountUsd || defaults.amount || defaults.purchaseAmount || '',
      postal_code: defaults.postalCode || '',
      holder_name: defaults.holderName || '',
      country: defaults.country || 'US',
      address_line1: defaults.addressLine1 || '',
      city: defaults.city || '',
      state: defaults.state || '',
      balance_threshold: policy.balanceThreshold || policy.balanceThresholdUsd || defaults.balanceThreshold || '',
      amount_below_threshold: policy.amountBelowThreshold || policy.amountBelowThresholdUsd || defaults.amountBelowThreshold || '',
      amount_at_or_above_threshold: policy.amountAtOrAboveThreshold || policy.amountAtOrAboveThresholdUsd || defaults.amountAtOrAboveThreshold || '',
      auto_topup_threshold: policy.autoTopupThreshold || defaults.autoTopupThreshold || '',
      auto_topup_amount: policy.autoTopupAmount || defaults.autoTopupAmount || '',
      idempotency_key: account.version
        ? `recharge_plan:${account.opomAccountId || account.id}:${account.version}`
        : '',
    };
  });
}

export function cardExpiryIso(row) {
  const explicit = row.expires_at || row.validityDate || row.validity_date || '';
  if (explicit) return new Date(explicit).toISOString();
  const month = Number(String(row.exp_month || '').replace(/\D/g, ''));
  let year = Number(String(row.exp_year || '').replace(/\D/g, ''));
  if (year > 0 && year < 100) year += 2000;
  if (!month || !year) return '';
  return new Date(Date.UTC(year, month, 0, 0, 0, 0)).toISOString();
}

export async function writeCompletedRow(args, row, details, context = {}) {
  const opomAccountId = plan.opomAccountId(row);
  if (!args.opomWriteback || !opomAccountId) {
    return {cardStatus: 'skipped', resultStatus: 'skipped'};
  }
  const runId = args.runId || context.runId || '';
  const orderNo = plan.ejhOrderNo(row);
  const cardNo = plan.cardNumber(row);
  const idempotencyKey = row.card_binding_idempotency_key || `card_binding:${opomAccountId}:${orderNo || details.cardLast4 || runId}`;
  const expiresAt = cardExpiryIso(row);
  if (!orderNo || !cardNo || !expiresAt) {
    throw writebackError(new Error('OPOM card binding requires orderNo, cardNo, and expiresAt'), {
      cardStatus: 'failed',
      resultStatus: 'skipped',
    });
  }
  const bindingBody = {
    idempotencyKey,
    card: {
      orderNo,
      cardNo,
      expiresAt,
      cvvPresent: !!row.cvv,
    },
    binding: {
      boundAt: new Date().toISOString(),
      source: 'recharge-runner',
      notes: runId ? `${runId} row ${context.rowNumber || ''}`.trim() : 'recharge-runner',
    },
  };
  try {
    await requestJson(args, `/api/v1/recharge/accounts/${encodeURIComponent(opomAccountId)}/card-binding`, {
      method: 'PUT',
      idempotent: true,
      body: JSON.stringify(bindingBody),
    });
  } catch (error) {
    throw writebackError(error, {cardStatus: 'failed', resultStatus: 'skipped'});
  }
  try {
    await writeRowResult(args, row, details, {...context, status: 'completed'});
  } catch (error) {
    throw writebackError(error, {cardStatus: 'written', resultStatus: 'failed'});
  }
  return {cardStatus: 'written', resultStatus: 'written'};
}

export async function writeRowResult(args, row, details, context = {}) {
  if (!args.opomWriteback || !plan.opomAccountId(row)) return {resultStatus: 'skipped'};
  const runId = args.runId || context.runId || 'local-run';
  const loginEmail = safeLoginEmail(row);
  const card = resultCard(row, details);
  const errorCode = context.errorCode || '';
  const errorMessage = redact(context.message || '');
  const stage = context.stage || '';
  const status = context.status || details.status || '';
  const stageKey = stage || (status === 'completed' ? 'completed' : 'result');
  const attemptNo = context.attemptNo || 1;
  const defaultIdempotencyKey = `recharge_result:${runId}:${context.rowNumber || ''}:${attemptNo}:${status || 'unknown'}:${stageKey}`;
  const idempotencyKey = row.result_idempotency_key
    ? `${row.result_idempotency_key}:${status || 'unknown'}:${stageKey}:${attemptNo}`
    : defaultIdempotencyKey;
  const body = {
    idempotencyKey,
    opomAccountId: plan.opomAccountId(row),
    ...(loginEmail ? {loginEmail} : {}),
    status,
    amountUsd: numberOrUndefined(details.purchaseAmount),
    balanceBeforeUsd: numberOrUndefined(details.balanceBefore),
    balanceAfterUsd: numberOrUndefined(details.balanceAfter),
    ...(card ? {card} : {}),
    ...(errorCode ? {errorCode} : {}),
    ...(errorMessage ? {errorMessage} : {}),
    ...(stage ? {stage} : {}),
    occurredAt: new Date().toISOString(),
  };
  await requestJson(args, `/api/v1/recharge/runs/${encodeURIComponent(runId)}/results`, {
    method: 'POST',
    idempotent: true,
    body: JSON.stringify(body),
  });
  return {resultStatus: 'written'};
}

function resultCard(row, details = {}) {
  const card = {};
  const orderNo = plan.ejhOrderNo(row);
  const panLast4 = details.cardLast4 || cardLast4FromRow(row);
  if (orderNo) card.orderNo = orderNo;
  if (/^\d{4}$/.test(panLast4)) card.panLast4 = panLast4;
  return Object.keys(card).length ? card : null;
}

function cardLast4FromRow(row) {
  const digits = plan.cardNumber(row).replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

function numberOrUndefined(value) {
  if (value === '' || value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function safeLoginEmail(row) {
  const value = plan.loginEmail(row);
  if (!value || value.includes('*')) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : '';
}

function writebackError(error, status) {
  const wrapped = new Error(redact(error?.message || 'OPOM writeback failed'));
  wrapped.opomCardWritebackStatus = status.cardStatus;
  wrapped.opomResultWritebackStatus = status.resultStatus;
  return wrapped;
}
