import {redact} from './redact.mjs';

export const ADSPOWER_STATUS_MODES = Object.freeze({
  DISABLED: 'disabled',
  GROUP_MOVE: 'group_move',
  REMARK_APPEND: 'remark_append',
  REMARK_APPEND_V2: 'remark_append_v2',
});

export const ADSPOWER_TAG_STATUSES = Object.freeze({
  SKIPPED: 'skipped',
  SKIPPED_WAITING_TAG_API: 'skipped_waiting_tag_api',
  SKIPPED_USER_WAIVED: 'skipped_user_waived',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

export const ADSPOWER_GROUP_ROLES = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  BLOCKER: 'blocker',
});

const DEFAULT_ADSPOWER_BASE = 'http://127.0.0.1:50325';
const MAX_SAFE_TEXT_LENGTH = 160;

const FAILURE_STATUSES = new Set([
  'missing_fields',
  'login_required',
  'identity_mismatch',
  'payment_issue_card_declined',
  'purchase_unverified',
  'failed',
]);

const SENSITIVE_KEYS = new Set([
  'username',
  'login_email',
  'loginEmail',
  'email',
  'account',
  'card_number',
  'cardNumber',
  'cvv',
  'cvc',
  'password',
  'token',
  'cookie',
  'session',
  'apiKey',
  'adspowerApiKey',
  'error',
  'message',
]);

export function adsPowerStatusDefaults(env = process.env) {
  return {
    mode: env.ADSPOWER_STATUS_MODE || ADSPOWER_STATUS_MODES.DISABLED,
    adspowerApiBase: env.ADSPOWER_API_BASE || DEFAULT_ADSPOWER_BASE,
    adspowerApiKey: env.ADSPOWER_API_KEY || '',
    successGroupId: env.ADSPOWER_SUCCESS_GROUP_ID || '',
    failureGroupId: env.ADSPOWER_FAILURE_GROUP_ID || '',
    blockerGroupId: env.ADSPOWER_BLOCKER_GROUP_ID || '',
    successGroupName: env.ADSPOWER_SUCCESS_GROUP_NAME || '',
    failureGroupName: env.ADSPOWER_FAILURE_GROUP_NAME || '',
    blockerGroupName: env.ADSPOWER_BLOCKER_GROUP_NAME || '',
  };
}

export async function writeAdsPowerStatus(row = {}, outcome = {}, options = {}) {
  const mode = normalizeMode(options.mode);
  if (mode === ADSPOWER_STATUS_MODES.DISABLED) {
    return skippedResult(ADSPOWER_TAG_STATUSES.SKIPPED_USER_WAIVED, 'user_waived_status_writeback', {
      mode,
      target: 'waived_by_user',
    });
  }

  const fetchImpl = options.fetch || options.fetchImpl;
  if (typeof fetchImpl !== 'function') {
    return skippedResult(ADSPOWER_TAG_STATUSES.SKIPPED, 'missing_fetch_adapter', {
      mode,
      target: `${mode}:missing_fetch_adapter`,
    });
  }

  const userId = adsPowerUserId(row);
  if (!userId) {
    return skippedResult(ADSPOWER_TAG_STATUSES.SKIPPED, 'missing_ads_power_user_id', {
      mode,
      target: 'missing_ads_power_user_id',
    });
  }

  if (mode === ADSPOWER_STATUS_MODES.GROUP_MOVE) {
    return moveAdsPowerGroup(fetchImpl, row, outcome, options, userId);
  }

  if (mode === ADSPOWER_STATUS_MODES.REMARK_APPEND || mode === ADSPOWER_STATUS_MODES.REMARK_APPEND_V2) {
    return appendAdsPowerRemark(fetchImpl, row, outcome, options, userId, mode);
  }

  return skippedResult(ADSPOWER_TAG_STATUSES.SKIPPED, 'unsupported_mode', {
    mode,
    target: `${mode}:unsupported`,
  });
}

export function adsPowerGroupRoleForStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'completed') return ADSPOWER_GROUP_ROLES.SUCCESS;
  if (normalized === 'manual_security_blocker') return ADSPOWER_GROUP_ROLES.BLOCKER;
  if (FAILURE_STATUSES.has(normalized)) return ADSPOWER_GROUP_ROLES.FAILURE;
  return null;
}

export function safeAdsPowerRemark(outcome = {}, options = {}) {
  const parts = [
    options.prefix || 'OpenRouter recharge',
    String(outcome.status || 'unknown').trim() || 'unknown',
  ];
  if (outcome.stage) parts.push(String(outcome.stage));
  return sanitizeText(parts.join(' | '));
}

async function moveAdsPowerGroup(fetchImpl, row, outcome, options, userId) {
  const role = adsPowerGroupRoleForStatus(outcome.status);
  if (!role) {
    return skippedResult(ADSPOWER_TAG_STATUSES.SKIPPED, 'status_not_mapped', {
      mode: ADSPOWER_STATUS_MODES.GROUP_MOVE,
      target: 'group:unmapped',
    });
  }

  const groupResolution = await resolveGroupIdForRole(fetchImpl, role, options);
  if (!groupResolution.ok) {
    return {
      attempted: true,
      ok: false,
      status: ADSPOWER_TAG_STATUSES.FAILED,
      mode: ADSPOWER_STATUS_MODES.GROUP_MOVE,
      groupRole: role,
      target: `group:${role}`,
      message: groupResolution.message,
    };
  }
  const groupId = groupResolution.groupId;
  if (!groupId) {
    return skippedResult(ADSPOWER_TAG_STATUSES.SKIPPED, `missing_${role}_group_id`, {
      mode: ADSPOWER_STATUS_MODES.GROUP_MOVE,
      groupRole: role,
      target: `group:${role}`,
    });
  }

  const payload = {
    user_ids: [userId],
    group_id: String(groupId),
  };

  const result = await postAdsPowerJson(fetchImpl, options, '/api/v1/user/regroup', payload);
  if (!result.ok) {
    return {
      attempted: true,
      ok: false,
      status: ADSPOWER_TAG_STATUSES.FAILED,
      mode: ADSPOWER_STATUS_MODES.GROUP_MOVE,
      groupRole: role,
      groupId: String(groupId),
      target: `group:${role}:${String(groupId)}`,
      message: result.message,
    };
  }

  return {
    attempted: true,
    ok: true,
    status: ADSPOWER_TAG_STATUSES.COMPLETED,
    mode: ADSPOWER_STATUS_MODES.GROUP_MOVE,
    groupRole: role,
    groupId: String(groupId),
    target: `group:${role}:${String(groupId)}`,
  };
}

async function resolveGroupIdForRole(fetchImpl, role, options) {
  const target = groupTargetForRole(role, options);
  if (target.id) return {ok: true, groupId: target.id};
  if (!target.name) return {ok: true, groupId: ''};
  const result = await findAdsPowerGroupByName(fetchImpl, options, target.name);
  if (!result.ok) return {ok: false, groupId: '', message: `AdsPower ${role} group lookup failed: ${result.reason || 'group_name_lookup_failed'}`};
  return {ok: true, groupId: result.groupId || ''};
}

async function appendAdsPowerRemark(fetchImpl, row, outcome, options, userId, mode) {
  const remark = combineRemark(options.existingRemark ?? row.remark, safeAdsPowerRemark(outcome, options));
  if (!remark) {
    return skippedResult(ADSPOWER_TAG_STATUSES.SKIPPED, 'empty_remark', {
      mode,
      target: `remark:${mode === ADSPOWER_STATUS_MODES.REMARK_APPEND_V2 ? 'v2' : 'v1'}`,
    });
  }

  const endpoint = mode === ADSPOWER_STATUS_MODES.REMARK_APPEND_V2
    ? '/api/v2/browser-profile/update'
    : '/api/v1/user/update';
  const payload = mode === ADSPOWER_STATUS_MODES.REMARK_APPEND_V2
    ? {profile_id: userId, remark}
    : {user_id: userId, remark};

  const result = await postAdsPowerJson(fetchImpl, options, endpoint, payload);
  if (!result.ok) {
    return {
      attempted: true,
      ok: false,
      status: ADSPOWER_TAG_STATUSES.FAILED,
      mode,
      target: `remark:${mode === ADSPOWER_STATUS_MODES.REMARK_APPEND_V2 ? 'v2' : 'v1'}`,
      message: result.message,
    };
  }

  return {
    attempted: true,
    ok: true,
    status: ADSPOWER_TAG_STATUSES.COMPLETED,
    mode,
    target: `remark:${mode === ADSPOWER_STATUS_MODES.REMARK_APPEND_V2 ? 'v2' : 'v1'}`,
  };
}

async function postAdsPowerJson(fetchImpl, options, pathname, payload) {
  const url = new URL(pathname, normalizeBase(options.adspowerApiBase));
  const headers = {'Content-Type': 'application/json'};
  if (options.adspowerApiKey) headers.Authorization = `Bearer ${options.adspowerApiKey}`;

  try {
    const response = await fetchImpl(String(url), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const body = await parseBody(response);
    const apiOk = body?.code == null || body.code === 0;
    if (response?.ok && apiOk) return {ok: true, body};
    return {
      ok: false,
      message: adsPowerFailureMessage(response?.status, body),
    };
  } catch (error) {
    return {
      ok: false,
      message: adsPowerFailureMessage('', {msg: error?.message || 'request failed'}),
    };
  }
}

async function getAdsPowerJson(fetchImpl, options, pathname, searchParams = {}) {
  const url = new URL(pathname, normalizeBase(options.adspowerApiBase));
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(key, String(value));
  }
  const headers = {};
  if (options.adspowerApiKey) headers.Authorization = `Bearer ${options.adspowerApiKey}`;

  try {
    const response = await fetchImpl(String(url), {
      method: 'GET',
      headers,
    });
    const body = await parseBody(response);
    const apiOk = body?.code == null || body.code === 0;
    if (response?.ok && apiOk) return {ok: true, body};
    return {
      ok: false,
      message: adsPowerFailureMessage(response?.status, body),
    };
  } catch (error) {
    return {
      ok: false,
      message: adsPowerFailureMessage('', {msg: error?.message || 'request failed'}),
    };
  }
}

async function parseBody(response) {
  if (!response) return {};
  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }
  if (typeof response.text === 'function') {
    try {
      return {msg: await response.text()};
    } catch {
      return {};
    }
  }
  return {};
}

async function findAdsPowerGroupByName(fetchImpl, options, groupName) {
  const name = String(groupName || '').trim();
  if (!name) return {ok: true, groupId: '', reason: 'empty_group_name'};
  const result = await getAdsPowerJson(fetchImpl, options, '/api/v1/group/list', {
    group_name: name,
    page: 1,
    page_size: 2000,
  });
  if (!result.ok) return {ok: false, reason: result.message};
  const groups = Array.isArray(result.body?.data?.list) ? result.body.data.list : [];
  const matches = groups.filter((group) => String(group.group_name || '').trim() === name);
  if (matches.length === 1 && matches[0].group_id) return {ok: true, groupId: String(matches[0].group_id)};
  if (matches.length > 1) return {ok: false, reason: 'ambiguous_group_name'};
  return {ok: false, reason: 'group_name_not_found'};
}

function groupTargetForRole(role, options) {
  const groups = options.groups || {};
  if (role === ADSPOWER_GROUP_ROLES.SUCCESS) {
    return groupTarget(options.successGroupId || groups.success || groups.completed || '', options.successGroupName || groups.successName || groups.completedName || '');
  }
  if (role === ADSPOWER_GROUP_ROLES.BLOCKER) {
    return groupTarget(options.blockerGroupId || groups.blocker || groups.manualSecurityBlocker || '', options.blockerGroupName || groups.blockerName || groups.manualSecurityBlockerName || '');
  }
  if (role === ADSPOWER_GROUP_ROLES.FAILURE) {
    return groupTarget(options.failureGroupId || groups.failure || groups.failed || '', options.failureGroupName || groups.failureName || groups.failedName || '');
  }
  return {id: '', name: ''};
}

function groupTarget(groupIdOrRef, explicitName) {
  const name = String(explicitName || '').trim();
  const ref = String(groupIdOrRef || '').trim();
  if (name) return {id: '', name};
  if (/^name:/i.test(ref)) return {id: '', name: ref.replace(/^name:/i, '').trim()};
  if (/^id:/i.test(ref)) return {id: ref.replace(/^id:/i, '').trim(), name: ''};
  return {id: ref, name: ''};
}

function adsPowerUserId(row) {
  return String(row.adsPowerUserId || row.ads_power_user_id || row.userId || row.user_id || '').trim();
}

function normalizeMode(mode) {
  const normalized = String(mode || ADSPOWER_STATUS_MODES.DISABLED).trim().toLowerCase();
  if (Object.values(ADSPOWER_STATUS_MODES).includes(normalized)) return normalized;
  return normalized || ADSPOWER_STATUS_MODES.DISABLED;
}

function normalizeBase(base) {
  const normalized = String(base || DEFAULT_ADSPOWER_BASE).trim() || DEFAULT_ADSPOWER_BASE;
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function skippedResult(status, reason, extra = {}) {
  return {
    attempted: false,
    ok: true,
    status,
    reason,
    ...extra,
  };
}

function combineRemark(existing, addition) {
  const left = sanitizeText(existing || '');
  const right = sanitizeText(addition || '');
  return [left, right].filter(Boolean).join(' | ').slice(0, 500);
}

function adsPowerFailureMessage(httpStatus, body) {
  const statusPart = httpStatus ? `HTTP ${httpStatus}` : 'request failed';
  const codePart = body?.code != null && body.code !== 0 ? ` code ${body.code}` : '';
  const reason = sanitizeText(body?.msg || body?.message || '');
  return [statusPart + codePart, reason].filter(Boolean).join(': ');
}

function sanitizeText(value) {
  let text = redact(String(value || ''));
  for (const key of SENSITIVE_KEYS) {
    const pattern = new RegExp(`\\b${escapeRegex(key)}\\b\\s*[:=]\\s*[^,;|\\n]+`, 'gi');
    text = text.replace(pattern, `${key}=***`);
  }
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SAFE_TEXT_LENGTH);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
