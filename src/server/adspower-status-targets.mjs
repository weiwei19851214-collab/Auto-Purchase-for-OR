import {redact} from './redact.mjs';

export function configuredTargetsFromRunner(runner = {}) {
  return {
    success: targetRef(runner.adspowerSuccessGroupId, runner.adspowerSuccessGroupName),
    failure: targetRef(runner.adspowerFailureGroupId, runner.adspowerFailureGroupName),
    blocker: targetRef(runner.adspowerBlockerGroupId, runner.adspowerBlockerGroupName),
  };
}

export async function inspectAdsPowerStatusTargets(options = {}) {
  const base = normalizeBaseUrl(options.adspowerApiBase || 'http://127.0.0.1:50325');
  const groupList = await fetchAdsPowerGroups({
    base,
    apiKey: options.adspowerApiKey || '',
    fetchImpl: options.fetchImpl || globalThis.fetch,
  });
  if (!groupList.ok) {
    return {
      ok: false,
      status: groupList.status,
      base,
      groups: [],
      targets: emptyTargets(options.configured || {}),
      candidates: {success: [], failure: [], blocker: []},
      suggestedEnv: [],
    };
  }

  const groups = groupList.groups
    .map((group) => ({
      groupId: String(group.group_id || group.groupId || '').trim(),
      groupName: String(group.group_name || group.groupName || '').trim(),
    }))
    .filter((group) => group.groupId || group.groupName)
    .sort((left, right) => left.groupName.localeCompare(right.groupName) || left.groupId.localeCompare(right.groupId));
  const targets = resolveConfiguredTargets(options.configured || {}, groups);
  const candidates = {
    success: candidateGroups(groups, [/success/i, /completed?/i, /done/i, /成功/, /完成/]),
    failure: candidateGroups(groups, [/fail(?:ed|ure)?/i, /error/i, /declin/i, /失败/, /错误/]),
    blocker: candidateGroups(groups, [/block/i, /security/i, /manual/i, /风控/, /阻塞/, /人工/]),
  };
  return {
    ok: true,
    status: `groups=${groups.length}`,
    base,
    groups,
    targets,
    candidates,
    suggestedEnv: suggestedEnv(targets, candidates),
  };
}

function resolveConfiguredTargets(configured, groups) {
  return {
    success: resolveConfiguredTarget(configured.success, groups),
    failure: resolveConfiguredTarget(configured.failure, groups),
    blocker: resolveConfiguredTarget(configured.blocker, groups),
  };
}

function resolveConfiguredTarget(rawTarget, groups) {
  const target = parseTarget(rawTarget);
  if (!target.id && !target.name) return {status: 'missing', groupId: '', groupName: ''};
  if (target.id) {
    const group = groups.find((item) => item.groupId === target.id);
    return {status: group ? 'id_found' : 'id_configured_not_verified', groupId: target.id, groupName: group?.groupName || ''};
  }
  const matches = groups.filter((item) => item.groupName === target.name);
  if (matches.length === 1) return {status: 'name_resolved', groupId: matches[0].groupId, groupName: matches[0].groupName};
  if (matches.length > 1) return {status: 'ambiguous_name', groupId: '', groupName: target.name};
  return {status: 'name_not_found', groupId: '', groupName: target.name};
}

function candidateGroups(groups, patterns) {
  return groups.filter((group) => patterns.some((pattern) => pattern.test(group.groupName))).slice(0, 10);
}

function suggestedEnv(targets, candidates) {
  const lines = [];
  for (const [role, envName] of [
    ['success', 'ADSPOWER_SUCCESS_GROUP_ID'],
    ['failure', 'ADSPOWER_FAILURE_GROUP_ID'],
    ['blocker', 'ADSPOWER_BLOCKER_GROUP_ID'],
  ]) {
    const resolved = targets[role];
    const groupId = resolved.groupId || candidates[role]?.[0]?.groupId || '';
    if (groupId) lines.push(`export ${envName}="${groupId}"`);
  }
  return lines;
}

async function fetchAdsPowerGroups({base, apiKey, fetchImpl}) {
  if (typeof fetchImpl !== 'function') return {ok: false, status: 'missing_fetch'};
  const url = new URL('/api/v1/group/list', base);
  url.searchParams.set('page', '1');
  url.searchParams.set('page_size', '2000');
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetchImpl(String(url), {headers, signal: controller.signal});
    const body = await safeJson(response);
    if (!response?.ok || (body?.code != null && body.code !== 0)) {
      return {
        ok: false,
        status: body?.code != null && body.code !== 0
          ? `http_${response?.status || ''}_code_${body.code}:${redact(body.msg || body.message || 'api_error')}`
          : `http_${response?.status || ''}`,
      };
    }
    return {ok: true, groups: Array.isArray(body?.data?.list) ? body.data.list : []};
  } catch (error) {
    return {ok: false, status: error?.name === 'AbortError' ? 'timeout' : 'request_failed'};
  } finally {
    clearTimeout(timer);
  }
}

function targetRef(idRef, nameRef) {
  return {
    idRef: String(idRef || '').trim(),
    nameRef: String(nameRef || '').trim(),
  };
}

function parseTarget(rawValue) {
  if (rawValue && typeof rawValue === 'object') {
    const nameRef = String(rawValue.nameRef || '').trim();
    if (nameRef) return {id: '', name: nameRef};
    return parseTarget(rawValue.idRef);
  }
  const value = String(rawValue || '').trim();
  if (!value) return {id: '', name: ''};
  if (/^name:/i.test(value)) return {id: '', name: value.replace(/^name:/i, '').trim()};
  if (/^id:/i.test(value)) return {id: value.replace(/^id:/i, '').trim(), name: ''};
  return {id: value, name: ''};
}

function emptyTargets(configured) {
  return {
    success: resolveConfiguredTarget(configured.success, []),
    failure: resolveConfiguredTarget(configured.failure, []),
    blocker: resolveConfiguredTarget(configured.blocker, []),
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function normalizeBaseUrl(baseUrl) {
  const base = String(baseUrl || 'http://127.0.0.1:50325').trim() || 'http://127.0.0.1:50325';
  return base.endsWith('/') ? base : `${base}/`;
}
