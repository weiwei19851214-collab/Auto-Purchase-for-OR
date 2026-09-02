import assert from 'node:assert/strict';
import test from 'node:test';
import {stopProfile} from '../automation/lib/adspower.mjs';

test('AdsPower profile stop request uses a bounded abort signal', async () => {
  const originalFetch = globalThis.fetch;
  let requestSignal = null;
  globalThis.fetch = async (_url, options) => {
    requestSignal = options.signal;
    return new Response(null, {status: 200});
  };
  try {
    const result = await stopProfile({adspowerApiBase: 'http://adspower.local'}, 'profile_abc');
    assert.equal(result.ok, true);
    assert.ok(requestSignal instanceof AbortSignal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
