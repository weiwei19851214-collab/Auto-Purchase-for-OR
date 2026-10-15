import assert from 'node:assert/strict';
import test from 'node:test';
import {selectAuthoritativeOkxTargetIndex, TRUSTED_OKX_EXTENSION_ID} from '../automation/lib/crypto-wallet-target.mjs';

const root = `chrome-extension://${TRUSTED_OKX_EXTENSION_ID}`;
const target = (type = 'page', path = '/index.html') => ({type, url: `${root}${path}`});

test('one notification page takes precedence over other pages and mirrors', () => {
  assert.equal(selectAuthoritativeOkxTargetIndex([
    target('webview', '/notification.html'), target(), target('page', '/notification.html#/confirm?request=1'), target(),
  ]), 2);
});
test('two notification pages remain ambiguous regardless of otherwise identical metadata', () => {
  const notification = {...target('page', '/notification.html'), id: 'same-id', stage: 'transaction', amount: 10};
  assert.equal(selectAuthoritativeOkxTargetIndex([notification, {...notification}]), -1);
});
test('one ordinary page takes precedence over any number of non-page mirrors', () => {
  assert.equal(selectAuthoritativeOkxTargetIndex([target('webview'), target(), target('background_page')]), 1);
});
test('multiple ordinary pages are ambiguous and do not fall back to mirrors', () => {
  assert.equal(selectAuthoritativeOkxTargetIndex([target(), target('webview', '/notification.html'), target()]), -1);
});
test('without pages only one trusted candidate qualifies', () => {
  assert.equal(selectAuthoritativeOkxTargetIndex([target('webview')]), 0);
  assert.equal(selectAuthoritativeOkxTargetIndex([target('webview'), target('background_page')]), -1);
  assert.equal(selectAuthoritativeOkxTargetIndex([]), -1);
});
test('untrusted and malformed URLs never qualify and original index is preserved', () => {
  const rejected = [
    `https://${TRUSTED_OKX_EXTENSION_ID}/notification.html`,
    `chrome-extension://${TRUSTED_OKX_EXTENSION_ID}.evil.test/notification.html`,
    `chrome-extension://evil@${TRUSTED_OKX_EXTENSION_ID}/notification.html`,
    `chrome-extension://${TRUSTED_OKX_EXTENSION_ID}:123/notification.html`,
    'not a URL',
  ].map(url => ({type: 'page', url}));
  assert.equal(selectAuthoritativeOkxTargetIndex(rejected), -1);
  assert.equal(selectAuthoritativeOkxTargetIndex([...rejected, target()]), rejected.length);
});
test('notification pathname must match exactly, not another path or query substring', () => {
  for (const path of ['/other.html?redirect=/notification.html', '/other.html#/notification.html', '/notification.html.evil', '/nested/notification.html', '/notification.html/child']) {
    assert.equal(selectAuthoritativeOkxTargetIndex([target('page', path), target()]), -1);
  }
  assert.equal(selectAuthoritativeOkxTargetIndex([target(), target('page', '/notification.html?request=2')]), 1);
});
test('null or incomplete descriptors cannot create a candidate', () => {
  for (const value of [null, undefined, {}, 'targets']) assert.equal(selectAuthoritativeOkxTargetIndex(value), -1);
  assert.equal(selectAuthoritativeOkxTargetIndex([null, {}, {url: null}, target()]), 3);
});

test('side panel outer target outranks its SES mirror after onboarding closes', () => {
  assert.equal(selectAuthoritativeOkxTargetIndex([target('iframe', '/ses.html#/wallet'), target('other', '/sidepanel.html#/wallet')]), 1);
  assert.equal(selectAuthoritativeOkxTargetIndex([target('other', '/sidepanel.html'), target('other', '/sidepanel.html'), target('iframe', '/ses.html')]), -1);
  assert.equal(selectAuthoritativeOkxTargetIndex([target('other', '/sidepanel.html'), target('page', '/notification.html')]), 1);
});
