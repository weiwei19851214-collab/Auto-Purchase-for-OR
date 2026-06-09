#!/usr/bin/env node
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {redact} from '../src/server/redact.mjs';

const SELECTOR_CSV = `login_email,ads_power_serial_number
ui-smoke@example.com,1415
`;

const ADDRESS_CSV = `LastName,FirstName,Street,City,State,Zip,PhoneNumber
Ignored,UI Smoke,1 Main St,Portland,OR,97001,5551112222
`;

const DEFAULT_PLAYWRIGHT_PATH = '/Users/weiwei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js';

const args = parseArgs(process.argv.slice(2));
const baseUrl = normalizeBase(args.base || process.env.SMOKE_BASE_URL || 'http://127.0.0.1:4174');
const checks = [];

function add(label, ok, status = '') {
  checks.push({label, ok: Boolean(ok), status: String(status || (ok ? 'ok' : 'failed'))});
}

let browser;
let tempDir = '';

try {
  const playwright = await loadPlaywright();
  const chromium = playwright.chromium || playwright.default?.chromium;
  if (!chromium) throw new Error('Loaded Playwright package does not expose chromium');
  tempDir = mkdtempSync(join(tmpdir(), 'recharge-ui-smoke-'));
  const csvPath = join(tempDir, 'selector.csv');
  const addressCsvPath = join(tempDir, 'addresses.csv');
  writeFileSync(csvPath, SELECTOR_CSV, 'utf8');
  writeFileSync(addressCsvPath, ADDRESS_CSV, 'utf8');

  browser = await chromium.launch({headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1200}});
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(baseUrl, {waitUntil: 'networkidle'});
  add('operator page loaded', (await page.title()) === 'OpenRouter 充值执行器', 'title_present');
  add('OPOM ready button visible', await page.locator('#opomReadyBtn').isVisible(), 'visible');
  add('AdsPower match button visible', await page.locator('#adsPowerMatchBtn').isVisible(), 'visible');
  add('AdsPower remark V2 option visible', await page.locator('#adspowerStatusMode option[value="remark_append_v2"]').count() === 1, 'present');

  await page.route('**/api/adspower/status-targets', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        status: 'groups=3',
        base: 'http://127.0.0.1:50325/',
        groups: [
          {groupId: 'g-success', groupName: 'Recharge Success'},
          {groupId: 'g-failure', groupName: 'Recharge Failed'},
          {groupId: 'g-blocker', groupName: 'Recharge Blocked'},
        ],
        targets: {
          success: {status: 'missing', groupId: '', groupName: ''},
          failure: {status: 'missing', groupId: '', groupName: ''},
          blocker: {status: 'missing', groupId: '', groupName: ''},
        },
        candidates: {
          success: [{groupId: 'g-success', groupName: 'Recharge Success'}],
          failure: [{groupId: 'g-failure', groupName: 'Recharge Failed'}],
          blocker: [{groupId: 'g-blocker', groupName: 'Recharge Blocked'}],
        },
        suggestedEnv: [
          'export ADSPOWER_SUCCESS_GROUP_ID="g-success"',
          'export ADSPOWER_FAILURE_GROUP_ID="g-failure"',
          'export ADSPOWER_BLOCKER_GROUP_ID="g-blocker"',
        ],
      }),
    });
  });

  await page.route('**/api/opom/resolve', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const payload = route.request().postDataJSON?.() || {};
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        total: rows.length,
        matched: rows.length,
        failed: 0,
        csvText: '',
        rows: rows.map((row, index) => ({
          ...row,
          opom_account_id: `acct-ui-selector-${index + 1}`,
          ads_power_user_id: row.ads_power_user_id || `profile-ui-selector-${index + 1}`,
          opom_health_status: 'ok',
          opom_health_reason: '',
        })),
      }),
    });
  });

  await page.route('**/api/adspower/match', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const payload = route.request().postDataJSON?.() || {};
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        total: rows.length,
        matched: rows.length,
        failed: 0,
        results: rows.map((row, index) => ({
          index,
          status: 'matched',
          profile: {
            userId: row.ads_power_user_id || `profile-ui-selector-${index + 1}`,
            serialNumber: row.ads_power_serial_number,
            groupName: 'recharge',
          },
        })),
      }),
    });
  });

  await page.selectOption('#adspowerStatusMode', 'group_move');
  await page.click('#adspowerDiscoverTargetsBtn');
  await page.waitForFunction(() => /groups=3/.test(document.querySelector('#adspowerTargetsSummary')?.textContent || ''));
  add('AdsPower target discovery summary rendered', /Recharge Success/.test(await page.locator('#adspowerTargetsSummary').textContent() || ''), 'summary_present');
  add('AdsPower discovered target apply enabled', await page.locator('#adspowerUseDiscoveredTargetsBtn').isEnabled(), 'enabled');
  await page.click('#adspowerUseDiscoveredTargetsBtn');
  add('AdsPower discovered targets fill local fields', await page.locator('#adspowerSuccessGroupId').inputValue() === 'id:g-success'
    && await page.locator('#adspowerFailureGroupId').inputValue() === 'id:g-failure'
    && await page.locator('#adspowerBlockerGroupId').inputValue() === 'id:g-blocker', 'filled');

  await page.setInputFiles('#csvFile', csvPath);
  await page.waitForFunction(() => /local selector rows=1/.test(document.querySelector('#opomSummary')?.textContent || ''));
  add('local selector CSV creates one canonical row before address upload', await page.locator('#opomPreviewBody tr').count() === 1, 'rows=1');
  await page.click('#adsPowerMatchBtn');
  await page.waitForFunction(() => /OPOM resolved=1\/1/.test(document.querySelector('#opomSummary')?.textContent || ''));
  add('local selector match resolves OPOM before AdsPower', /AdsPower matched=1 failed=0 OPOM resolved=1\/1/.test(await page.locator('#opomSummary').textContent() || ''), 'resolved=1/1');
  await page.setInputFiles('#addressMappingCsv', addressCsvPath);
  await page.click('#dryRunBtn');
  await page.waitForFunction(() => {
    const summary = document.querySelector('#dryRunSummary')?.textContent || '';
    return /ready\s*[:=]\s*0|blocked\s*[:=]\s*1|missing_fields|缺/.test(summary);
  });

  const dryRunSummary = await page.locator('#dryRunSummary').textContent();
  const bodyText = await page.locator('body').textContent();
  add('blocked dry-run summary rendered', /ready\s*[:=]\s*0|blocked\s*[:=]\s*1|missing_fields|缺/.test(dryRunSummary || ''), redact(dryRunSummary || 'missing'));
  add('blocked dry-run stays local-only', !(await page.locator('#confirmLive').isEnabled()), 'live_confirmation_disabled');
  add('UI text redaction after dry-run', !containsSensitive(bodyText), 'no_sensitive_values');
  add('no browser console errors', consoleErrors.length === 0, consoleErrors.length ? redact(consoleErrors.join(' | ')) : 'none');
  add('no page runtime errors', pageErrors.length === 0, pageErrors.length ? redact(pageErrors.join(' | ')) : 'none');
} catch (error) {
  add('ui interaction smoke exception', false, redact(error.message || 'unknown error'));
} finally {
  if (browser) await browser.close();
  if (tempDir) rmSync(tempDir, {recursive: true, force: true});
}

const failed = checks.filter((check) => !check.ok);
const result = {ok: failed.length === 0, failed: failed.length, baseUrl, checks};
if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const check of checks) {
    console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.label}: ${check.status}`);
  }
  console.log(result.ok ? 'ui interaction smoke passed' : `ui interaction smoke failed: ${failed.length} check(s)`);
}
process.exitCode = result.ok ? 0 : 1;

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_IMPORT_PATH || '',
    DEFAULT_PLAYWRIGHT_PATH,
    'playwright',
  ].filter(Boolean);

  const errors = [];
  for (const candidate of candidates) {
    try {
      if (candidate === 'playwright') return await import(candidate);
      if (!existsSync(candidate)) {
        errors.push(`${candidate}:missing`);
        continue;
      }
      return await import(pathToFileURL(candidate));
    } catch (error) {
      errors.push(`${candidate}:${error.message}`);
    }
  }
  throw new Error(`Unable to load Playwright. Set PLAYWRIGHT_IMPORT_PATH. ${errors.join(' | ')}`);
}

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

function containsSensitive(value) {
  return /5551112222|525797\d{10}|(?:^|[^0-9])456(?:[^0-9]|$)/i.test(String(value || ''));
}
