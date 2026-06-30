import * as csv from '../automation/lib/csv.mjs';
import * as opom from './opom-client.mjs';

const CANONICAL_HEADER = [
  'status',
  'opom_account_id',
  'login_email',
  'ads_power_user_id',
  'ads_power_serial_number',
  'ads_power_group_name',
  'opom_health_status',
  'opom_health_reason',
  'ads_match_status',
  'order_no',
  'card_no',
  'exp_month',
  'exp_year',
  'cvv',
  'amount',
  'postal_code',
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
  'idempotency_key',
];

export function canonicalCsvFromRows(rows) {
  const output = [CANONICAL_HEADER];
  for (const row of rows) output.push(CANONICAL_HEADER.map((key) => row[key] ?? ''));
  return csv.stringifyCsv(output);
}

const ADDRESS_FIELDS = ['postal_code', 'holder_name', 'country', 'address_line1', 'city', 'state'];

function valueFrom(row, keys) {
  for (const key of keys) {
    const value = String(row[key] ?? '').trim();
    if (value) return value;
  }
  return '';
}

export function addressMappingsFromCsv(text = '') {
  const parsed = csv.parseCsv(text);
  if (parsed.length < 2) return [];
  const header = parsed[0].map((key) => String(key || '').trim());
  return parsed.slice(1).map((line) => {
    const source = csv.rowObject(header, line);
    return {
      opom_account_id: valueFrom(source, ['opom_account_id', 'opomAccountId', 'account_id']),
      login_email: valueFrom(source, ['login_email', 'loginEmail', 'username', 'email']),
      postal_code: valueFrom(source, ['postal_code', 'postalCode', 'Zip', 'zip']),
      holder_name: valueFrom(source, ['holder_name', 'holderName', 'name', 'FirstName', 'firstName', 'first_name']),
      country: valueFrom(source, ['country']) || 'US',
      address_line1: valueFrom(source, ['address_line1', 'addressLine1', 'address', 'Street', 'street']),
      city: valueFrom(source, ['city', 'City']),
      state: valueFrom(source, ['state', 'State']),
    };
  }).filter((mapping) => mapping.opom_account_id || mapping.login_email || ADDRESS_FIELDS.some((field) => mapping[field]));
}

export function applyAddressMappings(rows, mappings = []) {
  if (!mappings.length) return rows;
  const byAccountId = new Map();
  const byEmail = new Map();
  for (const mapping of mappings) {
    if (mapping.opom_account_id) byAccountId.set(String(mapping.opom_account_id), mapping);
    if (mapping.login_email) byEmail.set(String(mapping.login_email).toLowerCase(), mapping);
  }
  let sequentialIndex = 0;
  return rows.map((row) => {
    const mapping = byAccountId.get(String(row.opom_account_id || ''))
      || byEmail.get(String(row.login_email || '').toLowerCase())
      || mappings.filter((item) => !item.opom_account_id && !item.login_email)[sequentialIndex++];
    if (!mapping) return row;
    const next = {...row};
    for (const field of ADDRESS_FIELDS) {
      if (mapping[field]) next[field] = mapping[field];
    }
    return next;
  });
}

export async function readyToRechargePayload(payload = {}) {
  const rawLimit = Number(payload.limit || 100);
  const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 100));
  const args = {
    ...opom.opomDefaults(),
    opomBaseUrl: payload.opomBaseUrl || process.env.OPOM_BASE_URL || process.env.OPOM_API_BASE || '',
    opomRechargeToken: payload.opomRechargeToken || process.env.RECHARGE_API_TOKEN || process.env.OPOM_RECHARGE_TOKEN || '',
    opomSecondaryBaseUrl: payload.opomSecondaryBaseUrl || process.env.OPOM_SECONDARY_BASE_URL || process.env.OPOM_WRITEBACK_SECONDARY_BASE_URL || '',
    opomSecondaryRechargeToken: payload.opomSecondaryRechargeToken || process.env.OPOM_SECONDARY_RECHARGE_TOKEN || process.env.OPOM_WRITEBACK_SECONDARY_TOKEN || '',
    opomRequestTimeoutMs: payload.opomRequestTimeoutMs || process.env.OPOM_REQUEST_TIMEOUT_MS || '',
    opomRequestRetries: payload.opomRequestRetries || process.env.OPOM_REQUEST_RETRIES || '',
    opomWritebackRetries: payload.opomWritebackRetries || process.env.OPOM_WRITEBACK_RETRIES || '',
    opomRetryDelayMs: payload.opomRetryDelayMs || process.env.OPOM_RETRY_DELAY_MS || '',
  };
  const {accounts, nextCursor} = await opom.fetchRechargeAccounts(args, {
    group: payload.group || 'recharge',
    status: payload.status || 'needs_recharge',
    limit,
    cursor: payload.cursor || '',
    sort: payload.sort || '',
  });
  const addressMappings = [
    ...(Array.isArray(payload.addressMappings) ? payload.addressMappings : []),
    ...addressMappingsFromCsv(payload.addressCsvText || ''),
  ];
  const rows = applyAddressMappings(
    opom.canonicalRowsFromOpomAccounts(accounts, payload.defaults || {}),
    addressMappings,
  );
  return {
    ok: true,
    group: payload.group || 'recharge',
    count: rows.length,
    nextCursor,
    addressMappingCount: addressMappings.length,
    rows,
    csvText: canonicalCsvFromRows(rows),
  };
}

function mapPush(map, key, account) {
  const normalized = String(key || '').trim().toLowerCase();
  if (!normalized) return;
  if (!map.has(normalized)) map.set(normalized, []);
  map.get(normalized).push(account);
}

async function fetchAllRechargeAccounts(args, {maxPages = 50, group = 'recharge', status = 'needs_recharge'} = {}) {
  const accounts = [];
  let cursor = '';
  let lastCursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    const result = await opom.fetchRechargeAccounts(args, {
      group,
      status,
      limit: 200,
      cursor,
    });
    accounts.push(...result.accounts);
    lastCursor = cursor;
    cursor = result.nextCursor || '';
    if (!cursor || cursor === lastCursor) break;
  }
  return accounts;
}

function buildOpomAccountIndex(accounts) {
  const byAccountId = new Map();
  const byEmail = new Map();
  const bySerial = new Map();
  const byUserId = new Map();
  for (const account of accounts) {
    const id = account.opomAccountId || account.id || '';
    if (id) byAccountId.set(String(id), account);
    mapPush(byEmail, account.loginEmail || account.username, account);
    mapPush(bySerial, account.adsPower?.serialNumber || account.ads_power_serial_number, account);
    mapPush(byUserId, account.adsPower?.userId || account.ads_power_user_id, account);
  }
  return {byAccountId, byEmail, bySerial, byUserId};
}

function candidateAccountsForRow(row, index) {
  const candidates = [];
  const add = (items) => {
    for (const item of items || []) {
      if (item) candidates.push(item);
    }
  };
  const accountId = String(row.opom_account_id || '').trim();
  if (accountId && index.byAccountId.has(accountId)) add([index.byAccountId.get(accountId)]);
  add(index.byUserId.get(String(row.ads_power_user_id || '').trim().toLowerCase()));
  add(index.byEmail.get(String(row.login_email || '').trim().toLowerCase()));
  add(index.bySerial.get(String(row.ads_power_serial_number || '').trim().toLowerCase()));

  const byId = new Map();
  for (const candidate of candidates) {
    const id = candidate.opomAccountId || candidate.id || '';
    if (id) byId.set(String(id), candidate);
  }
  return [...byId.values()];
}

function countResolvableRows(rows, index) {
  return rows.filter((row) => candidateAccountsForRow(row, index).length === 1).length;
}

async function loadBestResolveIndex(args, rows, {group, status, maxPages}) {
  const attempts = [
    {group, status},
    ...(status === 'all' ? [] : [{group, status: 'all'}]),
    ...(group === 'all' && status === 'all' ? [] : [{group: 'all', status: 'all'}]),
  ];
  let best = {accounts: [], index: buildOpomAccountIndex([]), resolveSource: `${group}/${status}`, matched: 0};
  for (const attempt of attempts) {
    const accounts = await fetchAllRechargeAccounts(args, {
      maxPages,
      group: attempt.group,
      status: attempt.status,
    });
    const index = buildOpomAccountIndex(accounts);
    const matched = countResolvableRows(rows, index);
    if (matched > best.matched) {
      best = {
        accounts,
        index,
        resolveSource: `${attempt.group}/${attempt.status}`,
        matched,
      };
    }
    if (matched >= rows.length) break;
  }
  return best;
}

function mergeResolvedOpomRow(row, canonical) {
  return {
    ...row,
    opom_account_id: canonical.opom_account_id || row.opom_account_id || '',
    login_email: row.login_email || canonical.login_email || '',
    ads_power_user_id: row.ads_power_user_id || canonical.ads_power_user_id || '',
    ads_power_serial_number: row.ads_power_serial_number || canonical.ads_power_serial_number || '',
    ads_power_group_name: canonical.ads_power_group_name || row.ads_power_group_name || '',
    opom_health_status: canonical.opom_health_status || 'ok',
    opom_health_reason: canonical.opom_health_reason || '',
    idempotency_key: canonical.idempotency_key || row.idempotency_key || '',
  };
}

function opomArgsFromPayload(payload = {}) {
  return {
    ...opom.opomDefaults(),
    opomBaseUrl: payload.opomBaseUrl || process.env.OPOM_BASE_URL || process.env.OPOM_API_BASE || '',
    opomRechargeToken: payload.opomRechargeToken || process.env.RECHARGE_API_TOKEN || process.env.OPOM_RECHARGE_TOKEN || '',
    opomSecondaryBaseUrl: payload.opomSecondaryBaseUrl || process.env.OPOM_SECONDARY_BASE_URL || process.env.OPOM_WRITEBACK_SECONDARY_BASE_URL || '',
    opomSecondaryRechargeToken: payload.opomSecondaryRechargeToken || process.env.OPOM_SECONDARY_RECHARGE_TOKEN || process.env.OPOM_WRITEBACK_SECONDARY_TOKEN || '',
    opomRequestTimeoutMs: payload.opomRequestTimeoutMs || process.env.OPOM_REQUEST_TIMEOUT_MS || '',
    opomRequestRetries: payload.opomRequestRetries || process.env.OPOM_REQUEST_RETRIES || '',
    opomWritebackRetries: payload.opomWritebackRetries || process.env.OPOM_WRITEBACK_RETRIES || '',
    opomRetryDelayMs: payload.opomRetryDelayMs || process.env.OPOM_RETRY_DELAY_MS || '',
  };
}

function normalizeResolveStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'matched') return 'matched';
  if (value === 'not_found') return 'opom_not_found';
  if (value === 'ambiguous') return 'opom_ambiguous';
  if (value === 'identity_mismatch') return 'opom_identity_mismatch';
  return value ? `opom_${value}` : 'opom_not_found';
}

function mergeBatchResolvedRow(row, result = {}) {
  if (String(result.status || '').toLowerCase() === 'matched' && result.account) {
    const canonical = opom.canonicalRowsFromOpomAccounts([result.account], {})[0] || {};
    return mergeResolvedOpomRow(row, canonical);
  }
  const status = normalizeResolveStatus(result.status);
  return {
    ...row,
    opom_health_status: status,
    opom_health_reason: result.reason || result.message || 'OPOM batch resolve did not match this row',
  };
}

async function resolveOpomAccountsBatch(args, rows, {group, status, includeAllStatus = false, fallbackAll = false} = {}) {
  const body = await opom.resolveRechargeAccounts(args, {
    rows,
    group,
    status,
    includeAllStatus,
    fallbackAll,
  });
  const resultByIndex = new Map();
  for (const [fallbackIndex, item] of body.results.entries()) {
    const index = Number.isInteger(item.index) ? item.index : fallbackIndex;
    resultByIndex.set(index, item);
  }
  let matched = 0;
  let failed = 0;
  const resolvedRows = rows.map((row, index) => {
    const result = resultByIndex.get(index);
    if (!result) {
      failed += 1;
      return mergeBatchResolvedRow(row, {
        status: 'not_found',
        reason: 'OPOM batch resolve returned no result for this row',
      });
    }
    if (String(result.status || '').toLowerCase() === 'matched' && result.account) matched += 1;
    else failed += 1;
    return mergeBatchResolvedRow(row, result);
  });
  return {
    ok: true,
    total: rows.length,
    matched,
    failed,
    resolveSource: 'batch_resolve',
    rows: resolvedRows,
    csvText: canonicalCsvFromRows(resolvedRows),
  };
}

async function resolveOpomAccountsLegacy(args, rows, payload = {}) {
  const group = payload.group || 'recharge';
  const status = payload.status || 'needs_recharge';
  const best = await loadBestResolveIndex(args, rows, {
    maxPages: payload.maxPages || 50,
    group,
    status,
  });
  const accounts = best.accounts;
  const index = best.index;
  const resolveSource = best.resolveSource;
  const canonicalById = new Map(opom.canonicalRowsFromOpomAccounts(accounts, {}).map((row) => [String(row.opom_account_id), row]));
  let matched = 0;
  let failed = 0;
  const resolvedRows = rows.map((row) => {
    const candidates = candidateAccountsForRow(row, index);
    if (candidates.length === 1) {
      matched += 1;
      const id = candidates[0].opomAccountId || candidates[0].id || '';
      return mergeResolvedOpomRow(row, canonicalById.get(String(id)) || {});
    }
    failed += 1;
    if (candidates.length > 1) {
      return {
        ...row,
        opom_health_status: 'opom_identity_mismatch',
        opom_health_reason: `multiple OPOM accounts matched: ${candidates.map((account) => account.opomAccountId || account.id).filter(Boolean).join(',')}`,
      };
    }
    return {
      ...row,
      opom_health_status: 'opom_not_found',
      opom_health_reason: 'no OPOM account matched selected login email or AdsPower id',
    };
  });
  return {
    ok: true,
    total: rows.length,
    matched,
    failed,
    resolveSource,
    rows: resolvedRows,
    csvText: canonicalCsvFromRows(resolvedRows),
  };
}

export async function resolveOpomAccountsPayload(payload = {}) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rows.length) {
    return {ok: true, total: 0, matched: 0, failed: 0, rows: [], csvText: canonicalCsvFromRows([])};
  }
  const args = opomArgsFromPayload(payload);
  try {
    return await resolveOpomAccountsBatch(args, rows, {
      group: payload.group || 'recharge',
      status: payload.status || 'needs_recharge',
      includeAllStatus: payload.includeAllStatus === true,
      fallbackAll: payload.fallbackAll === true,
    });
  } catch (error) {
    if (![404, 405].includes(Number(error?.httpStatus))) throw error;
    const result = await resolveOpomAccountsLegacy(args, rows, payload);
    return {
      ...result,
      resolveSource: `legacy:${result.resolveSource}`,
    };
  }
}
