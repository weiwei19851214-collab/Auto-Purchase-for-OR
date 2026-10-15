import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureRiskEvidence, clickRiskDom, clickRiskPlaywright, riskButtonSnapshot} from '../automation/lib/crypto-risk-browser.mjs';

const origin = 'chrome-extension://mcohilncbfahbmgdjkbpemcciiolgcge';
function fixture({count = 1, disabled = false, ariaDisabled = false, obstructed = false,
  body = 'Suspicious Receiving address', inputs = [], actualOrigin = origin} = {}) {
  const clicks = [];
  const buttons = Array.from({length: count}, () => ({
    tagName: 'BUTTON', innerText: 'Continue (Unsafe)', disabled,
    value: 'secret-button-value', id: 'secret-attribute',
    getBoundingClientRect: () => ({left: 10, top: 20, width: 100, height: 40}),
    getAttribute: name => name === 'aria-disabled' ? String(ariaDisabled) : 'secret-attribute',
    focus() { clicks.push('focus'); }, click() { clicks.push('click'); },
    contains(node) { return node === this; },
  }));
  const obstruction = {tagName: 'DIV', innerText: 'secret-overlay-text',
    getBoundingClientRect: () => ({left: 0, top: 0, width: 300, height: 300})};
  const hit = obstructed ? obstruction : buttons[0];
  const document = {
    body: {innerText: body}, activeElement: {tagName: 'INPUT', value: 'secret-input'},
    visibilityState: 'visible', hasFocus: () => false,
    querySelectorAll: selector => selector.startsWith('button') ? buttons : inputs,
    elementFromPoint: () => hit, elementsFromPoint: () => hit ? [hit, ...buttons] : [],
  };
  const globals = {document, location: {origin: actualOrigin, pathname: '/notification.html'},
    innerWidth: 400, innerHeight: 700, devicePixelRatio: 2,
    getComputedStyle: () => ({display: 'block', visibility: 'visible', pointerEvents: 'auto', zIndex: '1'})};
  const calls = [];
  const wallet = {async send(method, params) {
    calls.push(method);
    if (method === 'Runtime.evaluate') return {result: {value: runInNewContext(params.expression, globals)}};
    if (method === 'Page.bringToFront') return {};
    throw new Error('unexpected command');
  }};
  return {clicks, globals, calls, wallet};
}

test('DOM clicks the one enabled unobstructed risk Continue button', async () => {
  const f = fixture();
  await clickRiskDom(f.wallet);
  assert.deepEqual(f.clicks, ['focus', 'click']);
  assert.equal(f.calls[0], 'Page.bringToFront');
});

for (const options of [{count: 0}, {count: 2}, {disabled: true}, {ariaDisabled: true},
  {obstructed: true}, {body: 'Confirm Send'}, {actualOrigin: 'https://example.com'}]) {
  test(`DOM refuses an unavailable or unverified risk button ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await assert.rejects(clickRiskDom(f.wallet), /crypto_wallet_transaction_button_unavailable/);
    assert.deepEqual(f.clicks, []);
  });
}

test('snapshot records structural focus, position and obstruction without sensitive content', () => {
  const f = fixture({obstructed: true, body: 'Suspicious Receiving address secret-body-value'});
  const result = runInNewContext(`(${riskButtonSnapshot.toString()})()`, f.globals);
  const json = JSON.stringify(result);
  assert.equal(json.includes('secret'), false);
  assert.equal(result.documentFocused, false);
  assert.equal(result.activeTag, 'INPUT');
  assert.deepEqual(JSON.parse(JSON.stringify(result.button.center)), {x: 60, y: 40});
  assert.equal(result.hitButton, false);
  assert.equal(result.obstruction.tag, 'DIV');
  assert.equal(result.hitStack.length, 2);
});

test('visible input suppresses screenshots even when the risk text is present', () => {
  const input = {value: 'sensitive-seed', getBoundingClientRect: () => ({left: 0, top: 0, width: 100, height: 20})};
  const f = fixture({inputs: [input]});
  const result = runInNewContext(`(${riskButtonSnapshot.toString()})()`, f.globals);
  assert.equal(result.safeScreenshot, false);
  assert.equal(JSON.stringify(result).includes('sensitive-seed'), false);
});

test('screenshot failure still writes structural JSON, discarding raw errors and state extras', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypto-risk-evidence-'));
  try {
    const f = fixture();
    const send = f.wallet.send.bind(f.wallet);
    f.wallet.send = async (method, params) => {
      if (method === 'Page.captureScreenshot') throw new Error('secret-error');
      return send(method, params);
    };
    await captureRiskEvidence(f.wallet, dir, {method: 'dom', phase: 'timeout',
      state: {stage: 'risk_warning', originOk: true, password: 'secret-state'}});
    assert.deepEqual(readdirSync(dir), ['crypto-risk-dom-timeout.json']);
    const json = readFileSync(join(dir, 'crypto-risk-dom-timeout.json'), 'utf8');
    const result = JSON.parse(json);
    assert.equal(result.screenshot.status, 'failed');
    assert.equal(result.page.documentFocused, false);
    assert.equal(json.includes('secret'), false);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('sensitive wallet surface skips screenshots but preserves structural evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypto-risk-evidence-'));
  try {
    const f = fixture({body: 'Suspicious Receiving address Enter wallet password secret-pass'});
    await captureRiskEvidence(f.wallet, dir, {method: 'cdp', phase: 'before', state: {stage: 'risk_warning'}});
    const result = JSON.parse(readFileSync(join(dir, 'crypto-risk-cdp-before.json'), 'utf8'));
    assert.equal(result.screenshot.status, 'skipped');
    assert.equal(result.page.safeScreenshot, false);
    assert.equal(f.calls.includes('Page.captureScreenshot'), false);
    assert.equal(JSON.stringify(result).includes('secret-pass'), false);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

function playwrightFixture({verifyState = {stage: 'risk_warning', originOk: true, targetId: 'target'}, duplicate = false,
  onTrial} = {}) {
  const events = [];
  const makePage = (id, url) => ({
    id, url: () => url,
    bringToFront: async () => events.push(['front', id]),
    close: async () => { throw new Error('must not close page'); },
    getByRole(role, options) {
      events.push(['locator', id, role, options]);
      return {count: async () => 1, click: async options => {
        events.push(['click', id, options]);
        if (options.trial && onTrial) await onTrial(verifyState);
      }};
    },
  });
  const pages = [makePage('other', origin + '/notification.html'), makePage('target', origin + '/notification.html'),
    makePage('external', 'https://payments.coinbase.com/session')];
  if (duplicate) pages.push(makePage('target', origin + '/fullscreen.html'));
  const context = {pages: () => pages, close: async () => { throw new Error('must not close context'); },
    newCDPSession: async page => ({send: async () => ({targetInfo: {targetId: page.id}}),
      detach: async () => events.push(['detach', page.id])})};
  const browser = {contexts: () => [context], close: async () => events.push(['disconnect'])};
  const load = async () => ({chromium: {connectOverCDP: async (url, options) => {
    events.push(['connect', url, options]); return browser;
  }}});
  const verify = async () => { events.push(['verify']); return verifyState; };
  return {events, load, verify};
}

test('Playwright matches exact target ID and exact Continue label, then disconnects only', async () => {
  const f = playwrightFixture();
  await clickRiskPlaywright({debugPort: 9222}, 'target', f.verify, f.load);
  assert.deepEqual(f.events.find(e => e[0] === 'locator'), ['locator', 'target', 'button', {name: 'Continue (Unsafe)', exact: true}]);
  assert.deepEqual(f.events.filter(e => e[0] === 'click'), [
    ['click', 'target', {trial: true, timeout: 2000}], ['click', 'target', {timeout: 2000, delay: 100}],
  ]);
  assert.deepEqual(f.events.at(-1), ['disconnect']);
  assert.equal(f.events.filter(e => e[0] === 'detach').length, 2);
});

for (const verifyState of [
  {stage: 'confirm_send', originOk: true, targetId: 'target'},
  {stage: 'risk_warning', originOk: false, targetId: 'target'},
  {stage: 'risk_warning', originOk: true, targetId: 'replacement'},
  {stage: 'risk_warning', originOk: true},
]) {
  test(`Playwright does not dispatch when verification changes ${JSON.stringify(verifyState)}`, async () => {
    const f = playwrightFixture({verifyState});
    await assert.rejects(clickRiskPlaywright({debugPort: 9222}, 'target', f.verify, f.load), /risk_playwright_page_changed/);
    assert.equal(f.events.filter(e => e[0] === 'click' && !e[2].trial).length, 0);
    assert.deepEqual(f.events.at(-1), ['disconnect']);
  });
}

test('Playwright trial target replacement is detected before real dispatch', async () => {
  const f = playwrightFixture({onTrial: state => { state.targetId = 'new-authoritative-target'; }});
  await assert.rejects(clickRiskPlaywright({debugPort: 9222}, 'target', f.verify, f.load), /risk_playwright_page_changed/);
  assert.deepEqual(f.events.filter(e => e[0] === 'click'), [['click', 'target', {trial: true, timeout: 2000}]]);
  assert.deepEqual(f.events.at(-1), ['disconnect']);
});

test('Playwright ambiguous target never clicks and disconnects', async () => {
  const f = playwrightFixture({duplicate: true});
  await assert.rejects(clickRiskPlaywright({debugPort: 9222}, 'target', f.verify, f.load), /risk_playwright_target_ambiguous/);
  assert.equal(f.events.some(e => e[0] === 'click'), false);
  assert.deepEqual(f.events.at(-1), ['disconnect']);
});
