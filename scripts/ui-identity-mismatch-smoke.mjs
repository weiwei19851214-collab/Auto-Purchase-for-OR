#!/usr/bin/env node
import {existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {redact} from '../src/server/redact.mjs';

const DEFAULT_PLAYWRIGHT_PATH = '/Users/weiwei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js';

const args = parseArgs(process.argv.slice(2));
const baseUrl = normalizeBase(args.base || process.env.SMOKE_BASE_URL || 'http://127.0.0.1:4174');
const checks = [];

function add(label, ok, status = '') {
  checks.push({label, ok: Boolean(ok), status: String(status || (ok ? 'ok' : 'failed'))});
}

let browser;

try {
  const playwright = await loadPlaywright();
  const chromium = playwright.chromium || playwright.default?.chromium;
  if (!chromium) throw new Error('Loaded Playwright package does not expose chromium');

  browser = await chromium.launch({headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1200}});
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/api/opom/ready', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        count: 1,
        nextCursor: '',
        addressMappingCount: 0,
        csvText: '',
        rows: [{
          status: '',
          opom_account_id: 'acct-mismatch-1',
          login_email: 'expected@example.com',
          ads_power_user_id: 'ads-mismatch-1',
          ads_power_serial_number: '1416',
          ads_power_group_name: 'recharge',
          opom_health_status: 'ok',
          opom_health_reason: '',
          ads_match_status: '',
          order_no: 'order-mismatch-1',
          card_no: '5257970000000001',
          exp_month: '06',
          exp_year: '2028',
          cvv: '456',
          amount: '10',
          postal_code: '97001',
          holder_name: 'Mismatch User',
          country: 'US',
          address_line1: '1 Main St',
          city: 'Portland',
          state: 'OR',
          auto_topup_threshold: '2',
          auto_topup_amount: '25',
          idempotency_key: 'recharge_plan:acct-mismatch-1:v1',
        }],
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
            groupName: 'recharge',
          },
        }],
      }),
    });
  });

  await page.goto(baseUrl, {waitUntil: 'networkidle'});
  await page.click('#opomReadyBtn');
  await page.waitForFunction(() => /rows=1/.test(document.querySelector('#opomSummary')?.textContent || ''));
  add('Ready to recharge renders mismatch candidate', await page.locator('#opomPreviewBody tr').count() === 1, 'rows=1');

  await page.click('#adsPowerMatchBtn');
  await page.waitForFunction(() => /failed=1/.test(document.querySelector('#opomSummary')?.textContent || ''));
  const previewText = await page.locator('#opomPreviewBody').textContent();
  add('AdsPower mismatch is visible in preview', /identity_mismatch/.test(previewText || ''), redact(previewText || 'missing'));

  await page.click('#dryRunBtn');
  await page.waitForFunction(() => {
    const summary = document.querySelector('#dryRunSummary')?.textContent || '';
    return /ready\s*[:=]\s*0/.test(summary) && /blocked\s*[:=]\s*1/.test(summary);
  });
  const dryRunSummary = await page.locator('#dryRunSummary').textContent();
  const dryRunRows = await page.locator('#dryRunBody').textContent();
  add('identity_mismatch row is blocked by dry-run', /ready\s*[:=]\s*0/.test(dryRunSummary || '') && /blocked\s*[:=]\s*1/.test(dryRunSummary || ''), redact(dryRunSummary || 'missing'));
  add('dry-run explains AdsPower mismatch', /ads_match_status:identity_mismatch/.test(dryRunRows || ''), redact(dryRunRows || 'missing'));
  add('live confirmation disabled for mismatch', await page.locator('#confirmLive').isDisabled(), 'disabled');
  add('live run button disabled for mismatch', await page.locator('#liveRunBtn').isDisabled(), 'disabled');

  const bodyText = await page.locator('body').textContent();
  add('identity mismatch UI redaction', !containsSensitive(bodyText), 'no_sensitive_values');
  add('no browser console errors', consoleErrors.length === 0, consoleErrors.length ? redact(consoleErrors.join(' | ')) : 'none');
  add('no page runtime errors', pageErrors.length === 0, pageErrors.length ? redact(pageErrors.join(' | ')) : 'none');
} catch (error) {
  add('ui identity mismatch smoke exception', false, redact(error.message || 'unknown error'));
} finally {
  if (browser) await browser.close();
}

const failed = checks.filter((check) => !check.ok);
const result = {ok: failed.length === 0, failed: failed.length, baseUrl, checks};
if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const check of checks) {
    console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.label}: ${check.status}`);
  }
  console.log(result.ok ? 'ui identity mismatch smoke passed' : `ui identity mismatch smoke failed: ${failed.length} check(s)`);
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
  return /5257970000000001|expected@example\.com|,456,|cvv|card_no/i.test(String(value || ''));
}
