#!/usr/bin/env node

/**
 * Bind an OpenRouter payment card through an AdsPower browser using CDP.
 *
 * Secrets must be supplied at runtime through stdin, --input-json, or
 * environment variables. This script never prints full card numbers or CVV.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {isRechargeBalanceIncreaseVerified} from './lib/balance-verification.mjs';

const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/settings/credits';
const DEFAULT_ADSPOWER_BASE = 'http://127.0.0.1:50325';
const UPDATE_CURRENT_USER_ACTION = '60f1ee6dacb6d04fcb64a9d9a1d30bd7f5d04e47c3';
const DEFAULT_ADSPOWER_HTTP_TIMEOUT_MS = 15000;
const DEFAULT_ADSPOWER_START_TIMEOUT_MS = 45000;
const DEFAULT_CREDITS_ENTRY_WAIT_MS = 60000;
const DEFAULT_PAYMENT_ENTRY_WAIT_MS = 60000;
const DEFAULT_STRIPE_IFRAME_WAIT_MS = 60000;
const DEFAULT_NAVIGATION_COMMAND_TIMEOUT_MS = 60000;
const DEFAULT_NAVIGATION_READY_TIMEOUT_MS = 60000;
const DEFAULT_NAVIGATION_RETRIES = 3;
const DEFAULT_DOM_WAIT_MS = 60000;
const DEFAULT_DOM_POLL_MS = 1000;
const SLOW_DOM_POLL_MS = 1500;
const STRIPE_POST_FILL_SETTLE_MS = 1500;
const PAGE_SETTLE_MS = 3000;
const BALANCE_VERIFY_REFRESH_INTERVAL_MS = 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let diagnosticCounter = 0;

function diagnosticName(label, ext) {
  const count = String(++diagnosticCounter).padStart(3, '0');
  const safeLabel = String(label || 'step').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'step';
  return `${count}-${safeLabel}.${ext}`;
}

function redactDiagnostic(value) {
  if (typeof value === 'string') {
    return value
      .replace(/\b([A-Z0-9._%+-]{2})[A-Z0-9._%+-]*(@[A-Z0-9.-]+\.[A-Z]{2,})/gi, '$1***$2')
      .replace(/\b\d{13,19}\b/g, (digits) => `${digits.slice(0, 2)}***${digits.slice(-4)}`)
      .replace(/("?(?:cvc|cvv|cardCvc|card-cvc)"?\s*[:=]\s*)"[^"]+"/gi, '$1"***"');
  }
  if (Array.isArray(value)) return value.map(redactDiagnostic);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /cvc|cvv|token|cookie|session|password/i.test(key) ? '***' : redactDiagnostic(item),
    ]));
  }
  return value;
}

function writeDiagnostic(dir, label, data) {
  if (!dir) return null;
  mkdirSync(dir, {recursive: true});
  const file = `${dir}/${diagnosticName(label, 'json')}`;
  writeFileSync(file, JSON.stringify(redactDiagnostic(data), null, 2), 'utf8');
  return file;
}

async function captureDiagnosticScreenshot(client, dir, label, data = {}) {
  if (!dir || !client) return null;
  mkdirSync(dir, {recursive: true});
  const base = diagnosticName(label, 'png').replace(/\.png$/, '');
  const jsonFile = `${dir}/${base}.json`;
  const pngFile = `${dir}/${base}.png`;
  let screenshot = null;
  try {
    await client.send('Page.enable').catch(() => {});
    screenshot = await client.send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true}, 10000);
    if (screenshot?.data) writeFileSync(pngFile, Buffer.from(screenshot.data, 'base64'));
  } catch (error) {
    data = {...data, screenshotError: error.message};
  }
  writeFileSync(jsonFile, JSON.stringify(redactDiagnostic({...data, screenshot: screenshot?.data ? pngFile : null}), null, 2), 'utf8');
  return {jsonFile, pngFile: screenshot?.data ? pngFile : null};
}

function writeStepDiagnostic(dir, label, status, data = {}) {
  return writeDiagnostic(dir, `step-${label}-${status}`, {
    kind: 'automation_step',
    label,
    status,
    at: new Date().toISOString(),
    ...data,
  });
}

function safeDiagnosticUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value || '').split('?')[0].split('#')[0].slice(0, 220);
  }
}

function isIgnoredOpenRouterNetworkFailure(entry) {
  const url = safeDiagnosticUrl(entry?.url || '');
  const status = Number(entry?.status);
  return url === 'https://openrouter.ai/api/internal/v1/stripe'
    || (Number.isFinite(status) && status >= 500);
}

async function installNetworkDiagnostics(client) {
  if (!client || client.__networkDiagnosticsInstalled) return {installed: false, reason: 'already_installed'};
  client.__networkDiagnosticsInstalled = true;
  const requests = new Map();
  const failures = [];
  const rememberFailure = (entry) => {
    const url = safeDiagnosticUrl(entry.url);
    failures.push({
      at: new Date().toISOString(),
      ...entry,
      url,
      ignored: isIgnoredOpenRouterNetworkFailure({...entry, url}),
    });
    while (failures.length > 30) failures.shift();
  };
  client.getRecentNetworkFailures = () => failures.slice(-10);
  client.on?.('Network.requestWillBeSent', ({requestId, request}) => {
    requests.set(requestId, {
      method: request?.method || '',
      url: request?.url || '',
    });
    if (requests.size > 250) requests.delete(requests.keys().next().value);
  });
  client.on?.('Network.responseReceived', ({requestId, response, type}) => {
    const status = Number(response?.status);
    if (!Number.isFinite(status) || status < 400) return;
    const request = requests.get(requestId) || {};
    rememberFailure({
      kind: 'http_response',
      status,
      statusText: response?.statusText || '',
      method: request.method || '',
      type: type || '',
      url: response?.url || request.url || '',
    });
  });
  client.on?.('Network.loadingFailed', ({requestId, errorText, type, canceled}) => {
    if (canceled) return;
    const request = requests.get(requestId) || {};
    rememberFailure({
      kind: 'loading_failed',
      errorText: errorText || '',
      method: request.method || '',
      type: type || '',
      url: request.url || '',
    });
  });
  await client.send('Network.enable', {}, 5000).catch((error) => {
    rememberFailure({kind: 'network_enable_failed', errorText: error.message, url: ''});
  });
  return {installed: true};
}

async function pageStepState(page) {
  if (!page) return null;
  const state = await evaluate(page, `(() => {
    const text = document.body?.innerText || '';
    return {
      href: location.href,
      title: document.title || '',
      hasPaymentIssue: /Error:\\s*Payment\\s+Issue|Your card was declined/i.test(text),
      hasServerError: /\\b5\\d{2}\\b|Internal Server Error|Something went wrong|Application error|Invalid value for stripe\\.confirmSetup/i.test(text),
      hasAutoTopup: /Auto\\s*Top[- ]?Up/i.test(text),
      hasPurchaseCredits: /Purchase Credits/i.test(text),
      hasAddCredits: /Add Credits/i.test(text),
      tail: text.slice(-1800),
    };
  })()`).catch((error) => ({error: error.message}));
  const networkFailures = page.getRecentNetworkFailures?.() || [];
  const recentNetworkFailures = networkFailures.filter((entry) => !entry.ignored);
  const ignoredNetworkFailures = networkFailures.filter((entry) => entry.ignored);
  const ignoredServerError = Boolean(state.hasServerError && !state.hasPaymentIssue);
  return {
    ...state,
    hasServerErrorRaw: Boolean(state.hasServerError),
    hasServerError: false,
    ignoredServerError,
    recentNetworkFailures,
    ignoredNetworkFailures: ignoredNetworkFailures.slice(-5),
  };
}

async function dismissOpenRouterServerErrorToast(page) {
  if (!page) return {attempted: false};
  return evaluate(page, `(() => {
    const textOf = (node) => (node?.innerText || node?.textContent || '').trim();
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const clickNode = (target) => {
      if (!target) return false;
      target.scrollIntoView?.({block:'center', inline:'center'});
      const PointerLikeEvent = window.PointerEvent || MouseEvent;
      target.dispatchEvent(new PointerLikeEvent('pointerdown', {bubbles: true, cancelable: true, view: window}));
      target.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, view: window}));
      target.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true, view: window}));
      target.click?.();
      target.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, view: window}));
      return true;
    };
    const errorPattern = /\\bError\\s*5\\d{2}\\b|\\b5\\d{2}\\b|Internal Server Error|Something went wrong|Application error|Invalid value for stripe\\.confirmSetup/i;
    const exactDialogs = [...document.querySelectorAll('[data-slot="dialog-content"],[role="dialog"],[aria-modal="true"]')]
      .filter((node) => visible(node) && errorPattern.test(textOf(node)))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (ar.width * ar.height) - (br.width * br.height);
      });
    for (const dialog of exactDialogs) {
      const close = [...dialog.querySelectorAll('button[data-slot="dialog-close"],button[aria-label="Close"],button[title="Close"]')]
        .find((node) => visible(node) && node.getAttribute('aria-disabled') !== 'true');
      if (close && clickNode(close)) {
        return {
          attempted: true,
          found: true,
          clicked: true,
          method: close.getAttribute('data-slot') === 'dialog-close' ? 'dialog-close-slot' : 'dialog-close-label',
          text: textOf(dialog).slice(0, 240),
        };
      }
    }
    const errorNodes = [...document.querySelectorAll('body *')]
      .filter((node) => visible(node) && errorPattern.test(textOf(node)));
    if (!errorNodes.length) return {attempted: false, found: false};
    const containers = [];
    for (const node of errorNodes) {
      let current = node;
      for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
        if (!visible(current)) continue;
        const text = textOf(current);
        if (errorPattern.test(text)) {
          containers.push(current);
        }
      }
    }
    const unique = [...new Set(containers)];
    const closeCandidates = [];
    for (const container of unique) {
      closeCandidates.push(...[...container.querySelectorAll('button,[role="button"],[aria-label],svg')]
        .filter((node) => visible(node))
        .map((node) => {
          const label = [
            node.getAttribute('aria-label') || '',
            node.getAttribute('title') || '',
            textOf(node),
          ].join(' ').trim();
          const rect = node.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          const nearTopRight = rect.left > containerRect.left + containerRect.width * 0.6 && rect.top < containerRect.top + containerRect.height * 0.35;
          return {
            node,
            label,
            score: /close|dismiss|关闭|×|x/i.test(label) ? 2 : nearTopRight ? 1 : 0,
          };
        })
        .filter((candidate) => candidate.score > 0));
    }
    const ordered = [...closeCandidates].sort((a, b) => b.score - a.score);
    const clicked = [];
    for (const candidate of ordered.slice(0, 6)) {
      const target = candidate.node.closest?.('button,[role="button"],[aria-label]') || candidate.node;
      if (!target || clicked.includes(target)) continue;
      clickNode(target);
      clicked.push(target);
    }
    if (!clicked.length) return {attempted: true, found: true, clicked: false, reason: 'close_button_not_found'};
    return {attempted: true, found: true, clicked: true, clickedCount: clicked.length};
  })()`).catch((error) => ({attempted: true, error: error.message}));
}

async function commandRefreshCreditsPage(page) {
  if (!page) return {refreshed: false};
  await page.send('Page.bringToFront').catch(() => {});
  await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 91}).catch(() => {});
  await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82, modifiers: 4}).catch(() => {});
  await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82, modifiers: 4}).catch(() => {});
  await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 91}).catch(() => {});
  const ready = await waitForNavigationReady(page, OPENROUTER_CREDITS_URL, DEFAULT_NAVIGATION_READY_TIMEOUT_MS).catch(() => null);
  if (!ready) {
    await page.send('Page.reload', {ignoreCache: true}, DEFAULT_NAVIGATION_COMMAND_TIMEOUT_MS).catch(() => null);
    await waitForNavigationReady(page, OPENROUTER_CREDITS_URL, DEFAULT_NAVIGATION_READY_TIMEOUT_MS).catch(() => null);
  }
  await sleep(PAGE_SETTLE_MS);
  return {refreshed: true, method: 'command_r', ready};
}

async function detectNewAccountOverlay(page) {
  if (!page) return {found: false};
  return evaluate(page, `(() => {
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const textOf = (node) => (node?.innerText || node?.textContent || '').trim().replace(/\\s+/g, ' ');
    const newAccountPattern = /Profile details|Connected accounts|Connect account|Connect wallet|Manage your account info|You must add a verified email to access this feature|openrouter\\.ai says/i;
    const flowPattern = /Purchase Credits|Add a Payment Method|Save payment method|Add a Billing Address|Card number|Expiration date|CVC|Payment Issue|3D Secure|hCaptcha|captcha|passkey/i;
    const dialog = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[data-floating-ui-portal] [role="dialog"]')]
      .filter((node) => visible(node))
      .map((node) => ({node, text:textOf(node)}))
      .find((item) => newAccountPattern.test(item.text) && !flowPattern.test(item.text));
    return dialog
      ? {found:true, text:dialog.text.slice(0, 240), method:'refresh_new_account_overlay'}
      : {found:false};
  })()`).catch((error) => ({found: false, error: error.message}));
}

async function recoverNewAccountBlockerIfPresent(page, reason = 'new_account_blocker') {
  if (!page) return {recovered: false};
  const nativeDialog = await acceptJavascriptDialogIfAny(page, 150).catch(() => ({handled: false}));
  if (nativeDialog.handled) {
    await sleep(250);
    // 新号首次点击支付入口会弹验证邮箱提示，强刷可清掉一次性弹层并回到 Credits 主流程。
    const refreshed = await commandRefreshCreditsPage(page).catch((error) => ({refreshed: false, error: error.message}));
    return {
      recovered: true,
      reason: `${reason}:native_dialog`,
      nativeDialog,
      pageOverlay: {found: false},
      refreshed,
    };
  }
  const pageOverlay = await detectNewAccountOverlay(page);
  if (pageOverlay.found) {
    const refreshed = await commandRefreshCreditsPage(page).catch((error) => ({refreshed: false, error: error.message}));
    return {
      recovered: true,
      reason: `${reason}:page_overlay`,
      nativeDialog,
      pageOverlay,
      refreshed,
    };
  }
  return {recovered: false, nativeDialog, pageOverlay};
}

async function dismissInterferingOverlays(page) {
  if (!page) return {attempted: false};
  const nativeDialog = await acceptJavascriptDialogIfAny(page, 700).catch(() => ({handled: false}));
  const pageOverlay = await evaluate(page, `(() => {
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const textOf = (node) => (node?.innerText || node?.textContent || node?.getAttribute?.('aria-label') || '')
      .trim()
      .replace(/\\s+/g, ' ');
    // OpenRouter 维护提醒会影响后续余额回读，只按已确认的 portal id 和关闭按钮 class 处理。
    const maintenanceBanner = document.querySelector('#maintenance-banner-portal');
    if (maintenanceBanner && visible(maintenanceBanner)) {
      const closeControl = maintenanceBanner.getElementsByClassName('ml-2 mt-0.5')[0];
      const target = closeControl?.closest?.('button,[role="button"]') || closeControl;
      if (target && visible(target)) {
        target.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, view:window}));
        target.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true, view:window}));
        target.click?.();
        target.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
        return {attempted:true, found:true, clicked:true, kind:'maintenance_banner'};
      }
    }
    const flowBlocker = /Purchase Credits|Add a Payment Method|Add Payment Method|Save payment method|Add a Billing Address|Complete address details|Update Address|Card number|Expiration date|CVC|Postal code|Payment Issue|3D Secure|hCaptcha|captcha|security code|bank verification|passkey/i;
    const allowedNonFlowOverlay = /Profile details|Connected accounts|Connect account|Connect wallet|Manage your account info|You must add a verified email to access this feature|openrouter\\.ai says|\\bError\\s*5\\d{2}\\b|\\b5\\d{2}\\b|Internal Server Error|Something went wrong|Application error|Invalid value for stripe\\.confirmSetup/i;
    const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],div,section')]
      .filter(visible)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const buttons = [...node.querySelectorAll('button,[role="button"],[aria-label],svg')]
          .filter(visible)
          .map((button) => {
            const label = [textOf(button), button.getAttribute?.('aria-label') || '', button.getAttribute?.('title') || ''].join(' ').trim();
            const buttonRect = button.getBoundingClientRect();
            const nearTopRight = buttonRect.left > rect.left + rect.width * 0.72 && buttonRect.top < rect.top + rect.height * 0.24;
            return {node: button, label, rect: buttonRect, nearTopRight};
          });
        return {
          node,
          text: textOf(node),
          rect,
          stylePosition: style.position,
          zIndex: Number.parseInt(style.zIndex || '0', 10) || 0,
          role: node.getAttribute('role') || '',
          modal: node.getAttribute('aria-modal') || '',
          buttons,
        };
      })
      .filter((item) => item.rect.width >= 220 && item.rect.height >= 100)
      .filter((item) => {
        const hasExplicitCloseOrOk = item.buttons.some((button) => /^OK$/i.test(button.label) || /close|dismiss|关闭|×|x/i.test(button.label));
        const hasTopRightClose = item.buttons.some((button) => button.nearTopRight && /^(|×|x|close|dismiss|关闭)$/i.test(button.label));
        const hasCloseOrOk = hasExplicitCloseOrOk || hasTopRightClose;
        if (!hasCloseOrOk) return false;
        const protectedFlow = flowBlocker.test(item.text) && !/You must add a verified email to access this feature/i.test(item.text);
        if (protectedFlow) return false;
        const isRealOverlay = item.role === 'dialog'
          || item.modal === 'true'
          || (item.stylePosition === 'fixed' && item.zIndex >= 10);
        return allowedNonFlowOverlay.test(item.text) || isRealOverlay;
      })
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
    const dialog = dialogs[0];
    if (!dialog) return {attempted:false, found:false};
    const buttons = dialog.buttons
      .map((item) => ({
        ...item,
        score: /^OK$/i.test(item.label) ? 4 : /close|dismiss|关闭|×|x/i.test(item.label) ? 3 : item.nearTopRight ? 2 : 0,
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.rect.x - a.rect.x);
    const target = buttons[0]?.node?.closest?.('button,[role="button"],[aria-label]') || buttons[0]?.node || null;
    if (!target) return {attempted:true, found:true, clicked:false, reason:'close_target_not_found', text:dialog.text.slice(0, 240)};
    target.scrollIntoView?.({block:'center', inline:'center'});
    target.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, view:window}));
    target.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true, view:window}));
    target.click?.();
    target.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
    return {attempted:true, found:true, clicked:true, label:buttons[0]?.label || '', text:dialog.text.slice(0, 240)};
  })()`).catch((error) => ({attempted: true, error: error.message}));
  return {attempted: true, nativeDialog, pageOverlay};
}

async function recoverInterferingUi(page) {
  if (!page) return {attempted: false};
  const newAccountBlocker = await recoverNewAccountBlockerIfPresent(page, 'step_boundary');
  if (newAccountBlocker.recovered) {
    return {
      attempted: true,
      refreshedOnly: true,
      reason: newAccountBlocker.reason,
      dismissedOverlay: {
        attempted: true,
        nativeDialog: newAccountBlocker.nativeDialog,
        pageOverlay: newAccountBlocker.pageOverlay,
      },
      dismissedServerError: {attempted: false},
      paymentSurface: false,
      refreshed: newAccountBlocker.refreshed,
    };
  }
  const dismissedOverlay = await dismissInterferingOverlays(page);
  if (dismissedOverlay?.nativeDialog?.handled || dismissedOverlay?.pageOverlay?.clicked) await sleep(400);
  const dismissedServerError = await dismissOpenRouterServerErrorToast(page);
  if (dismissedServerError?.clicked) await sleep(400);
  const state = await pageStepState(page);
  const paymentSurface = await evaluate(page, `(() => {
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const textOf = (node) => (node?.innerText || node?.textContent || '').trim();
    const activeDialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[data-slot="dialog-content"],form')]
      .filter(visible)
      .map((node) => textOf(node))
      .filter(Boolean);
    return activeDialogs.some((text) => /Save payment method|Card number|Expiration date|CVC|Add a Billing Address|Purchase Credits[\\s\\S]*Total due|Auto\\s*Top[- ]?Up/i.test(text));
  })()`).catch(() => false);
  const refreshed = state.hasServerErrorRaw && !state.hasPaymentIssue && !paymentSurface
    ? await commandRefreshCreditsPage(page).catch((error) => ({refreshed: false, error: error.message}))
    : {refreshed: false};
  return {attempted: true, dismissedOverlay, dismissedServerError, paymentSurface, refreshed};
}

async function dismissServerErrorAfterStepIfPresent(page, debugDir, label, pageState) {
  if (!page || (!pageState?.hasServerError && !pageState?.ignoredServerError)) return {attempted: false};
  const dismissedPostStepServerError = await dismissOpenRouterServerErrorToast(page);
  if (dismissedPostStepServerError?.clicked) await sleep(250);
  const after = await pageStepState(page);
  writeStepDiagnostic(debugDir, `${label}-server-error-dismissed`, 'success', {
    kind: pageState?.ignoredServerError ? 'ignored_openrouter_server_error_dismissed' : 'non_fatal_server_error_dismissed',
    dismissedPostStepServerError,
    before: pageState,
    after,
  });
  return dismissedPostStepServerError;
}

async function runLoggedStep(label, debugDir, task, page = null) {
  const recoveredUi = page ? await recoverInterferingUi(page) : {attempted: false};
  writeStepDiagnostic(debugDir, label, 'start', {recoveredUi, page: await pageStepState(page)});
  try {
    const result = await task();
    const recoveredUiAfter = page ? await recoverInterferingUi(page) : {attempted: false};
    const pageState = await pageStepState(page);
    writeStepDiagnostic(debugDir, label, 'success', {result, recoveredUiAfter, page: pageState});
    await dismissServerErrorAfterStepIfPresent(page, debugDir, label, pageState);
    return result;
  } catch (error) {
    const pageState = await pageStepState(page);
    writeStepDiagnostic(debugDir, label, 'error', {error: error.message, page: pageState});
    if (page) {
      await captureDiagnosticScreenshot(page, debugDir, `step-${label}-error`, {
        kind: 'automation_step_error',
        label,
        error: error.message,
        page: pageState,
      }).catch(() => null);
    }
    throw error;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'stdin' || key === 'help' || key === 'no-open-purchase' || key === 'remove-existing' || key === 'verbose' || key === 'configure-auto-topup' || key === 'auto-topup-only' || key === 'billing-address-only' || key === 'credits-status-only' || key === 'purchase-only' || key === 'existing-billing-address' || key === 'confirm-purchase') {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function usage() {
  return `Usage:
  bind_openrouter_card_cdp.mjs --stdin
  bind_openrouter_card_cdp.mjs --input-json /secure/path/task.json
  bind_openrouter_card_cdp.mjs --debug-port 55035 --expected-account user@example.com ...
  bind_openrouter_card_cdp.mjs --stdin --remove-existing
  bind_openrouter_card_cdp.mjs --stdin --verbose
  bind_openrouter_card_cdp.mjs --debug-port 55035 --expected-account user@example.com --auto-topup-only --auto-topup-threshold 100 --auto-topup-amount 200
  bind_openrouter_card_cdp.mjs --stdin --credits-status-only
  bind_openrouter_card_cdp.mjs --stdin --billing-address-only
  bind_openrouter_card_cdp.mjs --stdin --purchase-only --confirm-purchase --purchase-amount 10
  bind_openrouter_card_cdp.mjs --stdin --confirm-purchase --purchase-amount 10
  bind_openrouter_card_cdp.mjs --stdin --confirm-purchase --balance-threshold 100 --amount-below-threshold 10 --amount-at-or-above-threshold 5

Inputs may be JSON:
{
  "profileNo": "1410",
  "profileId": "optional",
  "debugPort": "55035",
  "browserWs": "ws://127.0.0.1:55035/devtools/browser/...",
  "startupUrl": "https://openrouter.ai/settings/credits",
  "expectedAccount": "user@example.com",
  "removeExistingPaymentMethod": true,
  "billingAddressOnly": false,
  "purchaseOnly": false,
  "preparePurchaseOnly": false,
  "purchase": {"confirmed": false, "amount": "10", "rule": {"threshold": "100", "belowAmount": "10", "atOrAboveAmount": "5"}},
  "autoTopup": {"enabled": true, "threshold": "100", "amount": "200"},
  "card": {"number": "...", "expiry": "0628", "expMonth": "06", "expYear": "28", "cvc": "...", "postalCode": "97001"},
  "billing": {"name": "Name", "country": "US", "addressLine1": "1 Main St", "city": "Antelope", "state": "OR", "postalCode": "97001"}
}

Environment fallbacks:
  ADSPOWER_API_KEY, ADSPOWER_API_BASE, PROFILE_NO, PROFILE_ID, DEBUG_PORT,
  BROWSER_WS, EXPECTED_ACCOUNT, CARD_NO, CARD_EXP, CARD_CVC, CARD_ZIP,
  BILLING_NAME, BILLING_COUNTRY, BILLING_ADDRESS1, BILLING_CITY, BILLING_STATE,
  AUTO_TOPUP_THRESHOLD, AUTO_TOPUP_AMOUNT, PURCHASE_AMOUNT,
  PURCHASE_BALANCE_THRESHOLD, PURCHASE_AMOUNT_BELOW_THRESHOLD,
  PURCHASE_AMOUNT_AT_OR_ABOVE_THRESHOLD

The script saves the payment method and opens Add Credits to verify the masked
card. When autoTopup is supplied, it configures Auto top-up after card
verification. In billing-address-only mode it stops after the billing address
is saved and the card form is ready. It clicks Purchase only when
--confirm-purchase or purchase.confirmed=true is supplied with either a fixed
purchase amount or a complete balance-based purchase rule.`;
}

function readStdin() {
  if (process.stdin.isTTY) {
    throw new Error('--stdin requires piped or here-doc JSON input. Do not run it in an interactive PTY and paste JSON afterward; use --input-json or: node bind_openrouter_card_cdp.mjs --stdin <<\'JSON\' ... JSON');
  }
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function normalizeInput(args) {
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  let json = {};
  if (args['input-json']) json = JSON.parse(readFileSync(args['input-json'], 'utf8'));
  if (args.stdin) {
    const raw = readStdin().trim();
    if (raw) json = {...json, ...JSON.parse(raw)};
  }

  const card = {...(json.card || {})};
  const billing = {...(json.billing || {})};
  const autoTopup = {...(json.autoTopup || {})};
  const purchase = {...(json.purchase || {})};
  const purchaseRule = {...(json.purchaseRule || purchase.rule || {})};
  const autoTopupThreshold = args['auto-topup-threshold'] || autoTopup.threshold || process.env.AUTO_TOPUP_THRESHOLD || '';
  const autoTopupAmount = args['auto-topup-amount'] || autoTopup.amount || process.env.AUTO_TOPUP_AMOUNT || '';
  const purchaseAmount = args['purchase-amount'] || purchase.amount || json.amount || process.env.PURCHASE_AMOUNT || '';
  const purchaseBalanceThreshold = args['balance-threshold']
    || args['purchase-threshold']
    || purchaseRule.threshold
    || purchase.balanceThreshold
    || json.balanceThreshold
    || process.env.PURCHASE_BALANCE_THRESHOLD
    || '';
  const purchaseAmountBelowThreshold = args['amount-below-threshold']
    || purchaseRule.belowAmount
    || purchaseRule.amountBelowThreshold
    || purchase.belowAmount
    || process.env.PURCHASE_AMOUNT_BELOW_THRESHOLD
    || '';
  const purchaseAmountAtOrAboveThreshold = args['amount-at-or-above-threshold']
    || purchaseRule.atOrAboveAmount
    || purchaseRule.amountAtOrAboveThreshold
    || purchaseRule.aboveAmount
    || purchase.atOrAboveAmount
    || purchase.aboveAmount
    || process.env.PURCHASE_AMOUNT_AT_OR_ABOVE_THRESHOLD
    || '';
  const purchaseTargetBalance = args['target-balance']
    || purchaseRule.targetBalance
    || purchaseRule.target
    || purchaseRule.topUpToBalance
    || purchase.targetBalance
    || process.env.PURCHASE_TARGET_BALANCE
    || '';
  const cardExpiry = args['card-expiry']
    || card.expiry
    || joinExpiry(args['card-exp-month'] || card.expMonth || card.exp_month, args['card-exp-year'] || card.expYear || card.exp_year)
    || process.env.CARD_EXP
    || joinExpiry(process.env.CARD_EXP_MONTH, process.env.CARD_EXP_YEAR)
    || '';
  const input = {
    adspowerApiBase: args['adspower-api-base'] || json.adspowerApiBase || process.env.ADSPOWER_API_BASE || DEFAULT_ADSPOWER_BASE,
    adspowerApiKey: args['adspower-api-key'] || json.adspowerApiKey || process.env.ADSPOWER_API_KEY || '',
    adspowerStartTimeoutMs: normalizePositiveInteger(
      args['adspower-start-timeout-ms'] || json.adspowerStartTimeoutMs || process.env.ADSPOWER_START_TIMEOUT_MS || DEFAULT_ADSPOWER_START_TIMEOUT_MS,
      'adspowerStartTimeoutMs',
    ),
    profileNo: args['profile-no'] || json.profileNo || process.env.PROFILE_NO || '',
    profileId: args['profile-id'] || json.profileId || process.env.PROFILE_ID || '',
    debugPort: args['debug-port'] || json.debugPort || process.env.DEBUG_PORT || '',
    browserWs: args['browser-ws'] || json.browserWs || process.env.BROWSER_WS || '',
    startupUrl: args['startup-url'] || json.startupUrl || process.env.STARTUP_URL || OPENROUTER_CREDITS_URL,
    expectedAccount: args['expected-account'] || json.expectedAccount || process.env.EXPECTED_ACCOUNT || '',
    confirmationDebugDir: args['confirmation-debug-dir'] || json.confirmationDebugDir || process.env.CONFIRMATION_DEBUG_DIR || '',
    autoTopupOnly: !!(args['auto-topup-only'] || json.autoTopupOnly),
    billingAddressOnly: !!(args['billing-address-only'] || json.billingAddressOnly),
    creditsStatusOnly: !!(args['credits-status-only'] || json.creditsStatusOnly),
    purchaseOnly: !!(args['purchase-only'] || json.purchaseOnly),
    existingBillingAddress: !!(args['existing-billing-address'] || json.existingBillingAddress),
    openPurchaseForVerification: !args['no-open-purchase'],
    preparePurchaseOnly: !!(json.preparePurchaseOnly || json.preparePurchaseForm),
    purchase: {
      confirmed: !!(args['confirm-purchase'] || json.confirmPurchase || purchase.confirmed),
      amount: normalizeMoneyValue(purchaseAmount),
      rule: {
        enabled: !!(purchaseBalanceThreshold || purchaseAmountBelowThreshold || purchaseAmountAtOrAboveThreshold || purchaseTargetBalance),
        threshold: normalizeMoneyValue(purchaseBalanceThreshold),
        belowAmount: normalizeMoneyValue(purchaseAmountBelowThreshold),
        atOrAboveAmount: normalizeMoneyValue(purchaseAmountAtOrAboveThreshold),
        targetBalance: normalizeMoneyValue(purchaseTargetBalance),
        skipAtOrAbove: !!(purchaseRule.skipAtOrAbove || purchaseRule.skip_at_or_above || purchaseRule.targetBalance || purchaseTargetBalance),
      },
    },
    removeExistingPaymentMethod: !!(args['remove-existing'] || json.removeExistingPaymentMethod),
    verbose: !!(args.verbose || json.verbose),
    autoTopup: {
      enabled: !!(args['configure-auto-topup'] || json.configureAutoTopup || autoTopup.enabled || autoTopupThreshold || autoTopupAmount),
      threshold: normalizeMoneyValue(autoTopupThreshold),
      amount: normalizeMoneyValue(autoTopupAmount),
    },
    card: {
      number: args['card-number'] || card.number || process.env.CARD_NO || '',
      expiry: cardExpiry,
      cvc: args['card-cvc'] || card.cvc || process.env.CARD_CVC || '',
      postalCode: args['card-postal-code'] || card.postalCode || process.env.CARD_ZIP || '',
    },
    billing: {
      name: args['billing-name'] || billing.name || process.env.BILLING_NAME || '',
      country: normalizeCountry(args['billing-country'] || billing.country || process.env.BILLING_COUNTRY || 'US'),
      addressLine1: args['billing-address1'] || billing.addressLine1 || process.env.BILLING_ADDRESS1 || '',
      city: args['billing-city'] || billing.city || process.env.BILLING_CITY || '',
      state: normalizeState(args['billing-state'] || billing.state || process.env.BILLING_STATE || ''),
      postalCode: args['billing-postal-code'] || billing.postalCode || process.env.CARD_ZIP || '',
    },
  };

  if (!input.expectedAccount) throw new Error('expectedAccount is required');
  if ([input.autoTopupOnly, input.billingAddressOnly, input.creditsStatusOnly].filter(Boolean).length > 1) {
    throw new Error('autoTopupOnly, billingAddressOnly, and creditsStatusOnly cannot be combined');
  }
  if ((input.autoTopupOnly || input.billingAddressOnly || input.creditsStatusOnly) && input.purchase.confirmed) {
    throw new Error('purchase.confirmed cannot be combined with autoTopupOnly, billingAddressOnly, or creditsStatusOnly');
  }
  if (input.purchaseOnly && (input.autoTopupOnly || input.billingAddressOnly || input.creditsStatusOnly)) {
    throw new Error('purchaseOnly cannot be combined with autoTopupOnly, billingAddressOnly, or creditsStatusOnly');
  }
  if (input.purchaseOnly && !input.purchase.confirmed && !input.preparePurchaseOnly && !input.autoTopup.enabled) {
    throw new Error('purchaseOnly requires purchase.confirmed, preparePurchaseOnly, or autoTopup.enabled');
  }
  if (input.purchase.rule.enabled && input.purchase.rule.targetBalance && !input.purchase.rule.threshold) {
    throw new Error('purchase.rule.threshold is required when targetBalance is supplied');
  }
  if (input.purchase.rule.enabled && !input.purchase.rule.targetBalance && (!input.purchase.rule.threshold || !input.purchase.rule.belowAmount || !input.purchase.rule.atOrAboveAmount)) {
    throw new Error('purchase.rule.threshold, belowAmount, and atOrAboveAmount are required when any purchase rule value is supplied');
  }
  if ((input.purchase.confirmed || input.preparePurchaseOnly) && !input.purchase.amount && !input.purchase.rule.enabled) {
    throw new Error('purchase.amount/--purchase-amount or a complete purchase.rule is required when purchase is confirmed or prepared');
  }
  if (input.purchase.confirmed || input.preparePurchaseOnly) input.openPurchaseForVerification = true;
  const needsCard = !input.autoTopupOnly && !input.billingAddressOnly && !input.creditsStatusOnly && !input.purchaseOnly;
  if (needsCard && (!input.card.number || !input.card.expiry || !input.card.cvc)) {
    throw new Error('card.number, card.expiry, and card.cvc are required');
  }
  input.card.postalCode ||= input.billing.postalCode;
  input.billing.postalCode ||= input.card.postalCode;
  if (needsCard && !input.existingBillingAddress && !input.card.postalCode) throw new Error('card postalCode is required');
  if ((needsCard && !input.existingBillingAddress) || input.billingAddressOnly) requireBillingAddress(input.billing);
  if (input.autoTopup.enabled && !input.creditsStatusOnly && (!input.autoTopup.threshold || !input.autoTopup.amount)) {
    throw new Error('autoTopup.threshold and autoTopup.amount are required when autoTopup is enabled');
  }
  if (input.autoTopupOnly && !input.autoTopup.enabled) {
    throw new Error('autoTopup is required when autoTopupOnly is enabled');
  }
  if (!input.debugPort && !input.browserWs && !input.profileNo && !input.profileId) {
    throw new Error('Provide debugPort/browserWs or profileNo/profileId');
  }
  return input;
}

function requireBillingAddress(billing) {
  const missing = [];
  if (!billing.name) missing.push('billing.name');
  if (!billing.addressLine1) missing.push('billing.addressLine1');
  if (!billing.city) missing.push('billing.city');
  if (!billing.state) missing.push('billing.state');
  if (!billing.postalCode) missing.push('billing.postalCode');
  if (missing.length) throw new Error(`Missing billing address fields: ${missing.join(', ')}`);
}

function normalizeMoneyValue(value) {
  const cleaned = String(value || '').replace(/[$,\s]/g, '');
  if (!cleaned) return '';
  const number = Number(cleaned);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid money value: ${value}`);
  return Number.isInteger(number) ? String(number) : String(number);
}

function normalizePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function joinExpiry(month, year) {
  if (!month || !year) return '';
  const mm = String(month).replace(/\D/g, '').padStart(2, '0').slice(-2);
  let yy = String(year).replace(/\D/g, '');
  if (yy.length === 4 && yy.startsWith('20')) yy = yy.slice(2);
  yy = yy.padStart(2, '0').slice(-2);
  return `${mm}${yy}`;
}

function normalizeCountry(country) {
  const value = String(country || '').trim();
  if (!value) return 'US';
  if (/^(us|usa|united states|u\.s\.|u\.s\.a\.|美国)$/i.test(value)) return 'US';
  return value;
}

function normalizeState(state) {
  const value = String(state || '').trim();
  const upper = value.toUpperCase();
  const map = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
    CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
    HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
    KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
    MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
    NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
    OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
    SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
    VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
    WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
  };
  return map[upper] || value;
}

function maskCard(number) {
  const digits = String(number || '').replace(/\D/g, '');
  return {
    last4: digits.slice(-4),
    masked: digits ? `****${digits.slice(-4)}` : '',
  };
}

function normalizeExpiry(expiry) {
  const digits = String(expiry || '').replace(/\D/g, '');
  if (digits.length === 4) return digits;
  if (digits.length === 6 && digits.startsWith('20')) return `${digits.slice(4)}${digits.slice(2, 4)}`;
  return String(expiry || '').replace(/\s/g, '');
}

function displayExpiry(expiry) {
  const normalized = normalizeExpiry(expiry);
  const digits = normalized.replace(/\D/g, '');
  if (digits.length !== 4) return '';
  const month = String(Number(digits.slice(0, 2)));
  return `${month}/20${digits.slice(2, 4)}`;
}

function maskPaymentMethod(pm) {
  return {
    type: pm?.type || '',
    brand: pm?.brand || pm?.card?.brand || '',
    last4: pm?.last4 || pm?.card?.last4 || '',
    expiry: (pm?.exp_month && pm?.exp_year)
      ? `${pm.exp_month}/${pm.exp_year}`
      : (pm?.card?.exp_month && pm?.card?.exp_year ? `${pm.card.exp_month}/${pm.card.exp_year}` : ''),
  };
}

function adsPowerHeaders(apiKey) {
  const headers = {'Content-Type': 'application/json'};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function postJson(url, body, headers) {
  const res = await fetchWithTimeout(url, {method: 'POST', headers, body: JSON.stringify(body)}, DEFAULT_ADSPOWER_HTTP_TIMEOUT_MS);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = {raw: text}; }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  if (typeof data.code === 'number' && data.code !== 0) throw new Error(`AdsPower code ${data.code}: ${data.msg || text.slice(0, 300)}`);
  return data;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_ADSPOWER_HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...options, signal: controller.signal});
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`HTTP timeout after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAdsPowerEndpoint(data) {
  const ws = data?.data?.ws?.puppeteer
    || data?.data?.ws?.puppeteer_url
    || data?.data?.ws
    || data?.ws?.puppeteer
    || data?.ws?.puppeteer_url
    || data?.ws
    || '';
  const port = data?.data?.debug_port
    || data?.data?.debugPort
    || data?.debug_port
    || data?.debugPort
    || (String(ws).match(/127\.0\.0\.1:(\d+)/) || [])[1]
    || '';
  return {
    browserWs: typeof ws === 'string' ? ws : '',
    debugPort: port ? String(port) : '',
  };
}

function tryGetTargets(debugPort, timeoutSec = 3) {
  const raw = execFileSync('curl', ['-sS', '--max-time', String(timeoutSec), `http://127.0.0.1:${debugPort}/json/list`], {encoding: 'utf8'});
  return JSON.parse(raw);
}

function tryGetBrowserWs(debugPort, timeoutSec = 3) {
  const raw = execFileSync('curl', ['-sS', '--max-time', String(timeoutSec), `http://127.0.0.1:${debugPort}/json/version`], {encoding: 'utf8'});
  const data = JSON.parse(raw);
  return data.webSocketDebuggerUrl || '';
}

async function waitForDebugEndpoint(input, timeoutMs = DEFAULT_ADSPOWER_START_TIMEOUT_MS) {
  input.debugPort ||= debugPortFromWs(input.browserWs);
  if (!input.debugPort) return {ready: false, reason: 'missing debugPort'};
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      input.browserWs ||= tryGetBrowserWs(input.debugPort, 3);
      const targets = tryGetTargets(input.debugPort, 3);
      if (Array.isArray(targets)) {
        return {
          ready: true,
          debugPort: input.debugPort,
          browserWs: input.browserWs,
          targetCount: targets.length,
        };
      }
    } catch (error) {
      lastError = error.message;
    }
    await sleep(800);
  }
  return {
    ready: false,
    debugPort: input.debugPort,
    browserWs: input.browserWs,
    reason: lastError || 'debug endpoint did not become ready',
  };
}

function isBlankPageTarget(target) {
  const url = String(target?.url || '');
  return target?.type === 'page' && (!url || url === 'about:blank' || /^chrome:\/\/(newtab|new-tab-page)/i.test(url));
}

async function closeBlankPageTargets(input, keepTargetIds = []) {
  input.debugPort ||= debugPortFromWs(input.browserWs);
  if (!input.debugPort) return {attempted: false, closed: 0, reason: 'missing debugPort'};
  input.browserWs ||= getBrowserWs(input.debugPort);
  if (!input.browserWs) return {attempted: false, closed: 0, reason: 'missing browserWs'};

  const keep = new Set(keepTargetIds.filter(Boolean));
  const blankTargets = getTargets(input.debugPort)
    .filter((target) => isBlankPageTarget(target) && !keep.has(target.id));
  if (!blankTargets.length) return {attempted: true, closed: 0};

  const browser = await cdp(input.browserWs);
  const closed = [];
  const failed = [];
  try {
    for (const target of blankTargets) {
      try {
        const result = await browser.send('Target.closeTarget', {targetId: target.id}, 5000);
        if (result.success !== false) closed.push(target.id);
        else failed.push({id: target.id, reason: 'success=false'});
      } catch (error) {
        failed.push({id: target.id, reason: error.message});
      }
    }
  } finally {
    browser.close();
  }
  await sleep(500);
  return {attempted: true, closed: closed.length, failed};
}

async function primeOpenRouterTarget(input) {
  input.debugPort ||= debugPortFromWs(input.browserWs);
  if (!input.debugPort) return {ok: false, reason: 'missing debugPort'};
  input.browserWs ||= getBrowserWs(input.debugPort);
  if (!input.browserWs) return {ok: false, reason: 'missing browserWs'};

  const startupUrl = input.startupUrl || OPENROUTER_CREDITS_URL;
  let targets = getTargets(input.debugPort);
  let pageTarget = targets.find((target) => target.type === 'page' && target.url.startsWith(startupUrl));
  let createdTargetId = '';
  if (!pageTarget) {
    const browser = await cdp(input.browserWs);
    try {
      const created = await browser.send('Target.createTarget', {url: startupUrl}, 10000);
      createdTargetId = created.targetId || '';
    } finally {
      browser.close();
    }
    await sleep(1200);
    targets = getTargets(input.debugPort);
    pageTarget = targets.find((target) => (
      target.type === 'page'
      && (target.id === createdTargetId || target.url.startsWith(startupUrl))
    ));
  }

  const cleanup = await closeBlankPageTargets(input, pageTarget?.id ? [pageTarget.id] : []);
  return {
    ok: !!pageTarget,
    startupUrl,
    created: !!createdTargetId,
    targetId: pageTarget?.id || createdTargetId || '',
    targetUrl: pageTarget?.url || '',
    blankCleanup: cleanup,
  };
}

async function startProfileIfNeeded(input) {
  if (input.debugPort || input.browserWs) {
    const preflight = await waitForDebugEndpoint(input, Math.min(input.adspowerStartTimeoutMs, 10000));
    if (preflight.ready) {
      const openRouterTarget = await primeOpenRouterTarget(input).catch((error) => ({ok: false, error: error.message}));
      input.launch = {source: 'provided-endpoint', endpoint: preflight, openRouterTarget};
      return input;
    }
    if (!input.profileNo && !input.profileId) {
      throw new Error(`Provided AdsPower debug endpoint is not ready: ${JSON.stringify(preflight)}`);
    }
    input.debugPort = '';
    input.browserWs = '';
  }

  const headers = adsPowerHeaders(input.adspowerApiKey);
  const payload = {
    last_opened_tabs: '0',
    proxy_detection: '0',
    password_filling: '0',
    password_saving: '0',
  };
  if (input.profileId) payload.profile_id = input.profileId;
  if (input.profileNo) payload.profile_no = input.profileNo;

  const attempts = [
    {
      name: 'v2 browser-profile/start',
      run: async () => postJson(`${input.adspowerApiBase}/api/v2/browser-profile/start`, payload, headers),
    },
    async () => {
      const qs = new URLSearchParams();
      if (input.profileId) qs.set('user_id', input.profileId);
      if (input.profileNo) qs.set('serial_number', input.profileNo);
      const res = await fetchWithTimeout(`${input.adspowerApiBase}/api/v1/browser/start?${qs.toString()}`, {headers}, DEFAULT_ADSPOWER_HTTP_TIMEOUT_MS);
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
      const data = JSON.parse(text);
      if (typeof data.code === 'number' && data.code !== 0) throw new Error(`AdsPower code ${data.code}: ${data.msg || text.slice(0, 300)}`);
      return data;
    },
  ].map((attempt) => typeof attempt === 'function' ? {name: 'v1 browser/start', run: attempt} : attempt);

  const errors = [];
  for (const attempt of attempts) {
    try {
      const data = await attempt.run();
      const endpoint = normalizeAdsPowerEndpoint(data);
      if (endpoint.browserWs) input.browserWs = endpoint.browserWs;
      if (endpoint.debugPort) input.debugPort = endpoint.debugPort;
      const ready = await waitForDebugEndpoint(input, input.adspowerStartTimeoutMs);
      if (ready.ready) {
        const openRouterTarget = await primeOpenRouterTarget(input).catch((error) => ({ok: false, error: error.message}));
        input.launch = {source: attempt.name, endpoint: ready, openRouterTarget};
        return input;
      }
      errors.push(`${attempt.name}: ${JSON.stringify(ready)}`);
    } catch (error) {
      errors.push(`${attempt.name}: ${error.message}`);
    }
  }

  throw new Error(`Could not start AdsPower profile or attach CDP endpoint: ${errors.join(' | ')}`);
}

let globalMessageId = 0;

function cdp(wsUrl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Map();
    const timer = setTimeout(() => reject(new Error(`CDP connect timeout: ${wsUrl}`)), timeoutMs);

    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        on(method, handler) {
          if (!listeners.has(method)) listeners.set(method, new Set());
          listeners.get(method).add(handler);
          return () => listeners.get(method)?.delete(handler);
        },
        send(method, params = {}, commandTimeoutMs = timeoutMs) {
          const msg = {id: ++globalMessageId, method, params};
          ws.send(JSON.stringify(msg));
          return new Promise((res, rej) => {
            const commandTimer = setTimeout(() => {
              pending.delete(msg.id);
              rej(new Error(`CDP command timeout: ${method}`));
            }, commandTimeoutMs);
            pending.set(msg.id, {res, rej, method, commandTimer});
          });
        },
        close() {
          try { ws.close(); } catch {}
        },
      });
    };
    ws.onerror = (event) => reject(new Error(`CDP websocket error: ${event.message || wsUrl}`));
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) {
        const eventListeners = listeners.get(message.method);
        if (eventListeners) {
          for (const handler of eventListeners) {
            try { handler(message.params || {}); } catch {}
          }
        }
        return;
      }
      const pendingCommand = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(pendingCommand.commandTimer);
      if (message.error) {
        pendingCommand.rej(new Error(`${pendingCommand.method}: ${JSON.stringify(message.error)}`));
      } else {
        pendingCommand.res(message.result);
      }
    };
  });
}

function debugPortFromWs(wsUrl) {
  return (String(wsUrl || '').match(/127\.0\.0\.1:(\d+)/) || [])[1] || '';
}

function getTargets(debugPort) {
  return tryGetTargets(debugPort, 5);
}

function getBrowserWs(debugPort) {
  return tryGetBrowserWs(debugPort, 5);
}

async function evaluate(client, expression, timeoutMs = 15000) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, timeoutMs);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

function navigationHrefMatchesTarget(targetUrl, href) {
  try {
    const target = new URL(targetUrl);
    const current = new URL(href);
    const targetWithoutHash = `${target.origin}${target.pathname}${target.search}`;
    const currentWithoutHash = `${current.origin}${current.pathname}${current.search}`;
    if (currentWithoutHash === targetWithoutHash) return true;
    return current.origin === target.origin && /\/(?:login|sign-in|signin|auth)(?:\/|$)/i.test(current.pathname);
  } catch {
    return false;
  }
}

async function waitForNavigationReady(client, targetUrl, timeoutMs = DEFAULT_NAVIGATION_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await evaluate(client, `(() => ({
      href: location.href,
      readyState: document.readyState,
      title: document.title || ''
    }))()`, 5000).catch((error) => ({error: error.message}));
    if (
      !lastState?.error
      && (lastState.readyState === 'interactive' || lastState.readyState === 'complete')
      && navigationHrefMatchesTarget(targetUrl, lastState.href)
    ) {
      return lastState;
    }
    await sleep(DEFAULT_DOM_POLL_MS);
  }
  throw new Error(`navigation ready timeout after ${timeoutMs}ms: ${JSON.stringify(lastState || {})}`);
}

async function navigatePage(client, url, options = {}) {
  const commandTimeoutMs = options.commandTimeoutMs || DEFAULT_NAVIGATION_COMMAND_TIMEOUT_MS;
  const readyTimeoutMs = options.readyTimeoutMs || DEFAULT_NAVIGATION_READY_TIMEOUT_MS;
  const retries = Math.max(1, Number(options.retries || DEFAULT_NAVIGATION_RETRIES));
  let lastError = null;

  await client.send('Page.enable', {}, 5000).catch(() => {});

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await client.send('Page.navigate', {url}, commandTimeoutMs);
      return await waitForNavigationReady(client, url, readyTimeoutMs);
    } catch (error) {
      lastError = error;
      const alreadyReady = await waitForNavigationReady(client, url, 5000).catch(() => null);
      if (alreadyReady) return alreadyReady;

      await client.send('Page.stopLoading', {}, 5000).catch(() => {});

      try {
        await evaluate(client, `location.href = ${JSON.stringify(url)}; true`, 5000);
        return await waitForNavigationReady(client, url, readyTimeoutMs);
      } catch (fallbackError) {
        lastError = fallbackError;
      }

      if (attempt < retries) await sleep(1000 * attempt);
    }
  }

  throw new Error(`CDP navigation failed after ${retries} attempts: ${lastError?.message || 'unknown error'}`);
}

async function ensureCreditsPage(page) {
  const state = await evaluate(page, `(() => ({
    href: location.href,
    hasCreditsUi: /Add Credits|Auto\\s*Top[- ]?Up/i.test(document.body.innerText || ''),
  }))()`).catch(() => ({href: '', hasCreditsUi: false}));
  if (state.href.startsWith(OPENROUTER_CREDITS_URL) && state.hasCreditsUi) {
    return {navigated: false, state};
  }
  await navigatePage(page, OPENROUTER_CREDITS_URL);
  await sleep(1000);
  return {navigated: true, state};
}

async function fetchStripeData(page) {
  return evaluate(page, `(async () => {
    const res = await fetch('/api/internal/v1/stripe');
    const text = await res.text();
    if (!res.ok) return {ok:false, status:res.status, text:text.slice(0, 500)};
    const json = text ? JSON.parse(text) : {};
    return {
      ok: true,
      customerEmail: json.data?.customer?.email || '',
      paymentMethods: (json.data?.paymentMethods || []).map((pm) => ({
        type: pm.type || '',
        brand: pm.card?.brand || '',
        last4: pm.card?.last4 || '',
        exp_month: pm.card?.exp_month || null,
        exp_year: pm.card?.exp_year || null,
      })),
    };
  })()`);
}

async function verifySavedPaymentMethodForAutoTopup(page, expectedAccount) {
  const stripe = await fetchStripeData(page);
  if (!stripe.ok) {
    throw new Error(`Could not verify saved payment method before Auto top-up: ${stripe.status} ${stripe.text}`);
  }
  const expected = String(expectedAccount || '').trim().toLowerCase();
  const customerEmail = String(stripe.customerEmail || '').trim().toLowerCase();
  if (expected && customerEmail && expected !== customerEmail) {
    throw new Error(`Stripe customer mismatch before Auto top-up: expected ${expectedAccount}, got ${stripe.customerEmail}`);
  }
  if (!stripe.paymentMethods.length) {
    throw new Error('Saved payment method is required before Auto top-up configuration');
  }
  return {
    verified: true,
    paymentMethodCount: stripe.paymentMethods.length,
    paymentMethods: stripe.paymentMethods.map(maskPaymentMethod),
  };
}

async function clearDefaultPaymentMethod(page) {
  const before = await fetchStripeData(page);
  if (!before.ok) {
    if (before.status === 404) {
      return {
        clearedDefault: false,
        skipped: true,
        reason: /Customer not found/i.test(before.text || '')
          ? 'stripe_customer_not_found'
          : 'stripe_data_not_found',
        existingPaymentMethodCount: 0,
        existingPaymentMethods: [],
      };
    }
    throw new Error(`Could not read Stripe data before clearing default payment method: ${before.status} ${before.text}`);
  }

  const updateResult = await evaluate(page, `(async () => {
    const res = await fetch(location.href, {
      method: 'POST',
      headers: {
        'Next-Action': ${JSON.stringify(UPDATE_CURRENT_USER_ACTION)},
        'Content-Type': 'text/plain;charset=UTF-8',
        'Accept': 'text/x-component',
      },
      body: JSON.stringify([{stripe_payment_method_id:null, stripe_payment_method_backup_list:[]}]),
    });
    const text = await res.text();
    return {
      ok: res.ok && /"__kind":"OK"/.test(text) && /"stripe_payment_method_id":null/.test(text),
      status: res.status,
      text: text.slice(0, 1200),
    };
  })()`, 20000);
  if (!updateResult.ok) {
    if (/Server action not found/i.test(updateResult.text || '')) {
      await navigatePage(page, OPENROUTER_CREDITS_URL).catch(() => null);
      await sleep(500);
      return {
        clearedDefault: false,
        skipped: true,
        reason: 'openrouter_update_current_user_action_not_found',
        existingPaymentMethodCount: before.paymentMethods.length,
        existingPaymentMethods: before.paymentMethods.map(maskPaymentMethod),
      };
    }
    throw new Error(`Could not clear default payment method: ${updateResult.status} ${updateResult.text}`);
  }

  await navigatePage(page, OPENROUTER_CREDITS_URL);
  await sleep(1500);
  return {
    clearedDefault: true,
    existingPaymentMethodCount: before.paymentMethods.length,
    existingPaymentMethods: before.paymentMethods.map(maskPaymentMethod),
  };
}

async function ensureOpenRouterPage(input) {
  input.debugPort ||= debugPortFromWs(input.browserWs);
  if (!input.debugPort) throw new Error('No debugPort available');
  input.browserWs ||= getBrowserWs(input.debugPort);
  await primeOpenRouterTarget(input).catch(() => null);

  let targets = getTargets(input.debugPort);
  let pageTarget = targets.find((target) => (
    target.type === 'page'
    && target.url.startsWith(OPENROUTER_CREDITS_URL)
  ));

  if (!pageTarget) {
    pageTarget = targets.find((target) => target.type === 'page' && /^https?:/.test(target.url));
    if (pageTarget) {
      const page = await cdp(pageTarget.webSocketDebuggerUrl);
      await page.send('Runtime.enable');
      await navigatePage(page, OPENROUTER_CREDITS_URL);
      page.close();
    } else if (input.browserWs) {
      const browser = await cdp(input.browserWs);
      await browser.send('Target.createTarget', {url: OPENROUTER_CREDITS_URL});
      browser.close();
    } else {
      throw new Error('No page target available in AdsPower browser');
    }
    await sleep(2000);
    targets = getTargets(input.debugPort);
    pageTarget = targets.find((target) => (
      target.type === 'page'
      && target.url.startsWith(OPENROUTER_CREDITS_URL)
    ));
  }

  if (!pageTarget) throw new Error('OpenRouter Credits page target not found after navigation');
  await closeBlankPageTargets(input, [pageTarget.id]).catch(() => null);
  return pageTarget.webSocketDebuggerUrl;
}

async function waitForPaymentTarget(debugPort, timeoutMs = DEFAULT_STRIPE_IFRAME_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastStripeTargets = [];
  let lastCandidateState = null;
  while (Date.now() < deadline) {
    const targets = getTargets(debugPort);
    lastStripeTargets = targets
      .filter((item) => item.type === 'iframe' && /stripe\.com/.test(item.url || ''))
      .map((item) => item.url.split('#')[0])
      .slice(0, 8);
    const candidates = targets.filter((item) => (
      item.type === 'iframe'
      && /elements-inner/.test(item.url)
      && /componentName=payment/.test(item.url)
    ));
    for (const target of candidates) {
      let frame;
      try {
        frame = await cdp(target.webSocketDebuggerUrl, 3000);
        await frame.send('Runtime.enable').catch(() => {});
        const state = await evaluate(frame, `(() => {
          const text = document.body.innerText || '';
          const hasCardNumber = !!document.querySelector('#payment-numberInput');
          const cardTabSelected = /Card\\s+selected/i.test(text) || /Card number/i.test(text);
          return {
            hasCardNumber,
            cardTabSelected,
            tail: text.slice(-500),
          };
        })()`, 3000);
        lastCandidateState = state;
        if (state.hasCardNumber || state.cardTabSelected) return target.webSocketDebuggerUrl;
      } catch (error) {
        lastCandidateState = {error: error.message};
      } finally {
        if (frame) frame.close();
      }
    }
    await sleep(DEFAULT_DOM_POLL_MS);
  }
  throw new Error(`Stripe card payment iframe target not found after ${timeoutMs}ms; stripeTargets=${lastStripeTargets.join(' | ') || 'none'}; lastCandidateState=${JSON.stringify(lastCandidateState || {})}`);
}

async function waitForAddressTarget(debugPort, timeoutMs = DEFAULT_STRIPE_IFRAME_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastUrls = [];
  let lastStates = [];
  while (Date.now() < deadline) {
    const targets = getTargets(debugPort);
    lastUrls = targets
      .filter((item) => item.type === 'iframe' && /stripe\.com/.test(item.url || ''))
      .map((item) => item.url.split('#')[0])
      .slice(0, 6);
    const candidates = targets.filter((item) => (
      item.type === 'iframe'
      && /stripe\.com/.test(item.url)
      && /elements-inner-address/.test(item.url)
      && /componentName=address/.test(item.url)
    ));
    lastStates = [];
    for (const target of candidates) {
      if (!target.webSocketDebuggerUrl) continue;
      let frame;
      try {
        frame = await cdp(target.webSocketDebuggerUrl, 3000);
        await frame.send('Runtime.enable');
        const state = await evaluate(frame, `(() => {
          const visible = (node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const controls = [...document.querySelectorAll('input,select,[contenteditable="true"]')].filter(visible);
          return {
            readyState: document.readyState,
            controlCount: controls.length,
            text: (document.body.innerText || '').slice(0, 500),
          };
        })()`, 3000);
        lastStates.push({url: target.url.split('#')[0], ...state});
        if (state.controlCount > 0) return target.webSocketDebuggerUrl;
      } catch (error) {
        lastStates.push({url: target.url.split('#')[0], error: error.message});
      } finally {
        if (frame) frame.close();
      }
    }
    await sleep(SLOW_DOM_POLL_MS);
  }
  throw new Error(`Stripe address iframe not ready; stripeTargets=${lastUrls.join(' | ')}; states=${JSON.stringify(lastStates).slice(0, 1200)}`);
}

async function detectSecurityChallenge(debugPort) {
  for (const target of getTargets(debugPort).filter((item) => /hcaptcha|captcha|3dsecure|acs|challenge/i.test(item.url))) {
    const url = target.url || '';
    if (/hcaptcha-invisible|checkbox-invisible/i.test(url)) continue;
    let frame;
    try {
      frame = await cdp(target.webSocketDebuggerUrl, 3000);
      await frame.send('Runtime.enable');
      const state = await evaluate(frame, `(() => ({
        url: location.href,
        text: (document.body.innerText || '').slice(0, 500),
      }))()`, 3000);
      if (/select all|complete the security|hcaptcha|captcha|3D Secure|bank verification|security code|authentication required/i.test(state.text || '')) {
        return state;
      }
    } catch {
      if (/3dsecure|acs/i.test(target.url) || (/challenge/i.test(target.url) && !/hcaptcha|captcha/i.test(target.url))) {
        return {url: target.url, text: ''};
      }
    } finally {
      if (frame) frame.close();
    }
  }
  return null;
}

async function clickByText(page, pattern, options = {}) {
  const expression = `(() => {
    const rx = new RegExp(${JSON.stringify(pattern)}, 'i');
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const candidates = [...document.querySelectorAll('button,a,[role="button"]')]
      .filter((node) => isVisible(node));
    const el = candidates.find((node) => {
      const text = (node.innerText || node.textContent || '').trim();
      return rx.test(text) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
    });
    if (!el) return {clicked:false, tail:(document.body.innerText || '').slice(-1500)};
    el.scrollIntoView({block:'center', inline:'center'});
    el.click();
    return {clicked:true, label:(el.innerText || el.textContent || '').trim()};
  })()`;
  const result = await evaluate(page, expression);
  if (!result.clicked && options.required !== false) {
    throw new Error(`Button not found: ${pattern}; tail=${result.tail}`);
  }
  return result;
}

async function clickExactText(page, label, options = {}) {
  const expression = `(() => {
    const wanted = ${JSON.stringify(label)}.trim().replace(/\\s+/g, ' ');
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isDisabled = (node) => !!node.disabled || node.getAttribute('aria-disabled') === 'true';
    const candidates = [...document.querySelectorAll('button,a,[role="button"]')]
      .filter((node) => isVisible(node) && !isDisabled(node));
    let el = candidates.find((node) => (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' ') === wanted);
    if (!el) {
      const textNodeOwner = [...document.querySelectorAll('body *')].find((node) => (
        isVisible(node)
        &&
        (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' ') === wanted
      ));
      el = textNodeOwner?.closest('button,a,[role="button"]') || null;
    }
    if (!el || !isVisible(el) || isDisabled(el)) return {clicked:false, tail:(document.body.innerText || '').slice(-1500)};
    el.scrollIntoView({block:'center', inline:'center'});
    el.click();
    return {clicked:true, label:(el.innerText || el.textContent || '').trim()};
  })()`;
  const result = await evaluate(page, expression);
  if (!result.clicked && options.required !== false) {
    throw new Error(`Button not found: ${label}; tail=${result.tail}`);
  }
  return result;
}

async function clickAddPaymentMethod(page, options = {}) {
  const expression = `(() => {
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isDisabled = (node) => !!node.disabled || node.getAttribute('aria-disabled') === 'true';
    const normalize = (value) => String(value || '').trim().replace(/\\s+/g, ' ');
    const isPlusIconButton = (node) => {
      const pathD = [...node.querySelectorAll?.('svg path') || []].map((path) => path.getAttribute('d') || '').join(' ');
      const className = String(node.getAttribute('class') || '');
      return /M12\\s*4\\.5v15m7\\.5-7\\.5h-15/i.test(pathD)
        || (/\\bw-10\\b/.test(className) && /\\bh-full\\b/.test(className) && !!node.querySelector?.('svg'));
    };
    const candidates = [...document.querySelectorAll('button,a,[role="button"]')]
      .filter((node) => isVisible(node) && !isDisabled(node))
      .map((node) => ({node, text: normalize(node.innerText || node.textContent || node.getAttribute('aria-label') || ''), plusIcon: isPlusIconButton(node)}));
    let item = candidates.find((candidate) => /^Add a Payment Method$|^Add Payment Method$/i.test(candidate.text));
    if (!item) {
      item = candidates.find((candidate) => /\\bAdd a Payment Method\\b|\\bAdd Payment Method\\b/i.test(candidate.text));
    }
    if (!item) {
      const textOwner = [...document.querySelectorAll('body *')]
        .filter((node) => isVisible(node))
        .map((node) => ({node, text: normalize(node.innerText || node.textContent || '')}))
        .find((candidate) => /\\bAdd a Payment Method\\b|\\bAdd Payment Method\\b/i.test(candidate.text));
      const owner = textOwner?.node.closest('button,a,[role="button"]');
      if (owner && isVisible(owner) && !isDisabled(owner)) item = {node: owner, text: normalize(owner.innerText || owner.textContent || '')};
    }
    if (!item && /Purchase Credits/i.test(document.body.innerText || '')) {
      const modal = [...document.querySelectorAll('body *')]
        .filter((node) => isVisible(node))
        .map((node) => ({node, text: normalize(node.innerText || node.textContent || ''), rect: node.getBoundingClientRect()}))
        .filter((candidate) => /Purchase Credits/i.test(candidate.text) && /Total due/i.test(candidate.text))
        .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];
      const modalRect = modal?.rect;
      const iconItem = candidates
        .map((candidate) => ({...candidate, rect: candidate.node.getBoundingClientRect(), hasSvg: !!candidate.node.querySelector?.('svg')}))
        .filter((candidate) => {
          if (!modalRect) return false;
          const rect = candidate.rect;
          const inTopCardArea = rect.x > modalRect.x + modalRect.width * 0.62
            && rect.x < modalRect.x + modalRect.width - 35
            && rect.y > modalRect.y + 55
            && rect.y < modalRect.y + modalRect.height * 0.35;
          const plusLike = candidate.plusIcon || candidate.text === '+' || candidate.text === '' || candidate.hasSvg;
          const notClose = rect.y > modalRect.y + 45 && !/close|purchase/i.test(candidate.text);
          return inTopCardArea && plusLike && notClose && rect.width >= 35 && rect.width <= 140 && rect.height >= 45 && rect.height <= 180;
        })
        .sort((a, b) => b.rect.x - a.rect.x || a.rect.y - b.rect.y)[0];
      if (iconItem) item = {node: iconItem.node, text: iconItem.text || 'icon:add-payment-method'};
    }
    if (!item) return {clicked:false, tail:(document.body.innerText || '').slice(-1800)};
    item.node.scrollIntoView({block:'center', inline:'center'});
    item.node.click();
    return {clicked:true, label:item.text};
  })()`;
  const result = await evaluate(page, expression);
  if (!result.clicked && options.required !== false) {
    throw new Error(`Button not found: Add a Payment Method; tail=${result.tail}`);
  }
  return result;
}

async function waitForExactText(page, label, timeoutMs = DEFAULT_DOM_WAIT_MS, options = {}) {
  const deadline = Date.now() + timeoutMs;
  const pollMs = options.pollMs || DEFAULT_DOM_POLL_MS;
  let lastResult = null;
  while (Date.now() < deadline) {
    lastResult = await clickExactText(page, label, {required: false});
    if (lastResult.clicked) return lastResult;
    await sleep(pollMs);
  }
  if (options.refreshOnTimeout) {
    await refreshCreditsPageForRetry(page);
    try {
      const retry = await waitForExactText(page, label, timeoutMs, {...options, refreshOnTimeout: false});
      return {...retry, refreshedOnce: true};
    } catch (error) {
      throw new Error(`Button not found after ${timeoutMs}ms, refreshed once and retried: ${label}; ${error.message}`);
    }
  }
  throw new Error(`Button not found: ${label}; tail=${lastResult?.tail || ''}`);
}

async function waitForClickableText(page, pattern, timeoutMs = DEFAULT_DOM_WAIT_MS, options = {}) {
  const deadline = Date.now() + timeoutMs;
  const pollMs = options.pollMs || DEFAULT_DOM_POLL_MS;
  let lastResult = null;
  while (Date.now() < deadline) {
    lastResult = await clickByText(page, pattern, {required: false});
    if (lastResult.clicked) return lastResult;
    await sleep(pollMs);
  }
  if (options.refreshOnTimeout) {
    await refreshCreditsPageForRetry(page);
    try {
      const retry = await waitForClickableText(page, pattern, timeoutMs, {...options, refreshOnTimeout: false});
      return {...retry, refreshedOnce: true};
    } catch (error) {
      throw new Error(`Button not found after ${timeoutMs}ms, refreshed once and retried: ${pattern}; ${error.message}`);
    }
  }
  throw new Error(`Button not found: ${pattern}; tail=${lastResult?.tail || ''}`);
}

async function getPaymentEntryState(page, expectedLast4 = '', expectedExpiry = '') {
  return evaluate(page, `(() => {
    const text = document.body.innerText || '';
    const last4 = ${JSON.stringify(expectedLast4 || '')};
    const expiry = ${JSON.stringify(expectedExpiry || '')};
    const targetCardVisible = (() => {
      if (!last4) return false;
      const brandAndLast4 = new RegExp('\\\\b(VISA|MASTERCARD|AMEX|AMERICAN EXPRESS|DISCOVER|DINERS|JCB|UNIONPAY)\\\\b[\\\\s\\\\S]*' + last4, 'i');
      if (brandAndLast4.test(text)) return true;
      if (!expiry) return false;
      const safeExpiry = expiry.replace('/', '\\\\/');
      return new RegExp(last4 + '[\\\\s\\\\S]*' + safeExpiry + '|' + safeExpiry + '[\\\\s\\\\S]*' + last4, 'i').test(text);
    })();
    const buttons = [...document.querySelectorAll('button,a,[role="button"]')]
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          node,
          visible: rect.width > 0 && rect.height > 0,
          disabled: !!node.disabled || node.getAttribute('aria-disabled') === 'true',
          text: (node.innerText || node.textContent || node.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' '),
        };
      })
      .filter((item) => item.visible)
      .map((item) => ({text: item.text, disabled: item.disabled}))
      .filter((item) => item.text);
    const clickableButtons = buttons.filter((item) => !item.disabled).map((item) => item.text);
    const buttonLabels = buttons.map((item) => item.text);
    const hasClickableButton = (rx) => clickableButtons.some((label) => rx.test(label));
    const hasAnyButton = (rx) => buttonLabels.some((label) => rx.test(label));
    return {
      hasAddCredits: hasAnyButton(/^Add Credits$/i) || /\\bAdd Credits\\b/.test(text),
      canAddCredits: hasClickableButton(/^Add Credits$/i),
      hasAddPaymentMethod: hasAnyButton(/^Add a Payment Method$|^Add Payment Method$/i) || /\\bAdd a Payment Method\\b|\\bAdd Payment Method\\b/i.test(text),
      canAddPaymentMethod: hasClickableButton(/^Add a Payment Method$|^Add Payment Method$/i),
      hasAddBillingAddress: hasClickableButton(/^Add a Billing Address$|^Add Billing Address$/i) || /\\bAdd a Billing Address\\b|\\bAdd Billing Address\\b/i.test(text),
      hasAddressForm: /Full name|Address line 1|City|State|Postal|Update Address/i.test(text),
      hasSavePaymentMethod: /Save payment method/i.test(text),
      hasCardFormText: /Card number|Expiration date|CVC|Postal code/i.test(text),
      purchase: /Purchase Credits/i.test(text),
      targetCardVisible,
      emailVerificationBlocked: /You must add a verified email to access this feature/i.test(text),
      buttons: clickableButtons,
      disabledButtons: buttons.filter((item) => item.disabled).map((item) => item.text),
      tail: text.slice(-2200),
    };
  })()`);
}

function isBillingAddressFormOpen(state) {
  const tail = state?.tail || '';
  // OpenRouter 新号有时会直接弹出地址表单，此时入口按钮已经不存在，必须继续填地址。
  return !!state?.hasAddressForm
    || /Add a Billing Address[\s\S]{0,1000}(Full name|Address line 1|Complete address details to continue|A billing address is required)/i.test(tail)
    || /A billing address is required to verify your identity/i.test(tail);
}

async function openBillingAddressFormIfNeeded(page) {
  const before = await getPaymentEntryState(page);
  if (before.hasSavePaymentMethod || before.hasCardFormText || isBillingAddressFormOpen(before)) {
    return {opened: false, alreadyOpen: isBillingAddressFormOpen(before), state: before};
  }
  if (!before.hasAddBillingAddress && !/Complete address details to continue/i.test(before.tail)) {
    return {opened: false, state: before};
  }

  const clicked = await clickByText(page, '^Add a Billing Address$|^Add Billing Address$', {required: false});
  await sleep(clicked.clicked ? 1500 : 500);
  return {
    opened: clicked.clicked,
    clicked,
    state: await getPaymentEntryState(page),
  };
}

async function fillStripeBillingAddress(debugPort, billing) {
  const targetWs = await waitForAddressTarget(debugPort, DEFAULT_STRIPE_IFRAME_WAIT_MS);
  const address = await cdp(targetWs);
  try {
    await address.send('Runtime.enable');
    const values = {
      name: billing.name,
      country: billing.country || 'US',
      addressLine1: billing.addressLine1,
      city: billing.city,
      state: billing.state,
      postalCode: billing.postalCode,
    };
    const result = await evaluate(address, `(() => {
      const values = ${JSON.stringify(values)};
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const labelText = (el) => [
        el.name,
        el.id,
        el.placeholder,
        el.getAttribute('aria-label'),
        el.getAttribute('autocomplete'),
        el.labels?.[0]?.innerText,
        el.closest('label')?.innerText,
        el.parentElement?.innerText,
      ].filter(Boolean).join(' ').replace(/\\s+/g, ' ');
      const candidateInputs = () => [...document.querySelectorAll('input,[contenteditable="true"]')]
        .filter((el) => visible(el) && el.type !== 'hidden' && el.type !== 'checkbox' && el.type !== 'radio')
        .map((el, index) => ({el, index, text: labelText(el)}));
      const candidateSelects = () => [...document.querySelectorAll('select')]
        .filter(visible)
        .map((el, index) => ({el, index, text: labelText(el)}));
      const byFixedOrText = (selector, matchers) => {
        const fixed = document.querySelector(selector);
        if (visible(fixed)) return fixed;
        return candidateInputs().find((item) => matchers.some((rx) => rx.test(item.text)))?.el || null;
      };
      const setInput = (selector, matchers, value) => {
        const el = byFixedOrText(selector, matchers);
        if (!el || !value) return false;
        el.focus();
        if (el.isContentEditable) {
          el.textContent = value;
        } else {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
            || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, value);
          else el.value = value;
        }
        try {
          el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:String(value)}));
        } catch {
          el.dispatchEvent(new Event('input', {bubbles:true}));
        }
        el.dispatchEvent(new Event('change', {bubbles:true}));
        return true;
      };
      const setSelect = (selector, matchers, value) => {
        const fixed = document.querySelector(selector);
        const el = visible(fixed)
          ? fixed
          : candidateSelects().find((item) => matchers.some((rx) => rx.test(item.text)))?.el;
        if (!el || !value) return false;
        const normalized = String(value).trim().toLowerCase();
        const option = [...el.options].find((item) => (
          item.value === value
          || item.value.trim().toLowerCase() === normalized
          || item.text.trim().toLowerCase() === normalized
          || item.value.trim().toLowerCase().startsWith(normalized)
          || item.text.trim().toLowerCase().startsWith(normalized)
        ));
        if (!option) {
          return {
            ok: false,
            options: [...el.options].map((item) => ({value: item.value, text: item.text})).slice(0, 20),
          };
        }
        el.focus();
        el.value = option.value;
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
        return {ok: true, value: el.value, text: option.text};
      };
      const country = setSelect('#billingAddress-countryInput, select[name="country"]', [/country/i], values.country || 'US')
        || setInput('#billingAddress-countryInput, input[name="country"]', [/country/i], values.country || 'US');
      const state = setSelect('#billingAddress-administrativeAreaInput, select[name="administrativeArea"]', [/administrative|state|province|region/i], values.state)
        || setInput('#billingAddress-administrativeAreaInput, input[name="administrativeArea"]', [/administrative|state|province|region/i], values.state);
      const filled = {
        name: setInput('#billingAddress-nameInput, input[name="name"]', [/full.*name|\\bname\\b/i], values.name),
        country,
        addressLine1: setInput('#billingAddress-addressLine1Input, input[name="addressLine1"]', [/address.*line.*1|address.*1|address/i], values.addressLine1),
        city: setInput('#billingAddress-localityInput, input[name="locality"]', [/city|locality/i], values.city),
        state,
        postalCode: setInput('#billingAddress-postalCodeInput, input[name="postalCode"]', [/postal|zip/i], values.postalCode),
      };
      return {
        filled,
        inputs: candidateInputs().map((item) => ({index:item.index, text:item.text.slice(0, 200), value:item.el.isContentEditable ? item.el.textContent : item.el.value})),
        selects: candidateSelects().map((item) => ({index:item.index, text:item.text.slice(0, 200), value:item.el.value, options:[...item.el.options].map((option) => option.text).slice(0, 8)})),
        complete: Object.values(filled).every((item) => item === true || item?.ok === true),
      };
    })()`);
    await sleep(1200);
    return {filled: true, via: 'stripe_address_iframe', target: targetWs.split('/').slice(-1)[0], result};
  } finally {
    address.close();
  }
}

async function maybeFillBillingAddress(page, billing, debugPort = '') {
  const text = await evaluate(page, 'document.body.innerText || ""');
  if (!/Complete address details|Update Address|Billing address|Full name|Address line 1|City|State|Postal/i.test(text)) {
    return {filled: false};
  }
  if (/Card number|Save payment method/i.test(text)) return {filled: false};
  try {
    requireBillingAddress(billing);
  } catch (error) {
    throw new Error(`missing_fields: billing address is required by this account; ${error.message}`);
  }

  if (debugPort && /Add a Billing Address|Complete address details|Update Address/i.test(text)) {
    try {
      const stripeAddress = await fillStripeBillingAddress(debugPort, billing);
      if (stripeAddress.result?.complete !== true) {
        const cardForm = await waitForCardFormReady(page, debugPort, 2500).catch(() => null);
        if (cardForm?.ready) {
          return {
            filled: false,
            skipped: true,
            reason: 'card_form_ready_without_required_billing_address',
            stripeAddress,
            cardForm: {ready: cardForm.ready, source: cardForm.source},
          };
        }
        throw new Error(`Billing address form was not completely filled: ${JSON.stringify(stripeAddress.result)}`);
      }
      const clicked = await waitForClickableText(page, 'Update Address|Save|Continue', DEFAULT_DOM_WAIT_MS);
      await sleep(2500);
      return {...stripeAddress, clicked};
    } catch (error) {
      if (!/Stripe address iframe not found/i.test(error.message)) throw error;
    }
  }

  const values = {
    name: billing.name,
    addressLine1: billing.addressLine1,
    city: billing.city,
    state: billing.state,
    postalCode: billing.postalCode,
    country: billing.country || 'US',
  };

  const result = await evaluate(page, `(() => {
    const values = ${JSON.stringify(values)};
    const inputs = [...document.querySelectorAll('input')];
    const fieldText = (el) => [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.labels?.[0]?.innerText].filter(Boolean).join(' ');
    const by = (rx) => inputs.find((input) => rx.test(fieldText(input)));
    const set = (el, value) => {
      if (!el || !value) return false;
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      return true;
    };
    set(by(/name|full/i) || inputs[0], values.name);
    set(by(/address.*1|line.*1/i) || inputs[1], values.addressLine1);
    set(by(/city/i), values.city);
    set(by(/postal|zip/i), values.postalCode);
    const setSelect = (select, value) => {
      if (!select || !value) return false;
      const option = [...select.options].find((item) => (
        item.value === value
        || item.text.trim().toLowerCase() === String(value).trim().toLowerCase()
        || item.value.toLowerCase() === String(value).trim().toLowerCase()
      ));
      if (!option) return false;
      select.value = option.value;
      select.dispatchEvent(new Event('input', {bubbles:true}));
      select.dispatchEvent(new Event('change', {bubbles:true}));
      return true;
    };
    for (const select of document.querySelectorAll('select')) {
      const label = fieldText(select);
      if (/country/i.test(label)) {
        setSelect(select, values.country || 'US');
      }
      if (/state|province|region/i.test(label)) {
        setSelect(select, values.state);
      }
    }
    const button = [...document.querySelectorAll('button,[role="button"]')]
      .find((node) => /Update Address|Save|Continue/i.test((node.innerText || node.textContent || '').trim()) && !node.disabled);
    if (button) {
      button.scrollIntoView({block:'center'});
      button.click();
      return {filled:true, clicked:true, label:(button.innerText || button.textContent || '').trim()};
    }
    return {filled:true, clicked:false};
  })()`);

  await sleep(2500);
  return result;
}

async function focusAndInsertText(client, selector, text) {
  const ok = await evaluate(client, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    if (el.select) el.select();
    return true;
  })()`);
  if (!ok) throw new Error(`Missing Stripe field: ${selector}`);
  await sleep(120);
  await client.send('Input.insertText', {text});
  await sleep(180);
}

async function ensureStripeLinkUnchecked(payment) {
  let lastState = null;
  for (let i = 0; i < 6; i += 1) {
    lastState = await evaluate(payment, `(() => {
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const checkbox = document.querySelector('#payment-linkOptInInput');
      const phone = document.querySelector('#payment-linkMobilePhoneInput');
      const phoneVisible = visible(phone);
      if (checkbox && checkbox.checked) {
        checkbox.scrollIntoView({block:'center', inline:'center'});
        checkbox.click();
      }
      return {
        found: !!checkbox,
        checked: checkbox ? !!checkbox.checked : null,
        phoneVisible,
        phoneInvalidText: /Please provide a mobile phone number/i.test(document.body.innerText || ''),
      };
    })()`);
    if ((lastState.found === false || lastState.checked === false) && !lastState.phoneVisible && !lastState.phoneInvalidText) {
      return lastState;
    }
    await sleep(DEFAULT_DOM_POLL_MS);
  }
  throw new Error(`Stripe Link save-info checkbox or phone subform is still active: ${JSON.stringify(lastState)}`);
}

async function fillStripeCard(payment, card) {
  const deadline = Date.now() + DEFAULT_STRIPE_IFRAME_WAIT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await evaluate(payment, `(() => !!document.querySelector('#payment-numberInput'))()`);
    if (ready) break;
    await sleep(DEFAULT_DOM_POLL_MS);
  }
  if (!ready) throw new Error(`Missing Stripe field after ${DEFAULT_STRIPE_IFRAME_WAIT_MS}ms: #payment-numberInput`);
  await focusAndInsertText(payment, '#payment-numberInput', card.number);
  await focusAndInsertText(payment, '#payment-expiryInput', normalizeExpiry(card.expiry));
  await focusAndInsertText(payment, '#payment-cvcInput', card.cvc);
  const countryState = await evaluate(payment, `(() => {
    const el = document.querySelector('#payment-countryInput');
    if (!el) return {exists:false, changedFromNonUs:false, selected:false};
    const countryText = (node) => {
      if (!node) return '';
      if (node.tagName === 'SELECT') {
        return node.selectedOptions?.[0]?.textContent || '';
      }
      return node.value || node.textContent || '';
    };
    const isUnitedStates = (value, text = '') => /^(us|usa|united states|u\\.s\\.|u\\.s\\.a\\.)$/i.test(String(value || '').trim())
      || /^(us|usa|united states|u\\.s\\.|u\\.s\\.a\\.)$/i.test(String(text || '').trim());
    const beforeValue = el.value || '';
    const beforeText = countryText(el);
    const beforeMeaningful = String(beforeValue || '').trim()
      && !/^(country|select|select country|选择|请选择)$/i.test(String(beforeValue || '').trim());
    el.focus();
    const desired = ${JSON.stringify(normalizeCountry(card.country || 'US'))};
    if (el.tagName === 'SELECT') {
      const option = [...el.options].find((item) => isUnitedStates(item.value, item.textContent))
        || [...el.options].find((item) => String(item.value || '').trim().toLowerCase() === desired.toLowerCase());
      if (option) el.value = option.value;
      else el.value = desired;
    } else {
      el.value = desired;
    }
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
    return {
      exists: true,
      changedFromNonUs: !!beforeMeaningful && !isUnitedStates(beforeValue, beforeText),
      selected: isUnitedStates(el.value, countryText(el)),
      beforeValue,
      beforeText,
      afterValue: el.value || '',
      afterText: countryText(el),
    };
  })()`);
  const postalState = await evaluate(payment, `(() => {
    const el = document.querySelector('#payment-postalCodeInput');
    if (!el) return {exists:false};
    const rect = el.getBoundingClientRect();
    return {exists:true, visible:rect.width > 0 && rect.height > 0, value:el.value || ''};
  })()`);
  if (postalState.exists) {
    if (!card.postalCode) throw new Error('card postalCode is required because Stripe payment postal-code field is visible');
    await focusAndInsertText(payment, '#payment-postalCodeInput', card.postalCode);
  }

  const values = await evaluate(payment, `(() => [...document.querySelectorAll('input,select')].map((el) => ({
    id: el.id,
    value: /numberInput/.test(el.id)
      ? el.value.replace(/.*(\\d{4})$/, '****$1')
      : (/cvc|email|phone/i.test(el.id) ? '***' : el.value),
    checked: !!el.checked,
    label: (el.labels?.[0]?.innerText || '').slice(0, 80),
  })))()`);

  const linkState = countryState.changedFromNonUs && countryState.selected
    ? {
        found: null,
        checked: null,
        skipped: true,
        reason: 'country_changed_to_united_states_before_save',
        country: countryState,
      }
    : await ensureStripeLinkUnchecked(payment);
  await sleep(STRIPE_POST_FILL_SETTLE_MS);
  return {values, linkChecked: linkState.checked, linkState, countryState};
}

async function declineStripeLinkPrompts(debugPort) {
  const results = [];
  for (const target of getTargets(debugPort).filter((item) => /stripe\.com\/v3\//.test(item.url))) {
    let frame;
    try {
      frame = await cdp(target.webSocketDebuggerUrl, 3000);
      await frame.send('Runtime.enable');
      const result = await evaluate(frame, `(() => {
        const button = [...document.querySelectorAll('button,[role="button"]')]
          .find((node) => /No Thanks|Not now|Skip/i.test((node.innerText || node.textContent || '').trim()));
        if (!button) return false;
        button.click();
        return true;
      })()`, 3000);
      results.push({targetId: target.id, clicked: !!result, url: target.url.slice(0, 120)});
    } catch {
      // Accessory Stripe frames often disappear quickly; ignore stale targets.
      results.push({targetId: target.id, clicked: false, stale: true, url: target.url.slice(0, 120)});
    } finally {
      if (frame) frame.close();
    }
  }
  return results;
}

async function dismissSaveCardOverlays(page, debugPort = '') {
  const stripePrompts = debugPort ? await declineStripeLinkPrompts(debugPort) : [];

  const browserBubble = await dismissBrowserChromeBubbles(page);

  const pageState = await evaluate(page, `(() => {
    const text = document.body.innerText || '';
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    return {
      hasPageSaveCardText: /Save card\\?/i.test(text),
      visibleStripeFrames: [...document.querySelectorAll('iframe')]
        .filter((frame) => visible(frame) && /stripe\\.com/i.test(frame.src || ''))
        .map((frame) => ({src: (frame.src || '').slice(0, 120), rect: (() => {
          const rect = frame.getBoundingClientRect();
          return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
        })()})),
    };
  })()`).catch((error) => ({error: error.message}));

  return {stripePrompts, browserBubble, pageState};
}

async function dismissBrowserChromeBubbles(page) {
  if (!page) return {attempted: false};
  await page.send('Page.bringToFront').catch(() => {});
  const escapes = [];
  for (let i = 0; i < 4; i += 1) {
    const down = await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27}).then(() => true).catch(() => false);
    const up = await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27}).then(() => true).catch(() => false);
    escapes.push({down, up});
    await sleep(180);
  }
  const clickAway = await evaluate(page, `(() => ({
    x: Math.round(window.innerWidth * 0.42),
    y: Math.round(Math.max(120, window.innerHeight * 0.18)),
  }))()`).catch(() => ({x: 500, y: 140}));
  await page.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: clickAway.x, y: clickAway.y}).catch(() => {});
  await page.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: clickAway.x, y: clickAway.y, button: 'left', clickCount: 1}).catch(() => {});
  await page.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: clickAway.x, y: clickAway.y, button: 'left', clickCount: 1}).catch(() => {});
  await sleep(300);
  return {attempted: true, escapes, clickAway};
}

async function waitUntilSaveModalCloses(page) {
  for (let i = 0; i < 60; i += 1) {
    const state = await evaluate(page, `(() => {
      const text = document.body.innerText || '';
      return {
        stillSave: /Save payment method/.test(text),
        challenge: /hCaptcha|3D Secure|complete the security|security code|bank verification|SMS|passkey|suspicious/i.test(text),
        hasAddCredits: /Add Credits/.test(text),
        tail: text.slice(-1500),
      };
    })()`);
    if (state.challenge) throw new Error(`Security challenge visible: ${state.tail}`);
    if (!state.stillSave && state.hasAddCredits) return state;
    await sleep(SLOW_DOM_POLL_MS);
  }
  const state = await evaluate(page, `(() => ({tail:(document.body.innerText || '').slice(-2000)}))()`);
  throw new Error(`Save modal did not close: ${state.tail}`);
}

async function verifyByPurchaseModal(page, expectedLast4, expectedExpiry) {
  await waitForExactText(page, 'Add Credits', DEFAULT_CREDITS_ENTRY_WAIT_MS, {refreshOnTimeout: true});
  return waitForPurchaseCard(page, expectedLast4, expectedExpiry, DEFAULT_DOM_WAIT_MS, {refreshOnTimeout: true});
}

async function waitForPurchaseCard(page, expectedLast4, expectedExpiry, timeoutMs = DEFAULT_DOM_WAIT_MS, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    const verified = await evaluate(page, `(() => {
      const text = document.body.innerText || '';
      const last4 = ${JSON.stringify(expectedLast4)};
      const expiry = ${JSON.stringify(expectedExpiry)};
      const brandAndLast4 = new RegExp('\\\\b(VISA|MASTERCARD|AMEX|AMERICAN EXPRESS|DISCOVER|DINERS|JCB|UNIONPAY)\\\\b[\\\\s\\\\S]*' + last4, 'i');
      return {
        purchase: /Purchase Credits/.test(text),
        stillSaving: /Save payment method/.test(text),
        hasAddCredits: /Add Credits/.test(text),
        verified: brandAndLast4.test(text) || new RegExp(last4 + '[\\\\s\\\\S]*' + expiry.replace('/', '\\\\/') + '|' + expiry.replace('/', '\\\\/') + '[\\\\s\\\\S]*' + last4, 'i').test(text),
        tail: text.slice(-2000),
      };
    })()`);
    state = verified;
    if (verified.purchase && verified.verified) return verified;
    if (!verified.purchase && verified.hasAddCredits && !verified.stillSaving) {
      await clickExactText(page, 'Add Credits', {required: false});
    }
    await sleep(SLOW_DOM_POLL_MS);
  }
  if (options.refreshOnTimeout) {
    await refreshCreditsPageForRetry(page);
    await waitForExactText(page, 'Add Credits', DEFAULT_CREDITS_ENTRY_WAIT_MS);
    try {
      const retry = await waitForPurchaseCard(page, expectedLast4, expectedExpiry, timeoutMs, {...options, refreshOnTimeout: false});
      return {...retry, refreshedOnce: true};
    } catch (error) {
      throw new Error(`Saved card was not visible after ${timeoutMs}ms, refreshed once and retried: ${error.message}`);
    }
  }
  if (!state) state = await evaluate(page, `(() => ({tail:(document.body.innerText || '').slice(-2500)}))()`);
  throw new Error(`Saved card was not visible in Purchase Credits modal after ${timeoutMs}ms: ${state.tail}`);
}

const PURCHASE_MODAL_DOM_HELPERS = String.raw`
const visible = (node) => {
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};
const textOf = (node) => (node.innerText || node.textContent || node.getAttribute('aria-label') || '')
  .trim()
  .replace(/\s+/g, ' ');
const checkedOf = (node) => !!node.checked || node.getAttribute('aria-checked') === 'true' || node.getAttribute('data-state') === 'checked';
const switchControlSelector = 'button[role="switch"],[role="switch"],button[aria-checked],button[data-state],input[type="checkbox"]';
const isSwitchControl = (node) => (
  node.matches?.(switchControlSelector)
  && !node.disabled
  && node.getAttribute('aria-disabled') !== 'true'
);
const rectOf = (node) => {
  const rect = node.getBoundingClientRect();
  return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
};
const purchaseDialog = () => {
  const dialogs = [...document.querySelectorAll('[role="dialog"],section,article,form,main,div')]
    .filter((node) => visible(node) && /Purchase Credits/i.test(textOf(node)) && /Total\s+due/i.test(textOf(node)))
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (ar.width * ar.height) - (br.width * br.height);
    });
  return dialogs[0] || document.body;
};
const sanitizeSwitch = (item) => {
  if (!item) return null;
  return {
    checked: item.checked,
    method: item.method,
    rect: item.rect,
    text: item.text,
    ariaLabel: item.ariaLabel,
  };
};
const findSwitchByLabel = (labelPattern) => {
  const dialog = purchaseDialog();
  const labels = [...dialog.querySelectorAll('label,span,p,div')]
    .filter((node) => visible(node) && labelPattern.test(textOf(node)))
    .sort((a, b) => {
      const at = textOf(a);
      const bt = textOf(b);
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return at.length - bt.length || (ar.width * ar.height) - (br.width * br.height) || ar.y - br.y;
    });
  const label = labels[0] || null;
  if (!label) return {found:false, ambiguous:false, checked:null, reason:'label_not_found'};

  const labelRect = label.getBoundingClientRect();
  const controls = [...dialog.querySelectorAll(switchControlSelector)]
    .filter((node) => visible(node) && isSwitchControl(node))
    .map((node) => ({
      node,
      checked: checkedOf(node),
      rect: rectOf(node),
      text: textOf(node),
      ariaLabel: node.getAttribute('aria-label') || '',
      ariaLabelledby: node.getAttribute('aria-labelledby') || '',
    }));

  const semantic = controls.filter((item) => {
    if (item.ariaLabel && labelPattern.test(item.ariaLabel)) return true;
    if (label.id && item.ariaLabelledby.split(/\s+/).includes(label.id)) return true;
    const labelAncestor = item.node.closest('label');
    return labelAncestor && (labelAncestor === label || labelAncestor.contains(label));
  });

  const geometric = controls
    .filter((item) => (
      Math.abs((item.rect.y + item.rect.height / 2) - (labelRect.y + labelRect.height / 2)) < 55
      && item.rect.x > labelRect.x
    ))
    .sort((a, b) => (
      Math.abs((a.rect.y + a.rect.height / 2) - (labelRect.y + labelRect.height / 2))
      - Math.abs((b.rect.y + b.rect.height / 2) - (labelRect.y + labelRect.height / 2))
      || a.rect.x - b.rect.x
    ));

  const candidates = [...new Map([...(semantic.length ? semantic : geometric)].map((item) => [item.node, item])).values()];
  const labelInfo = {text: textOf(label), rect: rectOf(label)};
  if (candidates.length !== 1) {
    return {
      found:true,
      ambiguous:candidates.length > 1,
      checked:null,
      reason:candidates.length ? 'multiple_switch_candidates' : 'switch_not_found',
      label: labelInfo,
      candidates: candidates.map(sanitizeSwitch),
    };
  }
  return {
    found:true,
    ambiguous:false,
    checked:candidates[0].checked,
    node:candidates[0].node,
    label: labelInfo,
    candidate: sanitizeSwitch(candidates[0]),
  };
};
`;

async function getPurchaseModalState(page) {
  return evaluate(page, `(() => {
    ${PURCHASE_MODAL_DOM_HELPERS}
    const text = document.body.innerText || '';
    const controls = [...document.querySelectorAll('input,button,[role="button"],[role="switch"]')]
      .filter((node) => visible(node))
      .map((node, index) => {
        const rect = node.getBoundingClientRect();
        return {
          index,
          tag: node.tagName,
          role: node.getAttribute('role') || '',
          type: node.type || '',
          text: (node.innerText || node.textContent || node.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' '),
          value: node.value || '',
          checked: !!node.checked || node.getAttribute('aria-checked') === 'true' || node.getAttribute('data-state') === 'checked',
          disabled: !!node.disabled || node.getAttribute('aria-disabled') === 'true',
          rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
        };
      });
    const totalMatch = text.match(/Total\\s+due\\s+\\$\\s*([\\d,.]+)/i);
    const serviceFeeMatch = text.match(/Service\\s+fees\\s+\\$\\s*([\\d,.]+)/i);
    const amountControl = controls.find((item) => item.tag === 'INPUT' && item.type === 'number' && item.rect.y > 100)
      || controls.find((item) => item.tag === 'INPUT' && /number|text/.test(item.type) && item.rect.y > 100)
      || controls.find((item) => item.tag === 'INPUT' && /number|text/.test(item.type));
    const invoiceSwitchRaw = findSwitchByLabel(/\\bSend me invoices\\b/i);
    const {node: _invoiceSwitchNode, ...invoiceSwitch} = invoiceSwitchRaw;
    return {
      purchase: /Purchase Credits/i.test(text),
      amountValue: amountControl?.value || '',
      sendInvoicesText: invoiceSwitch.found || /Send me invoices/i.test(text),
      sendInvoicesChecked: invoiceSwitch.found && !invoiceSwitch.ambiguous ? invoiceSwitch.checked === true : false,
      sendInvoicesSwitch: invoiceSwitch,
      purchaseButton: controls.find((item) => /^Purchase$/i.test(item.text) && !item.disabled) || null,
      totalDue: totalMatch ? totalMatch[1] : '',
      serviceFee: serviceFeeMatch ? serviceFeeMatch[1] : '',
      controls,
      tail: text.slice(-2200),
    };
  })()`);
}

async function getCurrentCreditBalance(page) {
  const state = await evaluate(page, `(() => {
    const text = document.body.innerText || '';
    const ariaBalance = [...document.querySelectorAll('[aria-label]')]
      .map((node) => node.getAttribute('aria-label') || '')
      .find((label) => /Remaining credits:\\s*[-+]?\\d/i.test(label));
    const ariaMatch = ariaBalance?.match(/Remaining credits:\\s*([-+]?[0-9][\\d,]*(?:\\.\\d+)?)/i) || null;
    const normalized = text.replace(/\\s+/g, ' ');
    const beforeBuy = normalized.split(/\\b(?:Buy|Add)\\s+Credits\\b|\\bAuto\\s*Top[- ]?Up\\b/i)[0] || normalized;
    const fromCreditsBlock = beforeBuy.match(/\\$\\s*([0-9][\\d,]*(?:\\.\\d+)?)/);
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const elements = [...document.querySelectorAll('main *, body *')]
      .filter((node) => visible(node))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          text: (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' '),
          rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
          fontSize: Number.parseFloat(style.fontSize || '0') || 0,
        };
      })
      .filter((item) => /\\$\\s*[0-9]/.test(item.text) && !/Service\\s+fees|Total\\s+due|Sales\\s+Tax|VAT/i.test(item.text));
    const elementCandidate = elements
      .map((item) => {
        const match = item.text.match(/\\$\\s*([0-9][\\d,]*(?:\\.\\d+)?)/);
        return match ? {...item, rawAmount: match[1]} : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.fontSize - a.fontSize || a.rect.y - b.rect.y)[0] || null;
    const raw = ariaMatch?.[1] || fromCreditsBlock?.[1] || elementCandidate?.rawAmount || '';
    const balance = raw ? Number(raw.replace(/,/g, '')) : null;
    return {
      balance: Number.isFinite(balance) ? balance : null,
      raw,
      source: ariaMatch ? 'aria_remaining_credits' : (fromCreditsBlock ? 'credits_text_block' : (elementCandidate ? 'visible_element' : 'not_found')),
      account: (text.match(/Personal Account:\\s*([^\\n]+)/) || [])[1] || '',
      tail: text.slice(-1800),
    };
  })()`);
  if (!Number.isFinite(state.balance)) {
    throw new Error(`Could not parse current OpenRouter credit balance: ${state.tail}`);
  }
  return state;
}

async function resolvePurchasePlan(page, purchase) {
  if (!purchase.confirmed) return purchase;
  const balanceState = await getCurrentCreditBalance(page);
  if (purchase.rule?.enabled) {
    const threshold = normalizeMoneyForCompare(purchase.rule.threshold);
    const targetBalance = normalizeMoneyForCompare(purchase.rule.targetBalance);
    if (Number.isFinite(targetBalance)) {
      if (!Number.isFinite(threshold)) {
        throw new Error(`Invalid purchase target rule: ${JSON.stringify(purchase.rule)}`);
      }
      const branch = balanceState.balance < threshold ? 'below_threshold' : 'at_or_above_threshold';
      const rawAmount = Math.ceil(targetBalance - balanceState.balance);
      const atOrAboveAmount = normalizeMoneyValue(purchase.rule.atOrAboveAmount);
      const amount = branch === 'below_threshold'
        ? (rawAmount > 0 ? String(rawAmount) : '')
        : atOrAboveAmount;
      return {
        ...purchase,
        amount,
        skippedByRule: !amount,
        ruleDecision: {
          mode: 'top_up_to_target',
          threshold: purchase.rule.threshold,
          targetBalance: purchase.rule.targetBalance,
          atOrAboveAmount,
          balance: balanceState.balance,
          balanceRaw: balanceState.raw,
          balanceSource: balanceState.source,
          branch,
          selectedAmount: amount,
          skipped: !amount,
        },
        beforeBalance: {
          balance: balanceState.balance,
          raw: balanceState.raw,
          source: balanceState.source,
        },
      };
    }
    const belowAmount = normalizeMoneyValue(purchase.rule.belowAmount);
    const atOrAboveAmount = normalizeMoneyValue(purchase.rule.atOrAboveAmount);
    if (!Number.isFinite(threshold) || !belowAmount || !atOrAboveAmount) {
      throw new Error(`Invalid purchase rule: ${JSON.stringify(purchase.rule)}`);
    }
    const branch = balanceState.balance < threshold ? 'below_threshold' : 'at_or_above_threshold';
    const amount = branch === 'below_threshold' ? belowAmount : atOrAboveAmount;
    return {
      ...purchase,
      amount,
      ruleDecision: {
        threshold: purchase.rule.threshold,
        belowAmount,
        atOrAboveAmount,
        balance: balanceState.balance,
        balanceRaw: balanceState.raw,
        balanceSource: balanceState.source,
        branch,
        selectedAmount: amount,
      },
      beforeBalance: {
        balance: balanceState.balance,
        raw: balanceState.raw,
        source: balanceState.source,
      },
    };
  }
  if (!purchase.amount) throw new Error('Purchase amount is required');
  return {
    ...purchase,
    beforeBalance: {
      balance: balanceState.balance,
      raw: balanceState.raw,
      source: balanceState.source,
    },
  };
}

async function setPurchaseAmountInput(page, amount) {
  const value = normalizeMoneyValue(amount);
  if (!value) throw new Error('Purchase amount is required');
  const result = await evaluate(page, `(() => {
    ${PURCHASE_MODAL_DOM_HELPERS}
    const value = ${JSON.stringify(String(value))};
    const labelText = (input) => [
      input.name,
      input.id,
      input.placeholder,
      input.getAttribute('aria-label'),
      input.labels?.[0]?.innerText,
      input.closest('label')?.innerText,
      input.parentElement?.innerText,
      input.closest('[role="group"]')?.innerText,
      input.closest('form,[role="dialog"],section,article,div')?.innerText,
    ].filter(Boolean).join(' ').replace(/\\s+/g, ' ');
    const inputs = [...document.querySelectorAll('input')]
      .filter((input) => visible(input) && !input.disabled && input.type !== 'checkbox' && input.type !== 'radio' && input.type !== 'hidden')
      .map((input, index) => {
        const rect = input.getBoundingClientRect();
        return {input, index, rect, text: labelText(input)};
      });
    const candidate = inputs.find((item) => /creditAmount/i.test(item.text))
      || inputs.find((item) => item.input.type === 'number' && /\\bAmount\\b|Purchase\\s+Credits/i.test(item.text))
      || inputs.find((item) => item.input.type === 'number')
      || inputs.find((item) => /\\bAmount\\b|Purchase\\s+Credits/i.test(item.text));
    if (!candidate) {
      return {
        updated:false,
        reason:'amount_input_not_found',
        inputs:inputs.map((item) => ({index:item.index, type:item.input.type || '', value:item.input.value || '', text:item.text.slice(0, 300)})),
        tail:(document.body.innerText || '').slice(-1800),
      };
    }
    const input = candidate.input;
    const before = input.value || '';
    input.scrollIntoView({block:'center', inline:'center'});
    input.focus();
    if (input.select) input.select();
    const nativeValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    if (nativeValue) nativeValue.call(input, value);
    else input.value = value;
    try {
      input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:value}));
    } catch {
      input.dispatchEvent(new Event('input', {bubbles:true}));
    }
    input.dispatchEvent(new Event('change', {bubbles:true}));
    input.blur();
    return {
      updated: input.value === value,
      index: candidate.index,
      before,
      value: input.value || '',
      text: candidate.text.slice(0, 300),
      rect: {x:candidate.rect.x, y:candidate.rect.y, width:candidate.rect.width, height:candidate.rect.height},
    };
  })()`);
  if (!result.updated) {
    throw new Error(`Purchase amount input did not retain ${value}: ${JSON.stringify(result)}`);
  }
  await sleep(350);
  return result;
}

async function ensureOneTimePaymentMethodsOff(page) {
  const result = await evaluate(page, `(() => {
    const text = document.body.innerText || '';
    if (!/Use one-time payment methods/i.test(text)) {
      return {found:false, checked:null, clicked:false};
    }
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOf = (node) => (node.innerText || node.textContent || node.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
    const label = [...document.querySelectorAll('body *')]
      .filter((node) => visible(node) && /Use one-time payment methods/i.test(textOf(node)))
      .sort((a, b) => {
        const at = textOf(a);
        const bt = textOf(b);
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return at.length - bt.length || (ar.width * ar.height) - (br.width * br.height) || ar.y - br.y;
      })[0];
    const labelRect = label?.getBoundingClientRect();
    const controls = [...document.querySelectorAll('button,[role="switch"],input[type="checkbox"]')]
      .filter((node) => visible(node) && (node.getAttribute('role') === 'switch' || node.matches('input[type="checkbox"]')))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          node,
          rect,
          checked: !!node.checked || node.getAttribute('aria-checked') === 'true' || node.getAttribute('data-state') === 'checked',
          text: textOf(node),
        };
      });
    const switchLike = controls
      .filter((item) => !labelRect || Math.abs(item.rect.y - labelRect.y) < 90)
      .sort((a, b) => {
        if (!labelRect) return b.rect.x - a.rect.x;
        return Math.abs(a.rect.y - labelRect.y) - Math.abs(b.rect.y - labelRect.y) || b.rect.x - a.rect.x;
      })[0];
    if (!switchLike) return {found:true, checked:null, clicked:false, reason:'switch not found'};
    if (switchLike.checked) {
      switchLike.node.click();
      return {found:true, checked:true, clicked:true};
    }
    return {found:true, checked:false, clicked:false};
  })()`);
  await sleep(result.clicked ? 900 : 200);
  const verified = await evaluate(page, `(() => {
    const text = document.body.innerText || '';
    if (!/Use one-time payment methods/i.test(text)) return {found:false, checked:null};
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOf = (node) => (node.innerText || node.textContent || node.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
    const label = [...document.querySelectorAll('body *')]
      .filter((node) => visible(node) && /Use one-time payment methods/i.test(textOf(node)))
      .sort((a, b) => {
        const at = textOf(a);
        const bt = textOf(b);
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return at.length - bt.length || (ar.width * ar.height) - (br.width * br.height) || ar.y - br.y;
      })[0];
    const labelRect = label?.getBoundingClientRect();
    const controls = [...document.querySelectorAll('button,[role="switch"],input[type="checkbox"]')]
      .filter((node) => visible(node) && (node.getAttribute('role') === 'switch' || node.matches('input[type="checkbox"]')))
      .map((node) => ({node, rect: node.getBoundingClientRect(), checked: !!node.checked || node.getAttribute('aria-checked') === 'true' || node.getAttribute('data-state') === 'checked'}));
    const switchLike = controls
      .filter((item) => !labelRect || Math.abs(item.rect.y - labelRect.y) < 90)
      .sort((a, b) => {
        if (!labelRect) return b.rect.x - a.rect.x;
        return Math.abs(a.rect.y - labelRect.y) - Math.abs(b.rect.y - labelRect.y) || b.rect.x - a.rect.x;
      })[0];
    return {found:true, checked: switchLike ? switchLike.checked : null};
  })()`);
  if (verified.found && verified.checked !== false) {
    throw new Error(`Use one-time payment methods is visible but not confirmed off: ${JSON.stringify({initial: result, verified})}`);
  }
  return {initial: result, verified};
}

async function ensurePurchaseInvoiceChecked(page) {
  const result = await evaluate(page, `(() => {
    ${PURCHASE_MODAL_DOM_HELPERS}
    const text = document.body.innerText || '';
    if (!/Send me invoices/i.test(text)) {
      return {found:false, checked:null, clicked:false};
    }
    const invoiceSwitchRaw = findSwitchByLabel(/\\bSend me invoices\\b/i);
    const {node, ...invoiceSwitch} = invoiceSwitchRaw;
    if (!invoiceSwitch.found) {
      return {found:true, checked:null, clicked:false, reason:invoiceSwitch.reason || 'label not found', switch:invoiceSwitch};
    }
    if (invoiceSwitch.ambiguous || !node) {
      return {found:true, checked:null, clicked:false, ambiguous:!!invoiceSwitch.ambiguous, reason:invoiceSwitch.reason || 'switch not found', switch:invoiceSwitch};
    }
    if (!invoiceSwitch.checked) {
      node.click();
      return {found:true, checked:false, clicked:true, switch:invoiceSwitch};
    }
    return {found:true, checked:true, clicked:false, switch:invoiceSwitch};
  })()`);
  await sleep(result.clicked ? 800 : 200);
  if (result.found && (result.ambiguous || result.checked == null)) {
    throw new Error(`Send me invoices switch could not be uniquely confirmed: ${JSON.stringify(result)}`);
  }
  const state = await getPurchaseModalState(page);
  if (result.found && state.sendInvoicesSwitch?.ambiguous) {
    throw new Error(`Send me invoices switch is ambiguous; refusing purchase: ${JSON.stringify(state.sendInvoicesSwitch)}`);
  }
  if (result.found && state.sendInvoicesSwitch?.found && state.sendInvoicesSwitch.checked !== true) {
    throw new Error(`Send me invoices is visible but not confirmed checked: ${state.tail}`);
  }
  if (result.found && state.sendInvoicesText && !state.sendInvoicesChecked) {
    throw new Error(`Send me invoices is visible but not confirmed checked: ${state.tail}`);
  }
  return {initial: result, state};
}

async function preparePurchase(page, purchase, timeoutMs = DEFAULT_DOM_WAIT_MS) {
  const amount = normalizeMoneyValue(purchase.amount);
  if (!amount) throw new Error('Purchase amount is required');
  if (purchase.debugPort) {
    await declineStripeLinkPrompts(purchase.debugPort).catch(() => []);
  }
  const amountInput = await setPurchaseAmountInput(page, amount);
  const invoices = await ensurePurchaseInvoiceChecked(page);
  const oneTimePaymentMethods = await ensureOneTimePaymentMethodsOff(page);

  let state = null;
  const expectedAmount = normalizeMoneyForCompare(amount);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    state = await getPurchaseModalState(page);
    if (state.sendInvoicesText && state.sendInvoicesSwitch?.ambiguous) {
      throw new Error(`Send me invoices switch is ambiguous; refusing purchase: ${JSON.stringify(state.sendInvoicesSwitch)}`);
    }
    const modalAmount = normalizeMoneyForCompare(state.amountValue);
    const totalDue = normalizeMoneyForCompare(state.totalDue);
    if (
      state.purchase
      && modalAmount === expectedAmount
      && Number.isFinite(totalDue)
      && totalDue >= expectedAmount
      && state.purchaseButton
      && (!state.sendInvoicesText || state.sendInvoicesChecked)
    ) {
      return {ready: true, amount, amountInput, totalDue: state.totalDue, serviceFee: state.serviceFee, invoices, oneTimePaymentMethods, state};
    }
    await sleep(500);
  }
  throw new Error(`Purchase modal is not ready after ${timeoutMs}ms: ${state?.tail || ''}`);
}

async function clickPurchaseButton(page) {
  const clicked = await evaluate(page, `(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const button = [...document.querySelectorAll('button,[role="button"]')]
      .filter((node) => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true')
      .find((node) => /^Purchase$/i.test((node.innerText || node.textContent || '').trim()));
    if (!button) return {clicked:false, tail:(document.body.innerText || '').slice(-1600)};
    button.scrollIntoView({block:'center', inline:'center'});
    button.click();
    return {clicked:true, label:(button.innerText || button.textContent || '').trim()};
  })()`);
  if (!clicked.clicked) throw new Error(`Purchase button not clickable: ${clicked.tail}`);
  await sleep(2500);
  return clicked;
}

async function acceptJavascriptDialogIfAny(page, timeoutMs = 1500) {
  return page.send('Page.handleJavaScriptDialog', {accept: true}, timeoutMs)
    .then(() => ({handled: true}))
    .catch(() => ({handled: false}));
}

async function waitForJavascriptDialog(page, timeoutMs = 8000, debugDir = '', label = 'native-dialog') {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const handled = await acceptJavascriptDialogIfAny(page, 700);
    if (handled.handled) {
      const result = {
        handled: true,
        attempts,
        waitedMs: Date.now() - startedAt,
      };
      writeDiagnostic(debugDir, `${label}-accepted`, {kind: 'native_js_dialog', ...result});
      await sleep(1200);
      await captureDiagnosticScreenshot(page, debugDir, `${label}-after-accepted`, {
        kind: 'native_js_dialog',
        ...result,
      }).catch(() => null);
      return result;
    }
    await sleep(500);
  }
  const result = {
    handled: false,
    attempts,
    waitedMs: Date.now() - startedAt,
  };
  writeDiagnostic(debugDir, `${label}-not-present`, {kind: 'native_js_dialog', ...result});
  return result;
}

async function clickPurchaseConfirmationIfPresent(page, debugPort = '', debugDir = '') {
  await captureDiagnosticScreenshot(page, debugDir, 'after-purchase-before-confirmation-detection', {
    kind: 'main_page_before_detection',
  }).catch(() => null);
  await sleep(4000);
  const nativeDialog = await waitForJavascriptDialog(page, 8000, debugDir, 'purchase-native-dialog');
  if (nativeDialog.handled) {
    return {confirmed: true, method: 'native_dialog'};
  }
  return {confirmed: false, method: 'native_dialog_not_present', state: nativeDialog};
}

async function waitForPurchaseResult(page, debugPort = '', timeoutMs = DEFAULT_DOM_WAIT_MS, debugDir = '') {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
	  while (Date.now() < deadline) {
	    lastState = await evaluate(page, `(() => {
      const text = document.body.innerText || '';
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const issueNode = [...document.querySelectorAll('body *')]
        .filter((node) => visible(node) && /Error:\\s*Payment\\s+Issue/i.test(node.innerText || node.textContent || ''))
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const nodeText = (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' ');
          return {node, text:nodeText, area:rect.width * rect.height};
        })
        .filter((item) => item.text.length > 'Error: Payment Issue'.length)
        .sort((a, b) => b.text.length - a.text.length || a.area - b.area)[0] || null;
      const issueNodeText = issueNode ? issueNode.text : '';
      const paymentIssueMatch = text.match(/Error:\\s*Payment\\s+Issue[\\s\\S]{0,900}?((?:Your card was declined|Payment Issue)[^\\n.]*(?:\\.[^\\n.]*)?)/i);
      const genericPaymentIssue = /Error:\\s*Payment\\s+Issue/i.test(text);
      const paymentIssueText = issueNodeText || (paymentIssueMatch ? paymentIssueMatch[1].trim() : ((text.match(/Your card was declined[^\\n]*/i) || [])[0] || (genericPaymentIssue ? 'Error: Payment Issue' : '')));
      return {
        paymentIssue: genericPaymentIssue || !!paymentIssueMatch || /Your card was declined/i.test(text),
        paymentIssueText,
        submittedOrClosed: /payment succeeded|purchase successful|credits added|transaction|invoice|Recent Transactions|Payment successful|successfully/i.test(text) && !/Purchase Credits[\\s\\S]*Total due/i.test(text),
        stillPurchase: /Purchase Credits[\\s\\S]*Total due/i.test(text),
        href: location.href,
        tail: text.slice(-2500),
      };
    })()`).catch(async (error) => {
      const dialog = await waitForJavascriptDialog(page, 8000, debugDir, 'purchase-result-native-dialog-after-evaluate-error');
      if (dialog.handled) {
        return {submittedOrClosed: false, stillPurchase: false, acceptedDialog: true, error: error.message, tail: ''};
      }
      return {submittedOrClosed: false, stillPurchase: true, error: error.message, tail: ''};
    });
    writeDiagnostic(debugDir, 'purchase-result-poll', {
      kind: 'purchase_result_poll',
      state: lastState,
    });
    if (lastState.paymentIssue) {
      return {verified: false, declined: true, state: lastState};
    }
    if (lastState.submittedOrClosed || !lastState.stillPurchase) return {submitted: true, state: lastState};
    await sleep(500);
  }
  return {submitted: false, state: lastState};
}

async function recoverPurchaseAfterAutomationTimeout(page, purchase, debugPort = '', debugDir = '') {
  const confirmations = [];
  const nativeDialog = await waitForJavascriptDialog(page, 10000, debugDir, 'timeout-recovery-native-dialog');
  if (nativeDialog.handled) confirmations.push({method: 'native_dialog'});
  writeDiagnostic(debugDir, 'timeout-recovery-confirmation-pass', {
    kind: 'timeout_recovery',
    nativeDialog,
    confirmations,
  });

  const beforeBalance = Number.isFinite(purchase?.beforeBalance?.balance) ? purchase.beforeBalance.balance : null;
  const amount = purchase?.amount || purchase?.ruleDecision?.selectedAmount || '';
  if (Number.isFinite(beforeBalance) && amount) {
    const balanceVerification = await verifyPurchaseBalanceChange(page, beforeBalance, amount, 60000);
    if (balanceVerification.declined) {
      throw new Error(`payment_issue_card_declined: ${balanceVerification.issue?.message || 'Payment Issue'}`);
    }
    if (balanceVerification.verified) {
      return {
        recovered: true,
        confirmations,
        balanceVerification,
      };
    }
    if (confirmations.length) {
      throw new Error(`purchase_unverified: payment confirmation accepted after automation timeout; balance did not increase; ${JSON.stringify(balanceVerification)}`);
    }
  }

  return {recovered: false, confirmations};
}

async function verifyPurchaseBalanceChange(page, beforeBalance, amount, timeoutMs = DEFAULT_DOM_WAIT_MS) {
  const expectedAmount = normalizeMoneyForCompare(amount);
  if (!Number.isFinite(beforeBalance) || !Number.isFinite(expectedAmount)) {
    return {verified: null, reason: 'missing_before_balance_or_amount'};
  }
  const deadline = Date.now() + timeoutMs;
  let lastBalance = null;
  let lastError = '';
  let lastRefreshAt = 0;
  while (Date.now() < deadline) {
    try {
      if (!lastRefreshAt || Date.now() - lastRefreshAt >= BALANCE_VERIFY_REFRESH_INTERVAL_MS) {
        await navigatePage(page, OPENROUTER_CREDITS_URL);
        lastRefreshAt = Date.now();
        await sleep(PAGE_SETTLE_MS);
        await dismissInterferingOverlays(page).catch(() => null);
      }
      const issue = await detectPaymentIssue(page).catch(() => null);
      if (issue?.found) {
        return {
          verified: false,
          declined: true,
          beforeBalance,
          expectedIncrease: expectedAmount,
          issue,
        };
      }
      const balanceState = await getCurrentCreditBalance(page);
      lastBalance = balanceState;
      if (isRechargeBalanceIncreaseVerified(beforeBalance, balanceState.balance)) {
        return {
          verified: true,
          beforeBalance,
          afterBalance: balanceState.balance,
          expectedIncrease: expectedAmount,
          verificationRule: 'after_balance_gt_before_balance',
          balanceSource: balanceState.source,
        };
      }
      const transaction = await findRecentTransactionAmount(page, expectedAmount).catch(() => null);
      if (transaction?.found) {
        return {
          verified: true,
          beforeBalance,
          afterBalance: balanceState.balance,
          expectedIncrease: expectedAmount,
          verificationRule: 'recent_transaction_amount',
          balanceSource: balanceState.source,
          transaction,
        };
      }
    } catch (error) {
      lastError = error.message;
    }
    await sleep(3000);
  }
  return {
    verified: false,
    beforeBalance,
    expectedIncrease: expectedAmount,
    lastBalance,
    lastError,
    verificationRule: 'after_balance_gt_before_balance',
  };
}

async function findRecentTransactionAmount(page, expectedAmount) {
  const target = Number(expectedAmount);
  if (!Number.isFinite(target) || target <= 0) return {found: false, reason: 'missing_expected_amount'};
  return evaluate(page, `((expectedAmount) => {
    const text = document.body.innerText || '';
    const recentIndex = text.search(/Recent Transactions|History/i);
    const scope = recentIndex >= 0 ? text.slice(recentIndex, recentIndex + 2500) : text.slice(0, 2500);
    const escaped = String(expectedAmount).replace(/\\./g, '\\\\.');
    const amountPattern = new RegExp('\\\\$\\\\s*' + escaped + '(?:\\\\.00)?\\\\b');
    const found = amountPattern.test(scope);
    return {
      found,
      expectedAmount,
      source: found ? 'recent_transactions_text' : 'recent_transactions_text_missing',
    };
  })(${JSON.stringify(target)})`);
}

async function detectPaymentIssue(page) {
  return evaluate(page, `(() => {
    const text = document.body.innerText || '';
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const issueNode = [...document.querySelectorAll('body *')]
      .filter((node) => visible(node) && /Error:\\s*Payment\\s+Issue/i.test(node.innerText || node.textContent || ''))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const nodeText = (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' ');
        return {node, text:nodeText, area:rect.width * rect.height};
      })
      .filter((item) => item.text.length > 'Error: Payment Issue'.length)
      .sort((a, b) => b.text.length - a.text.length || a.area - b.area)[0] || null;
    const issueNodeText = issueNode ? issueNode.text : '';
    const match = text.match(/Error:\\s*Payment\\s+Issue[\\s\\S]{0,900}?((?:Your card was declined|Payment Issue)[^\\n.]*(?:\\.[^\\n.]*)?)/i);
    const genericPaymentIssue = /Error:\\s*Payment\\s+Issue/i.test(text);
    const line = issueNodeText || (match ? match[1].trim() : ((text.match(/Your card was declined[^\\n]*/i) || [])[0] || (genericPaymentIssue ? 'Error: Payment Issue' : '')));
    return {
      found: genericPaymentIssue || !!match || /Your card was declined/i.test(text),
      message: line,
      tail: text.slice(-1800),
    };
  })()`);
}

async function executeConfirmedPurchase(page, purchase, debugPort = '', debugDir = '') {
  const purchaseWithDebugPort = {...purchase, debugPort};
  const beforeBalance = Number.isFinite(purchase.beforeBalance?.balance)
    ? purchase.beforeBalance
    : await getCurrentCreditBalance(page);

  let autoTopupPendingRecovery = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await waitForExactText(page, 'Add Credits', DEFAULT_CREDITS_ENTRY_WAIT_MS);
      await clickExactText(page, 'Add Credits', {required: false});
      await sleep(PAGE_SETTLE_MS);
    }
    const prepared = await preparePurchase(page, purchaseWithDebugPort);
    await captureDiagnosticScreenshot(page, debugDir, `purchase-prepared-before-click-attempt-${attempt + 1}`, {
      kind: 'purchase_prepared',
      attempt: attempt + 1,
      amount: prepared.amount,
      beforeBalance,
    }).catch(() => null);
    const clicked = await clickPurchaseButton(page);
    await captureDiagnosticScreenshot(page, debugDir, `after-purchase-button-click-attempt-${attempt + 1}`, {
      kind: 'purchase_clicked',
      attempt: attempt + 1,
      clicked,
    }).catch(() => null);
    const confirmation = await clickPurchaseConfirmationIfPresent(page, debugPort, debugDir);
    writeDiagnostic(debugDir, `purchase-confirmation-result-attempt-${attempt + 1}`, {
      kind: 'purchase_confirmation_result',
      attempt: attempt + 1,
      confirmation,
    });
    const result = await waitForPurchaseResult(page, debugPort, 30000, debugDir);
    if (result.declined) {
      const message = result.state?.paymentIssueText || 'Payment Issue';
      if (attempt === 0 && /automatic top[- ]up might be pending/i.test(message)) {
        autoTopupPendingRecovery = {
          skipped: true,
          reason: 'auto_topup_disable_recovery_removed',
        };
        writeDiagnostic(debugDir, 'purchase-auto-topup-pending-recovery', {
          kind: 'purchase_auto_topup_pending_recovery',
          message,
          recovery: autoTopupPendingRecovery,
        });
        await sleep(2500);
        continue;
      }
      throw new Error(`payment_issue_card_declined: ${message}`);
    }
    const balanceVerification = await verifyPurchaseBalanceChange(page, beforeBalance.balance, prepared.amount);
    writeDiagnostic(debugDir, `purchase-balance-verification-attempt-${attempt + 1}`, {
      kind: 'purchase_balance_verification',
      attempt: attempt + 1,
      balanceVerification,
    });
    if (balanceVerification.declined) {
      throw new Error(`payment_issue_card_declined: ${balanceVerification.issue?.message || 'Payment Issue'}`);
    }
    if (!balanceVerification.verified) {
      throw new Error(`purchase_unverified: balance did not increase; ${JSON.stringify(balanceVerification)}`);
    }
    return {
      executed: true,
      amount: prepared.amount,
      totalDue: prepared.totalDue,
      serviceFee: prepared.serviceFee,
      sendInvoices: prepared.state.sendInvoicesText ? prepared.state.sendInvoicesChecked : null,
      oneTimePaymentMethods: prepared.oneTimePaymentMethods.verified.found ? 'off' : 'not_visible',
      ruleDecision: purchase.ruleDecision || null,
      beforeBalance,
      clicked,
      confirmation,
      result,
      autoTopupPendingRecovery,
      balanceVerification,
    };
  }
  throw new Error('payment_issue_card_declined: automatic top-up might be pending after retry');
}

async function clickSavedPaymentMethod(page, expectedLast4, expectedExpiry) {
  const result = await evaluate(page, `(() => {
    const last4 = ${JSON.stringify(expectedLast4)};
    const expiry = ${JSON.stringify(expectedExpiry)};
    const normalizedExpiry = expiry.replace('/20', '/');
    const candidates = [...document.querySelectorAll('button,a,[role="button"]')];
    const el = candidates.find((node) => {
      const text = (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' ');
      return text.includes(last4)
        && (text.includes(expiry) || text.includes(normalizedExpiry))
        && !node.disabled
        && node.getAttribute('aria-disabled') !== 'true';
    });
    if (!el) return {clicked:false, tail:(document.body.innerText || '').slice(-1500)};
    el.scrollIntoView({block:'center', inline:'center'});
    el.click();
    return {clicked:true, label:(el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ')};
  })()`);
  if (!result.clicked) {
    throw new Error(`Saved payment method not found for last4 ${expectedLast4}: ${result.tail}`);
  }
  return result;
}

async function removeSavedPaymentMethodsFromPicker(page) {
  const removed = [];

  await waitForExactText(page, 'Add Credits', DEFAULT_CREDITS_ENTRY_WAIT_MS, {refreshOnTimeout: true});
  await sleep(1200);

  for (let i = 0; i < 8; i += 1) {
    const result = await evaluate(page, `(() => {
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const buttons = [...document.querySelectorAll('button,a,[role="button"],svg,[aria-label],[title]')]
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          return {
            node,
            index,
            text: (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' '),
            title: node.getAttribute('title') || '',
            aria: node.getAttribute('aria-label') || '',
            disabled: !!node.disabled || node.getAttribute('aria-disabled') === 'true',
            rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
          };
        })
        .filter((item) => visible(item.node) && !item.disabled);

      const card = buttons
        .filter((item) => (
          /\\b(VISA|MASTERCARD|AMEX|AMERICAN EXPRESS|DISCOVER)\\b/i.test(item.text)
          && /\\(\\d{4}\\)/.test(item.text)
          && /\\d{1,2}\\s*\\/\\s*20\\d{2}/.test(item.text)
        ))
        .sort((a, b) => a.rect.y - b.rect.y)[0];
      if (!card) {
        return {
          clicked: false,
          done: true,
          hasSave: /Save payment method/.test(document.body.innerText || ''),
          tail: (document.body.innerText || '').slice(-1800),
        };
      }

      const trash = buttons
        .filter((item) => (
          item.index !== card.index
          && !item.text
          && item.rect.width >= 18
          && item.rect.width <= 42
          && item.rect.height >= 18
          && item.rect.height <= 42
          && item.rect.y >= card.rect.y - 8
          && item.rect.y <= card.rect.y + card.rect.height - 8
          && item.rect.x >= card.rect.x + card.rect.width - 110
          && item.rect.x <= card.rect.x + card.rect.width + 20
        ))
        .sort((a, b) => a.rect.y - b.rect.y)[0];

      if (!trash) {
        const points = [
          {x: card.rect.x + card.rect.width - 32, y: card.rect.y + 18},
          {x: card.rect.x + card.rect.width - 30, y: card.rect.y + card.rect.height / 2},
          {x: card.rect.x + card.rect.width - 62, y: card.rect.y + 18},
        ];
        for (const point of points) {
          const target = document.elementFromPoint(point.x, point.y);
          if (!target) continue;
          target.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, clientX:point.x, clientY:point.y}));
          target.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true, clientX:point.x, clientY:point.y}));
          target.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:point.x, clientY:point.y}));
          return {
            clicked: true,
            done: false,
            card: card.text,
            trashRect: {x: point.x, y: point.y, width: 0, height: 0},
            fallback: 'elementFromPoint',
            target: target.tagName,
          };
        }
        return {
          clicked: false,
          done: false,
          card: {text: card.text, rect: card.rect},
          buttons: buttons.map(({node, ...item}) => item).slice(-35),
          tail: (document.body.innerText || '').slice(-1800),
        };
      }

      trash.node.scrollIntoView({block:'center', inline:'center'});
      trash.node.click();
      return {
        clicked: true,
        done: false,
        card: card.text,
        trashRect: trash.rect,
      };
    })()`);

    if (result.done) {
      return {
        attempted: true,
        removedSavedPaymentMethods: removed,
        hasSavePaymentForm: !!result.hasSave,
      };
    }
    if (!result.clicked) {
      throw new Error(`Saved payment-method delete button not found: ${JSON.stringify(result).slice(0, 2000)}`);
    }
    removed.push(result.card);
    await sleep(800);

    const confirmed = await evaluate(page, `(() => {
      const confirm = [...document.querySelectorAll('button,[role="button"]')]
        .find((node) => /Remove|Delete|Confirm/i.test((node.innerText || node.textContent || '').trim()) && !node.disabled);
      if (confirm) confirm.click();
      return !!confirm;
    })()`);
    for (let wait = 0; wait < 10; wait += 1) {
      const state = await evaluate(page, `(() => {
        const text = document.body.innerText || '';
        const removedCard = ${JSON.stringify(result.card)};
        return {
          cardStillVisible: removedCard ? text.includes(removedCard) : false,
          hasSave: /Save payment method/.test(text),
          tail: text.slice(-1500),
        };
      })()`);
      if (!state.cardStillVisible || state.hasSave) break;
      await sleep(DEFAULT_DOM_POLL_MS);
      if (wait === 9) {
        throw new Error(`Saved payment-method removal did not take effect: ${state.tail}`);
      }
    }
    if (confirmed) await sleep(800);
  }

  throw new Error('Saved payment-method removal did not converge');
}

async function openAddCreditsPaymentPath(page, expectedLast4, expectedExpiry) {
  await waitForExactText(page, 'Add Credits', DEFAULT_CREDITS_ENTRY_WAIT_MS, {refreshOnTimeout: true});
  const deadline = Date.now() + DEFAULT_DOM_WAIT_MS;
  while (Date.now() < deadline) {
    const state = await evaluate(page, `(() => {
      const text = document.body.innerText || '';
      const last4 = ${JSON.stringify(expectedLast4)};
      const expiry = ${JSON.stringify(expectedExpiry)};
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const interactive = [...document.querySelectorAll('button,a,[role="button"]')]
        .map((node) => ({
          node,
          text: (node.innerText || node.textContent || node.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' '),
          visible: visible(node),
          disabled: !!node.disabled || node.getAttribute('aria-disabled') === 'true',
          rect: (() => {
            const rect = node.getBoundingClientRect();
            return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
          })(),
          hasSvg: !!node.querySelector?.('svg'),
          plusIcon: (() => {
            const pathD = [...node.querySelectorAll?.('svg path') || []].map((path) => path.getAttribute('d') || '').join(' ');
            const className = String(node.getAttribute('class') || '');
            return /M12\\s*4\\.5v15m7\\.5-7\\.5h-15/i.test(pathD)
              || (/\\bw-10\\b/.test(className) && /\\bh-full\\b/.test(className) && !!node.querySelector?.('svg'));
          })(),
        }))
        .filter((item) => item.visible);
      const buttons = interactive
        .filter((item) => item.visible && item.text);
      const clickable = buttons.filter((item) => !item.disabled).map((item) => item.text);
      const hasClickable = (rx) => clickable.some((label) => rx.test(label));
      const modal = [...document.querySelectorAll('body *')]
        .filter((node) => visible(node))
        .map((node) => ({text: (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' '), rect: node.getBoundingClientRect()}))
        .filter((item) => /Purchase Credits/i.test(item.text) && /Total due/i.test(item.text))
        .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];
      const modalRect = modal?.rect;
      const hasIconAddPaymentMethod = !!modalRect && interactive
        .filter((item) => !item.disabled)
        .some((item) => {
          const rect = item.rect;
          const inTopCardArea = rect.x > modalRect.x + modalRect.width * 0.62
            && rect.x < modalRect.x + modalRect.width - 35
            && rect.y > modalRect.y + 55
            && rect.y < modalRect.y + modalRect.height * 0.35;
          const plusLike = item.plusIcon || item.text === '+' || item.text === '' || item.hasSvg;
          return inTopCardArea && plusLike && !/close|purchase/i.test(item.text) && rect.width >= 35 && rect.width <= 140 && rect.height >= 45 && rect.height <= 180;
        });
      const brandAndLast4 = new RegExp('\\\\b(VISA|MASTERCARD|AMEX|AMERICAN EXPRESS|DISCOVER|DINERS|JCB|UNIONPAY)\\\\b[\\\\s\\\\S]*' + last4, 'i');
      return {
        purchase: /Purchase Credits/.test(text),
        targetCardVisible: !!last4 && (
          brandAndLast4.test(text)
          || (!!expiry && new RegExp(last4 + '[\\\\s\\\\S]*' + expiry.replace('/', '\\\\/') + '|' + expiry.replace('/', '\\\\/') + '[\\\\s\\\\S]*' + last4, 'i').test(text))
        ),
        hasAddPaymentMethod: /Add a Payment Method|Add Payment Method/i.test(text),
        canAddPaymentMethod: hasClickable(/^Add a Payment Method$|^Add Payment Method$/i) || hasIconAddPaymentMethod,
        hasIconAddPaymentMethod,
        hasSave: /Save payment method/.test(text),
        disabledEntryButtons: buttons
          .filter((item) => item.disabled && /Add Credits|Add a Payment Method|Add Payment Method/i.test(item.text))
          .map((item) => item.text),
        tail: text.slice(-2200),
      };
    })()`);
    if (state.purchase && state.targetCardVisible) return {alreadyBound: true, state};
    if (!state.purchase && state.targetCardVisible) {
      const selected = await clickSavedPaymentMethod(page, expectedLast4, expectedExpiry);
      const verified = await waitForPurchaseCard(page, expectedLast4, expectedExpiry, DEFAULT_DOM_WAIT_MS, {refreshOnTimeout: true});
      return {alreadyBound: true, reboundExisting: true, selected, state: verified};
    }
    if (state.purchase && state.hasSave) break;
    if (!state.purchase && state.hasSave) {
      return {alreadyBound: false, clicked: {clicked: false, label: 'Save payment method already visible'}};
    }
    if (!state.purchase && state.canAddPaymentMethod && !state.targetCardVisible) {
      await clickAddPaymentMethod(page, {required: false});
      await sleep(PAGE_SETTLE_MS);
      break;
    }
    await sleep(SLOW_DOM_POLL_MS);
  }

  const clicked = await clickAddPaymentMethod(page, {required: false});
  await sleep(PAGE_SETTLE_MS);
  return {alreadyBound: false, clicked};
}

function isPaymentEntryStateReady(state, expectedLast4 = '') {
  return !!(
    state?.canAddPaymentMethod
    || state?.hasAddPaymentMethod
    || state?.canAddCredits
    || state?.hasAddCredits
    || state?.hasAddBillingAddress
    || state?.hasAddressForm
    || state?.hasSavePaymentMethod
    || state?.hasCardFormText
    || (expectedLast4 && state?.purchase && state?.targetCardVisible)
  );
}

async function waitForPaymentEntryState(page, expectedLast4, expectedExpiry, timeoutMs = DEFAULT_PAYMENT_ENTRY_WAIT_MS, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    const blockerRecovery = await recoverNewAccountBlockerIfPresent(page, 'payment_entry_wait');
    if (blockerRecovery.recovered) {
      lastState = await getPaymentEntryState(page, expectedLast4, expectedExpiry);
      if (isPaymentEntryStateReady(lastState, expectedLast4)) {
        return {...lastState, blockerRecovery};
      }
    }
    lastState = await getPaymentEntryState(page, expectedLast4, expectedExpiry);
    if (isPaymentEntryStateReady(lastState, expectedLast4)) {
      return lastState;
    }
    await sleep(DEFAULT_DOM_POLL_MS);
  }
  if (options.refreshOnTimeout) {
    await refreshCreditsPageForRetry(page);
    const retry = await waitForPaymentEntryState(page, expectedLast4, expectedExpiry, timeoutMs, {...options, refreshOnTimeout: false});
    return {...retry, refreshedOnce: true};
  }
  return lastState || await getPaymentEntryState(page, expectedLast4, expectedExpiry);
}

async function waitForPaymentMethodSurfaceAfterClick(page, expectedLast4, expectedExpiry, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  let reClickCount = 0;
  while (Date.now() < deadline) {
    const blockerRecovery = await recoverNewAccountBlockerIfPresent(page, 'payment_surface_wait');
    if (blockerRecovery.recovered) {
      state = await getPaymentEntryState(page, expectedLast4, expectedExpiry);
      if ((state.canAddPaymentMethod || state.hasAddPaymentMethod) && !state.hasCardFormText && !state.hasSavePaymentMethod && !state.hasAddBillingAddress && !state.hasAddressForm && reClickCount < 2) {
        // 强刷回 Credits 主页面后，需要重新点击入口，否则会一直等一个已经被刷新掉的弹窗。
        const clicked = await clickAddPaymentMethod(page, {required: false});
        reClickCount += 1;
        await sleep(PAGE_SETTLE_MS);
        state = {...state, blockerRecovery, reClickedAfterRecovery: clicked};
      }
    }
    state = await getPaymentEntryState(page, expectedLast4, expectedExpiry);
    if (
      state.hasAddBillingAddress
      || state.hasAddressForm
      || state.hasCardFormText
      || state.hasSavePaymentMethod
      || (expectedLast4 && state.purchase && state.targetCardVisible)
    ) {
      return state;
    }
    await sleep(SLOW_DOM_POLL_MS);
  }
  throw new Error(`Add a Payment Method modal did not become ready after ${timeoutMs}ms; tail=${state?.tail || ''}`);
}

async function openPaymentMethodEntryPath(page, expectedLast4, expectedExpiry, options = {}) {
  const initial = await waitForPaymentEntryState(page, expectedLast4, expectedExpiry, options.timeoutMs || DEFAULT_PAYMENT_ENTRY_WAIT_MS, {
    refreshOnTimeout: options.refreshOnTimeout !== false,
  });
  if (!isPaymentEntryStateReady(initial, expectedLast4) && !initial.canAddCredits && !initial.hasAddCredits) {
    throw new Error(`Payment method entry not ready after ${options.timeoutMs || DEFAULT_PAYMENT_ENTRY_WAIT_MS}ms, refreshed once and retried; tail=${initial.tail || ''}`);
  }
  if (expectedLast4 && initial.purchase && initial.targetCardVisible) {
    return {alreadyBound: true, entry: 'purchase_modal_already_open', state: initial};
  }
  if (initial.hasSavePaymentMethod || initial.hasCardFormText || initial.hasAddBillingAddress || initial.hasAddressForm) {
    return {alreadyBound: false, entry: 'already_open', state: initial};
  }

  if (initial.canAddPaymentMethod || initial.hasAddPaymentMethod) {
    const clicked = await clickAddPaymentMethod(page, {required: false});
    await sleep(PAGE_SETTLE_MS);
    if (!clicked.clicked) {
      if (!options.requireAddPaymentMethod && (initial.canAddCredits || initial.hasAddCredits)) {
        const result = await openAddCreditsPaymentPath(page, expectedLast4, expectedExpiry);
        const state = await getPaymentEntryState(page, expectedLast4, expectedExpiry);
        return {...result, entry: 'add_credits_after_payment_method_click_miss', state};
      }
      throw new Error(`Add a Payment Method is visible but could not be clicked; tail=${clicked.tail || initial.tail || ''}`);
    }
    return {
      alreadyBound: false,
      entry: 'add_payment_method',
      clicked,
      state: await waitForPaymentMethodSurfaceAfterClick(page, expectedLast4, expectedExpiry, options.surfaceReadyTimeoutMs || 30000),
    };
  }

  if (options.requireAddPaymentMethod) {
    throw new Error(`Add a Payment Method entry is required for this mode; refusing Add Credits fallback; tail=${initial.tail}`);
  }

  if (initial.canAddCredits || initial.hasAddCredits) {
    const result = await openAddCreditsPaymentPath(page, expectedLast4, expectedExpiry);
    const state = await getPaymentEntryState(page, expectedLast4, expectedExpiry);
    return {...result, entry: 'add_credits', state};
  }

  throw new Error(`Payment method entry not found; tail=${initial.tail}`);
}

function isRetryablePageLoadError(error) {
  return /not ready|not found|Missing Stripe field|iframe|did not expose Save payment method|Saved card was not visible|Payment method entry|Add a Payment Method|Add Credits|Button not found|CDP command timeout/i.test(error?.message || '')
    && !/payment_issue_card_declined|Payment Issue|Your card was declined|Security challenge|3D Secure|hCaptcha|captcha|bank verification|passkey|manual_security_blocker/i.test(error?.message || '');
}

async function refreshCreditsPageForRetry(page) {
  await dismissInterferingOverlays(page).catch(() => null);
  await navigatePage(page, OPENROUTER_CREDITS_URL, {
    commandTimeoutMs: DEFAULT_NAVIGATION_COMMAND_TIMEOUT_MS,
    readyTimeoutMs: DEFAULT_NAVIGATION_READY_TIMEOUT_MS,
  });
  await sleep(PAGE_SETTLE_MS);
  await dismissInterferingOverlays(page).catch(() => null);
  return getPaymentEntryState(page);
}

async function waitForCardFormReady(page, debugPort, timeoutMs = DEFAULT_STRIPE_IFRAME_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  let lastTargetError = '';
  while (Date.now() < deadline) {
    lastState = await getPaymentEntryState(page);
    if (lastState.hasSavePaymentMethod || lastState.hasCardFormText) {
      return {ready: true, source: 'page_text', state: lastState};
    }
    if (debugPort) {
      try {
        const targetWs = await waitForPaymentTarget(debugPort, 3000);
        if (targetWs) return {ready: true, source: 'stripe_card_iframe'};
      } catch (error) {
        lastTargetError = error.message;
      }
    }
    await sleep(DEFAULT_DOM_POLL_MS);
  }
  return {
    ready: false,
    state: lastState,
    targetError: lastTargetError,
  };
}

async function detectCompletedCreditsMainPage(page, purchasePlan, autoTopup) {
  const state = await getPaymentEntryState(page).catch(() => null);
  const hasPaymentSurface = !!(
    state?.hasSavePaymentMethod
    || state?.hasCardFormText
    || state?.hasAddBillingAddress
    || state?.hasAddressForm
  );
  if (hasPaymentSurface) return null;

  const autoTopupState = autoTopup?.enabled
    ? await waitForAutoTopupOverview(page, 5000).catch((error) => ({enabled: false, error: error.message}))
    : {skipped: true, reason: 'auto_topup_not_requested'};
  const balanceVerification = purchasePlan?.confirmed && Number.isFinite(purchasePlan.beforeBalance?.balance) && purchasePlan.amount
    ? await verifyPurchaseBalanceChange(page, purchasePlan.beforeBalance.balance, purchasePlan.amount, 5000).catch((error) => ({verified: false, error: error.message}))
    : {verified: true, skipped: true, reason: 'purchase_not_requested'};

  const autoTopupOk = !autoTopup?.enabled || autoTopupState?.enabled;
  const purchaseOk = !purchasePlan?.confirmed || balanceVerification?.verified;
  if (!autoTopupOk || !purchaseOk) {
    return null;
  }
  return {
    recovered: true,
    reason: 'credits_main_page_already_completed',
    state,
    autoTopup: autoTopupState,
    balanceVerification,
  };
}

async function closePurchaseModal(page) {
  await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27}).catch(() => {});
  await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27}).catch(() => {});
  await sleep(500);
  await evaluate(page, `(() => {
    const closes = [...document.querySelectorAll('button,[role="button"]')]
      .map((node) => ({node, title: node.getAttribute('title') || '', aria: node.getAttribute('aria-label') || '', rect: node.getBoundingClientRect()}))
      .filter((item) => (
        (item.title === 'Close' || item.aria === 'Close')
        && item.rect.width > 0
        && item.rect.height > 0
      ))
      .sort((a, b) => a.rect.y - b.rect.y);
    if (closes[0]) closes[0].node.click();
    return !!closes[0];
  })()`).catch(() => {});
  await sleep(500);
}

function normalizeMoneyForCompare(value) {
  const number = Number(String(value || '').replace(/[$,\s]/g, ''));
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 100) / 100;
}

async function getAutoTopupState(page) {
  return evaluate(page, `(() => {
    const text = document.body.innerText || '';
    const enabledMatch = text.match(/Auto\\s*top[- ]?up\\s+is\\s+enabled\\s+and\\s+will\\s+add\\s+\\$?([\\d,.]+)\\s+credits\\s+automatically\\s+when\\s+your\\s+balance\\s+drops\\s+below\\s+\\$?([\\d,.]+)/i);
    const enabled = !!enabledMatch
      || /Auto\\s*Top[- ]?Up\\s+is\\s+enabled/i.test(text)
      || /will add\\s+\\$?[\\d,.]+\\s+credits automatically when your balance drops below\\s+\\$?[\\d,.]+/i.test(text);
    const hasAutoTopup = /Auto\\s*Top[- ]?Up/i.test(text);
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOf = (node) => (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' ');
    const autoContainer = [...document.querySelectorAll('section,article,div,main,body')]
      .filter((node) => visible(node) && /Auto\\s*Top[- ]?Up/i.test(textOf(node)))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const abody = a === document.body ? 1 : 0;
        const bbody = b === document.body ? 1 : 0;
        return abody - bbody || (ar.width * ar.height) - (br.width * br.height);
      })[0] || document.body;
    const actions = [...autoContainer.querySelectorAll('button,a,[role="button"]')]
      .filter((node) => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true')
      .map((node) => textOf(node));
    const hasEnable = actions.some((label) => /^Enable$/i.test(label) || /^Enable Auto Top[- ]?Up$/i.test(label));
    const hasManage = actions.some((label) => /^Manage$/i.test(label));
    return {
      enabled,
      amount: enabledMatch ? enabledMatch[1] : '',
      threshold: enabledMatch ? enabledMatch[2] : '',
      hasEnable,
      hasManage,
      actions,
      tail: text.slice(-2500),
    };
  })()`);
}

async function waitForAutoTopupOverview(page, timeoutMs = DEFAULT_DOM_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  let firstManageAt = 0;
  while (Date.now() < deadline) {
    state = await getAutoTopupState(page);
    if (state.enabled) return state;
    if (state.hasManage) {
      firstManageAt ||= Date.now();
      if (Date.now() - firstManageAt > 1200) return state;
    }
    if (state.hasEnable && !state.hasManage) return state;
    await sleep(400);
  }
  return state || {enabled: false, hasEnable: false, hasManage: false, tail: ''};
}

async function findAndClickAutoTopupAction(page, action) {
  let result = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await dismissBrowserChromeBubbles(page).catch(() => null);
    result = await evaluate(page, `(() => {
      const action = ${JSON.stringify(action)};
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const textOf = (node) => (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' ');
      const hasAutoTopup = (node) => /Auto\\s*Top[- ]?Up/i.test(textOf(node));
      const pageAnchors = [...document.querySelectorAll('h1,h2,h3,h4,p,span,div')]
        .filter((node) => visible(node) && hasAutoTopup(node))
        .map((node) => node.getBoundingClientRect());
      const buttons = [...document.querySelectorAll('button,a,[role="button"]')]
        .map((node) => ({node, rect: node.getBoundingClientRect(), text: textOf(node), disabled: !!node.disabled || node.getAttribute('aria-disabled') === 'true'}))
        .filter((item) => visible(item.node) && !item.disabled && new RegExp('^' + action + '$', 'i').test(item.text));

      const scored = buttons.map((button) => {
        let node = button.node.parentElement;
        let container = null;
        for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
          if (visible(node) && hasAutoTopup(node)) {
            container = node;
            break;
          }
        }
        const containerRect = container?.getBoundingClientRect() || document.body.getBoundingClientRect();
        const anchors = container
          ? [...container.querySelectorAll('h1,h2,h3,h4,p,span,div')]
            .filter((node) => visible(node) && hasAutoTopup(node))
            .map((node) => node.getBoundingClientRect())
          : [];
        const nearestAnchorDistance = anchors.length
          ? Math.min(...anchors.map((rect) => Math.abs(rect.y - button.rect.y) + Math.abs(rect.x - button.rect.x) / 8))
          : (pageAnchors.length
            ? Math.min(...pageAnchors.map((rect) => Math.abs(rect.y - button.rect.y) + Math.abs(rect.x - button.rect.x) / 8))
            : 5000);
        const area = containerRect.width * containerRect.height;
        const isPageWide = container === document.body || area > window.innerWidth * window.innerHeight * 0.85;
        return {
          ...button,
          score: (container ? 100000 : 0) - nearestAnchorDistance - (isPageWide ? 10000 : 0) - area / 1000,
          nearestAnchorDistance,
          containerText: container ? textOf(container).slice(0, 300) : '',
        };
      }).sort((a, b) => b.score - a.score);

      const target = scored[0] || null;
      if (!target || (!/Auto\\s*Top[- ]?Up/i.test(target.containerText || '') && target.nearestAnchorDistance > 350)) {
        return {
          clicked:false,
          buttonTexts:buttons.map((button) => button.text),
          scored: scored.map((item) => ({text:item.text, score:item.score, nearestAnchorDistance:item.nearestAnchorDistance, containerText:item.containerText})).slice(0, 5),
          tail:(document.body.innerText || '').slice(-2500),
        };
      }
      target.node.scrollIntoView({block:'center', inline:'center'});
      target.node.click();
      return {clicked:true, label:target.text, score:target.score};
    })()`);
    if (result.clicked) {
      await sleep(1200);
      return result;
    }
    await sleep(500);
  }
  throw new Error(`Auto top-up ${action} button not found: ${JSON.stringify(result)}`);
}

async function waitForAutoTopupForm(page, timeoutMs = DEFAULT_DOM_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(page, `(() => {
      const text = document.body.innerText || '';
      const fieldText = (input) => [
        input.name,
        input.id,
        input.placeholder,
        input.getAttribute('aria-label'),
        input.labels?.[0]?.innerText,
        input.closest('label')?.innerText,
        input.parentElement?.innerText,
        input.closest('[role="group"]')?.innerText,
      ].filter(Boolean).join(' ');
      const inputs = [...document.querySelectorAll('input')].map((input) => ({
        type: input.type || '',
        name: input.name || '',
        id: input.id || '',
        placeholder: input.placeholder || '',
        aria: input.getAttribute('aria-label') || '',
        value: input.value || '',
        label: fieldText(input),
        visible: (() => {
          const rect = input.getBoundingClientRect();
          return rect.width > 2 && rect.height > 2;
        })(),
      })).filter((input) => input.visible && input.type !== 'checkbox' && !/search/i.test((input.placeholder || '') + ' ' + (input.label || '')));
      const amountInputs = inputs.filter((input) => input.type === 'number' || /\\$/.test(input.label));
      const hasThreshold = inputs.some((input) => /when credits are below|balance drops below|below|threshold/i.test(input.label));
      const hasAmount = inputs.some((input) => /purchase this amount|add.*credits|amount|purchase/i.test(input.label));
      const textHasAutoAmounts = /When credits are below/i.test(text) && /Purchase this amount/i.test(text);
      const hasSaveAction = [...document.querySelectorAll('button,a,[role="button"]')]
        .some((node) => {
          const rect = node.getBoundingClientRect();
          const label = (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' ');
          return rect.width > 0 && rect.height > 0 && /^(Save|Update|Enable Auto Top[- ]?Up|Apply)$/i.test(label);
        });
      return {
        ready: textHasAutoAmounts && hasSaveAction && inputs.length >= 2 && ((hasThreshold && hasAmount) || amountInputs.length >= 2),
        inputs,
        textHasAutoAmounts,
        hasSaveAction,
        tail: text.slice(-2500),
      };
    })()`);
    if (last.ready) return last;
    await sleep(DEFAULT_DOM_POLL_MS);
  }
  throw new Error(`Auto top-up form not found: ${last?.tail || ''}`);
}

async function waitForAutoTopupEditorShell(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(page, `(() => {
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textOf = (node) => (node?.innerText || node?.textContent || '').trim().replace(/\\s+/g, ' ');
      const readSwitch = (node) => node ? ({
        found: true,
        wasEnabled: node.getAttribute('aria-checked') === 'true' || node.getAttribute('data-state') === 'checked' || node.checked === true,
        selector: node.id === 'auto-buy' ? '#auto-buy' : '',
        rect: (() => {
          const rect = node.getBoundingClientRect();
          return {x:rect.x, y:rect.y, width:rect.width, height:rect.height};
        })(),
      }) : {found:false};
      const dialog = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[data-slot="dialog-content"],form,section,article,div')]
        .filter((node) => visible(node) && /Auto\\s*Top\\s*Up|Auto\\s*Top[- ]?Up|Enable\\s+auto\\s+top\\s+up/i.test(textOf(node)))
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const abody = a === document.body ? 1 : 0;
          const bbody = b === document.body ? 1 : 0;
          return abody - bbody || (ar.width * ar.height) - (br.width * br.height);
        })[0] || null;
      const scope = dialog || document;
      const autoBuy = scope.querySelector?.('button#auto-buy[role="switch"],#auto-buy,[role="switch"][title*="Automatically buy credits" i],button[aria-checked][title*="Automatically buy credits" i]');
      const text = dialog ? textOf(dialog) : (document.body.innerText || '');
      const inputs = [...document.querySelectorAll('input')]
        .filter((input) => visible(input) && input.type !== 'checkbox' && input.type !== 'radio' && input.type !== 'hidden' && !/search/i.test(input.placeholder || ''))
        .map((input) => ({
          type: input.type || '',
          name: input.name || '',
          id: input.id || '',
          placeholder: input.placeholder || '',
          value: input.value || '',
        }));
      const textHasAutoAmounts = /When credits are below/i.test(text) && /Purchase this amount/i.test(text);
      const hasSaveAction = [...document.querySelectorAll('button,a,[role="button"]')]
        .some((node) => visible(node) && /^(Save|Update|Enable Auto Top[- ]?Up|Apply)$/i.test(textOf(node)));
      return {
        found: Boolean(dialog || visible(autoBuy)),
        formReady: textHasAutoAmounts && hasSaveAction && inputs.length >= 2,
        editorSwitch: readSwitch(autoBuy),
        tail: (document.body.innerText || '').slice(-1800),
      };
    })()`);
    if (last.formReady || last.editorSwitch?.found) return last;
    await sleep(DEFAULT_DOM_POLL_MS);
  }
  throw new Error(`Auto top-up editor shell not found: ${last?.tail || ''}`);
}

async function getAutoTopupEditorSwitchState(page) {
  return evaluate(page, `(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOf = (node) => (node.innerText || node.textContent || '').trim();
    const labelText = (node) => [
      node.getAttribute?.('aria-label'),
      node.labels?.[0]?.innerText,
      node.closest?.('label')?.innerText,
      node.parentElement?.innerText,
    ].filter(Boolean).join(' ');
    const direct = document.querySelector('button#auto-buy[role="switch"],#auto-buy,[role="switch"][title*="Automatically buy credits" i],button[aria-checked][title*="Automatically buy credits" i]');
    if (direct && visible(direct)) {
      const rect = direct.getBoundingClientRect();
      return {
        found: true,
        wasEnabled: direct.getAttribute('aria-checked') === 'true' || direct.getAttribute('data-state') === 'checked' || direct.checked === true,
        selector: direct.id === 'auto-buy' ? '#auto-buy' : '',
        method: 'auto-buy-switch',
        rect: {x:rect.x, y:rect.y, width:rect.width, height:rect.height},
        tail: (document.body.innerText || '').slice(-1800),
      };
    }
    const controls = [...document.querySelectorAll('[role="switch"],button[aria-checked],button[data-state],input[type="checkbox"]')]
      .map((node) => ({
        node,
        rect: node.getBoundingClientRect(),
        text: textOf(node),
        label: labelText(node),
        checked: node.getAttribute('aria-checked') === 'true' || node.getAttribute('data-state') === 'checked' || node.checked === true,
        role: node.getAttribute('role') || '',
        type: node.getAttribute('type') || '',
      }))
      .filter((item) => {
        if (item.type === 'checkbox' && !visible(item.node)) return false;
        if (item.type !== 'checkbox' && !visible(item.node)) return false;
        const text = (item.text || '') + ' ' + (item.label || '');
        return /Enable\\s+auto\\s+top\\s+up/i.test(text)
          || /Auto\\s*Top\\s*Up|Auto\\s*Top[- ]?Up/i.test(document.body.innerText || '');
      });
    const target = controls[0] || null;
    return {
      found: !!target,
      wasEnabled: target ? target.checked : null,
      tail: (document.body.innerText || '').slice(-1800),
    };
  })()`);
}

async function openAutoTopupEditor(page, state) {
  const action = state.enabled || state.hasManage ? 'Manage' : 'Enable';
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await findAndClickAutoTopupAction(page, action);
    try {
      const shell = await waitForAutoTopupEditorShell(page, 15000);
      if (shell.formReady) {
        const form = await waitForAutoTopupForm(page, 5000);
        return {opened: true, action, formReady: true, form, shell};
      }
      if (shell.editorSwitch?.found) {
        return {opened: true, action, formReady: false, editorSwitch: shell.editorSwitch, shell};
      }
    } catch (error) {
      lastError = error;
      const editorSwitch = await getAutoTopupEditorSwitchState(page).catch(() => null);
      if (editorSwitch?.found) {
        return {opened: true, action, formReady: false, editorSwitch};
      }
      await sleep(DEFAULT_DOM_POLL_MS);
    }
  }
  throw new Error(`Auto top-up ${action} did not open the settings form: ${lastError?.message || 'unknown error'}`);
}

async function replaceInputByRect(page, rect, value) {
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await page.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y}).catch(() => {});
  await page.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1});
  await page.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1});
  await sleep(120);
  await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 91});
  await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4});
  await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4});
  await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 91});
  await sleep(80);
  await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8});
  await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8});
  await sleep(80);
  await evaluate(page, `(() => {
    const targetRect = ${JSON.stringify(rect)};
    const inputs = [...document.querySelectorAll('input')]
      .filter((input) => {
        const item = input.getBoundingClientRect();
        return item.width > 0 && item.height > 0 && input.type !== 'checkbox' && input.type !== 'radio' && input.type !== 'hidden';
      })
      .map((input) => {
        const item = input.getBoundingClientRect();
        const distance = Math.abs((item.x + item.width / 2) - (targetRect.x + targetRect.width / 2))
          + Math.abs((item.y + item.height / 2) - (targetRect.y + targetRect.height / 2));
        return {input, distance};
      })
      .sort((a, b) => a.distance - b.distance);
    const input = inputs[0]?.input;
    if (!input || inputs[0].distance > 120) return false;
    input.focus();
    const nativeValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    if (nativeValue) nativeValue.call(input, '');
    else input.value = '';
    try {
      input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'deleteContentBackward', data:null}));
    } catch {
      input.dispatchEvent(new Event('input', {bubbles:true}));
    }
    input.dispatchEvent(new Event('change', {bubbles:true}));
    return true;
  })()`).catch(() => false);
  await sleep(120);
  await page.send('Input.insertText', {text: String(value)});
  await sleep(180);
}

async function fillAutoTopupForm(page, threshold, amount) {
  const fields = await evaluate(page, `(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const labelText = (input) => [
      input.name,
      input.id,
      input.placeholder,
      input.getAttribute('aria-label'),
      input.labels?.[0]?.innerText,
      input.closest('label')?.innerText,
      input.parentElement?.innerText,
      input.closest('[role="group"]')?.innerText,
    ].filter(Boolean).join(' ');
      const inputs = [...document.querySelectorAll('input')]
      .filter((input) => visible(input) && !input.disabled && input.type !== 'checkbox' && input.type !== 'radio' && input.type !== 'hidden' && !/search/i.test((input.placeholder || '') + ' ' + labelText(input)))
      .map((input, index) => ({input, index, text: labelText(input), rect: input.getBoundingClientRect()}));
    const sortedAmountInputs = inputs
      .filter((item) => item.input.type === 'number' || /\\$/.test(item.text))
      .sort((a, b) => a.rect.y - b.rect.y);
    const thresholdInput = inputs.find((item) => /when credits are below|balance drops below|below|threshold/i.test(item.text)) || sortedAmountInputs[0];
    const amountInput = inputs.find((item) => item.input !== thresholdInput?.input && /purchase this amount|add.*credits|amount|purchase/i.test(item.text)) || sortedAmountInputs.find((item) => item.input !== thresholdInput?.input) || inputs.find((item) => item.input !== thresholdInput?.input);
    if (!thresholdInput || !amountInput) {
      return {
        inputCount: inputs.length,
        inputs: inputs.map((item) => ({index:item.index, text:item.text, value:item.input.value})),
      };
    }
    const plain = (item) => ({
      index: item.index,
      text: item.text,
      value: item.input.value,
      rect: {x:item.rect.x, y:item.rect.y, width:item.rect.width, height:item.rect.height},
    });
    return {
      threshold: plain(thresholdInput),
      amount: plain(amountInput),
      inputCount: inputs.length,
    };
  })()`);
  if (!fields.threshold || !fields.amount) {
    throw new Error(`Could not locate Auto top-up fields: ${JSON.stringify(fields)}`);
  }

  const replaceInput = async (field, value) => {
    await replaceInputByRect(page, field.rect, String(value));
    const result = await evaluate(page, `(() => {
      const field = ${JSON.stringify(field)};
      const value = ${JSON.stringify(String(value))};
      const normalizeMoney = (item) => {
        const number = Number(String(item || '').replace(/[$,\\s]/g, ''));
        return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
      };
      const expected = normalizeMoney(value);
      const inputs = [...document.querySelectorAll('input')]
        .filter((input) => {
          const rect = input.getBoundingClientRect();
          const label = [input.placeholder, input.labels?.[0]?.innerText, input.parentElement?.innerText].filter(Boolean).join(' ');
          return rect.width > 0 && rect.height > 0 && input.type !== 'checkbox' && input.type !== 'radio' && input.type !== 'hidden' && !/search/i.test(label);
        })
        .map((input, index) => {
          const rect = input.getBoundingClientRect();
          const centerX = rect.x + rect.width / 2;
          const centerY = rect.y + rect.height / 2;
          const fieldCenterX = field.rect.x + field.rect.width / 2;
          const fieldCenterY = field.rect.y + field.rect.height / 2;
          const distance = Math.abs(centerX - fieldCenterX) + Math.abs(centerY - fieldCenterY);
          return {input, index, rect, distance};
        })
        .sort((a, b) => a.distance - b.distance);
      const target = inputs[0] || null;
      if (!target || target.distance > 120) {
        return {
          updated:false,
          reason:'target_not_found',
          inputs:inputs.slice(0, 5).map((item) => ({index:item.index, distance:item.distance, value:item.input.value})),
        };
      }
      const input = target.input;
      input.blur();
      return {
        updated: input.value === value || normalizeMoney(input.value) === expected,
        index: target.index,
        distance: target.distance,
        value: input.value,
      };
    })()`);
    if (!result.updated) {
      throw new Error(`Auto top-up input did not retain ${value}: ${JSON.stringify(result)}`);
    }
    await sleep(350);
    return result;
  };

  const thresholdInput = await replaceInput(fields.threshold, threshold);
  const amountInput = await replaceInput(fields.amount, amount);
  await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9}).catch(() => {});
  await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9}).catch(() => {});
  await sleep(400);
  const result = await evaluate(page, `(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const normalizeMoney = (value) => {
      const number = Number(String(value || '').replace(/[$,\\s]/g, ''));
      return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
    };
    const expectedThreshold = normalizeMoney(${JSON.stringify(threshold)});
    const expectedAmount = normalizeMoney(${JSON.stringify(amount)});
    const inputs = [...document.querySelectorAll('input')]
      .filter((input) => visible(input) && input.type !== 'checkbox' && input.type !== 'radio' && input.type !== 'hidden' && !/search/i.test(input.placeholder || ''))
      .map((input) => ({type:input.type, value:input.value}));
    const save = [...document.querySelectorAll('button,[role="button"]')]
      .find((node) => visible(node) && /^Save$/i.test((node.innerText || node.textContent || '').trim()));
    return {
      thresholdSet: inputs.some((input) => normalizeMoney(input.value) === expectedThreshold),
      amountSet: inputs.some((input) => normalizeMoney(input.value) === expectedAmount),
      saveDisabled: save ? (!!save.disabled || save.getAttribute('aria-disabled') === 'true') : null,
      inputs,
    };
  })()`);
  if (!result.thresholdSet || !result.amountSet) {
    throw new Error(`Auto top-up fields did not retain requested values: ${JSON.stringify(result)}`);
  }
  if (result.saveDisabled) {
    return {...result, unchanged: true, fields, thresholdInput, amountInput, dirtyNudge: true};
  }
  return {...result, fields, thresholdInput, amountInput, dirtyNudge: true};
}

async function toggleAutoTopupTo(page, desiredEnabled) {
  const readSwitch = () => evaluate(page, `(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const direct = document.querySelector('button#auto-buy[role="switch"],#auto-buy,[role="switch"][title*="Automatically buy credits" i],button[aria-checked][title*="Automatically buy credits" i]');
    if (direct && visible(direct)) {
      const rect = direct.getBoundingClientRect();
      return {
        found:true,
        wasEnabled: direct.getAttribute('aria-checked') === 'true' || direct.getAttribute('data-state') === 'checked' || direct.checked === true,
        method:'auto-buy-switch',
        inputCount:[...document.querySelectorAll('input')].filter((input) => {
          const item = input.getBoundingClientRect();
          return item.width > 0 && item.height > 0 && !input.disabled && input.type !== 'checkbox' && input.type !== 'radio' && input.type !== 'hidden' && !/search/i.test(input.placeholder || '');
        }).length,
        rect:{x:rect.x, y:rect.y, width:rect.width, height:rect.height},
        score:5000,
      };
    }
    const textOf = (node) => (node.innerText || node.textContent || '').trim();
    const labelText = (node) => [
      node.getAttribute?.('aria-label'),
      node.labels?.[0]?.innerText,
      node.closest?.('label')?.innerText,
      node.parentElement?.innerText,
    ].filter(Boolean).join(' ');
    const checkboxLabel = (node) => node.closest?.('label') || node.labels?.[0] || null;
    const labelNodes = [...document.querySelectorAll('label,div,span,p')]
      .filter((node) => visible(node) && /Enable\\s+auto\\s+top\\s+up/i.test(textOf(node)))
      .map((node) => ({node, rect:node.getBoundingClientRect()}));
    const controls = [...document.querySelectorAll('[role="switch"],button[aria-checked],button[data-state],input[type="checkbox"]')]
      .map((node) => ({
        node,
        text: textOf(node),
        label: labelText(node),
        labelNode: checkboxLabel(node),
        rect: node.getBoundingClientRect(),
        checked: node.getAttribute('aria-checked') === 'true' || node.getAttribute('data-state') === 'checked' || node.checked === true,
        role: node.getAttribute('role') || '',
        type: node.getAttribute('type') || '',
      }))
      .filter((item) => {
        if (item.type === 'checkbox' && !visible(item.node) && !visible(item.labelNode || item.node)) return false;
        if (item.type !== 'checkbox' && !visible(item.node)) return false;
        return item.role === 'switch' || item.node.hasAttribute('aria-checked') || item.node.hasAttribute('data-state') || item.type === 'checkbox';
      });
    const dialog = [...document.querySelectorAll('[role="dialog"],[role="presentation"],form,section,article,div,body')]
      .filter((node) => visible(node) && /Auto\\s*Top\\s*Up|Auto\\s*Top[- ]?Up|Enable\\s+auto\\s+top\\s+up/i.test(textOf(node)))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const abody = a === document.body ? 1 : 0;
        const bbody = b === document.body ? 1 : 0;
        return abody - bbody || (ar.width * ar.height) - (br.width * br.height);
      })[0];
    const scored = controls.map((item) => {
      const nearestLabelDistance = labelNodes.length
        ? Math.min(...labelNodes.map((label) => Math.abs(label.rect.y - item.rect.y) + Math.abs(label.rect.x - item.rect.x) / 8))
        : 5000;
      const inDialog = dialog && (dialog === item.node || dialog.contains(item.node) || dialog.contains(item.labelNode));
      const text = (item.text || '') + ' ' + (item.label || '');
      const switchShape = item.rect.width >= 20 && item.rect.width <= 70 && item.rect.height >= 10 && item.rect.height <= 45;
      const score = (inDialog ? 1000 : 0)
        + (/Enable\\s+auto\\s+top\\s+up/i.test(text) ? 500 : 0)
        + (item.role === 'switch' ? 200 : 0)
        + (switchShape ? 100 : 0)
        - nearestLabelDistance;
      return {...item, score, method:item.role === 'switch' ? 'role-switch' : (item.type === 'checkbox' ? 'checkbox' : 'state-button')};
    }).sort((a, b) => b.score - a.score);

    const target = scored[0] || null;
    const visibleInputs = [...document.querySelectorAll('input')]
      .filter((input) => {
        const rect = input.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !input.disabled && input.type !== 'checkbox' && input.type !== 'radio' && input.type !== 'hidden' && !/search/i.test(input.placeholder || '');
      });
    if (!target || target.score < -1000) {
      return {found:false, inputCount:visibleInputs.length, tail:(document.body.innerText || '').slice(-1800)};
    }
    const clickRect = visible(target.node)
      ? target.rect
      : (target.labelNode && visible(target.labelNode) ? target.labelNode.getBoundingClientRect() : target.rect);
    return {
      found:true,
      wasEnabled: target.checked,
      method: target.method,
      inputCount: visibleInputs.length,
      rect:{x:clickRect.x, y:clickRect.y, width:clickRect.width, height:clickRect.height},
      score: target.score,
    };
  })()`);

  const result = await readSwitch();
  if (!result.found) throw new Error(`Auto top-up switch not found: ${JSON.stringify(result)}`);
  if (result.wasEnabled !== desiredEnabled && result.rect) {
    const x = result.rect.x + result.rect.width / 2;
    const y = result.rect.y + result.rect.height / 2;
    await page.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y}).catch(() => {});
    await page.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1});
    await page.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1});
  }
  for (let i = 0; i < 12; i += 1) {
    await sleep(350);
    const state = await readSwitch();
    if (state.found && state.wasEnabled === desiredEnabled) {
      return {...result, verified: state};
    }
    if (i === 3 && result.method === 'auto-buy-switch') {
      await evaluate(page, `(() => {
        const target = document.querySelector('button#auto-buy[role="switch"],#auto-buy');
        if (!target) return false;
        target.scrollIntoView?.({block:'center', inline:'center'});
        const PointerLikeEvent = window.PointerEvent || MouseEvent;
        target.dispatchEvent(new PointerLikeEvent('pointerdown', {bubbles:true, cancelable:true, view:window}));
        target.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, view:window}));
        target.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true, view:window}));
        target.click?.();
        target.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
        return true;
      })()`).catch(() => false);
    }
  }
  throw new Error(`Auto top-up switch did not reach ${desiredEnabled ? 'on' : 'off'}: ${JSON.stringify(result)}`);
}

async function toggleAutoTopupIfNeeded(page) {
  return toggleAutoTopupTo(page, true);
}

async function saveAutoTopup(page) {
  const result = await evaluate(page, `(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOf = (node) => (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' ');
    const candidates = [...document.querySelectorAll('button,a,[role="button"]')]
      .filter((node) => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true')
      .map((node) => {
        const text = textOf(node);
        let container = node.parentElement;
        let score = /^(Save|Update|Enable Auto Top[- ]?Up|Confirm|Apply)$/i.test(text) ? 1000 : (/Save|Update|Enable Auto Top[- ]?Up|Apply/i.test(text) ? 500 : -1000);
        let containerText = '';
        for (let depth = 0; container && depth < 10; depth += 1, container = container.parentElement) {
          if (!visible(container)) continue;
          const candidateText = textOf(container);
          const hasForm = /Auto\\s*Top[- ]?Up|When credits are below|Purchase this amount|Payment Methods/i.test(candidateText);
          if (!hasForm) continue;
          const rect = container.getBoundingClientRect();
          const area = rect.width * rect.height;
          const isBody = container === document.body;
          score += 1000 - (isBody ? 500 : 0) - area / 2000;
          containerText = candidateText.slice(0, 800);
          break;
        }
        return {node, text, score, containerText};
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const button = candidates[0] || null;
    if (!button) return {clicked:false, buttons:[...document.querySelectorAll('button,a,[role="button"]')].filter(visible).map((node) => textOf(node)).slice(-30), tail:(document.body.innerText || '').slice(-2500)};
    button.node.scrollIntoView({block:'center', inline:'center'});
    button.node.click();
    return {clicked:true, label:button.text, score:button.score, containerText:button.containerText};
  })()`);
  if (!result.clicked) throw new Error(`Auto top-up save button not found: ${JSON.stringify(result)}`);
  await sleep(1800);
  return result;
}

async function waitForAutoTopupConfigured(page, threshold, amount, timeoutMs = DEFAULT_DOM_WAIT_MS) {
  const expectedThreshold = normalizeMoneyForCompare(threshold);
  const expectedAmount = normalizeMoneyForCompare(amount);
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await getAutoTopupState(page);
    const currentThreshold = normalizeMoneyForCompare(state.threshold);
    const currentAmount = normalizeMoneyForCompare(state.amount);
    if (state.enabled && currentThreshold === expectedThreshold && currentAmount === expectedAmount) {
      return {...state, configured: true};
    }
    await sleep(800);
  }
  throw new Error(`Auto top-up did not reach requested values: ${JSON.stringify(state)}`);
}

async function configureAutoTopup(page, autoTopup, debugPort = '') {
  if (!autoTopup?.enabled) return {configured: false, skipped: true};
  const navigation = await ensureCreditsPage(page);
  const dismissedOverlays = await dismissSaveCardOverlays(page, debugPort);
  const requested = {
    threshold: autoTopup.threshold,
    amount: autoTopup.amount,
  };
  let state = await waitForAutoTopupOverview(page);
  const currentThreshold = normalizeMoneyForCompare(state.threshold);
  const currentAmount = normalizeMoneyForCompare(state.amount);
  const requestedThreshold = normalizeMoneyForCompare(requested.threshold);
  const requestedAmount = normalizeMoneyForCompare(requested.amount);
  if (state.enabled && currentThreshold === requestedThreshold && currentAmount === requestedAmount) {
    return {configured: true, changed: false, requested, navigation, dismissedOverlays, state};
  }
  const dismissedBeforeEditor = await dismissSaveCardOverlays(page, debugPort);
  const opened = await openAutoTopupEditor(page, state);
  const toggled = await toggleAutoTopupIfNeeded(page);
  const formAfterToggle = await waitForAutoTopupForm(page, DEFAULT_DOM_WAIT_MS);
  const fields = await fillAutoTopupForm(page, requested.threshold, requested.amount);
  const saved = fields.unchanged ? {clicked: false, skipped: true, reason: 'values_already_set'} : await saveAutoTopup(page);
  state = await waitForAutoTopupConfigured(page, requested.threshold, requested.amount);
  return {configured: true, changed: !fields.unchanged, requested, navigation, dismissedOverlays, dismissedBeforeEditor, opened, toggled, formAfterToggle, fields, saved, state};
}

async function waitForAccountState(page, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_CREDITS_ENTRY_WAIT_MS;
  const requirePaymentEntry = options.requirePaymentEntry !== false;
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await evaluate(page, `(() => {
      const text = document.body.innerText || '';
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const buttons = [...document.querySelectorAll('button,a,[role="button"]')]
        .map((node) => ({
          text: (node.innerText || node.textContent || node.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' '),
          visible: visible(node),
          disabled: !!node.disabled || node.getAttribute('aria-disabled') === 'true',
        }))
        .filter((item) => item.visible && item.text);
      const clickable = buttons.filter((item) => !item.disabled).map((item) => item.text);
      const labels = buttons.map((item) => item.text);
      const hasAny = (rx) => labels.some((label) => rx.test(label));
      const hasClickable = (rx) => clickable.some((label) => rx.test(label));
      return {
        account: (text.match(/Personal Account:\\s*([^\\n]+)/) || [])[1] || '',
        hasAddCredits: hasAny(/^Add Credits$/i) || /Add Credits/.test(text),
        canAddCredits: hasClickable(/^Add Credits$/i),
        hasAddPaymentMethod: hasAny(/^Add a Payment Method$|^Add Payment Method$/i) || /Add a Payment Method|Add Payment Method/i.test(text),
        canAddPaymentMethod: hasClickable(/^Add a Payment Method$|^Add Payment Method$/i),
        signin: /Sign in|Continue with Google|Log in/i.test(text),
        disabledEntryButtons: buttons
          .filter((item) => item.disabled && /Add Credits|Add a Payment Method|Add Payment Method/i.test(item.text))
          .map((item) => item.text),
        tail: text.slice(-1200),
      };
    })()`);
    if (lastState.signin) return lastState;
    if (lastState.account && (!requirePaymentEntry || lastState.canAddCredits || lastState.canAddPaymentMethod)) return lastState;
    await sleep(500);
  }
  return lastState || {account: '', hasAddPaymentMethod: false, hasAddCredits: false, canAddCredits: false, canAddPaymentMethod: false, tail: ''};
}

async function run() {
  const startedAt = Date.now();
  const rawInput = normalizeInput(parseArgs(process.argv));
  const debugDir = rawInput.confirmationDebugDir || '';
  writeStepDiagnostic(debugDir, 'input-normalized', 'success', {
    profileNo: rawInput.profileNo,
    profileId: rawInput.profileId,
    expectedAccount: rawInput.expectedAccount,
    startupUrl: rawInput.startupUrl,
    scopes: {
      billingAddressOnly: rawInput.billingAddressOnly,
      autoTopupOnly: rawInput.autoTopupOnly,
      creditsStatusOnly: rawInput.creditsStatusOnly,
      purchaseOnly: rawInput.purchaseOnly,
      preparePurchaseOnly: rawInput.preparePurchaseOnly,
      purchaseConfirmed: rawInput.purchase?.confirmed,
      autoTopupEnabled: rawInput.autoTopup?.enabled,
    },
  });
  const input = await runLoggedStep('adspower-start-profile', debugDir, () => startProfileIfNeeded(rawInput));
  input.debugPort ||= debugPortFromWs(input.browserWs);
  const bindsCard = !input.autoTopupOnly && !input.billingAddressOnly && !input.creditsStatusOnly && !input.purchaseOnly;
  const {last4, masked} = bindsCard ? maskCard(input.card.number) : {last4: '', masked: ''};
  const expectedExpiry = bindsCard ? displayExpiry(input.card.expiry) : '';
  if (bindsCard && !last4) throw new Error('Could not determine card last4');
  if (bindsCard && !expectedExpiry) throw new Error('Could not determine card expiry display value');

  const pageWs = await ensureOpenRouterPage(input);
  const page = await cdp(pageWs);
  const pageNetworkDiagnostics = await installNetworkDiagnostics(page);
  let payment;
  let accountForRecovery = '';
  let purchasePlanForRecovery = null;
  let preAddCreditsAutoTopup = {skipped: true, reason: 'auto_topup_pre_disable_removed'};

  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable').catch(() => {});
    writeDiagnostic(debugDir, 'network-diagnostics', {kind: 'network_diagnostics', page: pageNetworkDiagnostics});
	    await runLoggedStep('navigate-credits-page', debugDir, () => navigatePage(page, OPENROUTER_CREDITS_URL), page);
	    const accountState = await runLoggedStep('wait-account-state', debugDir, () => waitForAccountState(page, {
      requirePaymentEntry: !input.creditsStatusOnly && !input.autoTopupOnly,
    }), page);
	    if (accountState.signin || !accountState.account) {
	      throw new Error(`login_required: OpenRouter credits page is not logged in; tail=${accountState.tail || ''}`);
	    }
	    if (accountState.account.toLowerCase() !== input.expectedAccount.toLowerCase()) {
	      throw new Error(`OpenRouter account mismatch: expected ${input.expectedAccount}, got ${accountState.account || '(not found)'}`);
	    }
    accountForRecovery = accountState.account;

    if (!input.creditsStatusOnly && !input.autoTopupOnly && !accountState.canAddCredits && !accountState.canAddPaymentMethod) {
      throw new Error(`Payment entry not ready after waiting: neither Add Credits nor Add a Payment Method is clickable; disabled=${(accountState.disabledEntryButtons || []).join(',')}; tail=${accountState.tail}`);
    }
    if (input.creditsStatusOnly) {
      const balance = await runLoggedStep('read-credit-balance', debugDir, () => getCurrentCreditBalance(page), page);
      const autoTopup = await runLoggedStep('read-auto-topup-overview', debugDir, () => waitForAutoTopupOverview(page), page).catch((error) => ({
        configured: false,
        error: error.message,
      }));
      return {
        ok: true,
        status: 'credits_status',
        account: accountState.account,
        launch: input.launch,
        balance,
        autoTopup,
        elapsedMs: Date.now() - startedAt,
      };
    }
    const purchasePlan = (input.purchase.confirmed || input.preparePurchaseOnly)
      ? await runLoggedStep('resolve-purchase-plan', debugDir, () => resolvePurchasePlan(page, input.preparePurchaseOnly ? {...input.purchase, confirmed: true} : input.purchase), page)
      : input.purchase;
    const purchaseSkippedByRule = !!purchasePlan.skippedByRule;
    const skippedPurchaseResult = purchaseSkippedByRule
      ? {
        skippedByRule: true,
        amount: '',
        ruleDecision: purchasePlan.ruleDecision || null,
        beforeBalance: purchasePlan.beforeBalance || null,
        balanceVerification: {
          verified: true,
          skipped: true,
          beforeBalance: purchasePlan.beforeBalance?.balance ?? null,
          afterBalance: purchasePlan.beforeBalance?.balance ?? null,
        },
      }
      : null;
    purchasePlan.confirmed = input.purchase.confirmed;
    purchasePlanForRecovery = purchasePlan;
    if (purchaseSkippedByRule) {
      input.purchase.confirmed = false;
      input.preparePurchaseOnly = false;
    }
    if (input.autoTopupOnly) {
      const paymentMethod = await runLoggedStep('verify-saved-payment-method-auto-topup', debugDir, () => verifySavedPaymentMethodForAutoTopup(page, input.expectedAccount), page);
      const autoTopupResult = await runLoggedStep('configure-auto-topup', debugDir, () => configureAutoTopup(page, input.autoTopup, input.debugPort), page);
      return {
        ok: true,
        status: autoTopupResult.changed ? 'auto_topup_updated' : 'auto_topup_unchanged',
        account: accountState.account,
        launch: input.launch,
        paymentMethod,
        autoTopup: autoTopupResult,
        elapsedMs: Date.now() - startedAt,
      };
    }
    if (input.purchaseOnly) {
      const paymentMethod = await runLoggedStep('verify-saved-payment-method-purchase-only', debugDir, () => verifySavedPaymentMethodForAutoTopup(page, input.expectedAccount), page);
      await runLoggedStep('wait-add-credits-purchase-only', debugDir, () => waitForExactText(page, 'Add Credits', DEFAULT_CREDITS_ENTRY_WAIT_MS, {refreshOnTimeout: true}), page);
      await sleep(PAGE_SETTLE_MS);
      const purchaseResult = input.purchase.confirmed
        ? await runLoggedStep('execute-confirmed-purchase-purchase-only', debugDir, () => executeConfirmedPurchase(page, purchasePlan, input.debugPort, input.confirmationDebugDir), page)
        : (input.preparePurchaseOnly ? await runLoggedStep('prepare-purchase-purchase-only', debugDir, () => preparePurchase(page, purchasePlan), page) : skippedPurchaseResult);
      if (input.preparePurchaseOnly) purchaseResult.submitted = false;
      if (input.preparePurchaseOnly) purchaseResult.mode = 'prepared_without_submission';
      if (!input.purchase.confirmed) await closePurchaseModal(page);
      const autoTopupResult = await runLoggedStep('configure-auto-topup-after-purchase-only', debugDir, () => configureAutoTopup(page, input.autoTopup, input.debugPort), page);
      return {
        ok: true,
        status: input.purchase.confirmed
          ? 'purchased_existing'
          : (input.preparePurchaseOnly ? 'prepared_purchase_existing' : (autoTopupResult.changed ? 'auto_topup_updated' : 'auto_topup_unchanged')),
        account: accountState.account,
        launch: input.launch,
        paymentMethod,
        preAddCreditsAutoTopup,
        autoTopup: autoTopupResult,
        purchase: purchaseResult,
        verified: true,
        purchaseModalOpened: input.purchase.confirmed || input.preparePurchaseOnly,
        elapsedMs: Date.now() - startedAt,
      };
    }
    const removal = input.removeExistingPaymentMethod
      ? await clearDefaultPaymentMethod(page)
      : {clearedDefault: false, existingPaymentMethodCount: null, existingPaymentMethods: []};
    const shouldTryPickerRemoval = input.removeExistingPaymentMethod && (
      removal.existingPaymentMethodCount > 0
      || /stripe_(?:customer|data)_not_found/.test(removal.reason || '')
    );
    if (shouldTryPickerRemoval) {
      removal.savedCardPickerRemoval = await removeSavedPaymentMethodsFromPicker(page);
    } else if (input.removeExistingPaymentMethod) {
      removal.savedCardPickerRemoval = {
        attempted: false,
        skipped: true,
        reason: removal.reason || 'no_existing_payment_methods',
      };
    }
    let paymentPath;
    try {
      paymentPath = await runLoggedStep('open-payment-method-entry', debugDir, () => openPaymentMethodEntryPath(page, last4, expectedExpiry, {
        requireAddPaymentMethod: input.billingAddressOnly,
        timeoutMs: DEFAULT_PAYMENT_ENTRY_WAIT_MS,
      }), page);
    } catch (error) {
      if (/refreshed once/i.test(error.message || '')) throw error;
      if (!isRetryablePageLoadError(error)) throw error;
      await runLoggedStep('refresh-after-payment-entry-timeout', debugDir, () => refreshCreditsPageForRetry(page), page);
      paymentPath = await runLoggedStep('open-payment-method-entry-retry', debugDir, () => openPaymentMethodEntryPath(page, last4, expectedExpiry, {
        requireAddPaymentMethod: input.billingAddressOnly,
        timeoutMs: DEFAULT_PAYMENT_ENTRY_WAIT_MS,
        refreshOnTimeout: false,
      }), page);
    }
    if (paymentPath.alreadyBound) {
      const purchaseResult = input.purchase.confirmed
        ? await runLoggedStep('execute-confirmed-purchase-existing-card', debugDir, () => executeConfirmedPurchase(page, purchasePlan, input.debugPort, input.confirmationDebugDir), page)
        : (input.preparePurchaseOnly ? await runLoggedStep('prepare-purchase-existing-card', debugDir, () => preparePurchase(page, purchasePlan), page) : skippedPurchaseResult);
      if (input.preparePurchaseOnly) purchaseResult.submitted = false;
      if (input.preparePurchaseOnly) purchaseResult.mode = 'prepared_without_submission';
      if (!input.purchase.confirmed) await closePurchaseModal(page);
      const autoTopupResult = await runLoggedStep('configure-auto-topup-existing-card', debugDir, () => configureAutoTopup(page, input.autoTopup, input.debugPort), page);
      return {
        ok: true,
        status: input.purchase.confirmed
          ? (paymentPath.reboundExisting ? 'purchased_rebound_existing' : 'purchased_existing')
          : (input.preparePurchaseOnly
            ? (paymentPath.reboundExisting ? 'prepared_purchase_rebound_existing' : 'prepared_purchase_existing')
            : (paymentPath.reboundExisting ? 'rebound_existing' : 'already_bound')),
        account: accountState.account,
        card: {last4, masked, expiry: expectedExpiry},
        launch: input.launch,
        removal,
        preAddCreditsAutoTopup,
        autoTopup: autoTopupResult,
        purchase: purchaseResult,
        verified: true,
        purchaseModalOpened: true,
        elapsedMs: Date.now() - startedAt,
      };
    }
    let billingEntry;
    try {
      billingEntry = await runLoggedStep('open-billing-address-form', debugDir, () => openBillingAddressFormIfNeeded(page), page);
    } catch (error) {
      if (!isRetryablePageLoadError(error)) throw error;
      await runLoggedStep('refresh-after-billing-entry-timeout', debugDir, () => refreshCreditsPageForRetry(page), page);
      paymentPath = await runLoggedStep('open-payment-method-entry-after-billing-entry-refresh', debugDir, () => openPaymentMethodEntryPath(page, last4, expectedExpiry, {
        requireAddPaymentMethod: input.billingAddressOnly,
        timeoutMs: DEFAULT_PAYMENT_ENTRY_WAIT_MS,
        refreshOnTimeout: false,
      }), page);
      billingEntry = await runLoggedStep('open-billing-address-form-retry', debugDir, () => openBillingAddressFormIfNeeded(page), page);
    }
    let billingAddress;
    try {
      billingAddress = await runLoggedStep('fill-billing-address', debugDir, () => maybeFillBillingAddress(page, input.billing, input.debugPort), page);
    } catch (error) {
      if (!isRetryablePageLoadError(error)) throw error;
      await runLoggedStep('refresh-after-billing-address-timeout', debugDir, () => refreshCreditsPageForRetry(page), page);
      paymentPath = await runLoggedStep('open-payment-method-entry-after-billing-refresh', debugDir, () => openPaymentMethodEntryPath(page, last4, expectedExpiry, {
        requireAddPaymentMethod: input.billingAddressOnly,
        timeoutMs: DEFAULT_PAYMENT_ENTRY_WAIT_MS,
        refreshOnTimeout: false,
      }), page);
      billingEntry = await runLoggedStep('open-billing-address-form-retry', debugDir, () => openBillingAddressFormIfNeeded(page), page);
      billingAddress = await runLoggedStep('fill-billing-address-retry', debugDir, () => maybeFillBillingAddress(page, input.billing, input.debugPort), page);
    }
    if (input.billingAddressOnly) {
      const cardForm = await runLoggedStep('wait-card-form-ready', debugDir, () => waitForCardFormReady(page, input.debugPort), page);
      if (!cardForm.ready) {
        throw new Error(`Billing address was submitted but card form is not ready; tail=${cardForm.state?.tail || ''}; targetError=${cardForm.targetError || ''}`);
      }
      return {
        ok: true,
        status: 'billing_address_ready_for_card',
        account: accountState.account,
        launch: input.launch,
        paymentPath: {
          entry: paymentPath.entry,
          clicked: paymentPath.clicked?.label || '',
        },
        billingEntry: {
          opened: !!billingEntry.opened,
          clicked: billingEntry.clicked?.label || '',
        },
        billingAddress,
        cardForm: {
          ready: cardForm.ready,
          source: cardForm.source,
        },
        elapsedMs: Date.now() - startedAt,
      };
    }

    const preCardForm = await runLoggedStep('wait-card-form-ready-before-fill', debugDir, () => waitForCardFormReady(page, input.debugPort, 10000), page);
    if (!preCardForm.ready) {
      const completedMainPage = await runLoggedStep('detect-completed-main-page-before-card-fill', debugDir, () => detectCompletedCreditsMainPage(page, purchasePlan, input.autoTopup), page);
      if (completedMainPage?.recovered) {
        return {
          ok: true,
          status: input.purchase.confirmed ? 'purchased_existing' : 'already_bound',
          account: accountState.account,
          card: {last4, masked, expiry: expectedExpiry},
          launch: input.launch,
          removal,
          paymentPath,
          billingEntry,
          billingAddress,
          purchase: input.purchase.confirmed
            ? {
                executed: true,
                recovered: true,
                recoveryReason: completedMainPage.reason,
                amount: purchasePlan.amount,
                ruleDecision: purchasePlan.ruleDecision || null,
                beforeBalance: purchasePlan.beforeBalance || null,
                balanceVerification: completedMainPage.balanceVerification,
              }
            : skippedPurchaseResult,
          autoTopup: completedMainPage.autoTopup,
          verified: true,
          recovered: completedMainPage,
          elapsedMs: Date.now() - startedAt,
        };
      }
      paymentPath = await runLoggedStep('reopen-payment-method-entry-before-card-fill', debugDir, () => openPaymentMethodEntryPath(page, last4, expectedExpiry, {
        requireAddPaymentMethod: false,
        timeoutMs: DEFAULT_PAYMENT_ENTRY_WAIT_MS,
        refreshOnTimeout: false,
      }), page);
      billingEntry = await runLoggedStep('open-billing-address-form-before-card-fill-retry', debugDir, () => openBillingAddressFormIfNeeded(page), page);
      billingAddress = await runLoggedStep('fill-billing-address-before-card-fill-retry', debugDir, () => maybeFillBillingAddress(page, input.billing, input.debugPort), page);
    }

    let paymentWs = await waitForPaymentTarget(input.debugPort, 15000);
    payment = await cdp(paymentWs);
    await installNetworkDiagnostics(payment);
    await payment.send('Runtime.enable');
    let stripeState;
    try {
      stripeState = await runLoggedStep('fill-stripe-card', debugDir, () => fillStripeCard(payment, input.card), payment);
    } catch (error) {
      if (!isRetryablePageLoadError(error)) throw error;
      payment.close();
      payment = null;
      await runLoggedStep('refresh-after-card-form-timeout', debugDir, () => refreshCreditsPageForRetry(page), page);
      paymentPath = await runLoggedStep('open-payment-method-entry-after-card-refresh', debugDir, () => openPaymentMethodEntryPath(page, last4, expectedExpiry, {
        requireAddPaymentMethod: false,
        timeoutMs: DEFAULT_PAYMENT_ENTRY_WAIT_MS,
        refreshOnTimeout: false,
      }), page);
      billingEntry = await runLoggedStep('open-billing-address-form-after-card-refresh', debugDir, () => openBillingAddressFormIfNeeded(page), page);
      billingAddress = await runLoggedStep('fill-billing-address-after-card-refresh', debugDir, () => maybeFillBillingAddress(page, input.billing, input.debugPort), page);
      paymentWs = await waitForPaymentTarget(input.debugPort, 15000);
      payment = await cdp(paymentWs);
      await installNetworkDiagnostics(payment);
      await payment.send('Runtime.enable');
      stripeState = await runLoggedStep('fill-stripe-card-retry', debugDir, () => fillStripeCard(payment, input.card), payment);
    }

    let saveClick;
    try {
      saveClick = await runLoggedStep('click-save-payment-method', debugDir, () => waitForClickableText(page, 'Save payment method', DEFAULT_DOM_WAIT_MS, {pollMs: SLOW_DOM_POLL_MS}), page);
    } catch (error) {
      if (!isRetryablePageLoadError(error)) throw error;
      if (payment) {
        payment.close();
        payment = null;
      }
      await runLoggedStep('refresh-after-save-payment-method-timeout', debugDir, () => refreshCreditsPageForRetry(page), page);
      paymentPath = await runLoggedStep('open-payment-method-entry-after-save-refresh', debugDir, () => openPaymentMethodEntryPath(page, last4, expectedExpiry, {
        requireAddPaymentMethod: false,
        timeoutMs: DEFAULT_PAYMENT_ENTRY_WAIT_MS,
        refreshOnTimeout: false,
      }), page);
      billingEntry = await runLoggedStep('open-billing-address-form-after-save-refresh', debugDir, () => openBillingAddressFormIfNeeded(page), page);
      billingAddress = await runLoggedStep('fill-billing-address-after-save-refresh', debugDir, () => maybeFillBillingAddress(page, input.billing, input.debugPort), page);
      paymentWs = await waitForPaymentTarget(input.debugPort, 15000);
      payment = await cdp(paymentWs);
      await installNetworkDiagnostics(payment);
      await payment.send('Runtime.enable');
      stripeState = await runLoggedStep('fill-stripe-card-after-save-refresh', debugDir, () => fillStripeCard(payment, input.card), payment);
      saveClick = await runLoggedStep('click-save-payment-method-retry', debugDir, () => waitForClickableText(page, 'Save payment method', DEFAULT_DOM_WAIT_MS, {pollMs: SLOW_DOM_POLL_MS}), page);
    }
    if (!saveClick.clicked) {
      throw new Error('Add Credits payment path did not expose Save payment method; refusing to click Purchase');
    }
    await sleep(2000);
    await declineStripeLinkPrompts(input.debugPort);
    const postSave = await runLoggedStep('wait-save-modal-closes', debugDir, () => waitUntilSaveModalCloses(page), page);
    let verified;
    if (input.openPurchaseForVerification) {
      try {
        verified = await runLoggedStep('verify-by-purchase-modal', debugDir, () => verifyByPurchaseModal(page, last4, expectedExpiry), page);
      } catch (error) {
        if (/refreshed once/i.test(error.message || '')) throw error;
        if (!isRetryablePageLoadError(error)) throw error;
        await runLoggedStep('refresh-after-purchase-modal-timeout', debugDir, () => refreshCreditsPageForRetry(page), page);
        verified = await runLoggedStep('verify-by-purchase-modal-retry', debugDir, () => verifyByPurchaseModal(page, last4, expectedExpiry), page);
      }
    } else {
      verified = {purchase: false, verified: postSave.hasAddCredits, tail: postSave.tail};
    }
    const purchaseResult = input.purchase.confirmed
      ? await runLoggedStep('execute-confirmed-purchase', debugDir, () => executeConfirmedPurchase(page, purchasePlan, input.debugPort, input.confirmationDebugDir), page)
      : (input.preparePurchaseOnly ? await runLoggedStep('prepare-purchase', debugDir, () => preparePurchase(page, purchasePlan), page) : skippedPurchaseResult);
    if (input.preparePurchaseOnly) purchaseResult.submitted = false;
    if (input.preparePurchaseOnly) purchaseResult.mode = 'prepared_without_submission';
    if (input.openPurchaseForVerification && !input.purchase.confirmed) await closePurchaseModal(page);
    const autoTopupResult = await runLoggedStep('configure-auto-topup-final', debugDir, () => configureAutoTopup(page, input.autoTopup, input.debugPort), page);

    return {
      ok: true,
      status: input.purchase.confirmed ? 'bound_and_purchased' : (input.preparePurchaseOnly ? 'bound_and_purchase_prepared' : 'bound'),
      account: accountState.account,
      card: {last4, masked, expiry: expectedExpiry},
      launch: input.launch,
      removal,
      autoTopup: autoTopupResult,
      purchase: purchaseResult,
      linkCheckedAfterUncheck: stripeState.linkChecked,
      postSave: {hasAddCredits: postSave.hasAddCredits},
      preAddCreditsAutoTopup,
      verified: verified.verified,
      purchaseModalOpened: input.openPurchaseForVerification,
      elapsedMs: Date.now() - startedAt,
      ...(input.verbose ? {stripeValues: stripeState.values} : {}),
    };
  } catch (error) {
    if (input.purchase.confirmed && /CDP command timeout|Runtime\.evaluate|Runtime\.enable/i.test(error.message || '') && input.debugPort) {
      const recovery = await recoverPurchaseAfterAutomationTimeout(page, purchasePlanForRecovery, input.debugPort, input.confirmationDebugDir).catch((recoveryError) => {
        throw recoveryError;
      });
      if (recovery?.recovered) {
        const autoTopupResult = await configureAutoTopup(page, input.autoTopup, input.debugPort);
        return {
          ok: true,
          status: 'purchased_after_timeout_recovery',
          account: accountForRecovery || input.expectedAccount,
          card: {last4, masked, expiry: expectedExpiry},
          launch: input.launch,
          preAddCreditsAutoTopup,
          autoTopup: autoTopupResult,
          purchase: {
            executed: true,
            amount: purchasePlanForRecovery?.amount || purchasePlanForRecovery?.ruleDecision?.selectedAmount || '',
            ruleDecision: purchasePlanForRecovery?.ruleDecision || null,
            beforeBalance: purchasePlanForRecovery?.beforeBalance || null,
            confirmation: {method: 'timeout_recovery', confirmations: recovery.confirmations},
            result: {submitted: true, state: {timeoutRecovery: true}},
            balanceVerification: recovery.balanceVerification,
          },
          verified: true,
          purchaseModalOpened: true,
          elapsedMs: Date.now() - startedAt,
        };
      }
    }
    throw error;
  } finally {
    if (payment) payment.close();
    page.close();
  }
}

run()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
      elapsedMs: null,
    }, null, 2));
    process.exitCode = 1;
  });
