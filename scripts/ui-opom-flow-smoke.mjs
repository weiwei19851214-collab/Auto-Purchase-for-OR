#!/usr/bin/env node
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {redact} from '../src/server/redact.mjs';

const DEFAULT_PLAYWRIGHT_PATH = '/Users/weiwei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js';
const FAKE_SAFE_CARD_CSV = `card_batch_id,row_number,card_provider,open_status,order_no,card_no,expiry_month,expiry_year,cvv,pan_last4
batch-ui,1,EJH,completed,order-ui-1,5257970000000001,06,2028,456,0001
batch-ui,2,EJH,completed,order-ui-2,5257970000000002,07,2029,789,0002
`;

const args = parseArgs(process.argv.slice(2));
const baseUrl = normalizeBase(args.base || process.env.SMOKE_BASE_URL || 'http://127.0.0.1:4100');
const checks = [];
let browser;
let tempDir = '';
let readyPayload = null;
const popups = [];

function add(label, ok, status = '') {
  checks.push({label, ok: Boolean(ok), status: String(status || (ok ? 'ok' : 'failed'))});
}

try {
  const playwright = await loadPlaywright();
  const chromium = playwright.chromium || playwright.default?.chromium;
  if (!chromium) throw new Error('Loaded Playwright package does not expose chromium');
  tempDir = mkdtempSync(join(tmpdir(), 'recharge-ui-opom-'));
  const cardCsvPath = join(tempDir, 'cards.csv');
  writeFileSync(cardCsvPath, FAKE_SAFE_CARD_CSV, 'utf8');

  browser = await launchChromium(chromium, {headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1200}});
  const consoleErrors = [];
  const pageErrors = [];
  page.on('popup', async (popup) => {
    popups.push(popup);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/api/opom/ready', async (route) => {
    readyPayload = route.request().postDataJSON?.() || {};
    const baseRow = {
      status: '',
      opom_account_id: 'acct-ui-1',
      login_email: 'ui-flow@example.com',
      ads_power_user_id: 'ads-ui-1',
      ads_power_serial_number: '1415',
      ads_power_group_name: 'VIP',
      opom_account_status: 'card_switch',
      opom_health_status: 'ok',
      opom_health_reason: '',
      opom_card_status: 'ACTIVE',
      ads_match_status: '',
      idempotency_key: 'recharge_plan:acct-ui-1:v1',
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        count: 2,
        nextCursor: '',
        rows: [
          baseRow,
          {
            ...baseRow,
            opom_account_id: 'acct-ui-2',
            login_email: 'ui-flow-2@example.com',
            ads_power_user_id: 'ads-ui-2',
            ads_power_serial_number: '1416',
            opom_account_status: 'overdue',
            idempotency_key: 'recharge_plan:acct-ui-2:v1',
          },
        ],
      }),
    });
  });

  await page.route('**/api/cards/allocate', async (route) => {
    const payload = route.request().postDataJSON?.() || {};
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        rows: rows.map((row, index) => ({
          ...row,
          order_no: `order-ui-${index + 1}`,
          card_no: `525797000000000${index + 1}`,
          exp_month: index === 0 ? '06' : '07',
          exp_year: index === 0 ? '2028' : '2029',
          cvv: index === 0 ? '456' : '789',
        })),
        allocated: rows.length,
      }),
    });
  });

  await page.route('**/api/jobs/dry-run', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        ready: 2,
        blocked: 0,
        liveConfirmationToken: 'ui-live-confirmation-token',
        rows: [],
      }),
    });
  });

  await page.route('**/api/jobs', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        job: {id: 'job-ui-confirmed'},
      }),
    });
  });

  await page.goto(baseUrl, {waitUntil: 'networkidle'});
  await page.click('[data-source="opom"]');
  add('OPOM switch enables Auto Top-Up only', await page.locator('#autoTopupEnableOnly').isChecked(), 'checked');
  add('OPOM switch skips Ads match', await page.locator('#skipMatch').isChecked(), 'checked');
  add('match button disabled when skipped', await page.locator('#matchButton').isDisabled(), 'disabled');

  await page.click('#loadOpomButton');
  await page.waitForFunction(() => /已获取 2/.test(document.querySelector('#opomLoadState')?.textContent || ''));
  add('combined OPOM status maps to needs_recharge API', readyPayload?.group === 'VIP' && readyPayload?.status === 'needs_recharge', `${readyPayload?.group}/${readyPayload?.status}`);
  add('Load OPOM renders rows', await page.locator('#matchBody tr').count() === 2, 'rows=2');

  await page.setInputFiles('#cardFile', cardCsvPath);
  await page.waitForFunction(() => /••••0001/.test(document.querySelector('#matchBody')?.textContent || ''));
  add('card CSV allocation is reflected without showing full card', /••••0001|待分配/.test(await page.locator('#matchBody').textContent() || ''), 'card_ui');

  await page.click('#startButton');
  await page.waitForFunction(() => document.querySelector('#confirmDialog')?.open === true);
  const confirmReadiness = await page.locator('#confirmReadiness').textContent();
  add('OPOM flow auto dry-run has two ready rows', /2 可执行 \/ 0 阻塞/.test(confirmReadiness || ''), redact(confirmReadiness || 'missing'));
  add('live confirmation dialog opens after passing dry-run', await page.locator('#confirmDialog').evaluate((node) => node.open), 'visible');
  add('execution page does not open before confirmation', popups.length === 0, `popups=${popups.length}`);

  const popupPromise = page.waitForEvent('popup');
  await page.click('#createJobButton');
  const executionPopup = await popupPromise;
  await executionPopup.waitForURL('**/execution.html?job=job-ui-confirmed');
  add('execution page opens only after confirmation', /\/execution\.html\?job=job-ui-confirmed$/.test(executionPopup.url()), executionPopup.url());
  add('confirmation dialog closes after job creation', !(await page.locator('#confirmDialog').evaluate((node) => node.open)), 'closed');
  await executionPopup.locator('#executionBody').evaluate((node) => {
    node.innerHTML = `
      <tr>
        <td data-label="状态"><span class="pill running">执行中</span></td>
        <td data-label="行">2</td>
        <td data-label="账号"><span class="account-cell"><strong>layout@example.com</strong><small>acct-layout</small></span></td>
        <td data-label="AdsPower">1415<br><span class="muted">ads-layout</span></td>
        <td data-label="阶段">configure.auto_topup</td>
        <td data-label="充值">verified / 150</td>
        <td data-label="余额">10 → 160</td>
        <td data-label="Auto Top-Up">configured 100/150</td>
        <td data-label="卡 / OPOM">结果 completed</td>
        <td class="message" data-label="消息">正在验证保存后的 Auto Top-Up 设置</td>
        <td data-label="操作"><div class="row-actions"><button type="button">从本行继续</button><button type="button">重试本行</button></div></td>
      </tr>
    `;
  });
  const layoutChecks = [];
  for (const width of [1440, 1024, 760, 375]) {
    await executionPopup.setViewportSize({width, height: 1000});
    const layout = await executionPopup.evaluate(() => {
      const wrap = document.querySelector('.execution-table-wrap');
      return {
        bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        tableOverflow: wrap.scrollWidth > wrap.clientWidth,
      };
    });
    layoutChecks.push({width, ...layout});
  }
  add(
    'execution task status has no horizontal scroll',
    layoutChecks.every((item) => !item.bodyOverflow && !item.tableOverflow),
    layoutChecks.map((item) => `${item.width}:${item.bodyOverflow || item.tableOverflow ? 'overflow' : 'fit'}`).join(','),
  );

  const bodyText = await page.locator('body').textContent();
  add('OPOM flow UI redaction', !containsSensitive(bodyText), 'no_sensitive_values');
  add('no browser console errors', consoleErrors.length === 0, consoleErrors.length ? redact(consoleErrors.join(' | ')) : 'none');
  add('no page runtime errors', pageErrors.length === 0, pageErrors.length ? redact(pageErrors.join(' | ')) : 'none');
} catch (error) {
  add('ui OPOM flow smoke exception', false, redact(error.message || 'unknown error'));
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
  console.log(result.ok ? 'ui OPOM flow smoke passed' : `ui OPOM flow failed: ${failed.length} check(s)`);
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
