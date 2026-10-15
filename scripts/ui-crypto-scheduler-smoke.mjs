#!/usr/bin/env node
// Isolated UI contract test. Every API is mocked; no payment service is contacted.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const publicRoot = new URL('../public/', import.meta.url);
const requests = [];
const initial = () => ({ok: true, enabled: false, walletPasswordConfigured: false, settings: {rechargeMode: 'crypto', scheduleType: 'interval', intervalMinutes: 30, dailyTimes: [], hourlyMinutes: [], amount: 150}});
let scheduler = {...initial(),history:{events:[{createdAt:'2026-10-15T11:47:28Z',status:'failed',message:'UND_ERR_SOCKET <script>alert(1)</script>'}],rounds:[{id:'round-1',createdAt:'2026-10-15T11:45:00Z',status:'completed',processedCount:2,totalCount:2,batchCount:1,batches:[{batchIndex:1,status:'completed',accountCount:2,jobId:'job&1'}]}]}};
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Content-Type', 'application/json');
  if (path === '/api/session') return res.end(JSON.stringify({token: 'mock-session', integrations: {}}));
  if (path === '/api/jobs') return res.end(JSON.stringify({jobs: [], worker: {}, schedulers: {crypto: scheduler, bank_card: {ok: true, enabled: false, settings: {rechargeMode: 'bank_card'}}}}));
  if (path === '/api/scheduler' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    scheduler = {...scheduler, settings: {...scheduler.settings, ...body.settings}, enabled: body.action === 'enable' ? true : body.action === 'disable' ? false : scheduler.enabled, walletPasswordConfigured: Boolean(body.walletPassword || scheduler.walletPasswordConfigured), message: '模拟计划状态', round: {batchIndex: 2, batchCount: 3, processedCount: 51, totalCount: 120, issueCount: 1, issues: [{accountId: '<img src=x>', status: 'skipped', message: '<script>alert(1)</script> 状态已变化'}]}, nextRunAt: '2026-10-15T01:00:00Z'};
    return res.end(JSON.stringify(scheduler));
  }
  const files = {'/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css'};
  if (files[path]) {
    res.setHeader('Content-Type', path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    return res.end(await readFile(new URL(files[path], publicRoot)));
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {channel: 'chrome'})});
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await page.locator('#recordsButton + #scheduleHistoryButton').count(), 1);
  await page.getByRole('button', {name: '计划执行历史', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('#cryptoScheduleHistoryList').textContent.includes('UND_ERR_SOCKET'));
  assert.equal(await page.locator('#scheduleHistoryDialog').isVisible(), true);
  assert.equal(await page.locator('#settingsDialog #cryptoScheduleHistoryList').count(), 0);
  assert.match(await page.locator('#cryptoScheduleHistoryList').textContent(), /UND_ERR_SOCKET/);
  assert.match(await page.locator('#cryptoScheduleHistoryList').textContent(), /19:47:28/);
  assert.equal(await page.locator('#cryptoScheduleHistoryList script').count(),0);
  assert.equal(await page.locator('#cryptoScheduleHistoryList a').getAttribute('href'),'/execution.html?job=job%261');
  await page.getByRole('button', {name: '关闭计划执行历史', exact: true}).click();
  assert.equal(await page.locator('#scheduleHistoryDialog').isVisible(), false);
  await page.getByRole('button', {name: '设置', exact: true}).click();
  await page.locator('#cryptoScheduleDetails > summary').click();
  assert.equal(await page.locator('#cryptoScheduleAmount').inputValue(), '150');
  assert.equal(await page.locator('#cryptoIntervalMinutes').inputValue(), '30');
  await page.locator('#cryptoSchedulePassword').fill('mock-wallet-secret');
  await page.locator('#saveCryptoScheduleButton').click();
  await page.waitForFunction(() => document.querySelector('#cryptoPasswordState').textContent === '钱包密码已配置');
  assert.equal(requests[0].action, 'save');
  assert.equal(requests[0].confirmAutomaticPurchase, undefined);
  assert.equal(requests[0].walletPassword, 'mock-wallet-secret');
  assert.equal(requests[0].options, undefined);
  assert.equal(await page.locator('#cryptoSchedulePassword').inputValue(), '');
  assert.equal(await page.evaluate(() => JSON.stringify({...localStorage, ...sessionStorage}).includes('mock-wallet-secret')), false);
  await page.locator('#cryptoScheduleType').selectOption('daily');
  assert.equal(await page.locator('#cryptoIntervalField').isVisible(), false);
  await page.locator('#cryptoDailyTimes').fill('09:00, 21:30');
  await page.locator('#saveCryptoScheduleButton').click();
  await page.waitForFunction(() => !document.querySelector('#saveCryptoScheduleButton').disabled);
  assert.deepEqual(requests.at(-1).settings.dailyTimes, ['09:00', '21:30']);
  await page.locator('#cryptoScheduleType').selectOption('hourly');
  await page.locator('#cryptoHourlyMinutes').fill('15, 45');
  const beforeCancel = requests.length;
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#enableCryptoScheduleButton').click();
  assert.equal(requests.length, beforeCancel);
  page.once('dialog', async (dialog) => {
    assert.match(dialog.message(), /持续授权自动付款及 OPOM 写回/);
    await dialog.accept();
  });
  await page.locator('#enableCryptoScheduleButton').click();
  await page.waitForFunction(() => document.querySelector('#cryptoScheduleState').textContent.includes('已启用'));
  assert.equal(requests.at(-1).confirmAutomaticPurchase, true);
  assert.equal(await page.locator('#autoRechargeChannel').textContent(), '虚拟币');
  assert.equal(await page.locator('#autoRechargeEnabled').isChecked(), true);
  assert.match(await page.locator('#autoRechargeSummary').textContent(), /虚拟币计划已启用/);
  assert.deepEqual(requests.at(-1).settings.hourlyMinutes, [15, 45]);
  assert.match(await page.locator('#cryptoScheduleState').textContent(), /51\/120/);
  assert.equal(await page.locator('#cryptoScheduleIssuesTitle').textContent(), '账号处理说明（1）');
  await page.locator('#cryptoScheduleIssuesTitle').click();
  assert.match(await page.locator('#cryptoScheduleIssuesList').textContent(), /<img src=x>/);
  assert.match(await page.locator('#cryptoScheduleIssuesList').textContent(), /<script>alert\(1\)<\/script>/);
  assert.equal(await page.locator('#cryptoScheduleIssuesList img, #cryptoScheduleIssuesList script').count(), 0);
  assert.match(await page.locator('#cryptoScheduleState').textContent(), /09:00:00/);
  await page.locator('#disableCryptoScheduleButton').click();
  await page.waitForFunction(() => document.querySelector('#cryptoScheduleState').textContent.includes('已暂停'));
  assert.equal(requests.at(-1).action, 'disable');
  assert.equal(requests.at(-1).settings, undefined);
  // Even while the manual page stays on bank cards, reload must show the active crypto plan.
  scheduler = {...scheduler, enabled: true};
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#autoRechargeEnabled').checked);
  assert.equal(await page.locator('#autoRechargeChannel').textContent(), '虚拟币');
  await page.locator('#autoRechargeEnabled + .switch-track').click();
  await page.waitForFunction(() => !document.querySelector('#autoRechargeEnabled').checked);
  assert.equal(requests.at(-1).rechargeMode, 'crypto');
  assert.equal(requests.at(-1).action, 'disable');
  scheduler = initial(); // Simulate server restart: settings exist, password does not.
  await page.reload();
  await page.locator('#settingsButton').click();
  await page.locator('#cryptoScheduleDetails > summary').click();
  assert.match(await page.locator('#cryptoPasswordState').textContent(), /重新输入/);
  assert.equal(await page.locator('#cryptoSchedulePassword').inputValue(), '');
  assert.deepEqual(errors, []);
  console.log('PASS crypto scheduler UI: independent settings, three schedules, authorization, password privacy, progress and restart');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
