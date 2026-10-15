import assert from 'node:assert/strict';
import test from 'node:test';
import {selectOpenRouterTarget, coinbaseSessionUrl, selectNewCoinbaseTarget} from '../automation/crypto_recharge_openrouter_cdp.mjs';

const target = (id, url) => ({id, url, type: 'page', webSocketDebuggerUrl: `ws://test/${id}`});
const session = (id) => `https://payments.coinbase.com/payment-sessions/${id}`;

test('Credits selection preserves Gmail and other websites', () => {
  const gmail = target('gmail', 'https://mail.google.com/mail/u/0/#inbox');
  const unrelated = target('other', 'https://example.test');
  const account = target('account', 'https://openrouter.ai/settings/account');
  const credits = target('credits', 'https://openrouter.ai/settings/credits');
  assert.equal(selectOpenRouterTarget([gmail, unrelated]), undefined);
  assert.equal(selectOpenRouterTarget([gmail, unrelated, account]), account);
  assert.equal(selectOpenRouterTarget([gmail, account, credits]), credits);
  assert.equal(selectOpenRouterTarget([target('fake', 'https://openrouter.ai.example.test/settings/credits')]), undefined);
});

test('only exact Coinbase HTTPS payment sessions are eligible', () => {
  for (const url of ['http://payments.coinbase.com/payment-sessions/a', 'https://evil.test/payments.coinbase.com/payment-sessions/a', 'https://payments.coinbase.com.evil.test/payment-sessions/a']) {
    assert.equal(coinbaseSessionUrl(target('fake', url)), '');
  }
});

test('old session remains excluded across query and hash changes', () => {
  const old = target('old', session('old') + '?source=a#one');
  const baseline = [coinbaseSessionUrl(old)];
  assert.equal(selectNewCoinbaseTarget([target('old', session('old') + '/?source=b#two')], baseline), undefined);
});

test('same tab navigating to a new session is accepted while stale tabs are rejected', () => {
  const old = target('same-tab', session('old'));
  const fresh = target('same-tab', session('new'));
  assert.equal(selectNewCoinbaseTarget([old, fresh], [coinbaseSessionUrl(old)]), fresh);
});

test('multiple new checkout sessions fail safely', () => {
  assert.throws(() => selectNewCoinbaseTarget([target('a', session('a')), target('b', session('b'))]), /ambiguous/);
});
