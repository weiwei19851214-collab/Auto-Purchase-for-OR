import {existsSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {AUTOMATION_DIR, AUTOMATION_LIB_DIR, BATCH_SCRIPT, BIND_SCRIPT, DB_PATH, PUBLIC_DIR} from './config.mjs';
import {runnerArgs} from './automation-adapter.mjs';
import {ADSPOWER_STATUS_MODES} from './adspower-status.mjs';

function checkPath(label, path, type = 'file') {
  if (!existsSync(path)) return {label, ok: false, status: 'missing', path};
  const stat = statSync(path);
  const ok = type === 'dir' ? stat.isDirectory() : stat.isFile();
  return {label, ok, status: ok ? 'ok' : `not_${type}`, path};
}

async function checkAdsPower(base) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/status`, {signal: controller.signal});
    return {label: 'AdsPower Local API', ok: true, status: `reachable_http_${res.status}`, base};
  } catch (error) {
    return {label: 'AdsPower Local API', ok: false, status: error.name === 'AbortError' ? 'timeout' : 'unreachable', base};
  } finally {
    clearTimeout(timer);
  }
}

function adsPowerWritebackCheck(args) {
  if (!Object.values(ADSPOWER_STATUS_MODES).includes(args.adspowerStatusMode)) {
    return {
      label: 'AdsPower status writeback',
      ok: false,
      status: `unsupported_mode_${args.adspowerStatusMode || 'empty'}`,
    };
  }
  if (args.adspowerStatusMode === ADSPOWER_STATUS_MODES.DISABLED) {
    return {
      label: 'AdsPower status writeback',
      ok: true,
      status: 'disabled by user; result CSV records skipped_user_waived',
    };
  }
  if (args.adspowerStatusMode === ADSPOWER_STATUS_MODES.GROUP_MOVE) {
    return {
      label: 'AdsPower status writeback',
      ok: true,
      status: 'group_move via /api/v1/user/regroup; requires success/failure/blocker group targets at run time',
    };
  }
  if (args.adspowerStatusMode === ADSPOWER_STATUS_MODES.REMARK_APPEND_V2) {
    return {
      label: 'AdsPower status writeback',
      ok: true,
      status: 'remark_append_v2 via /api/v2/browser-profile/update remark',
    };
  }
  return {
    label: 'AdsPower status writeback',
    ok: true,
    status: 'remark_append via /api/v1/user/update remark',
  };
}

function adsPowerNativeTagCheck() {
  return {
    label: 'AdsPower native tag API',
    ok: true,
    status: 'not documented for Local API; use group_move or remark_append modes until an official tag endpoint is confirmed',
  };
}

export async function environmentPreflight(options = {}) {
  const args = runnerArgs(options);
  const checks = [
    {label: 'Node.js', ok: true, status: process.version},
    checkPath('project automation engine', AUTOMATION_DIR, 'dir'),
    checkPath('project automation lib', AUTOMATION_LIB_DIR, 'dir'),
    checkPath('single-profile bind script', BIND_SCRIPT, 'file'),
    checkPath('batch runner script', BATCH_SCRIPT, 'file'),
    checkPath('operator console HTML', join(PUBLIC_DIR, 'index.html'), 'file'),
    checkPath('operator console app script', join(PUBLIC_DIR, 'app.js'), 'file'),
    {label: 'SQLite database path', ok: true, status: 'configured', path: DB_PATH},
    await checkAdsPower(args.adspowerApiBase),
    adsPowerWritebackCheck(args),
    adsPowerNativeTagCheck(),
  ];
  const blocking = checks.filter((check) => !check.ok && check.label !== 'AdsPower Local API');
  return {
    ok: blocking.length === 0,
    checks,
    message: blocking.length ? 'required local files are missing' : 'required local files are present',
  };
}
