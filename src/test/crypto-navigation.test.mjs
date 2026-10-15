import assert from 'node:assert/strict';
import test from 'node:test';
import {navigate, ensureCreditsPage} from '../automation/crypto_recharge_openrouter_cdp.mjs';

const credits = 'https://openrouter.ai/settings/credits';
test('CDP navigation network failure exits immediately with safe actionable error', async () => {
  const methods = [];
  const client = {async send(method) {
    methods.push(method);
    return method === 'Page.navigate' ? {errorText: 'net::ERR_SOCKS_CONNECTION_FAILED private-debug-value'} : {};
  }};
  await assert.rejects(navigate(client, credits), (error) => {
    assert.equal(error.message, 'Credits navigation failed: ERR_SOCKS_CONNECTION_FAILED (https://openrouter.ai)');
    return true;
  });
  assert.deepEqual(methods, ['Page.enable', 'Page.navigate']);
});

for (const failure of ['network', 'runtime']) {
  test(`Credits initialization closes its unreturned CDP socket on ${failure} failure`, async () => {
    let closes = 0;
    const page = {async send(method) {
      if (failure === 'runtime' && method === 'Runtime.enable') throw new Error('runtime unavailable');
      return method === 'Page.navigate' ? {errorText: 'net::ERR_SOCKS_CONNECTION_FAILED'} : {};
    }, close() { closes++; }};
    await assert.rejects(ensureCreditsPage({browserWs: 'ws://browser'}, {
      getTargets: () => [{type: 'page', url: credits, webSocketDebuggerUrl: 'ws://page'}],
      cdp: async () => page,
    }), failure === 'network' ? /ERR_SOCKS_CONNECTION_FAILED/ : /runtime unavailable/);
    assert.equal(closes, 1);
  });
}
