#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT_DIR} from '../src/server/config.mjs';
import {redact} from '../src/server/redact.mjs';

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.base ? normalizeBase(args.base) : '';
const checks = [];

function add(label, ok, status = '') {
  checks.push({label, ok: Boolean(ok), status: String(status || (ok ? 'ok' : 'failed'))});
}

try {
  const html = baseUrl
    ? await fetchText(`${baseUrl}/`)
    : readFileSync(join(ROOT_DIR, 'public/index.html'), 'utf8');
  const appJs = baseUrl
    ? await fetchText(`${baseUrl}/app.js`)
    : readFileSync(join(ROOT_DIR, 'public/app.js'), 'utf8');
  const css = baseUrl
    ? await fetchText(`${baseUrl}/styles.css`)
    : readFileSync(join(ROOT_DIR, 'public/styles.css'), 'utf8');

  add('operator console HTML served', /<title>OpenRouter 充值执行器<\/title>/.test(html), 'title_present');
  add('operator console JS served', /function optionsPayload/.test(appJs), 'app_script_present');
  add('operator console CSS served', /\.topbar|\.layout|\.panel/.test(css), 'style_present');

  const idsInHtml = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
  const queriedIds = [...new Set([...appJs.matchAll(/document\.querySelector\(['"]#([A-Za-z0-9_-]+)['"]\)/g)].map((match) => match[1]))];
  const optionalHiddenIds = new Set([
    'adspowerStatusMode',
    'adspowerSuccessGroupId',
    'adspowerFailureGroupId',
    'adspowerBlockerGroupId',
    'adspowerDiscoverTargetsBtn',
    'adspowerUseDiscoveredTargetsBtn',
    'adspowerTargetsSummary',
  ]);
  const missingIds = queriedIds.filter((id) => !idsInHtml.has(id) && !optionalHiddenIds.has(id));
  add('app.js selector contract', missingIds.length === 0, missingIds.length ? `missing:${missingIds.join(',')}` : `ids=${queriedIds.length}`);
  add(
    'OPOM health fields retained in browser CSV contract',
    /'opom_health_status'/.test(appJs) && /'opom_health_reason'/.test(appJs),
    'present',
  );
  add(
    'default recharge rule values',
    /id=["']defaultAmount["'][^>]*value=["']0["']/.test(html)
      && /id=["']defaultBalanceThreshold["'][^>]*value=["']40["']/.test(html)
      && /id=["']defaultAmountBelow["'][^>]*value=["']150["']/.test(html)
      && /id=["']defaultAmountAtOrAbove["'][^>]*value=["']100["']/.test(html)
      && /id=["']defaultAutoTopupThreshold["'][^>]*value=["']100["']/.test(html)
      && /id=["']defaultAutoTopupAmount["'][^>]*value=["']100["']/.test(html),
    'fixed=0 balance=40 below=150 at_or_above=100 auto=100/100',
  );
  add(
    'OPOM writeback default checked in UI',
    /id=["']opomWriteback["'][^>]*checked/.test(html),
    'checked',
  );
  add(
    'sticky summary cards reflect current workflow',
    />清单<\/span>/.test(html)
      && />AdsPower<\/span>/.test(html)
      && />Billing<\/span>/.test(html)
      && />卡<\/span>/.test(html)
      && />预检<\/span>/.test(html)
      && /id=["']statBilling["']/.test(html)
      && /\.status-strip\s*{[\s\S]*position:\s*sticky/.test(css),
    'list/adspower/billing/card/preflight',
  );

  for (const item of [
    ['Load OPOM group action', /id=["']opomReadyBtn["'][\s\S]*?>Load OPOM group</],
    ['OPOM pagination action', /id=["']opomLoadMoreBtn["'][\s\S]*?>Load next page</],
    ['Match AdsPower action', /id=["']adsPowerMatchBtn["'][\s\S]*?>Match AdsPower</],
    ['EJH card creation action', /id=["']createCardsBtn["'][\s\S]*?>Create EJH cards</],
    ['EJH safe CSV input', /id=["']ejhSafeCsv["']/],
    ['Concurrency input default', /id=["']concurrency["'][^>]*value=["']1["']/],
    ['Live execution action', /id=["']liveRunBtn["']/],
    ['Result CSV download action', /id=["']downloadLink["'][\s\S]*?>下载 result CSV</],
    ['Jobs pagination controls', /id=["']jobsPrevPageBtn["'][\s\S]*id=["']jobsPageInfo["'][\s\S]*id=["']jobsNextPageBtn["']/],
    ['OPOM writeback control', /id=["']opomWriteback["']/],
    ['OPOM health table column', />OPOM health</],
  ]) {
    add(item[0], item[1].test(html), item[1].test(html) ? 'present' : 'missing');
  }

  add('job detail appears before job records', html.indexOf('<h2>任务详情</h2>') >= 0
    && html.indexOf('<h2>任务记录</h2>') > html.indexOf('<h2>任务详情</h2>'), 'detail_first');
  add('execution bar follows recharge preview', html.indexOf('<h2>待充值清单</h2>') >= 0
    && html.indexOf('aria-label="预检和启动执行"') > html.indexOf('<h2>待充值清单</h2>')
    && html.indexOf('<h2>任务详情</h2>') > html.indexOf('aria-label="预检和启动执行"'), 'after_preview');
  add('manual Dry-run action hidden', !/id=["']dryRunBtn["']/.test(html), 'hidden');
  add('auto preflight copy present', /自动预检/.test(html), 'present');
  add('AdsPower status writeback UI hidden', !/adspowerStatusMode|adspowerDiscoverTargetsBtn|adspowerUseDiscoveredTargetsBtn/.test(html), 'hidden');
  add('native tag boundary copy not in UI', !/native tag|tag API|pending_tag_api/i.test(html), 'operator_ui_clean');
  add('no obvious sensitive literals in UI assets', !containsSensitive(`${html}\n${appJs}\n${css}`), 'no_sensitive_literals');
} catch (error) {
  add('ui smoke exception', false, redact(error.message || 'unknown error'));
}

const failed = checks.filter((check) => !check.ok);
const result = {ok: failed.length === 0, failed: failed.length, baseUrl: baseUrl || 'local_files', checks};
if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const check of checks) {
    console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.label}: ${check.status}`);
  }
  console.log(result.ok ? 'ui smoke passed' : `ui smoke failed: ${failed.length} check(s)`);
}
process.exitCode = result.ok ? 0 : 1;

function parseArgs(argv) {
  const parsed = {base: '', json: false};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--base') {
      parsed.base = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--base=')) {
      parsed.base = arg.split('=').slice(1).join('=');
    }
  }
  return parsed;
}

function normalizeBase(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('base URL must be http(s)');
  return String(url).replace(/\/$/, '');
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

function containsSensitive(value) {
  return /5257970000000001|card_number=|cvv=|sk-or-v1-|api[_-]?key\s*[:=]/i.test(String(value || ''));
}
