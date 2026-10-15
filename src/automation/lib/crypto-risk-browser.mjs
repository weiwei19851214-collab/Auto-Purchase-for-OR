import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const EXTENSION_ORIGIN = 'chrome-extension://mcohilncbfahbmgdjkbpemcciiolgcge';
const LABEL = 'Continue (Unsafe)';

async function evaluate(wallet, fn, args = []) {
  const response = await wallet.send('Runtime.evaluate', {
    expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) throw new Error('risk_evaluation_failed');
  return response.result.value;
}

// Only structural evidence: never serialize arbitrary text, attributes or input values.
export function riskButtonSnapshot() {
  const rect = node => {
    const r = node.getBoundingClientRect();
    return {x: r.left, y: r.top, width: r.width, height: r.height};
  };
  const visible = node => {
    const r = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const describe = node => node ? {
    tag: node.tagName,
    rect: rect(node),
    pointerEvents: getComputedStyle(node).pointerEvents,
    zIndex: getComputedStyle(node).zIndex,
  } : null;
  const candidates = [...document.querySelectorAll('button,[role="button"]')]
    .filter(node => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim() === 'Continue (Unsafe)' && visible(node));
  const button = candidates.length === 1 ? candidates[0] : null;
  const bounds = button && rect(button);
  const center = bounds && {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
  const hit = center && document.elementFromPoint(center.x, center.y);
  const text = document.body?.innerText || '';
  const originOk = location.origin === 'chrome-extension://mcohilncbfahbmgdjkbpemcciiolgcge';
  const sensitiveSurface = /seed phrase|recovery phrase|private key|enter.*password/i.test(text)
    || [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].some(visible);
  return {
    originOk,
    surface: /^\/(?:notification|fullscreen|sidepanel)\.html$/.test(location.pathname) ? location.pathname : 'other',
    documentFocused: document.hasFocus(),
    visibility: document.visibilityState,
    activeTag: document.activeElement?.tagName || '',
    viewport: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio},
    candidateCount: candidates.length,
    button: button && {rect: bounds, center, disabled: button.disabled === true,
      ariaDisabled: button.getAttribute('aria-disabled') === 'true',
      pointerEvents: getComputedStyle(button).pointerEvents},
    hitButton: Boolean(button && hit && button.contains(hit)),
    obstruction: hit && (!button || !button.contains(hit)) ? describe(hit) : null,
    hitStack: center ? document.elementsFromPoint(center.x, center.y).slice(0, 6).map(describe) : [],
    safeScreenshot: originOk && !sensitiveSurface
      && (/Suspicious Receiving address/i.test(text) || /\bConfirm Send\b/i.test(text)),
  };
}

export async function captureRiskEvidence(wallet, dir, entry) {
  if (!dir) return;
  const name = `crypto-risk-${entry.method}-${entry.phase}`;
  const evidence = {method: entry.method, phase: entry.phase, observedAt: new Date().toISOString(),
    stage: entry.state?.stage || 'unknown', originOk: entry.state?.originOk === true,
    targetId: entry.targetId || '',
    amountMatched: entry.state?.hasAmount === true, networkMatched: entry.state?.hasNetwork === true,
    screenshot: {status: 'not_captured', reason: 'snapshot_unavailable'}};
  if (entry.phase === 'dispatch_error') evidence.errorCode = 'crypto_wallet_risk_continue_dispatch_failed';
  mkdirSync(dir, {recursive: true});
  try {
    evidence.page = await evaluate(wallet, riskButtonSnapshot);
    if (evidence.page.safeScreenshot) {
      const shot = await wallet.send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
      if (typeof shot.data !== 'string' || !shot.data) throw new Error('screenshot_unavailable');
      const path = join(dir, name + '.png');
      writeFileSync(path, Buffer.from(shot.data, 'base64'), {mode: 0o600});
      evidence.screenshot = {status: 'captured', path};
    } else evidence.screenshot = {status: 'skipped', reason: 'unverified_or_sensitive_surface'};
  } catch {
    evidence.screenshot = {status: 'failed', reason: 'capture_unavailable'};
  }
  writeFileSync(join(dir, name + '.json'), JSON.stringify(evidence, null, 2), {mode: 0o600});
}

export async function clickRiskDom(wallet) {
  await wallet.send('Page.bringToFront');
  const dispatched = await evaluate(wallet, (origin, label) => {
    if (location.origin !== origin || !/Suspicious Receiving address/i.test(document.body?.innerText || '')) return false;
    const matches = [...document.querySelectorAll('button,[role="button"]')].filter(node => {
      const r = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim() === label
        && r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        && style.pointerEvents !== 'none' && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
    });
    if (matches.length !== 1) return false;
    const button = matches[0];
    const r = button.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !button.contains(hit)) return false;
    button.focus({preventScroll: true});
    button.click();
    return true;
  }, [EXTENSION_ORIGIN, LABEL]);
  if (!dispatched) throw new Error('manual_security_blocker: crypto_wallet_transaction_button_unavailable');
}

export async function clickRiskPlaywright(input, targetId, verify, load = () => import('playwright-core')) {
  if (!targetId || !input.debugPort) throw new Error('risk_playwright_target_missing');
  let browser;
  try {
    const {chromium} = await load();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(input.debugPort)}`, {timeout: 5000, noDefaults: true});
    const matches = [];
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (!page.url().startsWith(EXTENSION_ORIGIN + '/')) continue;
        const session = await context.newCDPSession(page);
        try {
          const {targetInfo} = await session.send('Target.getTargetInfo');
          if (targetInfo.targetId === targetId) matches.push(page);
        } finally { await session.detach(); }
      }
    }
    if (matches.length !== 1) throw new Error('risk_playwright_target_ambiguous');
    const page = matches[0];
    await page.bringToFront();
    const button = page.getByRole('button', {name: LABEL, exact: true});
    if (await button.count() !== 1) throw new Error('risk_playwright_button_ambiguous');
    await button.click({trial: true, timeout: 2000});
    const state = await verify();
    if (state.stage !== 'risk_warning' || state.originOk !== true || state.targetId !== targetId) {
      throw new Error('risk_playwright_page_changed');
    }
    await button.click({timeout: 2000, delay: 100});
  } finally {
    // connectOverCDP disconnects on close; never close the existing page/context.
    await browser?.close().catch(() => {});
  }
}
