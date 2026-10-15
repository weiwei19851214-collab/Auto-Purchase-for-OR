import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {inspectWalletStage} from '../automation/crypto_recharge_openrouter_cdp.mjs';

const origin = 'chrome-extension://mcohilncbfahbmgdjkbpemcciiolgcge';
async function stageFor(route, {text = '', buttons = [], fields = [], pageOrigin = origin} = {}) {
  const visible = {getBoundingClientRect: () => ({width: 100, height: 30})};
  const document = {
    body: {innerText: text},
    querySelectorAll(selector) {
      return selector === 'button,[role="button"]'
        ? buttons.map(label => ({...visible, innerText: label}))
        : fields.map(field => ({...visible, disabled: false, value: '', ...field}));
    },
  };
  const wallet = {async send(method, params) {
    assert.equal(method, 'Runtime.evaluate');
    return {result: {value: runInNewContext(params.expression, {document, location: {origin: pageOrigin, hash: route}})}};
  }};
  return inspectWalletStage(wallet);
}

const cases = [
  {stage: 'welcome', routes: ['#/initialize', '#/web-onboarding'], fixture: {buttons: ['Import wallet']}},
  {stage: 'method', routes: ['#/initialize-import', '#/web-onboarding/import'], fixture: {text: 'Seed phrase or private key\nSocial login\nHardware wallet'}},
  {stage: 'words', routes: ['#/import-with-seed-phrase-and-private-key', '#/web-onboarding/import-mnemonic-or-private-key'], fixture: {text: 'Seed phrase or private key', buttons: ['Confirm'], fields: Array.from({length: 12}, () => ({type: 'text'}))}},
  {stage: 'password_choice', routes: ['#/password-type', '#/web-onboarding/password-setup'], fixture: {text: 'Secure your wallet', buttons: ['Next']}},
  {stage: 'password_setup', routes: ['#/password-type', '#/web-onboarding/password-setup'], fixture: {text: 'Set password', buttons: ['Confirm'], fields: [{type: 'password'}, {type: 'password'}]}},
];
for (const {stage, routes, fixture} of cases) {
  test(`OKX old and new routes both identify ${stage} with matching DOM evidence`, async () => {
    for (const route of routes) {
      assert.equal((await stageFor(route, fixture)).stage, stage);
      assert.equal((await stageFor(`${route}?source=onboarding`, fixture)).stage, stage);
      assert.equal((await stageFor(route, {...fixture, pageOrigin: 'https://example.test'})).stage, 'unknown');
      assert.equal((await stageFor(route)).stage, 'unknown');
    }
  });
}
test('new mnemonic and password routes still require exact field counts', async () => {
  assert.equal((await stageFor('#/web-onboarding/import-mnemonic-or-private-key', {
    text: 'Seed phrase or private key', buttons: ['Confirm'], fields: [{type: 'text'}],
  })).stage, 'unknown');
  assert.equal((await stageFor('#/web-onboarding/password-setup', {
    text: 'Set password', buttons: ['Confirm'], fields: [{type: 'password'}],
  })).stage, 'unknown');
});


test('new welcome requires matching route, heading and Open wallet action', async () => {
  const fixture = {text: 'Welcome to OKX Wallet\nExplore the world of Web3', buttons: ['Open wallet']};
  assert.equal((await stageFor('#/web-onboarding/welcome', fixture)).stage, 'post_password_welcome');
  assert.equal((await stageFor('#/web-onboarding/welcome?source=seed', fixture)).stage, 'post_password_welcome');
  assert.equal((await stageFor('#/other', fixture)).stage, 'unknown');
  assert.equal((await stageFor('#/web-onboarding/welcome', {...fixture, buttons: ['Confirm']})).stage, 'unknown');
  assert.equal((await stageFor('#/web-onboarding/welcome', {...fixture, pageOrigin: 'https://example.test'})).stage, 'unknown');
});
