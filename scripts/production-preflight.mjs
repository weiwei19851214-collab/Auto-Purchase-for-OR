#!/usr/bin/env node
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {ROOT_DIR} from '../src/server/config.mjs';
import {parsePlan, runnerArgs} from '../src/server/automation-adapter.mjs';
import {environmentPreflight} from '../src/server/preflight.mjs';
import {ejhDefaults} from '../src/server/card-provider-ejh.mjs';
import {ADSPOWER_STATUS_MODES} from '../src/server/adspower-status.mjs';
import {redact} from '../src/server/redact.mjs';
import * as csv from '../src/automation/lib/csv.mjs';

const RAW_DIAGNOSTIC_COLUMNS = new Set([
  'encryptedparam',
  'encrypted_param',
  'requestpayload',
  'request_payload',
  'rawresponse',
  'raw_response',
]);

const args = parseArgs(process.argv.slice(2));
const checks = [];

function add(label, ok, status, extra = {}) {
  checks.push({label, ok: Boolean(ok), status: String(status || (ok ? 'ok' : 'failed')), ...extra});
}

function requiredEnv(name, enabled = true) {
  const present = Boolean(process.env[name]);
  add(`env ${name}`, !enabled || present, enabled ? (present ? 'present' : 'missing') : 'not_required');
}

const runner = runnerArgs();
const ejh = ejhDefaults();
const requireOpom = args.requireOpom !== false;
const requireEjh = args.requireEjh !== false;
const requireAdsPower = args.requireAdsPower !== false;

const local = await environmentPreflight({adspowerApiBase: runner.adspowerApiBase});
for (const check of local.checks) {
  const ok = check.label === 'AdsPower Local API' && !requireAdsPower ? true : check.ok;
  const status = check.label === 'AdsPower Local API' && !requireAdsPower ? 'not_required' : check.status;
  add(check.label, ok, status, check.path ? {path: check.path} : check.base ? {base: check.base} : {});
}

requiredEnv('OPOM_BASE_URL', requireOpom && !process.env.OPOM_API_BASE);
requiredEnv('OPOM_RECHARGE_TOKEN', requireOpom);
if (process.env.OPOM_BASE_URL || process.env.OPOM_API_BASE) {
  add('OPOM base url shape', isHttpUrl(process.env.OPOM_BASE_URL || process.env.OPOM_API_BASE), 'configured');
}
if (args.withOpomRead) {
  const opomRead = await checkOpomRead({
    baseUrl: process.env.OPOM_BASE_URL || process.env.OPOM_API_BASE || '',
    token: process.env.OPOM_RECHARGE_TOKEN || '',
    group: args.opomGroup,
  });
  add('OPOM recharge queue read', opomRead.ok, opomRead.status, opomRead.extra);
  if (opomRead.ok) {
    add(
      'OPOM production verification marker',
      true,
      `set OPOM_PRODUCTION_RECHARGE_API_VERIFIED=true OPOM_PRODUCTION_PREFLIGHT_PASSED_AT=${new Date().toISOString()}`,
    );
  }
}
if (args.csvPath) {
  for (const check of await checkCsvContract(args.csvPath, runner)) {
    add(check.label, check.ok, check.status, check.extra || {});
  }
}

requiredEnv('EJH_APP_KEY', requireEjh);
requiredEnv('EJH_APP_SECRET', requireEjh);
add('EJH script', existsSync(join(ROOT_DIR, 'ejh_create_cards.py')), 'local_file');
add('Python command', Boolean(ejh.python), ejh.python || 'missing');

add('AdsPower API base url shape', isHttpUrl(runner.adspowerApiBase), runner.adspowerApiBase);
if (requireAdsPower) {
  const adsPower = local.checks.find((check) => check.label === 'AdsPower Local API');
  add('AdsPower reachable', Boolean(adsPower?.ok), adsPower?.status || 'not_checked', {base: runner.adspowerApiBase});
}

const statusMode = runner.adspowerStatusMode;
add(
  'AdsPower status mode',
  Object.values(ADSPOWER_STATUS_MODES).includes(statusMode),
  statusMode,
);
if (statusMode === ADSPOWER_STATUS_MODES.GROUP_MOVE) {
  add('AdsPower success group target', Boolean(runner.adspowerSuccessGroupId || runner.adspowerSuccessGroupName), runner.adspowerSuccessGroupId || runner.adspowerSuccessGroupName ? 'present' : 'missing');
  add('AdsPower failure group target', Boolean(runner.adspowerFailureGroupId || runner.adspowerFailureGroupName), runner.adspowerFailureGroupId || runner.adspowerFailureGroupName ? 'present' : 'missing');
  add('AdsPower blocker group target', Boolean(runner.adspowerBlockerGroupId || runner.adspowerBlockerGroupName), runner.adspowerBlockerGroupId || runner.adspowerBlockerGroupName ? 'present' : 'missing');
  if (requireAdsPower) {
    for (const check of await checkAdsPowerGroupMoveTargets(runner)) {
      add(check.label, check.ok, check.status, check.extra || {});
    }
  }
}

add('OpenRouter live purchase boundary', process.env.CONFIRM_OPENROUTER_LIVE_RECHARGE !== '1', 'requires UI dry-run token; no env bypass');
add(
  'Production write boundary',
  true,
  args.withOpomRead
    ? 'OPOM read queue check only; no card binding/result write API called'
    : 'no OPOM write API called by this preflight',
);

const failed = checks.filter((check) => !check.ok);
if (args.markerFile) {
  if (failed.length) {
    add('Production preflight marker file', true, 'skipped_preflight_failed');
  } else {
    const marker = writePreflightMarker(args.markerFile);
    add('Production preflight marker file', marker.ok, marker.status, marker.extra || {});
  }
}

const finalFailed = checks.filter((check) => !check.ok);
const result = {
  ok: finalFailed.length === 0,
  failed: finalFailed.length,
  checks,
};

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const check of checks) {
    const marker = check.ok ? 'OK' : 'FAIL';
    const suffix = check.path ? ` ${check.path}` : check.base ? ` ${check.base}` : '';
    console.log(`${marker} ${check.label}: ${check.status}${suffix}`);
  }
  console.log(result.ok ? 'production preflight passed' : `production preflight failed: ${finalFailed.length} check(s)`);
}

process.exitCode = result.ok ? 0 : 1;

function parseArgs(argv) {
  const parsed = {
    json: false,
    requireOpom: true,
    requireEjh: true,
    requireAdsPower: true,
    withOpomRead: false,
    opomGroup: 'recharge',
    csvPath: '',
    markerFile: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--no-opom') {
      parsed.requireOpom = false;
    } else if (arg === '--no-ejh') {
      parsed.requireEjh = false;
    } else if (arg === '--no-ads' || arg === '--no-adspower') {
      parsed.requireAdsPower = false;
    } else if (arg === '--with-opom-read') {
      parsed.withOpomRead = true;
    } else if (arg === '--opom-group') {
      parsed.opomGroup = argv[index + 1] || parsed.opomGroup;
      index += 1;
    } else if (arg.startsWith('--opom-group=')) {
      parsed.opomGroup = arg.split('=').slice(1).join('=') || parsed.opomGroup;
    } else if (arg === '--csv') {
      parsed.csvPath = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--csv=')) {
      parsed.csvPath = arg.split('=').slice(1).join('=') || '';
    } else if (arg === '--marker-file') {
      parsed.markerFile = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--marker-file=')) {
      parsed.markerFile = arg.split('=').slice(1).join('=') || '';
    }
  }
  return parsed;
}

function writePreflightMarker(markerFile) {
  const path = resolve(markerFile || '');
  if (!path) return {ok: false, status: 'missing_path'};
  const opomRead = checks.find((check) => check.label === 'OPOM recharge queue read');
  const marker = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: true,
    opomReadVerified: Boolean(opomRead?.ok),
    opomBaseUrl: process.env.OPOM_BASE_URL || process.env.OPOM_API_BASE || '',
    opomGroup: args.opomGroup || 'recharge',
    checks: checks.map((check) => ({
      label: check.label,
      ok: Boolean(check.ok),
      status: redact(check.status),
    })),
  };
  try {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, {mode: 0o600});
    return {ok: true, status: 'written', extra: {path}};
  } catch (error) {
    return {ok: false, status: `write_failed:${redact(error.message || 'unknown_error')}`};
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function checkOpomRead({baseUrl, token, group}) {
  if (!isHttpUrl(baseUrl)) return {ok: false, status: 'missing_or_invalid_base_url'};
  if (!token) return {ok: false, status: 'missing_token'};
  const url = new URL('/api/v1/recharge/accounts', baseUrl);
  url.searchParams.set('group', group || 'recharge');
  url.searchParams.set('status', 'needs_recharge');
  url.searchParams.set('limit', '1');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(String(url), {
      headers: {'x-recharge-api-token': token},
      signal: controller.signal,
    });
    const body = await safeJson(response);
    if (!response.ok) {
      return {ok: false, status: `http_${response.status}`};
    }
    const rows = Array.isArray(body?.data) ? body.data : null;
    if (!rows) return {ok: false, status: 'invalid_response_shape'};
    return {
      ok: true,
      status: `ok_rows_${rows.length}`,
      extra: {base: baseUrl, group: group || 'recharge'},
    };
  } catch (error) {
    return {ok: false, status: error?.name === 'AbortError' ? 'timeout' : 'request_failed'};
  } finally {
    clearTimeout(timer);
  }
}

async function checkAdsPowerGroupMoveTargets(runnerArgsForCheck) {
  const targets = [
    ['success', runnerArgsForCheck.adspowerSuccessGroupId, runnerArgsForCheck.adspowerSuccessGroupName],
    ['failure', runnerArgsForCheck.adspowerFailureGroupId, runnerArgsForCheck.adspowerFailureGroupName],
    ['blocker', runnerArgsForCheck.adspowerBlockerGroupId, runnerArgsForCheck.adspowerBlockerGroupName],
  ];
  const checks = [];
  const parsedTargets = targets.map(([role, idRef, explicitName]) => [role, parseAdsPowerGroupTarget(idRef, explicitName)]);
  const needsNameLookup = parsedTargets.some(([, target]) => target.name);
  const groupList = needsNameLookup ? await fetchAdsPowerGroups(runnerArgsForCheck) : {ok: true, groups: []};
  for (const [role, idRef, explicitName] of targets) {
    const target = parseAdsPowerGroupTarget(idRef, explicitName);
    const label = `AdsPower ${role} group target lookup`;
    if (!target.id && !target.name) {
      checks.push({label, ok: false, status: 'missing'});
      continue;
    }
    if (target.id) {
      checks.push({label, ok: true, status: `id_present:${target.id}`});
      continue;
    }
    checks.push(matchAdsPowerGroupName(groupList, label, target.name));
  }
  return checks;
}

function parseAdsPowerGroupTarget(idRef, explicitName) {
  const name = String(explicitName || '').trim();
  const ref = String(idRef || '').trim();
  if (name) return {id: '', name};
  if (/^name:/i.test(ref)) return {id: '', name: ref.replace(/^name:/i, '').trim()};
  if (/^id:/i.test(ref)) return {id: ref.replace(/^id:/i, '').trim(), name: ''};
  return {id: ref, name: ''};
}

async function fetchAdsPowerGroups(runnerArgsForCheck) {
  const url = new URL('/api/v1/group/list', normalizeBaseUrl(runnerArgsForCheck.adspowerApiBase));
  url.searchParams.set('page', '1');
  url.searchParams.set('page_size', '2000');
  const headers = {};
  if (runnerArgsForCheck.adspowerApiKey) headers.Authorization = `Bearer ${runnerArgsForCheck.adspowerApiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(String(url), {headers, signal: controller.signal});
    const body = await safeJson(response);
    if (!response.ok || (body?.code != null && body.code !== 0)) {
      return {
        ok: false,
        status: body?.code != null && body.code !== 0
          ? `http_${response.status}_code_${body.code}:${redact(body.msg || body.message || 'api_error')}`
          : `http_${response.status}`,
      };
    }
    return {ok: true, groups: Array.isArray(body?.data?.list) ? body.data.list : []};
  } catch (error) {
    return {ok: false, status: error?.name === 'AbortError' ? 'timeout' : 'request_failed'};
  } finally {
    clearTimeout(timer);
  }
}

function matchAdsPowerGroupName(groupList, label, groupName) {
  const name = String(groupName || '').trim();
  if (!name) return {label, ok: false, status: 'empty_name'};
  if (!groupList.ok) return {label, ok: false, status: groupList.status || 'group_list_failed'};
  const matches = groupList.groups.filter((group) => String(group.group_name || '').trim() === name);
  if (matches.length === 1 && matches[0].group_id) {
    return {label, ok: true, status: `name_resolved:${matches[0].group_id}`};
  }
  if (matches.length > 1) return {label, ok: false, status: 'ambiguous_name'};
  return {label, ok: false, status: 'name_not_found'};
}

async function checkCsvContract(csvPath, options) {
  const checks = [];
  const push = (label, ok, status, extra = {}) => checks.push({label, ok: Boolean(ok), status, extra});
  if (!csvPath) {
    push('CSV contract file', false, 'missing_path');
    return checks;
  }
  if (!existsSync(csvPath)) {
    push('CSV contract file', false, 'missing');
    return checks;
  }
  push('CSV contract file', true, 'readable', {path: csvPath});

  let text = '';
  try {
    text = readFileSync(csvPath, 'utf8');
  } catch {
    push('CSV contract file read', false, 'failed');
    return checks;
  }

  let parsed = [];
  try {
    parsed = csv.parseCsv(text);
  } catch (error) {
    push('CSV syntax', false, redact(error.message || 'parse_failed'));
    return checks;
  }
  const header = parsed[0] || [];
  const forbidden = header
    .map((column) => String(column || '').trim())
    .filter((column) => RAW_DIAGNOSTIC_COLUMNS.has(normalizeHeaderName(column)));
  push(
    'CSV EJH raw diagnostic fields',
    forbidden.length === 0,
    forbidden.length ? `forbidden_columns:${forbidden.join(',')}` : 'absent',
  );

  try {
    const dryRun = await parsePlan(text, options);
    const readyRows = dryRun.rows.filter((row) => row.status === 'ready');
    const blockedRows = dryRun.rows.filter((row) => row.status === 'missing_fields');
    const skippedRows = dryRun.rows.filter((row) => row.status === 'skipped');
    push(
      'CSV dry-run contract',
      readyRows.length > 0 && blockedRows.length === 0,
      `ready=${readyRows.length} blocked=${blockedRows.length} skipped=${skippedRows.length}`,
      blockedRows.length ? {blockedRows: blockedRows.slice(0, 20).map((row) => row.rowNumber)} : {},
    );
  } catch (error) {
    push('CSV dry-run contract', false, redact(error.message || 'failed'));
  }
  return checks;
}

function normalizeHeaderName(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
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
