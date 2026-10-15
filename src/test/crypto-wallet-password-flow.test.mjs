import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {completeOkxPasswordSetup, inspectWalletStage, prepareOkxWallet} from '../automation/crypto_recharge_openrouter_cdp.mjs';

const password = 'Fixture-Only!9';
const phrase = Array(12).fill('notawalletword').join(' ');
const origin = 'chrome-extension://mcohilncbfahbmgdjkbpemcciiolgcge';

// 使用现场的设置密码说明，覆盖 unlocking 子串误判；测试不读取任何真实 CSV 凭据。
function walletFixture(initial, options = {}) {
  let stage;
  let fields = [];
  let active = null;
  let pressed = null;
  let lastScrolled = null;
  let closed = 0;
  const clicks = [];
  const typed = [];
  const blurred = [];
  const routes = {
    welcome: '#/initialize', method: '#/initialize-import', words: '#/import-with-seed-phrase-and-private-key',
    password_choice: '#/password-type?from=seed&sestheme=light', password_setup: '#/password-type?from=seed&sestheme=light',
    unlock: '#/unlock', post_password_welcome: '#/show-supported-chains/seed', connect_request: '#/connect/fixture', ready: '#/wallet',
  };
  const texts = {
    welcome: 'Import wallet',
    method: 'Import wallet Seed phrase or private key Use 12, 18, or 24-word seed phrases, or private keys Social login Hardware wallet',
    words: 'Seed phrase or private key',
    password_choice: 'Secure your wallet Password Create a password to protect your wallet Biometric authentication',
    password_setup: 'Set password This is your device-wide password. It is required for additional verification when unlocking, backing up, or exporting seed phrase, private-key, and social-login wallets. Password Confirm password',
    unlock: 'Onchain. Any Chain. Enter your password Unlock Forgot password?',
    post_password_welcome: 'Welcome to OKX Wallet',
    connect_request: 'Connect account Coinbase ' + (options.requestOrigin || 'payments.coinbase.com') + ' Allow this DApp to connect with your wallet.',
    ready: 'Assets Tokens Send Receive',
  };
  const transition = (next) => {
    stage = next;
    active = null;
    fields = Array.from({length: next === 'words' ? 12 : next === 'password_setup' ? (options.setupCount ?? 2) : next === 'unlock' ? 1 : 0}, (_, index) => ({
      type: next === 'words' ? 'text' : 'password', disabled: false,
      value: options.prefilled && next !== 'words' ? 'stale' : '',
      scrollIntoView() { lastScrolled = this; },
      getBoundingClientRect() { return {left: 10, top: index * 30, width: 100, height: 25}; },
    }));
  };
  transition(initial);
  const button = (label, next) => ({
    innerText: label,
    disabled: !!options.disabled && ['Confirm', 'Unlock'].includes(label),
    getAttribute: () => null,
    matches: () => true,
    scrollIntoView() { lastScrolled = this; },
    getBoundingClientRect: () => ({left: 10, top: 500, width: 100, height: 30}),
    click() {
      clicks.push(label);
      if (['password_setup', 'unlock'].includes(stage)) {
        assert.ok(fields.every((field) => field.value === password), 'all password fields must match the supplied fixture');
      }
      if (next !== stage) transition(next);
    },
  });
  const controls = () => ({
    welcome: [button('Import wallet', 'method')],
    method: [button('Seed phrase or private key Use 12, 18, or 24-word seed phrases, or private keys', 'words')],
    words: [button('Confirm', 'password_choice')],
    password_choice: [button('Password Create a password to protect your wallet', 'password_choice'), button('Next', 'password_setup')],
    password_setup: [button('Confirm', options.directConnect ? 'connect_request' : 'post_password_welcome')],
    unlock: [button('Unlock', 'connect_request')],
    post_password_welcome: [button('Start your Web3 journey', 'connect_request')],
    connect_request: [button('Connect', 'ready'), button('Cancel', 'connect_request')],
    ready: [button('Send', 'ready'), button('Receive', 'ready')],
  })[stage] || [];
  const document = {
    get body() { return {innerText: texts[stage] || ''}; },
    get activeElement() { return active; },
    querySelectorAll(selector) {
      if (selector === 'input,textarea') return fields;
      if (selector === 'input[type="password"]') return fields.filter((field) => field.type === 'password');
      return controls();
    },
  };
  const wallet = {
    close() { closed += 1; },
    async send(method, params) {
      if (method === 'Runtime.evaluate') return {result: {value: runInNewContext(params.expression, {
        document, location: {origin: options.origin || origin, hash: options.route || routes[stage]},
      })}};
      if (method === 'Input.dispatchMouseEvent') {
        assert.ok(Number.isFinite(params.x) && Number.isFinite(params.y));
        if (params.type === 'mousePressed') pressed = lastScrolled;
        if (params.type === 'mouseReleased') {
          if (fields.includes(pressed)) active = pressed;
          else pressed?.click();
          pressed = null;
        }
        return {};
      }
      assert.equal(method, 'Input.dispatchKeyEvent');
      if (params.type === 'char') {
        assert.equal(params.text.length, 1, 'no whole-string insert or paste');
        assert.ok(fields.includes(active));
        active.value += params.text;
        typed.push(stage);
      }
      if (params.type === 'rawKeyDown' && params.key === 'Backspace') active.value = active.value.slice(0, -1);
      if (params.type === 'rawKeyDown' && params.key === 'Tab') {
        blurred.push(stage);
        const index = fields.indexOf(active);
        // 密码框 Tab 会先到显示密码按钮，不能要求它直接跳到第二个密码框。
        active = stage === 'words' ? fields[index + 1] || {} : {};
      }
      return {};
    },
  };
  const acquired = [];
  const adapters = {acquireStage: async (_input, allowed) => {
    const state = await inspectWalletStage(wallet);
    assert.ok(allowed.includes(state.stage), 'stage ' + state.stage + ' must be routable');
    acquired.push(state.stage);
    return {wallet, state};
  }};
  return {wallet, adapters, clicks, typed, blurred, acquired, get closed() { return closed; }};
}

test('Set password description containing unlocking is not an unlock screen', async () => {
  const page = walletFixture('password_setup');
  assert.equal((await inspectWalletStage(page.wallet)).stage, 'password_setup');
  assert.equal((await inspectWalletStage(walletFixture('unlock').wallet)).stage, 'unlock');
  assert.equal((await inspectWalletStage(walletFixture('password_setup', {setupCount: 1}).wallet)).stage, 'unknown');
});

for (const start of ['welcome', 'password_choice', 'password_setup', 'unlock', 'post_password_welcome', 'connect_request', 'ready']) {
  test('wallet flow continues automatically from ' + start, async () => {
    const page = walletFixture(start, {prefilled: true});
    const result = await prepareOkxWallet({walletSeedPhrase: phrase, walletPassword: password}, page.adapters);
    assert.equal(result.status, start === 'ready' ? 'ready' : 'connect_submitted');
    if (['welcome', 'password_choice', 'password_setup'].includes(start)) {
      assert.equal(page.typed.filter((stage) => stage === 'password_setup').length, password.length * 2);
      assert.equal(page.blurred.filter((stage) => stage === 'password_setup').length, 2);
      assert.ok(page.clicks.includes('Confirm'));
    }
    if (start === 'unlock') {
      assert.equal(page.typed.length, password.length);
      assert.deepEqual(page.clicks, ['Unlock', 'Connect']);
    }
    assert.equal(page.closed, page.acquired.length);
    assert.equal(JSON.stringify(result).includes(password), false);
  });
}

test('password Confirm may go directly to Connect without a welcome page', async () => {
  const page = walletFixture('password_setup', {directConnect: true});
  assert.equal((await prepareOkxWallet({walletPassword: password}, page.adapters)).status, 'connect_submitted');
  assert.deepEqual(page.clicks, ['Confirm', 'Connect']);
});

test('unlocked wallet transaction page is routed to payment confirmation instead of wallet-page blocker', async () => {
  const page = walletFixture('ready');
  const calls = [];
  const result = await prepareOkxWallet({
    confirmWalletPayment: true,
    expectedCryptoPayment: {amount: '10.50', asset: 'USDC', network: 'Arbitrum One'},
  }, {
    acquireStage: async (_input, allowed) => {
      assert.ok(allowed.includes('transaction_confirmation'));
      return {wallet: page.wallet, target: {}, state: {stage: 'transaction_confirmation', transactionStage: 'risk_warning'}};
    },
    confirmWalletPayment: async (_input, amount, asset, network) => {
      calls.push({amount, asset, network});
      return {confirmed: true, riskWarningClicked: true, confirmationClicked: true};
    },
  });
  assert.equal(result.status, 'payment_confirmed');
  assert.deepEqual(calls, [{amount: '10.50', asset: 'USDC', network: 'Arbitrum One'}]);
  assert.equal(page.closed, 1);
});

test('missing CSV password fails before typing and still releases the target', async () => {
  const page = walletFixture('password_setup');
  await assert.rejects(prepareOkxWallet({}, page.adapters), /crypto_wallet_password_missing/);
  assert.equal(page.typed.length, 0);
  assert.equal(page.closed, 1);
});

test('disabled password Confirm is not submitted', async () => {
  const page = walletFixture('password_setup', {disabled: true});
  await assert.rejects(prepareOkxWallet({walletPassword: password}, page.adapters), /crypto_wallet_password_submit_unavailable/);
  assert.deepEqual(page.clicks, []);
  assert.equal(page.closed, 1);
});

test('password entry refuses wrong origin and non-setup routes', async () => {
  for (const options of [{origin: 'https://example.test'}, {route: '#/transaction/fixture'}]) {
    const page = walletFixture('password_setup', options);
    await assert.rejects(completeOkxPasswordSetup(page.wallet, password), /crypto_wallet_password_page_changed/);
    assert.equal(page.typed.length, 0);
  }
});

test('connection opt-out and other DApps cannot be silently connected', async () => {
  const paused = walletFixture('connect_request');
  assert.equal((await prepareOkxWallet({confirmWalletConnection: false}, paused.adapters)).status, 'connect_required');
  assert.deepEqual(paused.clicks, []);
  const other = walletFixture('connect_request', {requestOrigin: 'payments.coinbase.com.attacker.test'});
  await assert.rejects(prepareOkxWallet({}, other.adapters), /crypto_wallet_connect_origin_mismatch/);
  assert.deepEqual(other.clicks, []);
});
