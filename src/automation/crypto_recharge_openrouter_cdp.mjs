#!/usr/bin/env node

/**
 * OpenRouter 虚拟币充值执行器。
 *
 * 该文件只负责 OPOM 账号对应的虚拟币充值页面和 OKX Wallet 连接流程，
 * 不包含银行卡、Stripe、Billing Address 或 Auto Top-Up 逻辑。
 */

import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {readCryptoAccountPassword} from './lib/crypto-account-password.mjs';

const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/settings/credits';
const DEFAULT_ADSPOWER_BASE = 'http://127.0.0.1:50325';
const DEFAULT_TIMEOUT_MS = 30000;
const CRYPTO_PURCHASE_FORM_WAIT_MS = 20000;
const POLL_MS = 750;
const COINBASE_WALLET_UI_TIMEOUT_MS = 5000;
const COINBASE_WALLET_UI_POLL_MS = 100;
const COINBASE_FAILURE_STABLE_MS = 3000;
const OKX_EXTENSION_ID = 'mcohilncbfahbmgdjkbpemcciiolgcge';
// 业务约定：所有充值账号共用同一个 OKX 钱包，不按 OpenRouter 账号创建不同钱包。
// Import wallet 欢迎页只说明当前浏览器尚未配置钱包，不能据此断言钱包从未登录；禁止覆盖已有钱包。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let messageId = 0;

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (['stdin', 'verbose'].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw new Error('Missing value for --' + key);
    args[key] = value;
    index += 1;
  }
  return args;
}

function readInput(args) {
  let input = {};
  if (args.stdin) {
    const raw = readFileSync(0, 'utf8').trim();
    if (raw) {
      try {
        input = JSON.parse(raw);
      } catch {
        // JSON 解析异常可能包含原始输入片段，不能把助记词回显到子进程 stderr。
        throw new Error('Invalid crypto runner input JSON');
      }
    }
  }
  return {
    ...input,
    profileNo: args['profile-no'] || input.profileNo || '',
    profileId: args['profile-id'] || input.profileId || '',
    debugPort: args['debug-port'] || input.debugPort || '',
    browserWs: args['browser-ws'] || input.browserWs || '',
    expectedAccount: args['expected-account'] || input.expectedAccount || '',
    adspowerApiBase: input.adspowerApiBase || process.env.ADSPOWER_API_BASE || DEFAULT_ADSPOWER_BASE,
    adspowerApiKey: input.adspowerApiKey || process.env.ADSPOWER_API_KEY || '',
    adspowerStartTimeoutMs: Number(input.adspowerStartTimeoutMs || DEFAULT_TIMEOUT_MS),
    confirmationDebugDir: input.confirmationDebugDir || '',
    walletSeedPhrase: input.walletSeedPhrase || '',
    walletPassword: input.walletPassword || '',
    // 当前任务已授权钱包连接；只有显式传 false 才保留 Connect 人工确认，付款/签名仍不自动提交。
    confirmWalletConnection: input.confirmWalletConnection !== false,
    purchase: {...(input.purchase || {})},
    verbose: !!(args.verbose || input.verbose),
  };
}

function validateInput(input) {
  if (!input.expectedAccount) throw new Error('expectedAccount is required');
  if (!input.debugPort && !input.browserWs && !input.profileNo && !input.profileId) {
    throw new Error('Provide debugPort/browserWs or profileNo/profileId');
  }
  const rule = input.purchase?.rule || {};
  if (!input.purchase?.amount && !(rule.threshold && rule.belowAmountConfigured)) {
    throw new Error('Crypto purchase requires a fixed amount or a complete balance rule');
  }
  if (input.walletSeedPhrase && !/^[a-z]+(?: [a-z]+){11}$/i.test(input.walletSeedPhrase)) {
    throw new Error('manual_security_blocker: crypto_wallet_import_phrase_invalid');
  }
}

function redact(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[account]')
    .slice(0, 1200);
}

function writeDiagnostic(dir, name, data) {
  if (!dir) return;
  mkdirSync(dir, {recursive: true});
  const safeName = String(name || 'crypto-step').replace(/[^a-z0-9._-]+/gi, '-');
  writeFileSync(dir + '/' + safeName + '.json', JSON.stringify(data, null, 2), 'utf8');
}

function headers(apiKey) {
  const output = {'Content-Type': 'application/json'};
  if (apiKey) output.Authorization = 'Bearer ' + apiKey;
  return output;
}

async function requestJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {...options, signal: controller.signal});
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + text.slice(0, 300));
    if (typeof body.code === 'number' && body.code !== 0) {
      throw new Error('AdsPower code ' + body.code + ': ' + (body.msg || 'unknown error'));
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeEndpoint(data) {
  const ws = data?.data?.ws?.puppeteer
    || data?.data?.ws?.puppeteer_url
    || data?.data?.ws
    || data?.ws?.puppeteer
    || data?.ws?.puppeteer_url
    || data?.ws
    || '';
  const debugPort = data?.data?.debug_port
    || data?.data?.debugPort
    || data?.debug_port
    || data?.debugPort
    || (String(ws).match(/127\.0\.0\.1:(\d+)/) || [])[1]
    || '';
  const webdriver = data?.data?.webdriver || data?.webdriver || '';
  const browserAppPath = String(webdriver || '').replace(
    /\/chromedriver\.app\/Contents\/MacOS\/chromedriver$/i,
    '/SunBrowser.app',
  );
  return {
    browserWs: typeof ws === 'string' ? ws : '',
    debugPort: String(debugPort || ''),
    browserAppPath: browserAppPath.endsWith('/SunBrowser.app') ? browserAppPath : '',
  };
}

function curlJson(url, timeoutSeconds = 3) {
  const raw = execFileSync('curl', ['-sS', '--max-time', String(timeoutSeconds), url], {encoding: 'utf8'});
  return JSON.parse(raw);
}

function getTargets(debugPort) {
  return curlJson('http://127.0.0.1:' + debugPort + '/json/list', 5);
}

function getBrowserWs(debugPort) {
  return curlJson('http://127.0.0.1:' + debugPort + '/json/version', 5).webSocketDebuggerUrl || '';
}

function debugPortFromWs(wsUrl) {
  return (String(wsUrl || '').match(/127\.0\.0\.1:(\d+)/) || [])[1] || '';
}

async function waitForDebugEndpoint(input) {
  input.debugPort ||= debugPortFromWs(input.browserWs);
  const deadline = Date.now() + input.adspowerStartTimeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      input.browserWs ||= getBrowserWs(input.debugPort);
      const targets = getTargets(input.debugPort);
      if (Array.isArray(targets)) return {ready: true, targetCount: targets.length};
    } catch (error) {
      lastError = error.message;
    }
    await sleep(800);
  }
  return {ready: false, reason: lastError || 'debug endpoint did not become ready'};
}

async function startProfile(input) {
  if (input.debugPort || input.browserWs) {
    const ready = await waitForDebugEndpoint(input);
    if (ready.ready) return {...input, launch: {source: 'provided-endpoint', ready}};
    input.debugPort = '';
    input.browserWs = '';
  }

  const payload = {last_opened_tabs: '0', proxy_detection: '0', password_filling: '0', password_saving: '0'};
  if (input.profileId) payload.profile_id = input.profileId;
  if (input.profileNo) payload.profile_no = input.profileNo;
  const attempts = [
    {
      name: 'v2 browser-profile/start',
      run: () => requestJson(input.adspowerApiBase + '/api/v2/browser-profile/start', {
        method: 'POST', headers: headers(input.adspowerApiKey), body: JSON.stringify(payload),
      }),
    },
    {
      name: 'v1 browser/start',
      run: () => {
        const params = new URLSearchParams();
        if (input.profileId) params.set('user_id', input.profileId);
        if (input.profileNo) params.set('serial_number', input.profileNo);
        return requestJson(input.adspowerApiBase + '/api/v1/browser/start?' + params.toString(), {headers: headers(input.adspowerApiKey)});
      },
    },
  ];
  const failures = [];
  for (const attempt of attempts) {
    try {
      const endpoint = normalizeEndpoint(await attempt.run());
      input.browserWs = endpoint.browserWs || input.browserWs;
      input.debugPort = endpoint.debugPort || input.debugPort;
      input.browserAppPath = endpoint.browserAppPath || input.browserAppPath || '';
      const ready = await waitForDebugEndpoint(input);
      if (ready.ready) return {...input, launch: {source: attempt.name, ready}};
      failures.push(attempt.name + ': ' + ready.reason);
    } catch (error) {
      failures.push(attempt.name + ': ' + error.message);
    }
  }
  throw new Error('Could not start AdsPower profile: ' + failures.join(' | '));
}

function cdp(wsUrl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const timer = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}, commandTimeoutMs = timeoutMs) {
          const message = {id: ++messageId, method, params};
          ws.send(JSON.stringify(message));
          return new Promise((res, rej) => {
            const commandTimer = setTimeout(() => {
              pending.delete(message.id);
              rej(new Error('CDP command timeout: ' + method));
            }, commandTimeoutMs);
            pending.set(message.id, {res, rej, method, commandTimer});
          });
        },
        close() {
          try { ws.close(); } catch {}
        },
      });
    };
    ws.onerror = () => reject(new Error('CDP websocket error'));
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.commandTimer);
      if (message.error) item.rej(new Error(item.method + ': ' + JSON.stringify(message.error)));
      else item.res(message.result);
    };
  });
}

function functionExpression(fn, args) {
  return '(' + fn.toString() + ')(' + args.map((value) => JSON.stringify(value)).join(',') + ')';
}

async function evaluate(client, fn, ...args) {
  const expression = typeof fn === 'function' ? functionExpression(fn, args) : String(fn);
  const result = await client.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  if (result.exceptionDetails) throw new Error('Runtime.evaluate failed');
  return result.result.value;
}

async function dispatchKey(client, type, params = {}) {
  return client.send('Input.dispatchKeyEvent', {type, ...params}, 5000);
}

async function typeCharacters(client, value, delayMs = 0) {
  for (const char of String(value)) {
    const key = /^[0-9]$/.test(char)
      ? {key: char, code: 'Digit' + char, windowsVirtualKeyCode: char.charCodeAt(0)}
      : char === '.' ? {key: char, code: 'Period', windowsVirtualKeyCode: 190} : {key: char};
    // 文本只能由 char 写入一次；keyDown 携带 text 再发送 char 会把 150 输入成 115500。
    await dispatchKey(client, 'rawKeyDown', key);
    await dispatchKey(client, 'char', {...key, text: char, unmodifiedText: char});
    await dispatchKey(client, 'keyUp', key);
    if (delayMs > 0) await sleep(delayMs);
  }
}

async function clearFocusedInput(client, length) {
  // 数字输入框先把光标移到末尾，再逐次 Backspace，避免依赖系统全选快捷键。
  await dispatchKey(client, 'rawKeyDown', {key: 'End', code: 'End', windowsVirtualKeyCode: 35});
  await dispatchKey(client, 'keyUp', {key: 'End', code: 'End', windowsVirtualKeyCode: 35});
  for (let index = 0; index < Math.max(1, Number(length || 0) + 2); index += 1) {
    await dispatchKey(client, 'rawKeyDown', {key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8});
    await dispatchKey(client, 'keyUp', {key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8});
  }
}

async function navigate(client, url) {
  await client.send('Page.enable').catch(() => {});
  await client.send('Page.navigate', {url}, DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await evaluate(client, () => ({href: location.href, readyState: document.readyState})).catch(() => ({}));
    if (String(state.href || '').startsWith(url) && ['interactive', 'complete'].includes(state.readyState)) return state;
    await sleep(POLL_MS);
  }
  throw new Error('Credits navigation ready timeout');
}

async function ensureCreditsPage(input) {
  input.browserWs ||= getBrowserWs(input.debugPort);
  let targets = getTargets(input.debugPort);
  let target = targets.find((item) => item.type === 'page' && String(item.url || '').startsWith(OPENROUTER_CREDITS_URL));
  if (!target) {
    const existing = targets.find((item) => item.type === 'page' && /^https?:/i.test(item.url || ''));
    if (existing) {
      const client = await cdp(existing.webSocketDebuggerUrl);
      try { await navigate(client, OPENROUTER_CREDITS_URL); } finally { client.close(); }
    } else {
      const browser = await cdp(input.browserWs);
      try { await browser.send('Target.createTarget', {url: OPENROUTER_CREDITS_URL}); } finally { browser.close(); }
    }
    await sleep(1500);
    targets = getTargets(input.debugPort);
    target = targets.find((item) => item.type === 'page' && String(item.url || '').startsWith(OPENROUTER_CREDITS_URL));
  }
  if (!target?.webSocketDebuggerUrl) throw new Error('OpenRouter Credits page target not found');
  const page = await cdp(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await navigate(page, OPENROUTER_CREDITS_URL);
  return page;
}

async function waitForAccount(page, expectedAccount) {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  let state = null;
  while (Date.now() < deadline) {
    state = await evaluate(page, () => {
      const text = document.body?.innerText || '';
      const accounts = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
      return {
        account: accounts[0] || '',
        signin: /Sign in|Continue with Google|Log in/i.test(text),
        hasCredits: /Credits|Buy Credits|Use crypto/i.test(text),
        tail: text.slice(-1800),
      };
    });
    if (state.signin) throw new Error('login_required: OpenRouter Credits page is not logged in');
    if (state.account && state.hasCredits) break;
    await sleep(POLL_MS);
  }
  if (!state?.account) throw new Error('login_required: account email was not found on Credits page');
  if (state.account.toLowerCase() !== String(expectedAccount).toLowerCase()) {
    throw new Error('OpenRouter account mismatch: expected ' + expectedAccount + ', got ' + state.account);
  }
  return state;
}

function money(value) {
  const cleaned = String(value ?? '').replace(/[$,\s]/g, '');
  const number = Number(cleaned);
  if (!Number.isFinite(number) || number <= 0) return '';
  return String(Math.round(number * 100) / 100);
}

async function readBalance(page) {
  const deadline = Date.now() + 20000;
  let state = null;
  while (Date.now() < deadline) {
    state = await evaluate(page, () => {
      const text = (document.body?.innerText || '').replace(/\u00a0/g, ' ');
      const match = text.match(/TOTAL AVAILABLE[\s\S]{0,120}?\$\s*([-+]?\s*[0-9][\d,]*(?:\.\d+)?)/i)
        || text.match(/Total available credits[\s\S]{0,120}?\$\s*([-+]?\s*[0-9][\d,]*(?:\.\d+)?)/i);
      return {raw: match?.[1] || '', tail: text.slice(-1800)};
    });
    const value = Number(String(state.raw || '').replace(/[,$\s]/g, ''));
    if (Number.isFinite(value)) return {balance: value, raw: state.raw};
    await sleep(POLL_MS);
  }
  throw new Error('Could not parse current OpenRouter credit balance');
}

export async function resolveAmount(page, purchase) {
  const beforeBalance = await readBalance(page);
  const rule = purchase?.rule || {};
  if (rule.enabled) {
    const threshold = Number(rule.threshold);
    const belowAmount = money(rule.belowAmount);
    const atOrAboveAmount = money(rule.atOrAboveAmount);
    const branch = beforeBalance.balance < threshold ? 'below_threshold' : 'at_or_above_threshold';
    const amount = branch === 'below_threshold' ? belowAmount : atOrAboveAmount;
    return {
      amount,
      skippedByRule: !amount,
      beforeBalance,
      ruleDecision: {threshold, belowAmount, atOrAboveAmount, balance: beforeBalance.balance, branch, selectedAmount: amount},
    };
  }
  const amount = money(purchase?.amount);
  if (!amount) throw new Error('Crypto purchase amount is required');
  return {amount, skippedByRule: false, beforeBalance, ruleDecision: null};
}

async function inspectCryptoPurchaseForm(page) {
  return evaluate(page, () => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const amountInput = inputs.find((node) => node.type === 'number' && /Amount/i.test([
      node.getAttribute('aria-label'),
      node.closest('label')?.innerText,
      node.parentElement?.innerText,
    ].filter(Boolean).join(' '))) || inputs.find((node) => node.type === 'number');
    const purchaseButton = [...document.querySelectorAll('button,[role="button"]')]
      .find((node) => visible(node) && /^Purchase$/i.test((node.innerText || node.textContent || '').trim()));
    return {
      amountInputVisible: !!amountInput,
      purchaseButtonVisible: !!purchaseButton,
      purchaseButtonEnabled: !!purchaseButton && !purchaseButton.disabled && purchaseButton.getAttribute('aria-disabled') !== 'true',
      tail: (document.body?.innerText || '').slice(-1800),
    };
  });
}

async function waitForCryptoPurchaseForm(page, timeoutMs = CRYPTO_PURCHASE_FORM_WAIT_MS) {
  // Use crypto 会触发 Credits 卡片异步刷新；最多等待 20 秒，金额框和 Purchase 同时出现后才允许输入。
  const deadline = Date.now() + timeoutMs;
  let lastState = {};
  while (Date.now() < deadline) {
    lastState = await inspectCryptoPurchaseForm(page);
    if (lastState.amountInputVisible && lastState.purchaseButtonVisible) {
      return {...lastState, waitedMs: timeoutMs - Math.max(0, deadline - Date.now())};
    }
    await sleep(200);
  }
  throw new Error(`Crypto purchase form did not become ready within ${timeoutMs}ms: ` + (lastState.tail || ''));
}

export async function fillAmount(page, amount) {
  const target = await evaluate(page, () => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !node.disabled;
    };
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const input = inputs.find((node) => node.type === 'number' && /Amount/i.test([node.getAttribute('aria-label'), node.closest('label')?.innerText, node.parentElement?.innerText].filter(Boolean).join(' ')))
      || inputs.find((node) => node.type === 'number');
    if (!input) return {found: false};
    input.setAttribute('data-crypto-amount-target', 'true');
    input.scrollIntoView({block: 'center'});
    input.focus();
    return {found: true, before: input.value || '', focused: document.activeElement === input};
  });
  if (!target.found || !target.focused) throw new Error('Crypto amount input not found or not focused');
  await clearFocusedInput(page, target.before.length);
  // 必须先证实旧金额清空，失败就停止，不能继续把新金额拼到旧值后面。
  const cleared = await evaluate(page, () => {
    const input = document.querySelector('[data-crypto-amount-target]');
    return !!input && input.value === '' && document.activeElement === input;
  });
  if (!cleared) throw new Error('Crypto amount input did not retain empty value before typing');
  await typeCharacters(page, amount);
  await dispatchKey(page, 'rawKeyDown', {key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
  await dispatchKey(page, 'keyUp', {key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
  const state = await evaluate(page, (expected) => {
    const input = document.querySelector('[data-crypto-amount-target]');
    const actual = input?.value || '';
    input?.removeAttribute('data-crypto-amount-target');
    const purchaseReady = [...document.querySelectorAll('button,[role="button"]')].some((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !node.disabled && node.getAttribute('aria-disabled') !== 'true'
        && /^Purchase$/i.test((node.innerText || node.textContent || '').trim());
    });
    return {actual, blurred: document.activeElement !== input, retained: !!input && actual !== '' && Number(actual) === Number(expected), purchaseReady};
  }, amount);
  if (!state.retained || !state.blurred || !state.purchaseReady) throw new Error('Crypto amount input did not retain ' + amount);
  return state;
}

async function ensureUseCrypto(page) {
  const inspect = () => evaluate(page, () => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const controls = [...document.querySelectorAll('[role="switch"],button[aria-checked],input[type="checkbox"]')].filter(visible);
    const control = controls.find((node) => /Use crypto|Pay with crypto/i.test([
      node.getAttribute('aria-label'), node.closest('label')?.innerText,
      node.parentElement?.innerText, node.closest('section,article,form,div')?.innerText,
    ].filter(Boolean).join(' ')));
    if (!control) return {found: false, enabled: false};
    const enabled = control.matches('input[type="checkbox"]')
      ? !!control.checked
      : (control.getAttribute('aria-checked') === 'true' || control.getAttribute('data-state') === 'checked');
    return {found: true, enabled};
  });
  let state = await inspect();
  if (!state.found) throw new Error('Use crypto switch not found');
  if (state.enabled) return {changed: false};
  const clicked = await evaluate(page, () => {
    const controls = [...document.querySelectorAll('[role="switch"],button[aria-checked],input[type="checkbox"]')];
    const control = controls.find((node) => /Use crypto|Pay with crypto/i.test([
      node.getAttribute('aria-label'), node.closest('label')?.innerText,
      node.parentElement?.innerText, node.closest('section,article,form,div')?.innerText,
    ].filter(Boolean).join(' ')));
    if (!control) return false;
    control.click();
    return true;
  });
  if (!clicked) throw new Error('Use crypto switch could not be clicked');
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    state = await inspect();
    if (state.enabled) return {changed: true};
    await sleep(500);
  }
  throw new Error('Use crypto switch did not become enabled');
}

async function clickPurchase(page) {
  const clicked = await evaluate(page, () => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const button = [...document.querySelectorAll('button,[role="button"]')]
      .find((node) => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true' && /^Purchase$/i.test((node.innerText || node.textContent || '').trim()));
    if (!button) return {clicked: false, tail: (document.body?.innerText || '').slice(-1800)};
    button.scrollIntoView({block: 'center'});
    button.click();
    return {clicked: true};
  });
  if (!clicked.clicked) throw new Error('Crypto Purchase button not clickable: ' + (clicked.tail || ''));
  await sleep(2000);
  return clicked;
}

export async function fillCryptoVerificationPassword(input, page, passwordReader = readCryptoAccountPassword) {
  // 仅在 OpenRouter Credits 的指定确认弹窗填写；登录、验证码、MFA 与钱包签名不在此流程内。
  const target = await evaluate(page, (expectedAccount) => {
    if (location.origin !== 'https://openrouter.ai' || location.pathname !== '/settings/credits') return null;
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const accountText = document.body?.innerText || '';
    const emails = accountText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}/ig) || [];
    if (!emails.some((email) => email.toLowerCase() === String(expectedAccount).toLowerCase())) return null;
    const dialogs = [...document.querySelectorAll('[role="dialog"],dialog')].filter(visible);
    const dialog = dialogs.find((node) => /Verification required/i.test(node.innerText || '')
      && /Enter your current password/i.test(node.innerText || ''));
    const field = dialog && [...dialog.querySelectorAll('input[type="password"]')].find((node) => visible(node) && !node.disabled);
    if (!field) return null;
    field.setAttribute('data-crypto-password-target', 'true');
    field.focus();
    return {length: field.value.length, focused: document.activeElement === field};
  }, input.expectedAccount);
  if (!target?.focused) throw new Error('manual_security_blocker: crypto_password_identity_unverified');
  let password = '';
  try {
    password = await passwordReader(input, input);
    await clearFocusedInput(page, target.length);
    const cleared = await evaluate(page, () => {
      const field = document.querySelector('[data-crypto-password-target]');
      return !!field && field.value === '' && document.activeElement === field;
    });
    if (!cleared) throw new Error();
    await typeCharacters(page, password);
    await dispatchKey(page, 'rawKeyDown', {key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
    await dispatchKey(page, 'keyUp', {key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
    const filled = await evaluate(page, (expectedLength) => {
      const field = document.querySelector('[data-crypto-password-target]');
      return !!field && field.value.length === expectedLength && document.activeElement !== field;
    }, password.length);
    if (!filled) throw new Error();
    return {filled: true};
  } catch {
    // 错误、键盘事件和字段值均不可回显；保留现场人工处理，不猜测或重试其他密码。
    throw new Error('manual_security_blocker: crypto_password_fill_failed');
  } finally {
    password = '';
    await evaluate(page, () => document.querySelector('[data-crypto-password-target]')?.removeAttribute('data-crypto-password-target')).catch(() => {});
  }
}

export async function continueCryptoVerification(page) {
  // 只点击当前密码确认弹窗中的 Continue，不点击钱包确认或其他验证方式。
  const clicked = await evaluate(page, () => {
    if (location.origin !== 'https://openrouter.ai' || location.pathname !== '/settings/credits') return false;
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const dialog = [...document.querySelectorAll('[role="dialog"],dialog')].find((node) => visible(node)
      && /Verification required/i.test(node.innerText || '') && /Enter your current password/i.test(node.innerText || ''));
    const button = dialog && [...dialog.querySelectorAll('button')].find((node) => visible(node)
      && !node.disabled && node.getAttribute('aria-disabled') !== 'true'
      && /^Continue$/i.test((node.innerText || node.textContent || '').trim()));
    if (!button) return false;
    button.click();
    return true;
  });
  if (!clicked) throw new Error('manual_security_blocker: crypto_password_continue_unavailable');
  return {clicked: true};
}

export async function cryptoPasswordRejected(page) {
  // 只识别当前 Credits 密码弹窗的错误提示；不读取密码字段，也不把弹窗正文写入日志。
  return evaluate(page, () => {
    if (location.origin !== 'https://openrouter.ai' || location.pathname !== '/settings/credits') return false;
    const dialog = [...document.querySelectorAll('[role="dialog"],dialog')].find((node) => {
      const rect = node.getBoundingClientRect();
      const text = node.innerText || '';
      return rect.width > 0 && rect.height > 0
        && /Verification required/i.test(text) && /Enter your current password/i.test(text);
    });
    return !!dialog && /Invalid credentials|Incorrect password/i.test(dialog.innerText || '');
  });
}

async function openCheckout(input, page) {
  let deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  let verificationSubmitted = false;
  let lastTargets = [];
  while (Date.now() < deadline) {
    if (await cryptoPasswordRejected(page).catch(() => false)) {
      throw new Error('manual_security_blocker: crypto_password_invalid_credentials');
    }
    const verification = await evaluate(page, () => {
      const text = document.body?.innerText || '';
      return /Verification required/i.test(text) && /Enter your current password/i.test(text);
    }).catch(() => false);
    if (verification && !verificationSubmitted) {
      await fillCryptoVerificationPassword(input, page);
      await continueCryptoVerification(page);
      verificationSubmitted = true;
      // 密码只提交一次；留出独立跳转等待时间，失败或出现其他验证时交给人工。
      deadline = Date.now() + DEFAULT_TIMEOUT_MS;
      if (await cryptoPasswordRejected(page).catch(() => false)) {
        throw new Error('manual_security_blocker: crypto_password_invalid_credentials');
      }
    }
    // 弹窗未消失前不能接受可能属于上一次操作的 Coinbase 标签，更不能重新填密码。
    if (verification && verificationSubmitted) {
      await sleep(POLL_MS);
      continue;
    }
    const targets = getTargets(input.debugPort);
    lastTargets = targets.filter((target) => target.type === 'page').map((target) => ({title: target.title || '', url: String(target.url || '').split('?')[0]}));
    const target = targets.find((item) => item.type === 'page' && /payments\.coinbase\.com\/payment-sessions\//i.test(item.url || ''));
    if (target?.webSocketDebuggerUrl) {
      const checkout = await cdp(target.webSocketDebuggerUrl);
      await checkout.send('Runtime.enable');
      return {checkout, target};
    }
    await sleep(POLL_MS);
  }
  if (verificationSubmitted) throw new Error('manual_security_blocker: crypto_password_verification_pending');
  throw new Error('Coinbase crypto checkout target not found: ' + JSON.stringify(lastTargets));
}

async function selectOkxWallet(checkout) {
  const deadline = Date.now() + COINBASE_WALLET_UI_TIMEOUT_MS;
  let selectionClicked = false;
  while (Date.now() < deadline) {
    const controls = await evaluate(checkout, () => {
      if (location.origin !== 'https://payments.coinbase.com') return {};
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const center = (node) => {
        node.scrollIntoView({block: 'center', inline: 'center'});
        const rect = node.getBoundingClientRect();
        return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
      };
      const launch = [...document.querySelectorAll('button,[role="button"],a')]
        .find((node) => visible(node) && /^Launch extension$/i.test((node.innerText || node.textContent || '').trim()));
      if (launch) return {launch: center(launch)};
      const candidates = [...document.querySelectorAll('button,[role="button"],a,li,label')]
        .filter(visible)
        .map((node) => ({node, text: (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim()}));
      const item = candidates.find((entry) => entry.text === 'OKX Wallet')
        || candidates.find((entry) => /^OKX Wallet(?:\s+OKX Wallet)?(?:\s+Recent)?$/i.test(entry.text));
      return item ? {wallet: center(item.node)} : {};
    });
    if (controls.launch) {
      return {selected: true, launchReady: true, selectionClicked};
    }
    if (!selectionClicked && controls.wallet) {
      await checkout.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: controls.wallet.x, y: controls.wallet.y});
      await checkout.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: controls.wallet.x, y: controls.wallet.y, button: 'left', clickCount: 1});
      await checkout.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: controls.wallet.x, y: controls.wallet.y, button: 'left', clickCount: 1});
      selectionClicked = true;
    }
    await sleep(COINBASE_WALLET_UI_POLL_MS);
  }
  throw new Error('OKX Wallet or Launch extension was not available within 5000ms');
}

function interactiveOkxTargets(debugPort) {
  const extensionRoot = 'chrome-extension://' + OKX_EXTENSION_ID + '/';
  return getTargets(debugPort).filter((target) =>
    ['page', 'other', 'iframe'].includes(target.type)
    && String(target.url || '').startsWith(extensionRoot)
    && !/(?:^|\/)(?:ses-)?sandbox\.html(?:\?|#|$)|(?:^|\/)offscreen\.html(?:\?|#|$)/i.test(String(target.url || ''))
    && target.webSocketDebuggerUrl);
}

function okxTargetSummary(debugPort) {
  const extensionRoot = 'chrome-extension://' + OKX_EXTENSION_ID + '/';
  return getTargets(debugPort)
    .filter((target) => String(target.url || '').startsWith(extensionRoot))
    .map((target) => ({
      type: target.type || '',
      url: String(target.url || '').split('?')[0],
      hasWebSocket: !!target.webSocketDebuggerUrl,
    }));
}

async function launchOkxExtension(checkout, input = {}) {
  // Coinbase 的扩展启动需要真实用户手势；这里只建立连接，绝不点击钱包里的确认、签名或广播按钮。
  let browserActivated = false;
  if (process.platform === 'darwin' && input.browserAppPath) {
    try {
      execFileSync('open', [input.browserAppPath], {stdio: 'ignore'});
      browserActivated = true;
      await sleep(150);
    } catch {}
  }
  await checkout.send('Page.bringToFront').catch(() => {});
  const deadline = Date.now() + COINBASE_WALLET_UI_TIMEOUT_MS;
  let target = null;
  while (!target && Date.now() < deadline) {
    target = await evaluate(checkout, () => {
      if (location.origin !== 'https://payments.coinbase.com') return null;
      const button = [...document.querySelectorAll('button,[role="button"],a')]
        .find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0
            && /^Launch extension$/i.test((node.innerText || node.textContent || '').trim());
        });
      if (!button) return null;
      button.scrollIntoView({block: 'center', inline: 'center'});
      const rect = button.getBoundingClientRect();
      return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    });
    if (!target) await sleep(COINBASE_WALLET_UI_POLL_MS);
  }
  if (!target) throw new Error('Launch extension button not clickable');
  await checkout.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: target.x, y: target.y});
  await checkout.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1});
  await checkout.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1});
  const firstDeadline = Date.now() + 800;
  while (Date.now() < firstDeadline) {
    const targets = interactiveOkxTargets(input.debugPort);
    if (targets.length) return {clicked: true, browserActivated, fallbackClicked: false, targetCount: targets.length};
    await sleep(COINBASE_WALLET_UI_POLL_MS);
  }
  // 部分 Chrome 版本只把键盘激活识别成扩展启动的真实用户手势。
  const focused = await evaluate(checkout, () => {
    const button = [...document.querySelectorAll('button,[role="button"],a')]
      .find((node) => /^Launch extension$/i.test((node.innerText || node.textContent || '').trim()));
    button?.focus();
    return document.activeElement === button;
  });
  if (focused) {
    await dispatchKey(checkout, 'rawKeyDown', {key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13});
    await dispatchKey(checkout, 'keyUp', {key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13});
    const keyboardDeadline = Date.now() + 800;
    while (Date.now() < keyboardDeadline) {
      const targets = interactiveOkxTargets(input.debugPort);
      if (targets.length) return {clicked: true, browserActivated, keyboardClicked: true, fallbackClicked: false, targetCount: targets.length};
      await sleep(COINBASE_WALLET_UI_POLL_MS);
    }
  }
  // 某些 AdsPower/Chrome 版本只响应 Coinbase 自己的 click handler；只兜底一次，不触碰付款按钮。
  const fallbackClicked = await evaluate(checkout, () => {
    const button = [...document.querySelectorAll('button,[role="button"],a')]
      .find((node) => /^Launch extension$/i.test((node.innerText || node.textContent || '').trim()));
    if (!button) return false;
    button.click();
    return true;
  });
  const fallbackDeadline = Date.now() + COINBASE_WALLET_UI_TIMEOUT_MS;
  while (Date.now() < fallbackDeadline) {
    const targets = interactiveOkxTargets(input.debugPort);
    if (targets.length) return {clicked: true, browserActivated, fallbackClicked, targetCount: targets.length};
    await sleep(COINBASE_WALLET_UI_POLL_MS);
  }
  writeDiagnostic(input.confirmationDebugDir, 'crypto-wallet-launch-failed', {
    focused,
    browserActivated,
    fallbackClicked,
    targets: okxTargetSummary(input.debugPort),
  });
  throw new Error('OKX extension did not open after Launch extension click');
}

async function readCheckoutState(checkout) {
  const deadline = Date.now() + 10000;
  let state = null;
  let paymentFailureSeenAt = 0;
  while (Date.now() < deadline) {
    state = await evaluate(checkout, () => {
      const text = document.body?.innerText || '';
      const match = text.match(/You need\s+([0-9,.]+)\s+([A-Z0-9_]+)\s+to complete your payment/i);
      return {
        insufficientFunds: /Insufficient funds/i.test(text),
        paymentFailed: /Try again/i.test(text),
        walletConnected: /OKX Wallet connected/i.test(text),
        paymentCompleted: /Payment complete|Payment successful|Paid successfully/i.test(text),
        requiredAmount: match?.[1] || '',
        requiredAsset: match?.[2] || '',
        tail: text.slice(-1800),
      };
    });
    if (state.paymentFailed) {
      paymentFailureSeenAt ||= Date.now();
      if (Date.now() - paymentFailureSeenAt >= COINBASE_FAILURE_STABLE_MS) return state;
    } else {
      paymentFailureSeenAt = 0;
      if (state.insufficientFunds || state.walletConnected || state.paymentCompleted) return state;
    }
    await sleep(500);
  }
  return state || {};
}

export async function inspectWalletStage(wallet) {
  return evaluate(wallet, (extensionId) => {
    if (location.origin !== 'chrome-extension://' + extensionId) return {stage: 'unknown'};
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const text = document.body?.innerText || '';
    const route = (location.hash || '').split('?')[0];
    const buttons = [...document.querySelectorAll('button,[role="button"]')]
      .filter(visible).map((node) => (node.innerText || node.textContent || '').trim());
    const fields = [...document.querySelectorAll('input,textarea')]
      .filter((node) => visible(node) && !node.disabled && !['hidden', 'checkbox', 'radio'].includes(node.type));
    // 只回传阶段、计数与布尔值，不回传页面文本、输入值或助记词。
    // 设置页说明包含 “when unlocking”，不能靠正文子串判断解锁；按路由、字段数量和精确按钮分支。
    const passwordCount = fields.filter((field) => field.type === 'password').length;
    if (route === '#/password-type' && /Set password|Create password/i.test(text)
      && passwordCount === 2 && buttons.some((label) => /^Confirm$/i.test(label))) return {stage: 'password_setup'};
    if (route === '#/password-type' && /Secure your wallet/i.test(text) && passwordCount === 0
      && buttons.some((label) => /^Next$/i.test(label))) return {stage: 'password_choice'};
    if (route === '#/unlock' && passwordCount === 1
      && buttons.some((label) => /^Unlock$/i.test(label))) return {stage: 'unlock'};
    if (/Welcome to OKX Wallet/i.test(text)
      && buttons.some((label) => /^Start your Web3 journey$/i.test(label))) return {stage: 'post_password_welcome'};
    if (/Connect account/i.test(text)
      && buttons.some((label) => /^Connect$/i.test(label))) return {stage: 'connect_request'};
    if (route.startsWith('#/connect/') && /\bConnected\b/i.test(text)) return {stage: 'ready'};
    if (/Transaction|Gas fee|Sign request|Approve payment/i.test(text)) return {stage: 'unknown'};
    // Confirm 在空表单上是 disabled，仍是识别此路由的必要控件。
    if (route === '#/import-with-seed-phrase-and-private-key' && fields.length === 12
      && /Seed phrase or private key/i.test(text)
      && buttons.some((label) => /^Confirm$/i.test(label))) {
      return {stage: 'words', empty: fields.every((field) => !field.value)};
    }
    if (route === '#/initialize-import' && /Seed phrase or private key/i.test(text)
      && /Social login/i.test(text) && /Hardware wallet/i.test(text)) return {stage: 'method'};
    if (route === '#/initialize' && buttons.some((label) => /^Import(?: existing)? wallet$/i.test(label))) return {stage: 'welcome'};
    if (/Assets|Tokens/i.test(text) && buttons.some((label) => /^Send$/i.test(label))
      && buttons.some((label) => /^Receive$/i.test(label))) return {stage: 'ready'};
    return {stage: 'unknown'};
  }, OKX_EXTENSION_ID);
}

async function waitForWalletStage(wallet, allowed, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await inspectWalletStage(wallet);
    if (allowed.includes(state.stage)) return state;
    if (state.stage === 'unlock' || state.stage === 'password_setup') {
      throw new Error('manual_security_blocker: crypto_wallet_import_authentication_required');
    }
    await sleep(400);
  } while (Date.now() < deadline);
  throw new Error('manual_security_blocker: crypto_wallet_import_page_changed');
}

async function clickWalletStep(wallet, stage, label) {
  if ((await inspectWalletStage(wallet)).stage !== stage) {
    throw new Error('manual_security_blocker: crypto_wallet_import_page_changed');
  }
  const target = await evaluate(wallet, (expectedStage, expectedLabelSource, extensionId) => {
    const routes = {
      welcome: '#/initialize',
      method: '#/initialize-import',
      words: '#/import-with-seed-phrase-and-private-key',
      password_choice: '#/password-type',
      post_password_welcome: '#/show-supported-chains',
      unlock: '#/unlock',
      password_setup: '#/password-type',
      connect_request: '#/connect/',
    };
    if (location.origin !== 'chrome-extension://' + extensionId
      || !routes[expectedStage]
      || !String(location.hash || '').startsWith(routes[expectedStage])) return null;
    const expectedLabel = new RegExp(expectedLabelSource, 'i');
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const selectors = ['method', 'password_choice'].includes(expectedStage)
      ? 'button,[role="button"],a,li,div'
      : 'button,[role="button"]';
    const matches = [...document.querySelectorAll(selectors)].filter((node) => {
      const rect = node.getBoundingClientRect();
      const text = normalize(node.innerText || node.textContent);
      return rect.width > 0 && rect.height > 0 && !node.disabled && expectedLabel.test(text);
    }).sort((left, right) => {
      const interactive = (node) => node.matches('button,[role="button"],a,li') ? 0 : 1;
      return interactive(left) - interactive(right)
        || normalize(left.innerText || left.textContent).length - normalize(right.innerText || right.textContent).length;
    });
    if (!matches.length) return null;
    const chosen = matches[0];
    // 导入确认必须是唯一的、已启用的独立控件；不允许把容器内的别的 Confirm 当成钱包批准。
    if (expectedStage === 'words' && (matches.length !== 1
      || normalize(chosen.innerText || chosen.textContent).toLowerCase() !== 'confirm')) return null;
    chosen.scrollIntoView({block: 'center', inline: 'center'});
    const rect = chosen.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  }, stage, label.source, OKX_EXTENSION_ID);
  if (!target) throw new Error('manual_security_blocker: crypto_wallet_import_button_unavailable');
  // OKX 的方式选择项是整行可点击容器，不是标准 button；使用真实鼠标事件避免只聚焦不跳转。
  await wallet.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: target.x, y: target.y});
  await wallet.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1});
  await wallet.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1});
}

export async function importOkxWallet(wallet, phrase, options = {}) {
  const initial = await inspectWalletStage(wallet);
  if (initial.stage === 'ready') return {status: 'ready'};
  if (initial.stage === 'unlock' || initial.stage === 'password_setup') {
    throw new Error('manual_security_blocker: crypto_wallet_import_authentication_required');
  }
  if (!['welcome', 'method', 'words'].includes(initial.stage)) {
    throw new Error('manual_security_blocker: crypto_wallet_import_unknown_page');
  }
  if (!/^[a-z]+(?: [a-z]+){11}$/i.test(phrase || '')) {
    throw new Error('manual_security_blocker: crypto_wallet_import_phrase_missing');
  }
  if (initial.stage === 'words' && !initial.empty) {
    throw new Error('manual_security_blocker: crypto_wallet_import_fields_not_empty');
  }
  if (initial.stage === 'welcome') {
    await clickWalletStep(wallet, 'welcome', /^Import(?: existing)? wallet$/i);
    await waitForWalletStage(wallet, ['method']);
  }
  if (initial.stage !== 'words') {
    await clickWalletStep(wallet, 'method', /^Seed phrase or private key\s+Use 12, 18, or 24-word seed phrases, or private keys/i);
  }
  const wordsPage = await waitForWalletStage(wallet, ['words']);
  if (!wordsPage.empty) throw new Error('manual_security_blocker: crypto_wallet_import_fields_not_empty');

  const words = phrase.split(' ');
  for (let index = 0; index < words.length; index += 1) {
    const fieldTarget = await evaluate(wallet, (fieldIndex, extensionId) => {
      if (location.origin !== 'chrome-extension://' + extensionId
        || location.hash !== '#/import-with-seed-phrase-and-private-key') return null;
      const fields = [...document.querySelectorAll('input,textarea')].filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !node.disabled && !['hidden', 'checkbox', 'radio'].includes(node.type);
      });
      if (fields.length !== 12
        || fields.slice(0, fieldIndex).some((field) => !field.value)
        || !!fields[fieldIndex].value) return null;
      fields[fieldIndex].scrollIntoView({block: 'center', inline: 'center'});
      const rect = fields[fieldIndex].getBoundingClientRect();
      return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    }, index, OKX_EXTENSION_ID);
    if (!fieldTarget) throw new Error('manual_security_blocker: crypto_wallet_import_field_changed');
    // OKX 的输入区位于 SES iframe 中；必须真实点击当前格，再逐字符键入，不能用 DOM focus/value 旁路。
    await wallet.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: fieldTarget.x, y: fieldTarget.y});
    await wallet.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: fieldTarget.x, y: fieldTarget.y, button: 'left', clickCount: 1});
    await wallet.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: fieldTarget.x, y: fieldTarget.y, button: 'left', clickCount: 1});
    const focusReady = async () => evaluate(wallet, (fieldIndex) => {
      const fields = [...document.querySelectorAll('input,textarea')].filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !node.disabled && !['hidden', 'checkbox', 'radio'].includes(node.type);
      });
      return fields.length === 12 && document.activeElement === fields[fieldIndex];
    }, index);
    let focused = false;
    let focusDeadline = Date.now() + 500;
    while (!focused && Date.now() < focusDeadline) {
      focused = await focusReady();
      if (!focused) await sleep(50);
    }
    if (!focused) {
      // OKX SES 首次点击偶尔只激活窗口；第二次点击才把焦点交给输入框。
      await wallet.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: fieldTarget.x, y: fieldTarget.y, button: 'left', clickCount: 1});
      await wallet.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: fieldTarget.x, y: fieldTarget.y, button: 'left', clickCount: 1});
      focusDeadline = Date.now() + 500;
      while (!focused && Date.now() < focusDeadline) {
        focused = await focusReady();
        if (!focused) await sleep(50);
      }
    }
    if (!focused) {
      // 两次真实鼠标点击后仍无焦点时，只用 DOM focus 选择目标格；内容仍全部由真实键盘事件输入。
      focused = await evaluate(wallet, (fieldIndex) => {
        const fields = [...document.querySelectorAll('input,textarea')].filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !node.disabled && !['hidden', 'checkbox', 'radio'].includes(node.type);
        });
        if (fields.length !== 12 || !fields[fieldIndex]) return false;
        fields[fieldIndex].focus();
        return document.activeElement === fields[fieldIndex];
      }, index);
    }
    if (!focused) throw new Error('manual_security_blocker: crypto_wallet_import_field_changed');
    await typeCharacters(wallet, words[index], 12);
    await dispatchKey(wallet, 'rawKeyDown', {key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
    await dispatchKey(wallet, 'keyUp', {key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
    const deadline = Date.now() + 2000;
    let verified = false;
    do {
      verified = await evaluate(wallet, (fieldIndex, length, extensionId) => {
        if (location.origin !== 'chrome-extension://' + extensionId
          || location.hash !== '#/import-with-seed-phrase-and-private-key') return false;
        const fields = [...document.querySelectorAll('input,textarea')].filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !node.disabled && !['hidden', 'checkbox', 'radio'].includes(node.type);
        });
        const nextFocused = fieldIndex === fields.length - 1
          ? document.activeElement !== fields[fieldIndex]
          : document.activeElement === fields[fieldIndex + 1];
        return fields.length === 12 && fields[fieldIndex].value.length === length && nextFocused;
      }, index, words[index].length, OKX_EXTENSION_ID);
      if (!verified) await sleep(50);
    } while (!verified && Date.now() < deadline);
    if (!verified) throw new Error('manual_security_blocker: crypto_wallet_import_field_unverified');
  }
  // 只在仍是导入页、12 格都已输入且 Confirm 可用时提交；导入成功还必须回读钱包主页。
  if ((await inspectWalletStage(wallet)).stage !== 'words') {
    throw new Error('manual_security_blocker: crypto_wallet_import_page_changed');
  }
  const confirmReady = await evaluate(wallet, (extensionId) => {
    if (location.origin !== 'chrome-extension://' + extensionId
      || location.hash !== '#/import-with-seed-phrase-and-private-key') return false;
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && /^Confirm$/i.test((node.innerText || node.textContent || '').trim());
    });
    const fields = [...document.querySelectorAll('input,textarea')].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !node.disabled && !['hidden', 'checkbox', 'radio'].includes(node.type);
    });
    const text = document.body?.innerText || '';
    return buttons.length === 1 && !buttons[0].disabled && fields.length === 12
      && fields.every((field) => !!field.value)
      && !/Incorrect seed phrase|Check and re-enter/i.test(text);
  }, OKX_EXTENSION_ID);
  if (!confirmReady) throw new Error('manual_security_blocker: crypto_wallet_import_confirm_unavailable');
  await clickWalletStep(wallet, 'words', /^Confirm$/i);
  if (options.deferPasswordSetup) {
    const transitionDeadline = Date.now() + 800;
    let stage = 'words';
    while (Date.now() < transitionDeadline) {
      stage = (await inspectWalletStage(wallet).catch(() => ({stage: 'transitioning'}))).stage;
      if (stage !== 'words') return {status: 'password_setup'};
      await sleep(50);
    }
    // SES 偶尔接收鼠标事件但未触发 React handler；仅对已启用的导入 Confirm 兜底一次。
    await evaluate(wallet, () => {
      const button = [...document.querySelectorAll('button,[role="button"]')]
        .find((node) => !node.disabled && /^Confirm$/i.test((node.innerText || node.textContent || '').trim()));
      button?.click();
    });
    return {status: 'password_setup'};
  }
  const nextStage = await waitForWalletStage(wallet, ['ready', 'password_setup'], 20000);
  if (nextStage.stage === 'password_setup') {
    throw new Error('manual_security_blocker: crypto_wallet_import_authentication_required');
  }
  return {status: 'ready'};
}

// 设置密码要求两格，解锁要求一格；只向当前阶段填写，不使用 OpenRouter 账号密码替代 CSV 钱包密码。
export async function completeOkxPasswordSetup(wallet, password, expectedStage = 'password_setup') {
  const normalizedPassword = typeof password === 'string' ? password : '';
  if (!normalizedPassword) throw new Error('manual_security_blocker: crypto_wallet_password_missing');
  if (!['password_setup', 'unlock'].includes(expectedStage)) {
    throw new Error('manual_security_blocker: crypto_wallet_password_page_changed');
  }
  const state = await inspectWalletStage(wallet);
  if (state.stage !== expectedStage) {
    throw new Error('manual_security_blocker: crypto_wallet_password_page_changed');
  }
  const expectedCount = expectedStage === 'password_setup' ? 2 : 1;
  for (let index = 0; index < expectedCount; index += 1) {
    if ((await inspectWalletStage(wallet)).stage !== expectedStage) {
      throw new Error('manual_security_blocker: crypto_wallet_password_page_changed');
    }
    // 每格滚动后重新取坐标，不能提前缓存两格坐标；只回传长度，绝不回传密码。
    const target = await evaluate(wallet, (fieldIndex, count) => {
      const fields = [...document.querySelectorAll('input[type="password"]')].filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !node.disabled;
      });
      if (fields.length !== count) return null;
      const field = fields[fieldIndex];
      field.scrollIntoView({block: 'center', inline: 'center'});
      const rect = field.getBoundingClientRect();
      return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, length: field.value.length};
    }, index, expectedCount);
    if (!target) throw new Error('manual_security_blocker: crypto_wallet_password_fields_unavailable');
    await wallet.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: target.x, y: target.y});
    await wallet.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1});
    await wallet.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1});
    const focusReady = () => evaluate(wallet, (fieldIndex) => {
      const fields = [...document.querySelectorAll('input,textarea')].filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !node.disabled && node.type === 'password';
      });
      return document.activeElement === fields[fieldIndex];
    }, index);
    let focused = false;
    const focusDeadline = Date.now() + 1000;
    do {
      focused = await focusReady();
      if (!focused) await sleep(50);
    } while (!focused && Date.now() < focusDeadline);
    if (!focused) throw new Error('manual_security_blocker: crypto_wallet_password_field_changed');
    await clearFocusedInput(wallet, target.length);
    const cleared = await evaluate(wallet, () => document.activeElement?.type === 'password'
      && document.activeElement.value === '');
    if (!cleared) throw new Error('manual_security_blocker: crypto_wallet_password_unverified');
    await typeCharacters(wallet, normalizedPassword, 12);
    await dispatchKey(wallet, 'rawKeyDown', {key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
    await dispatchKey(wallet, 'keyUp', {key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
    const verified = await evaluate(wallet, (fieldIndex, length) => {
      const fields = [...document.querySelectorAll('input,textarea')].filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !node.disabled && node.type === 'password';
      });
      return fields[fieldIndex]?.value.length === length && document.activeElement !== fields[fieldIndex];
    }, index, normalizedPassword.length);
    if (!verified) throw new Error('manual_security_blocker: crypto_wallet_password_unverified');
  }
  const submitLabel = expectedStage === 'unlock' ? 'Unlock' : 'Confirm';
  const submitted = await evaluate(wallet, (extensionId, count, length, label, stage) => {
    if (location.origin !== 'chrome-extension://' + extensionId) return null;
    const route = (location.hash || '').split('?')[0];
    if (route !== (stage === 'unlock' ? '#/unlock' : '#/password-type')) return null;
    const fields = [...document.querySelectorAll('input[type="password"]')].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !node.disabled;
    });
    if (fields.length !== count || fields.some((field) => field.value.length !== length)
      || (count === 2 && fields[0].value !== fields[1].value)) return null;
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !node.disabled
        && node.getAttribute('aria-disabled') !== 'true'
        && (node.innerText || node.textContent || '').trim() === label;
    });
    if (buttons.length !== 1) return null;
    buttons[0].scrollIntoView({block: 'center', inline: 'center'});
    const rect = buttons[0].getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  }, OKX_EXTENSION_ID, expectedCount, normalizedPassword.length, submitLabel, expectedStage);
  if (!submitted) throw new Error('manual_security_blocker: crypto_wallet_password_submit_unavailable');
  await wallet.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: submitted.x, y: submitted.y});
  await wallet.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: submitted.x, y: submitted.y, button: 'left', clickCount: 1});
  await wallet.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: submitted.x, y: submitted.y, button: 'left', clickCount: 1});
}

async function completeOkxPasswordUnlock(wallet, password) {
  await completeOkxPasswordSetup(wallet, password, 'unlock');
}

async function clickOkxWalletConnect(wallet) {
  const state = await inspectWalletStage(wallet);
  if (state.stage !== 'connect_request') {
    throw new Error('manual_security_blocker: crypto_wallet_connect_page_changed');
  }
  // 连接仅限当前 Coinbase 来源，不把其他 DApp 的 Connect 当作充值流程授权。
  const trusted = await evaluate(wallet, () => {
    const text = document.body?.innerText || '';
    return (location.hash || '').startsWith('#/connect/')
      && /\bCoinbase\b/.test(text)
      && /(?:^|\s)payments\.coinbase\.com(?=\s|$)/.test(text);
  });
  if (!trusted) throw new Error('manual_security_blocker: crypto_wallet_connect_origin_mismatch');
  await clickWalletStep(wallet, 'connect_request', /^Connect$/i);
  return {status: 'connect_submitted'};
}

export async function findOkxWalletTargets(input, listTargets = getTargets, pause = sleep) {
  const extensionRoot = 'chrome-extension://' + OKX_EXTENSION_ID + '/';
  const deadline = Date.now() + 10000;
  do {
    const targets = listTargets(input.debugPort).filter((target) =>
      ['page', 'other', 'iframe'].includes(target.type) && String(target.url || '').startsWith(extensionRoot)
      && !/(?:^|\/)(?:ses-)?sandbox\.html(?:\?|#|$)|(?:^|\/)offscreen\.html(?:\?|#|$)/i.test(String(target.url || ''))
      && target.webSocketDebuggerUrl);
    if (targets.length) return targets;
    await pause(200);
  } while (Date.now() < deadline);
  throw new Error('manual_security_blocker: crypto_wallet_import_target_missing');
}

export function classifyOkxWalletStages(stages) {
  const actionable = stages.flatMap((state, index) =>
    ['welcome', 'method', 'words', 'ready'].includes(state.stage) ? [index] : []);
  if (stages.some((state) => ['unlock', 'password_setup'].includes(state.stage))) {
    return {status: 'authentication_required', index: -1};
  }
  if (actionable.length > 1) return {status: 'ambiguous', index: -1};
  if (actionable.length === 1) return {status: stages[actionable[0]].stage, index: actionable[0]};
  return {status: 'pending', index: -1};
}

async function acquireOkxWalletStage(input, allowed, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastKnownStages = [];
  do {
    const targets = await findOkxWalletTargets(input);
    const clients = [];
    let selectedIndex = -1;
    try {
      for (const target of targets) {
        const wallet = await cdp(target.webSocketDebuggerUrl);
        clients.push(wallet);
        await wallet.send('Runtime.enable');
      }
      const stages = await Promise.all(clients.map((wallet) =>
        inspectWalletStage(wallet).catch(() => ({stage: 'unknown'}))));
      lastKnownStages = stages.map((state) => state.stage);
      writeDiagnostic(input.confirmationDebugDir, 'crypto-wallet-targets', {
        allowed,
        targets: targets.map((target, index) => ({
          type: target.type || '',
          url: String(target.url || '').split('?')[0],
          stage: stages[index]?.stage || 'unknown',
        })),
      });
      const matches = stages.flatMap((state, index) => allowed.includes(state.stage) ? [index] : []);
      if (matches.length > 1) {
        throw new Error('manual_security_blocker: crypto_wallet_import_target_ambiguous');
      }
      if (matches.length === 1) {
        selectedIndex = matches[0];
        const wallet = clients[selectedIndex];
        for (let index = 0; index < clients.length; index += 1) {
          if (index !== selectedIndex) clients[index].close();
        }
        return {wallet, target: targets[selectedIndex], state: stages[selectedIndex]};
      }
      if (stages.some((state) => ['unlock', 'password_setup'].includes(state.stage))) {
        throw new Error('manual_security_blocker: crypto_wallet_import_authentication_required');
      }
    } catch (error) {
      if (/^manual_security_blocker: crypto_wallet_import_/.test(error.message || '')) throw error;
    } finally {
      if (selectedIndex < 0) {
        for (const client of clients) client.close();
      }
    }
    await sleep(200);
  } while (Date.now() < deadline);
  throw new Error('manual_security_blocker: crypto_wallet_import_page_changed:' + lastKnownStages.join(','));
}

export async function prepareOkxWallet(input, adapters = {}) {
  const acquire = adapters.acquireStage || acquireOkxWalletStage;
  let current;
  try {
    // 普通密码页是可执行阶段，不是人工阻断；允许从上一次已完成的页面直接接续。
    let allowed = ['ready', 'unlock', 'welcome', 'method', 'words', 'password_choice', 'password_setup',
      'post_password_welcome', 'connect_request'];
    for (let transition = 0; transition < 8; transition += 1) {
      current = await acquire(input, allowed, 20000);
      const stage = current.state.stage;
      if (stage === 'ready') return {status: 'ready'};
      if (stage === 'connect_request') {
        if (input.confirmWalletConnection === false) return {status: 'connect_required'};
        return await clickOkxWalletConnect(current.wallet);
      }
      if (['unlock', 'password_choice', 'password_setup'].includes(stage) && !input.walletPassword) {
        throw new Error('manual_security_blocker: crypto_wallet_password_missing');
      }
      switch (stage) {
        case 'welcome':
          await clickWalletStep(current.wallet, stage, /^Import(?: existing)? wallet$/i);
          allowed = ['method', 'words'];
          break;
        case 'method':
          await clickWalletStep(current.wallet, stage, /^Seed phrase or private key\s+Use 12, 18, or 24-word seed phrases, or private keys/i);
          allowed = ['words'];
          break;
        case 'words':
          await importOkxWallet(current.wallet, input.walletSeedPhrase, {deferPasswordSetup: true});
          allowed = ['password_choice', 'password_setup', 'post_password_welcome', 'ready', 'connect_request'];
          break;
        case 'password_choice':
          await clickWalletStep(current.wallet, stage, /^Password\s+Create a password to protect your wallet/i);
          await clickWalletStep(current.wallet, stage, /^Next$/i);
          allowed = ['password_setup'];
          break;
        case 'password_setup':
          await completeOkxPasswordSetup(current.wallet, input.walletPassword);
          allowed = ['post_password_welcome', 'ready', 'connect_request'];
          break;
        case 'unlock':
          await completeOkxPasswordUnlock(current.wallet, input.walletPassword);
          allowed = ['ready', 'connect_request'];
          break;
        case 'post_password_welcome':
          await clickWalletStep(current.wallet, stage, /^Start your Web3 journey$/i);
          allowed = ['ready', 'connect_request'];
          break;
        default:
          throw new Error('manual_security_blocker: crypto_wallet_import_unknown_page');
      }
      // OKX 会在路由切换时重建 SES iframe；每一步完成后重新绑定，不重跑助记词或密码提交。
      current.wallet.close();
      current = null;
    }
    throw new Error('manual_security_blocker: crypto_wallet_import_page_changed');
  } catch (error) {
    if (/^manual_security_blocker: crypto_wallet_(?:import_|password_|connect_)/.test(error.message || '')) throw error;
    // 扩展内部异常不得将浏览器错误（可能包含输入内容）写入任务日志。
    throw new Error('manual_security_blocker: crypto_wallet_import_inspection_failed');
  } finally {
    current?.wallet?.close();
  }
}

async function inspectOkxTargets(debugPort) {
  const targets = getTargets(debugPort).filter((target) => String(target.url || '').startsWith('chrome-extension://' + OKX_EXTENSION_ID + '/'));
  const output = [];
  for (const target of targets) {
    let client;
    try {
      client = await cdp(target.webSocketDebuggerUrl, 3000);
      await client.send('Runtime.enable');
      const state = await evaluate(client, () => {
        const text = document.body?.innerText || '';
        return {confirmationVisible: /Confirm|Pay|Review transaction|Sign/i.test(text)};
      });
      output.push({type: target.type || '', ...state});
    } catch (error) {
      output.push({type: target.type || '', error: error.message});
    } finally {
      client?.close();
    }
  }
  return output;
}

export async function continueCryptoAfterAmount(input, page, purchaseContext, adapters = {}) {
  const prepareWallet = adapters.prepareWallet || prepareOkxWallet;
  const submitPurchase = adapters.submitPurchase || clickPurchase;
  const openPaymentCheckout = adapters.openCheckout || openCheckout;
  const chooseWallet = adapters.selectWallet || selectOkxWallet;
  const openWalletExtension = adapters.launchExtension || launchOkxExtension;
  const inspectCheckout = adapters.readCheckout || readCheckoutState;
  const inspectTargets = adapters.inspectTargets || inspectOkxTargets;
  // Purchase 只创建 Coinbase checkout；最终钱包确认、签名和广播仍严格保留给人工。
  const purchaseClick = await submitPurchase(page);
  const checkoutTarget = await openPaymentCheckout(input, page);
  const checkout = checkoutTarget.checkout;
  try {
    const walletSelection = await chooseWallet(checkout);
    const walletLaunch = await openWalletExtension(checkout, input);
    writeDiagnostic(input.confirmationDebugDir, 'crypto-wallet-launch', {
      selectionClicked: walletSelection.selectionClicked === true,
      launchReady: walletSelection.launchReady === true,
      fallbackClicked: walletLaunch?.fallbackClicked === true,
      browserActivated: walletLaunch?.browserActivated === true,
      targetCount: Number(walletLaunch?.targetCount || 0),
    });
    // Coinbase 的 Launch extension 弹出钱包后，再判断登录状态或执行首次导入。
    const wallet = await prepareWallet(input);
    if (wallet.status === 'connect_required' || wallet.status === 'connect_submitted') {
      const checkoutState = await inspectCheckout(checkout);
      const okxTargets = await inspectTargets(input.debugPort);
      return {
        checkout,
        cryptoPurchase: {
          ...purchaseContext,
          purchaseClick,
          checkoutUrl: String(checkoutTarget.target.url || '').split('?')[0],
          walletSelection,
          wallet,
          checkoutState,
          okxTargets,
          walletConnectionRequired: wallet.status === 'connect_required',
          walletConnectionSubmitted: wallet.status === 'connect_submitted',
          walletConfirmationRequired: true,
          insufficientFunds: checkoutState.insufficientFunds === true,
          paymentFailed: checkoutState.paymentFailed === true,
        },
      };
    }
    if (wallet.status !== 'ready') throw new Error('manual_security_blocker: crypto_wallet_import_unverified');
    const checkoutState = await inspectCheckout(checkout);
    const okxTargets = await inspectTargets(input.debugPort);
    return {
      checkout,
      cryptoPurchase: {
        ...purchaseContext,
        purchaseClick,
        checkoutUrl: String(checkoutTarget.target.url || '').split('?')[0],
        walletSelection,
        wallet,
        walletPasswordAvailable: Boolean(input.walletPassword),
        checkoutState,
        okxTargets,
        insufficientFunds: checkoutState.insufficientFunds === true,
        walletConfirmationRequired: checkoutState.insufficientFunds !== true && checkoutState.paymentCompleted !== true,
      },
    };
  } catch (error) {
    checkout.close();
    throw error;
  }
}

async function runCryptoRecharge(rawInput) {
  const startedAt = Date.now();
  const input = await startProfile(rawInput);
  let page;
  let checkout;
  try {
    page = await ensureCreditsPage(input);
    const account = await waitForAccount(page, input.expectedAccount);
    const purchase = await resolveAmount(page, input.purchase);
    if (purchase.skippedByRule) {
      return {ok: true, status: 'crypto_skipped_by_balance_rule', account: account.account, cryptoPurchase: {...purchase, walletConfirmationRequired: false}};
    }
    const useCrypto = await ensureUseCrypto(page);
    const purchaseForm = await waitForCryptoPurchaseForm(page);
    writeDiagnostic(input.confirmationDebugDir, 'crypto-purchase-form-ready', purchaseForm);
    const amountInput = await fillAmount(page, purchase.amount);
    const continued = await continueCryptoAfterAmount(input, page, {...purchase, useCrypto, purchaseForm, amountInput});
    checkout = continued.checkout;
    const cryptoPurchase = continued.cryptoPurchase;
    writeDiagnostic(input.confirmationDebugDir, 'crypto-checkout-result', cryptoPurchase);
    return {
      ok: true,
      status: cryptoPurchase.paymentFailed
        ? 'crypto_payment_failed'
        : (cryptoPurchase.insufficientFunds ? 'crypto_insufficient_funds' : 'wallet_confirmation_required'),
      account: account.account,
      launch: input.launch,
      cryptoPurchase,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    checkout?.close();
    page?.close();
  }
}

async function main() {
  const input = readInput(parseArgs(process.argv));
  validateInput(input);
  return runCryptoRecharge(input);
}

// 导入时仅提供可测试函数，不启动 AdsPower，更不触发充值。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(JSON.stringify({ok: false, error: redact(error.message || error)}));
    process.exitCode = 1;
  });
