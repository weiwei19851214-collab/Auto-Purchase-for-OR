import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {acquireOkxTransactionTarget, clickOkxTransactionButton} from '../automation/crypto_recharge_openrouter_cdp.mjs';

const origin = 'chrome-extension://mcohilncbfahbmgdjkbpemcciiolgcge';
const expected = {amount: '10.50', asset: 'USDC', network: 'Arbitrum One'};
const confirmText = '1 of 2 confirmations\nConfirm Send\n-10.50 USDC\nNetwork\nArbitrum One';
function fixture({text = confirmText, covered = false} = {}) {
  const calls = [];
  let closed = 0;
  const button = {innerText: 'Confirm', disabled: false,
    getBoundingClientRect: () => ({left: 10, top: 20, width: 100, height: 40}),
    getAttribute: () => '', scrollIntoView() {}, contains: hit => hit === button};
  const document = {body: {innerText: text}, querySelectorAll: () => text === 'Loading' ? [] : [button],
    elementFromPoint: () => (typeof covered === 'function' ? covered(document) : covered) ? {} : button};
  const wallet = {async send(method, params) {
    calls.push(method);
    if (method === 'Runtime.evaluate') return {result: {value: runInNewContext(params.expression, {document, location: {origin}})}};
    return {};
  }, close() { closed++; }};
  return {wallet, calls, closed: () => closed};
}

test('loading notification is inspected before ready fullscreen and never falls back to mirror', async () => {
  const notification = {type: 'page', url: `${origin}/notification.html`, webSocketDebuggerUrl: 'ws://notification'};
  const fullscreen = {type: 'page', url: `${origin}/fullscreen.html`, webSocketDebuggerUrl: 'ws://fullscreen'};
  const connections = [];
  const loading = fixture({text: 'Loading'});
  const ready = fixture();
  let attempts = 0;
  const acquired = await acquireOkxTransactionTarget({}, expected, ['confirm_send'], 1000, {
    findTargets: async () => [fullscreen, notification],
    cdp: async url => { connections.push(url); return ++attempts === 1 ? loading.wallet : ready.wallet; },
    sleep: async () => {},
  });
  assert.equal(acquired.target, notification);
  assert.deepEqual(connections, ['ws://notification', 'ws://notification']);
  assert.equal(loading.closed(), 1);
  assert.equal(ready.closed(), 0);
  acquired.wallet.close();
});

test('overlay covering Confirm blocks mouse dispatch after bringing extension forward', async () => {
  const {wallet, calls} = fixture({covered: true});
  await assert.rejects(clickOkxTransactionButton(wallet, 'confirm_send', 'Confirm', expected), /button_unavailable/);
  assert.equal(calls[0], 'Page.bringToFront');
  assert.equal(calls.filter(method => method === 'Input.dispatchMouseEvent').length, 0);
});

test('uncovered matched Confirm receives exactly one click sequence', async () => {
  const {wallet, calls} = fixture();
  await clickOkxTransactionButton(wallet, 'confirm_send', 'Confirm', expected);
  assert.equal(calls[0], 'Page.bringToFront');
  assert.equal(calls.filter(method => method === 'Input.dispatchMouseEvent').length, 3);
});

test('transient overlay settles then produces only one click', async () => {
  let hits = 0;
  const {wallet, calls} = fixture({covered: () => ++hits < 3});
  await clickOkxTransactionButton(wallet, 'confirm_send', 'Confirm', expected);
  assert.equal(hits, 3);
  assert.equal(calls.filter(method => method === 'Runtime.evaluate').length, 6);
  assert.equal(calls.filter(method => method === 'Input.dispatchMouseEvent').length, 3);
});

test('transaction changes during overlay wait abort before any click', async () => {
  const {wallet, calls} = fixture({covered: document => {
    document.body.innerText = confirmText.replace('-10.50 USDC', '-100.50 USDC');
    return true;
  }});
  await assert.rejects(clickOkxTransactionButton(wallet, 'confirm_send', 'Confirm', expected), /page_changed/);
  assert.equal(calls.filter(method => method === 'Input.dispatchMouseEvent').length, 0);
});
