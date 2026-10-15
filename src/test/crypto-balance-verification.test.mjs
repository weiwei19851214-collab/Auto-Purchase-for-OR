import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {readBalance, waitForBalanceIncrease} from '../automation/crypto_recharge_openrouter_cdp.mjs';

function pageFixture({url = 'https://openrouter.ai/settings/credits', text = '', refreshedText = text} = {}) {
  const navigations = [];
  const page = {async send(method, params) {
    if (method === 'Page.enable') return {};
    if (method === 'Page.navigate') {
      navigations.push(params.url);
      url = params.url;
      text = refreshedText;
      return {};
    }
    assert.equal(method, 'Runtime.evaluate');
    return {result: {value: runInNewContext(params.expression, {
      document: {body: {innerText: text}, readyState: 'complete'},
      location: {origin: new URL(url).origin, href: url},
    })}};
  }};
  return {page, navigations};
}

test('missing credits text is not parsed as zero', async () => {
  const {page} = pageFixture({text: 'Loading Credits'});
  await assert.rejects(readBalance(page, {timeoutMs: 1}), /Could not parse/);
});

test('balance accepts actual zero and negative balance but rejects another origin', async () => {
  for (const balance of ['0.00', '-2.62', '10.00']) {
    const {page} = pageFixture({text: `TOTAL AVAILABLE $${balance}`});
    assert.equal((await readBalance(page)).balance, Number(balance));
  }
  const {page} = pageFixture({url: 'https://payments.coinbase.com/payment-sessions/test', text: 'TOTAL AVAILABLE $10.00'});
  await assert.rejects(readBalance(page), /origin mismatch/);
});

test('same-tab Coinbase completion navigates to Credits and verifies account before accepting increase', async () => {
  const {page, navigations} = pageFixture({
    url: 'https://payments.coinbase.com/payment-sessions/test',
    text: 'Payment completed',
    refreshedText: 'person@example.test Credits TOTAL AVAILABLE $10.00',
  });
  const balance = await waitForBalanceIncrease(page, 0, 1000, {expectedAccount: 'person@example.test'});
  assert.equal(balance.balance, 10);
  assert.deepEqual(navigations, ['https://openrouter.ai/settings/credits']);
});

test('wrong account after checkout cannot produce payment success', async () => {
  const {page} = pageFixture({text: 'other@example.test Credits TOTAL AVAILABLE $10.00'});
  await assert.rejects(waitForBalanceIncrease(page, 0, 1000, {expectedAccount: 'person@example.test'}), /account mismatch/);
});

test('missing baseline cannot be converted to zero for completion', async () => {
  const {page, navigations} = pageFixture({text: 'TOTAL AVAILABLE $10.00'});
  for (const baseline of [null, undefined, '', 'bad']) {
    await assert.rejects(waitForBalanceIncrease(page, baseline, 1000), /missing pre-purchase/);
  }
  assert.equal(navigations.length, 0);
});
