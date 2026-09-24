import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {continueCryptoAfterAmount} from '../automation/crypto_recharge_openrouter_cdp.mjs';
import {automationScriptForRechargeMode, executeRowWithAdapters, parsePlan} from '../server/automation-adapter.mjs';
import {normalizeResultError} from '../server/worker.mjs';

const CRYPTO_CSV = [
  'status,opom_account_id,login_email,ads_power_user_id,opom_health_status,ads_match_status,balance_threshold,amount_below_threshold,amount_at_or_above_threshold',
  ',acct_crypto,user@example.com,profile_crypto,ok,matched,145,150,20',
  '',
].join('\n');

const CRYPTO_OPTIONS = {
  rechargeMode: 'crypto',
  scopeBillingAddress: false,
  scopePaymentMethod: false,
  scopePurchase: true,
  scopeAutoTopup: false,
  confirmPurchase: false,
  preparePurchaseOnly: false,
  skipAdsPowerMatch: false,
};

test('runtime dispatcher keeps bank-card and crypto executors physically separated', () => {
  assert.match(automationScriptForRechargeMode('crypto'), /crypto_recharge_openrouter_cdp\.mjs$/);
  assert.match(automationScriptForRechargeMode('bank_card'), /bind_openrouter_card_cdp\.mjs$/);
  assert.notEqual(automationScriptForRechargeMode('crypto'), automationScriptForRechargeMode('bank_card'));

  // 回归保护：正式 Worker 入口不能再硬编码银行卡脚本，否则虚拟币任务会在启动 AdsPower 前被银行卡参数校验拦截。
  const adapterSource = readFileSync(join(process.cwd(), 'src/server/automation-adapter.mjs'), 'utf8');
  const executeRowStart = adapterSource.indexOf('export async function executeRow(');
  const executeRowEnd = adapterSource.indexOf('export async function executeRowWithAdapters(', executeRowStart);
  const executeRowSource = adapterSource.slice(executeRowStart, executeRowEnd);
  assert.doesNotMatch(executeRowSource, /BIND_SCRIPT|CRYPTO_RECHARGE_SCRIPT|bindScript/);
});

test('crypto dry-run uses account, AdsPower and recharge rule without card fields', async () => {
  const parsed = await parsePlan(CRYPTO_CSV, CRYPTO_OPTIONS);
  assert.equal(parsed.rows[0].status, 'ready');
  assert.equal(parsed.args.rechargeMode, 'crypto');
  assert.equal(parsed.rows[0].executionScope, 'purchase_prepare');
});

test('crypto browser result pauses the batch at the OKX wallet confirmation boundary', async () => {
  let capturedTask = null;
  let capturedScript = '';
  const result = await executeRowWithAdapters(CRYPTO_CSV, 0, CRYPTO_OPTIONS, {
    common: {cardLast4: () => ''},
    runClosedLoopChildAsync: async (_bindScript, task) => {
      capturedScript = _bindScript;
      capturedTask = task;
      return {
        ok: true,
        result: {
          cryptoPurchase: {
            amount: '150',
            beforeBalance: {balance: 10},
            walletConfirmationRequired: true,
          },
        },
      };
    },
  });

  assert.equal(capturedTask.cryptoOnly, true);
  assert.match(capturedScript, /crypto_recharge_openrouter_cdp\.mjs$/);
  assert.equal(capturedTask.rechargeMode, 'crypto');
  assert.equal('card' in capturedTask, false);
  assert.equal('billing' in capturedTask, false);
  assert.equal('autoTopup' in capturedTask, false);
  assert.equal('purchaseOnly' in capturedTask, false);
  assert.equal(capturedTask.purchase.confirmed, true);
  assert.equal(capturedTask.purchase.rule.enabled, true);
  assert.equal(capturedTask.purchase.rule.threshold, '145');
  assert.equal(capturedTask.purchase.rule.belowAmount, '150');
  assert.equal(capturedTask.purchase.rule.atOrAboveAmount, '20');
  assert.equal(result.status, 'manual_security_blocker');
  assert.equal(result.stage, 'crypto.wallet_confirmation');
  assert.match(result.message, /当前钱包界面/);
  assert.equal(result.safeToContinue, false);
  assert.equal(result.stopProfile, false);
  assert.equal(result.details.purchaseAmount, '150');
});

test('crypto browser reports Coinbase insufficient USDC funds without closing the profile', async () => {
  const result = await executeRowWithAdapters(CRYPTO_CSV, 0, CRYPTO_OPTIONS, {
    common: {cardLast4: () => ''},
    runClosedLoopChildAsync: async () => ({
      ok: true,
      result: {
        cryptoPurchase: {
          amount: '10',
          totalDue: '10.50',
          insufficientFunds: true,
          walletConfirmationRequired: false,
          checkoutState: {
            insufficientFunds: true,
            requiredAmount: '10.50',
            requiredAsset: 'USDC',
          },
        },
      },
    }),
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'crypto.insufficient_funds');
  assert.equal(result.errorCode, 'crypto_insufficient_funds');
  assert.equal(result.message, '余额不足：需要 10.50 USDC');
  assert.equal(result.safeToContinue, false);
  assert.equal(result.stopProfile, false);
});

test('worker keeps the crypto amount in the user-facing block reason', () => {
  const normalized = normalizeResultError({
    status: 'failed',
    stage: 'crypto.insufficient_funds',
    errorCode: 'crypto_insufficient_funds',
    message: '余额不足：需要 10.50 USDC',
  });
  assert.equal(normalized.message, '余额不足：需要 10.50 USDC');
  assert.equal(normalized.errorCode, 'crypto_insufficient_funds');
});

test('crypto execution page labels the result message column as block reason', () => {
  const html = readFileSync(join(process.cwd(), 'public/execution.html'), 'utf8');
  const script = readFileSync(join(process.cwd(), 'public/execution.js'), 'utf8');
  assert.match(html, /id="messageColumnHeader"/);
  assert.match(script, /rechargeMode === 'crypto' \? '阻塞原因' : '消息'/);
});

test('bank-card and crypto scheduler controls live on the channel page instead of generic settings', () => {
  const html = readFileSync(join(process.cwd(), 'public/index.html'), 'utf8');
  const script = readFileSync(join(process.cwd(), 'public/app.js'), 'utf8');
  const settingsStart = html.indexOf('id="settingsDialog"');
  const settingsEnd = html.indexOf('</dialog>', settingsStart);
  const settingsHtml = html.slice(settingsStart, settingsEnd);
  assert.doesNotMatch(settingsHtml, /autoRechargeEnabled|自动充值计划/);
  assert.match(html, /id="autoRechargePanel"/);
  assert.match(html, /id="autoRechargeChannel">银行卡/);
  assert.ok(script.includes("const modeLabel = crypto ? '虚拟币' : '银行卡';"));
  assert.match(script, /`\$\{modeLabel\}自动充值计划`/);
  assert.ok(script.includes('state.schedulers[state.rechargeMode]'));
});

test('crypto browser flow uses human amount input and stops before wallet payment confirmation', () => {
  const source = readFileSync(join(process.cwd(), 'src/automation/crypto_recharge_openrouter_cdp.mjs'), 'utf8');
  const bankCardSource = readFileSync(join(process.cwd(), 'src/automation/bind_openrouter_card_cdp.mjs'), 'utf8');
  assert.match(source, /async function ensureUseCrypto/);
  assert.match(source, /const CRYPTO_PURCHASE_FORM_WAIT_MS = 20000/);
  assert.match(source, /async function waitForCryptoPurchaseForm/);
  assert.match(source, /const purchaseForm = await waitForCryptoPurchaseForm\(page\)/);
  assert.ok(source.indexOf('await waitForCryptoPurchaseForm(page)') < source.indexOf('await fillAmount(page, purchase.amount)'));
  assert.match(source, /const amountInput = await fillAmount\(page, purchase\.amount\)/);
  assert.ok(source.includes('payments\\.coinbase\\.com'));
  assert.match(source, /async function selectOkxWallet/);
  assert.match(source, /async function launchOkxExtension/);
  assert.doesNotMatch(source, /okx-keychain|readWalletCredentials/);
  assert.match(source, /async function continueCryptoAfterAmount/);
  assert.ok(source.indexOf('const amountInput = await fillAmount(page, purchase.amount)')
    < source.indexOf('const continued = await continueCryptoAfterAmount(input, page'));
  const continuation = source.slice(source.indexOf('async function continueCryptoAfterAmount('), source.indexOf('async function runCryptoRecharge('));
  assert.ok(continuation.indexOf('await openWalletExtension(checkout)')
    < continuation.indexOf('const wallet = await prepareWallet(input)'));
  assert.match(continuation, /wallet.status !== 'ready'/);
  assert.doesNotMatch(source, /panel-only|probeOkxSidePanel|okx-side-panel/);
  assert.match(source, /只在仍是导入页、12 格都已输入且 Confirm 可用时提交/);
  assert.match(source, /async function readCheckoutState/);
  assert.match(source, /Insufficient funds/);
  assert.match(source, /walletConfirmationRequired: checkoutState\.insufficientFunds !== true/);
  assert.ok(source.includes("await fillCryptoVerificationPassword(input, page)"));
  assert.ok(source.includes("await continueCryptoVerification(page)"));
  assert.ok(source.includes("verification && !verificationSubmitted"));
  assert.doesNotMatch(bankCardSource, /OKX Wallet|payments\.coinbase\.com|Use crypto|cryptoOnly/);
});

test('post-amount flow launches OKX, then checks login before wallet confirmation', async () => {
  const calls = [];
  const checkout = {close() { calls.push('close'); }};
  const adapters = {
    prepareWallet: async () => { calls.push('wallet'); return {status: 'ready'}; },
    submitPurchase: async () => { calls.push('purchase'); return {clicked: true}; },
    openCheckout: async () => { calls.push('checkout'); return {checkout, target: {url: 'https://payments.coinbase.com/payment-sessions/test'}}; },
    selectWallet: async () => { calls.push('select-okx'); return {selected: true}; },
    launchExtension: async () => { calls.push('launch'); },
    readCheckout: async () => { calls.push('checkout-state'); return {walletConnected: true}; },
    inspectTargets: async () => { calls.push('targets'); return [{type: 'other'}]; },
  };
  const result = await continueCryptoAfterAmount({debugPort: 'fixture'}, {}, {amount: '150'}, adapters);
  assert.deepEqual(calls, ['purchase', 'checkout', 'select-okx', 'launch', 'wallet', 'checkout-state', 'targets']);
  assert.equal(result.cryptoPurchase.wallet.status, 'ready');
  assert.deepEqual(result.cryptoPurchase.okxTargets, [{type: 'other'}]);
  result.checkout.close();

  let confirmations = 0;
  const blockedCheckout = {close() {}};
  await assert.rejects(continueCryptoAfterAmount({}, {}, {}, {
    prepareWallet: async () => ({status: 'locked'}),
    submitPurchase: async () => ({clicked: true}),
    openCheckout: async () => ({checkout: blockedCheckout, target: {url: 'https://payments.coinbase.com/payment-sessions/test'}}),
    selectWallet: async () => ({selected: true}),
    launchExtension: async () => {},
    readCheckout: async () => { confirmations += 1; return {}; },
  }), /crypto_wallet_import_unverified/);
  assert.equal(confirmations, 0);
});
