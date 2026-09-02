#!/usr/bin/env node
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {redact} from '../src/server/redact.mjs';

const DEFAULT_PLAYWRIGHT_PATH = '/Users/weiwei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js';
const CSV = `login_email,ads_power_user_id,ads_power_serial_number
expected@example.com,ads-mismatch-1,1416
`;
const args = parseArgs(process.argv.slice(2));
const baseUrl = normalizeBase(args.base || process.env.SMOKE_BASE_URL || 'http://127.0.0.1:4100');
const checks = [];
let browser;
let tempDir = '';
const popups = [];

function add(label, ok, status = '') {
  checks.push({label, ok: Boolean(ok), status: String(status || (ok ? 'ok' : 'failed'))});
}

try {
  const playwright = await loadPlaywright();
  const chromium = playwright.chromium || playwright.default?.chromium;
  if (!chromium) throw new Error('Loaded Playwright package does not expose chromium');
  tempDir = mkdtempSync(join(tmpdir(), 'recharge-identity-smoke-'));
  const csvPath = join(tempDir, 'accounts.csv');
  writeFileSync(csvPath, CSV, 'utf8');

  browser = await launchChromium(chromium, {headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1200}});
  const consoleErrors = [];
  const pageErrors = [];
  page.on('popup', async (popup) => {
    popups.push(popup);
    await popup.close().catch(() => {});
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/api/opom/resolve', async (route) => {
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
        rows: rows.map((row) => ({
          ...row,
          opom_account_id: 'acct-mismatch-1',
          opom_health_status: 'ok',
        })),
      }),
    });
  });

  await page.route('**/api/adspower/match', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        matched: 0,
        failed: 1,
        results: [{
          index: 0,
          status: 'identity_mismatch',
          error: 'AdsPower profile belongs to a different OpenRouter account',
          profile: {
            userId: 'ads-mismatch-1',
            serialNumber: '1416',
            groupName: 'VIP',
          },
        }],
      }),
    });
  });

  await page.goto(baseUrl, {waitUntil: 'networkidle'});
  await page.setInputFiles('#accountFile', csvPath);
  await page.waitForFunction(() => /1 个账号/.test(document.querySelector('#detailTitle')?.textContent || ''));
  add('CSV renders mismatch candidate', await page.locator('#matchBody tr').count() === 1, 'rows=1');

  await page.click('#matchButton');
  await page.waitForFunction(() => /报错/.test(document.querySelector('#matchBody')?.textContent || ''));
  const previewText = await page.locator('#matchBody').textContent();
  add('AdsPower mismatch is visible as error', /报错/.test(previewText || ''), redact(previewText || 'missing'));

  add('identity_mismatch row blocks start', await page.locator('#startButton').isDisabled(), 'disabled');
  add('confirmation dialog remains closed for mismatch', !(await page.locator('#confirmDialog').evaluate((node) => node.open)), 'closed');

  const bodyText = await page.locator('body').textContent();
  add('identity mismatch UI redaction', !containsSensitive(bodyText), 'no_sensitive_values');
  add('no browser console errors', consoleErrors.length === 0, consoleErrors.length ? redact(consoleErrors.join(' | ')) : 'none');
  add('no page runtime errors', pageErrors.length === 0, pageErrors.length ? redact(pageErrors.join(' | ')) : 'none');
} catch (error) {
  add('ui identity mismatch smoke exception', false, redact(error.message || 'unknown error'));
} finally {
  for (const popup of popups) await popup.close().catch(() => {});
  if (browser) await browser.close();
  if (tempDir) rmSync(tempDir, {recursive: true, force: true});
}

const failed = checks.filter((check) => !check.ok);
const result = {ok: failed.length === 0, failed: failed.length, baseUrl, checks};
if (args.json) console.log(JSON.stringify(result, null, 2));
else {
  for (const check of checks) console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.label}: ${check.status}`);
  console.log(result.ok ? 'ui identity mismatch smoke passed' : `ui identity mismatch failed: ${failed.length} check(s)`);
}
process.exitCode = result.ok ? 0 : 1;

async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_IMPORT_PATH || '', DEFAULT_PLAYWRIGHT_PATH, 'playwright'].filter(Boolean);
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

async function launchChromium(chromium, options) {
  const executablePath = String(process.env.PLAYWRIGHT_EXECUTABLE_PATH || '').trim();
  if (executablePath) return chromium.launch({...options, executablePath});
  try {
    return await chromium.launch(options);
  } catch (error) {
    if (!/Executable doesn't exist|browser executable/i.test(error.message || '')) throw error;
    return chromium.launch({...options, channel: 'chrome'});
  }
}

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

function containsSensitive(value) {
  return /525797\d{10}|(?:^|[^0-9])456(?:[^0-9]|$)/i.test(String(value || ''));
}
