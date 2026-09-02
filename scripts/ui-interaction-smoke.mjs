#!/usr/bin/env node
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {redact} from '../src/server/redact.mjs';

const SELECTOR_CSV = `login_email,ads_power_serial_number
ui-smoke@example.com,1415
`;
const DEFAULT_PLAYWRIGHT_PATH = '/Users/weiwei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js';
const args = parseArgs(process.argv.slice(2));
const baseUrl = normalizeBase(args.base || process.env.SMOKE_BASE_URL || 'http://127.0.0.1:4100');
const checks = [];

function add(label, ok, status = '') {
  checks.push({label, ok: Boolean(ok), status: String(status || (ok ? 'ok' : 'failed'))});
}

let browser;
let tempDir = '';
const popups = [];

try {
  const playwright = await loadPlaywright();
  const chromium = playwright.chromium || playwright.default?.chromium;
  if (!chromium) throw new Error('Loaded Playwright package does not expose chromium');
  tempDir = mkdtempSync(join(tmpdir(), 'recharge-ui-smoke-'));
  const csvPath = join(tempDir, 'selector.csv');
  writeFileSync(csvPath, SELECTOR_CSV, 'utf8');

  browser = await launchChromium(chromium, {headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1200}});
  const consoleErrors = [];
  const pageErrors = [];
  page.on('popup', async (popup) => {
    popups.push(popup);
    await popup.close().catch(() => {});
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/503 \(Service Unavailable\)/.test(text)) return;
    consoleErrors.push(text);
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
        resolveSource: `${payload.group}/${payload.status}`,
        rows: rows.map((row, index) => ({
          ...row,
          opom_account_id: `acct-ui-selector-${index + 1}`,
          opom_health_status: 'ok',
          opom_health_reason: '',
        })),
      }),
    });
  });

  await page.route('**/api/adspower/match', async (route) => {
    const payload = route.request().postDataJSON?.() || {};
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        total: rows.length,
        matched: 0,
        failed: rows.length,
        results: rows.map((row, index) => ({
          index,
          status: 'identity_mismatch',
          error: 'AdsPower profile belongs to a different OpenRouter account',
          profile: {
            userId: row.ads_power_user_id || `profile-ui-selector-${index + 1}`,
            serialNumber: row.ads_power_serial_number,
            groupName: 'VIP',
          },
        })),
      }),
    });
  });

  await page.goto(baseUrl, {waitUntil: 'networkidle'});
  add('operator page loaded', (await page.title()) === 'OpenRouter 充值准备', 'title_present');
  add('CSV source is default', await page.locator('[data-source="csv"].is-selected').count() === 1, 'csv_default');
  add('OPOM source option visible', await page.locator('[data-source="opom"]').isVisible(), 'visible');
  add('AdsPower match button visible', await page.locator('#matchButton').isVisible(), 'visible');
  add('ZDR-only switch is visible and defaults off', await page.locator('#zdrOnly').isVisible()
    && !(await page.locator('#zdrOnly').isChecked()), 'default_off');
  await page.click('label.zdr-only-row');
  const disabledScopeControls = await page.locator(
    '#balanceThreshold:disabled, #amountBelow:disabled, #amountAtOrAbove:disabled, #autoTopupEnableOnly:disabled, #autoTopupThreshold:disabled, #autoTopupAmount:disabled, #cardFileButton:disabled, #billingState:disabled',
  ).count();
  add('ZDR-only forces ZDR on and disables recharge controls', await page.locator('#disableZdr').isChecked()
    && await page.locator('#disableZdr').isDisabled()
    && disabledScopeControls === 8, `disabled=${disabledScopeControls}`);
  await page.click('label.zdr-only-row');
  add('leaving ZDR-only restores normal controls', !(await page.locator('#disableZdr').isChecked())
    && !(await page.locator('#disableZdr').isDisabled())
    && !(await page.locator('#balanceThreshold').isDisabled()), 'restored');
  add('ZDR enable-only switch is visible and defaults off', await page.locator('#enableZdrOnly').isVisible()
    && !(await page.locator('#enableZdrOnly').isChecked()), 'default_off');
  await page.click('#enableZdrOnly');
  add('ZDR enable-only disables recharge controls without enabling the close action', !(await page.locator('#disableZdr').isChecked())
    && await page.locator('#disableZdr').isDisabled()
    && await page.locator('#balanceThreshold').isDisabled(), 'enable_only_scope');
  await page.click('#enableZdrOnly');

  await page.setInputFiles('#accountFile', csvPath);
  await page.waitForFunction(() => /1 个账号/.test(document.querySelector('#detailTitle')?.textContent || ''));
  add('local account CSV creates one canonical row', await page.locator('#matchBody tr').count() === 1, 'rows=1');
  const previewBeforeMatch = await page.locator('#matchBody').textContent();
  add('unmatched CSV row is neutral before AdsPower match', /-/.test(previewBeforeMatch || '') && await page.locator('#matchBody .pill.error').count() === 0, 'neutral_before_match');

  await page.click('#selectAllRows');
  add('header checkbox can cancel all selections', await page.locator('#matchBody .row-check:checked').count() === 0, 'cleared');
  await page.click('#selectAllRows');
  add('header checkbox can select all rows', await page.locator('#matchBody .row-check:checked').count() === 1, 'selected');

  await page.click('#matchButton');
  await page.waitForFunction(() => /失败/.test(document.querySelector('#matchBody')?.textContent || ''));
  const previewAfterMatch = await page.locator('#matchBody').textContent();
  add('AdsPower mismatch visible as error not percent', /失败/.test(previewAfterMatch || '') && !/%/.test(previewAfterMatch || ''), 'match_error');

  add('start remains disabled for failed match', await page.locator('#startButton').isDisabled(), 'disabled');
  add('confirmation dialog not opened for blocked row', !(await page.locator('#confirmDialog').evaluate((node) => node.open)), 'dialog_closed');
  let zdrOnlyOptions = null;
  await page.route('**/api/jobs/dry-run', async (route) => {
    zdrOnlyOptions = route.request().postDataJSON?.()?.options || null;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        planned: 1,
        ready: 1,
        blocked: 0,
        skipped: 0,
        liveConfirmationToken: 'ui-zdr-only-token',
        rows: [],
      }),
    });
  });
  await page.click('label[for="skipMatch"], label.switch-row:has(#skipMatch)');
  await page.click('label.zdr-only-row');
  await page.click('#startButton');
  await page.waitForFunction(() => document.querySelector('#confirmDialog')?.open === true);
  add('ZDR-only dry-run payload skips every other scope', Boolean(zdrOnlyOptions)
    && zdrOnlyOptions.disableZdr === true
    && zdrOnlyOptions.scopeBillingAddress === false
    && zdrOnlyOptions.scopePaymentMethod === false
    && zdrOnlyOptions.scopePurchase === false
    && zdrOnlyOptions.scopeAutoTopup === false
    && zdrOnlyOptions.confirmPurchase === false
    && zdrOnlyOptions.opomWriteback === false, JSON.stringify(zdrOnlyOptions || {}));
  await page.locator('#confirmDialog .close-button').click();
  let enableZdrOnlyOptions = null;
  await page.route('**/api/jobs/dry-run', async (route) => {
    enableZdrOnlyOptions = route.request().postDataJSON?.()?.options || null;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        planned: 1,
        ready: 1,
        blocked: 0,
        skipped: 0,
        liveConfirmationToken: 'ui-zdr-enable-only-token',
        rows: [],
      }),
    });
  });
  await page.click('#enableZdrOnly');
  await page.click('#startButton');
  await page.waitForFunction(() => document.querySelector('#confirmDialog')?.open === true);
  add('ZDR enable-only dry-run payload skips every other scope', Boolean(enableZdrOnlyOptions)
    && enableZdrOnlyOptions.disableZdr === false
    && enableZdrOnlyOptions.enableZdr === true
    && enableZdrOnlyOptions.scopeBillingAddress === false
    && enableZdrOnlyOptions.scopePaymentMethod === false
    && enableZdrOnlyOptions.scopePurchase === false
    && enableZdrOnlyOptions.scopeAutoTopup === false
    && enableZdrOnlyOptions.confirmPurchase === false
    && enableZdrOnlyOptions.opomWriteback === false, JSON.stringify(enableZdrOnlyOptions || {}));
  await page.locator('#confirmDialog .close-button').click();
  const bodyText = await page.locator('body').textContent();
  add('UI text redaction after auto dry-run', !containsSensitive(bodyText), 'no_sensitive_values');
  add('no browser console errors', consoleErrors.length === 0, consoleErrors.length ? redact(consoleErrors.join(' | ')) : 'none');
  add('no page runtime errors', pageErrors.length === 0, pageErrors.length ? redact(pageErrors.join(' | ')) : 'none');
} catch (error) {
  add('ui interaction smoke exception', false, redact(error.message || 'unknown error'));
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
  console.log(result.ok ? 'ui interaction smoke passed' : `ui interaction smoke failed: ${failed.length} check(s)`);
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
  return /5551112222|525797\d{10}|(?:^|[^0-9])456(?:[^0-9]|$)/i.test(String(value || ''));
}
