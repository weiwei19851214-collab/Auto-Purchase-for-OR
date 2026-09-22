#!/usr/bin/env node

/**
 * OpenRouter 虚拟币充值执行器。
 *
 * 该文件只负责 OPOM 账号对应的虚拟币充值页面和 OKX Wallet 连接流程，
 * 不包含银行卡、Stripe、Billing Address 或 Auto Top-Up 逻辑。
 */

import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';

const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/settings/credits';
const DEFAULT_ADSPOWER_BASE = 'http://127.0.0.1:50325';
const DEFAULT_TIMEOUT_MS = 30000;
const POLL_MS = 750;
const OKX_EXTENSION_ID = 'mcohilncbfahbmgdjkbpemcciiolgcge';
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
    if (raw) input = JSON.parse(raw);
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
  return {browserWs: typeof ws === 'string' ? ws : '', debugPort: String(debugPort || '')};
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

async function typeCharacters(client, value) {
  for (const char of String(value)) {
    await dispatchKey(client, 'keyDown', {key: char, text: char, unmodifiedText: char});
    await dispatchKey(client, 'char', {text: char, unmodifiedText: char});
    await dispatchKey(client, 'keyUp', {key: char});
  }
}

async function clearFocusedInput(client, length) {
  // 数字输入框先把光标移到末尾，再逐次 Backspace，避免依赖系统全选快捷键。
  await dispatchKey(client, 'keyDown', {key: 'End', code: 'End'});
  await dispatchKey(client, 'keyUp', {key: 'End', code: 'End'});
  for (let index = 0; index < Math.max(1, Number(length || 0) + 2); index += 1) {
    await dispatchKey(client, 'keyDown', {key: 'Backspace', code: 'Backspace'});
    await dispatchKey(client, 'keyUp', {key: 'Backspace', code: 'Backspace'});
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

async function resolveAmount(page, purchase) {
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

async function fillAmount(page, amount) {
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
  await typeCharacters(page, amount);
  await dispatchKey(page, 'keyDown', {key: 'Tab', code: 'Tab'});
  await dispatchKey(page, 'keyUp', {key: 'Tab', code: 'Tab'});
  const state = await evaluate(page, (expected) => {
    const input = document.querySelector('[data-crypto-amount-target]');
    const actual = input?.value || '';
    input?.removeAttribute('data-crypto-amount-target');
    return {actual, blurred: document.activeElement !== input, retained: Number(actual) === Number(expected)};
  }, amount);
  if (!state.retained || !state.blurred) throw new Error('Crypto amount input did not retain ' + amount);
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

async function openCheckout(input, page) {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  let lastTargets = [];
  while (Date.now() < deadline) {
    const verification = await evaluate(page, () => {
      const text = document.body?.innerText || '';
      return /Verification required/i.test(text) && /Enter your current password/i.test(text);
    }).catch(() => false);
    if (verification) {
      throw new Error('manual_security_blocker: Verification required; Enter your current password before crypto checkout');
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
  throw new Error('Coinbase crypto checkout target not found: ' + JSON.stringify(lastTargets));
}

async function selectOkxWallet(checkout) {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const clicked = await evaluate(checkout, () => {
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = [...document.querySelectorAll('button,[role="button"],a,li,label,div')]
        .filter(visible)
        .map((node) => ({node, text: (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim()}));
      const item = candidates.find((entry) => entry.text === 'OKX Wallet')
        || candidates.find((entry) => /^OKX Wallet(?: Recent)?$/i.test(entry.text));
      if (!item) return false;
      const button = item.node.closest('button,[role="button"],a,li,label') || item.node;
      button.click();
      return true;
    });
    if (clicked) break;
    await sleep(POLL_MS);
  }
  const readyDeadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (Date.now() < readyDeadline) {
    const ready = await evaluate(checkout, () => {
      const text = document.body?.innerText || '';
      const launch = [...document.querySelectorAll('button,[role="button"],a')]
        .some((node) => /^Launch extension$/i.test((node.innerText || node.textContent || '').trim()));
      return launch && /Scan with OKX Wallet/i.test(text);
    });
    if (ready) return {selected: true, launchReady: true};
    await sleep(POLL_MS);
  }
  throw new Error('OKX Wallet or Launch extension was not available');
}

async function launchOkxExtension(checkout) {
  // 这里只建立连接，绝不点击钱包里的确认、签名或广播按钮。
  const clicked = await evaluate(checkout, () => {
    const button = [...document.querySelectorAll('button,[role="button"],a')]
      .find((node) => /^Launch extension$/i.test((node.innerText || node.textContent || '').trim()));
    if (!button) return false;
    button.click();
    return true;
  });
  if (!clicked) throw new Error('Launch extension button not clickable');
  await sleep(2500);
}

async function readCheckoutState(checkout) {
  const deadline = Date.now() + 10000;
  let state = null;
  while (Date.now() < deadline) {
    state = await evaluate(checkout, () => {
      const text = document.body?.innerText || '';
      const match = text.match(/You need\s+([0-9,.]+)\s+([A-Z0-9_]+)\s+to complete your payment/i);
      return {
        insufficientFunds: /Insufficient funds/i.test(text),
        walletConnected: /OKX Wallet connected/i.test(text),
        paymentCompleted: /Payment complete|Payment successful|Paid successfully/i.test(text),
        requiredAmount: match?.[1] || '',
        requiredAsset: match?.[2] || '',
        tail: text.slice(-1800),
      };
    });
    if (state.insufficientFunds || state.walletConnected || state.paymentCompleted) return state;
    await sleep(500);
  }
  return state || {};
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
        return {confirmationVisible: /Confirm|Pay|Review transaction|Sign/i.test(text), tail: text.slice(-1200)};
      });
      output.push({type: target.type || '', url: String(target.url || '').split('?')[0], ...state});
    } catch (error) {
      output.push({type: target.type || '', error: error.message});
    } finally {
      client?.close();
    }
  }
  return output;
}

async function runCryptoRecharge(rawInput) {
  const startedAt = Date.now();
  const input = await startProfile(rawInput);
  const page = await ensureCreditsPage(input);
  let checkout;
  try {
    const account = await waitForAccount(page, input.expectedAccount);
    const purchase = await resolveAmount(page, input.purchase);
    if (purchase.skippedByRule) {
      return {ok: true, status: 'crypto_skipped_by_balance_rule', account: account.account, cryptoPurchase: {...purchase, walletConfirmationRequired: false}};
    }
    const useCrypto = await ensureUseCrypto(page);
    const amountInput = await fillAmount(page, purchase.amount);
    const purchaseClick = await clickPurchase(page);
    const checkoutTarget = await openCheckout(input, page);
    checkout = checkoutTarget.checkout;
    const walletSelection = await selectOkxWallet(checkout);
    await launchOkxExtension(checkout);
    const checkoutState = await readCheckoutState(checkout);
    const okxTargets = await inspectOkxTargets(input.debugPort);
    const cryptoPurchase = {
      ...purchase,
      useCrypto,
      amountInput,
      purchaseClick,
      checkoutUrl: String(checkoutTarget.target.url || '').split('?')[0],
      walletSelection,
      checkoutState,
      okxTargets,
      insufficientFunds: checkoutState.insufficientFunds === true,
      walletConfirmationRequired: checkoutState.insufficientFunds !== true && checkoutState.paymentCompleted !== true,
    };
    writeDiagnostic(input.confirmationDebugDir, 'crypto-checkout-result', cryptoPurchase);
    return {
      ok: true,
      status: cryptoPurchase.insufficientFunds ? 'crypto_insufficient_funds' : 'wallet_confirmation_required',
      account: account.account,
      launch: input.launch,
      cryptoPurchase,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    checkout?.close();
    page.close();
  }
}

async function main() {
  const input = readInput(parseArgs(process.argv));
  validateInput(input);
  return runCryptoRecharge(input);
}

main()
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(JSON.stringify({ok: false, error: redact(error.message || error)}));
    process.exitCode = 1;
  });
