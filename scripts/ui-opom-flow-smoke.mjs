#!/usr/bin/env node
import {existsSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {redact} from '../src/server/redact.mjs';

const DEFAULT_PLAYWRIGHT_PATH = '/Users/weiwei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js';

const FAKE_SAFE_CARD_CSV = `card_batch_id,row_number,card_provider,open_status,order_no,card_no,expiry_month,expiry_year,cvv,pan_last4
batch-ui,1,EJH,completed,order-ui-1,5257970000000001,06,2028,456,0001
batch-ui,2,EJH,completed,order-ui-2,5257970000000002,07,2029,789,0002
`;

const FAKE_ADDRESS_CSV = `LastName,FirstName,Street,City,State,Zip,PhoneNumber
Ignored,UI Flow,1 Main St,Portland,OR,97001,5551112222
Ignored,UI Flow 2,2 Main St,Portland,OR,97002,5551113333
`;

const args = parseArgs(process.argv.slice(2));
const baseUrl = normalizeBase(args.base || process.env.SMOKE_BASE_URL || 'http://127.0.0.1:4100');
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
  const page = await browser.newPage({viewport: {width: 1440, height: 1400}});
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));

  await page.route('**/api/opom/ready', async (route) => {
    const request = route.request();
    const payload = request.postDataJSON?.() || {};
    const cursor = String(payload.cursor || '');
    const firstRow = {
      status: '',
      opom_account_id: 'acct-ui-1',
      login_email: 'ui-flow@example.com',
      ads_power_user_id: 'ads-ui-1',
      ads_power_serial_number: '1415',
      ads_power_group_name: 'recharge',
      opom_health_status: 'ok',
      opom_health_reason: '',
      ads_match_status: '',
      order_no: '',
      card_no: '',
      exp_month: '',
      exp_year: '',
      cvv: '',
      amount: '',
      postal_code: '97001',
      holder_name: 'UI Flow',
      country: 'US',
      address_line1: '1 Main St',
      city: 'Portland',
      state: 'OR',
      auto_topup_threshold: '',
      auto_topup_amount: '',
      idempotency_key: 'recharge_plan:acct-ui-1:v1',
    };
    const secondRow = {
      ...firstRow,
      opom_account_id: 'acct-ui-2',
      login_email: 'ui-flow-2@example.com',
      ads_power_user_id: 'ads-ui-2',
      ads_power_serial_number: '1416',
      postal_code: '97002',
      holder_name: 'UI Flow 2',
      address_line1: '2 Main St',
      idempotency_key: 'recharge_plan:acct-ui-2:v1',
    };
    const rows = cursor ? [firstRow, secondRow] : [firstRow];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        count: rows.length,
        nextCursor: cursor ? '' : 'cursor-page-2',
        addressMappingCount: 0,
        csvText: '',
        rows,
      }),
    });
  });

  await page.route('**/api/adspower/match', async (route) => {
    const request = route.request();
    const payload = request.postDataJSON?.() || {};
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        matched: rows.length,
        failed: 0,
        results: rows.map((row, index) => ({
          index,
          status: 'matched',
          profile: {
            userId: row.ads_power_user_id,
            serialNumber: row.ads_power_serial_number,
            groupName: 'recharge',
          },
        })),
      }),
    });
  });

  await page.goto(baseUrl, {waitUntil: 'networkidle'});
  await page.fill('#defaultAmount', '10');
  await page.fill('#defaultAutoTopupThreshold', '2');
  await page.fill('#defaultAutoTopupAmount', '25');
  const addressCsvPath = join(tmpdir(), `recharge-ui-addresses-${Date.now()}.csv`);
  writeFileSync(addressCsvPath, FAKE_ADDRESS_CSV, 'utf8');
  await page.setInputFiles('#addressMappingCsv', addressCsvPath);
  await page.check('#noPurchaseMode');

  await page.click('#opomReadyBtn');
  await page.waitForFunction(() => /rows=1/.test(document.querySelector('#opomSummary')?.textContent || ''));
  add('Load OPOM group renders OPOM row', await page.locator('#opomPreviewBody tr').count() === 1, 'rows=1');
  add('OPOM pagination indicates more rows', await page.locator('#opomLoadMoreBtn').isEnabled(), 'hasMore=true');

  await page.click('#opomLoadMoreBtn');
  await page.waitForFunction(() => /rows=2/.test(document.querySelector('#opomSummary')?.textContent || ''));
  add('Load next page appends OPOM rows with de-duplication', await page.locator('#opomPreviewBody tr').count() === 2, 'rows=2');

  await page.click('#adsPowerMatchBtn');
  await page.waitForFunction(() => /matched=2/.test(document.querySelector('#opomSummary')?.textContent || ''));
  add('Match AdsPower updates OPOM rows', /matched=2/.test(await page.locator('#opomSummary').textContent() || ''), 'matched=2');

  const cardCsvPath = join(tmpdir(), `recharge-ui-cards-${Date.now()}.csv`);
  writeFileSync(cardCsvPath, FAKE_SAFE_CARD_CSV, 'utf8');
  await page.setInputFiles('#ejhSafeCsv', cardCsvPath);
  await page.click('#allocateCardsBtn');
  await page.waitForFunction(() => /allocated=2/.test(document.querySelector('#opomSummary')?.textContent || ''));
  add('Allocate cards updates OPOM rows', /allocated=2/.test(await page.locator('#opomSummary').textContent() || ''), 'allocated=2');

  await page.check('#confirmLive');
  await page.click('#liveRunBtn');
  await page.waitForFunction(() => {
    const summary = document.querySelector('#dryRunSummary')?.textContent || '';
    return /ready\s*[:=]\s*2/.test(summary) && /blocked\s*[:=]\s*0/.test(summary);
  });
  const dryRunSummary = await page.locator('#dryRunSummary').textContent();
  add('OPOM flow auto preflight has two ready rows', /ready\s*[:=]\s*2/.test(dryRunSummary || '') && /blocked\s*[:=]\s*0/.test(dryRunSummary || ''), redact(dryRunSummary || 'missing'));
  add('No-purchase confirmation stays enabled after ready preflight', await page.locator('#confirmLive').isEnabled(), 'enabled');

  const bodyText = await page.locator('body').textContent();
  add('OPOM flow UI redaction', !containsSensitive(bodyText), 'no_sensitive_values');
  add('no browser console errors', consoleErrors.length === 0, consoleErrors.length ? redact(consoleErrors.join(' | ')) : 'none');
  add('no page runtime errors', pageErrors.length === 0, pageErrors.length ? redact(pageErrors.join(' | ')) : 'none');
} catch (error) {
  add('ui OPOM flow smoke exception', false, redact(error.message || 'unknown error'));
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
  console.log(result.ok ? 'ui OPOM flow smoke passed' : `ui OPOM flow smoke failed: ${failed.length} check(s)`);
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
  return /,456,|,789,|cvv/i.test(String(value || ''));
}
