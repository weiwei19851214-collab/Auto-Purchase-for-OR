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
  const html = baseUrl ? await fetchText(`${baseUrl}/`) : readFileSync(join(ROOT_DIR, 'public/index.html'), 'utf8');
  const appJs = baseUrl ? await fetchText(`${baseUrl}/app.js`) : readFileSync(join(ROOT_DIR, 'public/app.js'), 'utf8');
  const css = baseUrl ? await fetchText(`${baseUrl}/styles.css`) : readFileSync(join(ROOT_DIR, 'public/styles.css'), 'utf8');
  const executionHtml = baseUrl ? await fetchText(`${baseUrl}/execution.html`) : readFileSync(join(ROOT_DIR, 'public/execution.html'), 'utf8');
  const executionJs = baseUrl ? await fetchText(`${baseUrl}/execution.js`) : readFileSync(join(ROOT_DIR, 'public/execution.js'), 'utf8');

  add('operator console HTML served', /<title>OpenRouter 充值准备<\/title>/.test(html), 'title_present');
  add('operator console JS served', /function optionsPayload/.test(appJs), 'app_script_present');
  add('operator console CSS served', /\.toolbar|\.control-grid|\.match-table/.test(css), 'style_present');
  add('execution page served', /执行工作/.test(executionHtml) && /execution\.js/.test(executionHtml), 'execution_present');

  const idsInHtml = new Set([...`${html}\n${executionHtml}`.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
  const queriedIds = [...new Set([...`${appJs}\n${executionJs}`.matchAll(/document\.querySelector\(['"]#([A-Za-z0-9_-]+)['"]\)/g)].map((match) => match[1]))];
  const missingIds = queriedIds.filter((id) => !idsInHtml.has(id));
  add('JS selector contract', missingIds.length === 0, missingIds.length ? `missing:${missingIds.join(',')}` : `ids=${queriedIds.length}`);

  add('CSV and OPOM source switch present', /data-source=["']csv["']/.test(html) && /data-source=["']opom["']/.test(html), 'dual_source');
  add('OPOM combined status maps in UI', /card_switch\s*&amp;\s*overdue/.test(html), 'combined_status');
  add('default rule values', /id=["']balanceThreshold["'][^>]*value=["']145["']/.test(html)
    && /id=["']amountBelow["'][^>]*value=["']150["']/.test(html)
    && /id=["']amountAtOrAbove["'][^>]*value=["']20["']/.test(html)
    && /id=["']autoTopupThreshold["'][^>]*value=["']100["']/.test(html)
    && /id=["']autoTopupAmount["'][^>]*value=["']150["']/.test(html), '145/150/20 auto=100/150');
  add('auto top-up enable-only switch present', /id=["']autoTopupEnableOnly["'][^>]*role=["']switch["']/.test(html), 'present');
  add('preserve existing payment card switch present', /id=["']preserveExistingCard["'][^>]*role=["']switch["'][^>]*disabled/.test(html)
    && /preserveExistingPaymentMethod/.test(appJs)
    && /有卡保留 · 无卡新增/.test(appJs), 'default_replace_optional_preserve');
  add('ZDR switch defaults off and is wired', /id=["']disableZdr["'][^>]*role=["']switch["']/.test(html)
    && /disableZdr:\s*el\.zdrOnly\.checked\s*\|\|\s*\(!enableZdr\s*&&\s*el\.disableZdr\.checked\)/.test(appJs)
    && !/id=["']disableZdr["'][^>]*checked/.test(html), 'default_off');
  add('ZDR-only switches disable all other execution scopes', /id=["']zdrOnly["'][^>]*role=["']switch["']/.test(html)
    && /id=["']enableZdrOnly["'][^>]*role=["']switch["']/.test(html)
    && /enableZdr,/.test(appJs)
    && /scopeBillingAddress:\s*zdrOnly\s*\?\s*false/.test(appJs)
    && /scopePaymentMethod:\s*zdrOnly\s*\?\s*false/.test(appJs)
    && /scopePurchase:\s*!zdrOnly/.test(appJs)
    && /scopeAutoTopup:\s*!zdrOnly/.test(appJs)
    && /opomWriteback:\s*!zdrOnly/.test(appJs), 'zdr_only_scope');
  add('auto recharge scheduler switch present', /id=["']autoRechargeEnabled["'][^>]*role=["']switch["']/.test(html)
    && /\/api\/scheduler/.test(appJs), 'present');
  add('mapping and concurrency controls present', /id=["']matchButton["']/.test(html) && /id=["']skipMatch["']/.test(html) && /id=["']concurrency["'][^>]*max=["']10["']/.test(html), 'present');
  add('automatic dry-run and job creation wired', /\/api\/jobs\/dry-run/.test(appJs) && /\/api\/jobs/.test(appJs) && /liveConfirmationToken/.test(appJs), 'wired');
  add('execution page job recovery wired', /URLSearchParams\(location\.search\)\.get\(['"]job/.test(executionJs) && /resume-preview/.test(executionJs) && /opom-writeback-repair/.test(executionJs), 'wired');
  add('result CSV download uses session header', /X-Runner-Session/.test(executionJs), 'session_header');
  add('local session recovers once after server restart', /response\.status === 401 && !retriedAfterSessionRefresh/.test(appJs)
    && /response\.status === 401 && !retriedAfterSessionRefresh/.test(executionJs)
    && /sessionRefreshPromise/.test(appJs)
    && /sessionRefreshPromise/.test(executionJs), 'one_retry');
  add('deprecated UI controls removed from main page', !/createCardsBtn|noPurchaseMode|adspowerStatusMode|adspowerDiscoverTargetsBtn|addressMappingCsv|EJH_APP_KEY|EJH_APP_SECRET|Python/.test(html), 'removed');
  add('OPOM writeback is enabled for recharge and skipped for ZDR-only', !/id=["']opomWriteback["']/.test(html)
    && /opomWriteback:\s*!zdrOnly/.test(appJs), 'scope_aware');
  add('AdsPower status writeback forced disabled', /adspowerStatusMode:\s*['"]disabled['"]/.test(appJs) && !/group_move|remark_append|Discover groups/.test(html), 'disabled');
  add('light/dark/high-contrast tokens present', /color-scheme:\s*light dark/.test(css) && /body\.high-contrast/.test(css), 'themes');
  add('44px controls retained', /--control:\s*44px/.test(css), '44px');
  add('no obvious sensitive literals in UI assets', !containsSensitive(`${html}\n${appJs}\n${css}\n${executionHtml}\n${executionJs}`), 'no_sensitive_literals');
} catch (error) {
  add('ui smoke exception', false, redact(error.message || 'unknown error'));
}

const failed = checks.filter((check) => !check.ok);
const result = {ok: failed.length === 0, failed: failed.length, baseUrl: baseUrl || 'local_files', checks};
if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const check of checks) console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.label}: ${check.status}`);
  console.log(result.ok ? 'ui smoke passed' : `ui smoke failed: ${failed.length} check(s)`);
}
process.exitCode = result.ok ? 0 : 1;

function parseArgs(argv) {
  const parsed = {base: '', json: false};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') parsed.json = true;
    else if (arg === '--base') {
      parsed.base = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--base=')) parsed.base = arg.split('=').slice(1).join('=');
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
  return /5257970000000001|card_number\s*=|cvv\s*=|sk-or-v1-|api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i.test(String(value || ''));
}
