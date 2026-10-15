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

const observedCheckoutPayment = async () => ({
  amount: '10.50', asset: 'USDC', network: 'arbitrum one', source: 'coinbase_checkout',
  networkFee: {amount: '', asset: '', usd: '', display: '', status: 'unavailable', source: 'coinbase_checkout'},
});

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
  assert.equal(result.stopProfile, true);
  assert.equal(result.details.purchaseAmount, '150');
});

test('crypto browser reports Coinbase insufficient USDC funds and pauses the task', async () => {
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
  assert.match(result.message, /任务余额不足，任务未执行完/);
  assert.match(result.message, /10\.50 USDC/);
  assert.equal(result.safeToContinue, false);
  assert.equal(result.stopProfile, true);
});

test('Coinbase Try again is a terminal crypto payment failure and is not retried', async () => {
  const result = await executeRowWithAdapters(CRYPTO_CSV, 0, CRYPTO_OPTIONS, {
    common: {cardLast4: () => ''},
    runClosedLoopChildAsync: async () => ({
      ok: true,
      result: {cryptoPurchase: {paymentFailed: true, checkoutState: {paymentFailed: true}}},
    }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'crypto.payment_failed');
  assert.equal(result.errorCode, 'crypto_payment_failed_try_again');
  assert.match(result.message, /充值失败，可能是余额不足/);
  assert.equal(result.safeToContinue, true);
  assert.equal(result.stopProfile, true);
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

test('crypto recharge defaults the account source to CSV when no mode draft exists', () => {
  const script = readFileSync(join(process.cwd(), 'public/app.js'), 'utf8');
  assert.match(script, /state.source = draft?.source || 'csv';/);
  assert.match(script, /state.source = 'opom';/);
});

test('crypto fixed amount controls reach the task options and toggle the visible rule fields', () => {
  const script = readFileSync(join(process.cwd(), 'public/app.js'), 'utf8');
  assert.match(script, /data-crypto-rule-mode/);
  assert.match(script, /cryptoRechargeRuleMode: crypto \? cryptoRuleMode\(\) : 'balance_threshold'/);
  assert.match(script, /cryptoFixedAmount: crypto \? String\(cryptoFixedAmount\(\)\) : ''/);
  assert.match(script, /balanceRuleFields.hidden = fixedCrypto/);
  assert.match(script, /cryptoFixedAmountField.hidden = !fixedCrypto/);
});

test('crypto fixed amount defaults to ten while balance rule amounts remain unchanged', () => {
  const html = readFileSync(join(process.cwd(), 'public/index.html'), 'utf8');
  const script = readFileSync(join(process.cwd(), 'public/app.js'), 'utf8');
  assert.match(html, /id="cryptoFixedAmount"[^>]*value="10"/);
  assert.ok(script.includes('return numericValue(el.cryptoFixedAmount, 10);'));
  assert.ok(script.includes("cryptoFixedAmount: el.cryptoFixedAmount?.value || '10'"));
  assert.ok(script.includes("el.cryptoFixedAmount.value = draft?.cryptoFixedAmount || '10';"));
  assert.ok(script.includes("el.cryptoFixedAmount.value = '10';"));
  // 只调整虚拟币固定金额，余额阈值分支仍保留原来的充值金额。
  assert.match(html, /id="amountBelow"[^>]*value="150"/);
  assert.match(html, /id="amountAtOrAbove"[^>]*value="20"/);
});

test('crypto browser flow uses human amount input and reaches wallet payment confirmation', () => {
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
  assert.match(source, /COINBASE_WALLET_UI_TIMEOUT_MS = 15000/);
  assert.match(source, /COINBASE_WALLET_UI_POLL_MS = 100/);
  assert.match(source, /if \(controls\.launch\)/);
  assert.match(source, /COINBASE_FAILURE_STABLE_MS = 3000/);
  assert.match(source, /Page\.bringToFront/);
  assert.match(source, /fallbackClicked/);
  assert.match(source, /crypto-wallet-launch/);
  assert.match(source, /keyboardClicked/);
  assert.match(source, /crypto-wallet-launch-failed/);
  assert.match(source, /browserAppPath/);
  assert.match(source, /execFileSync\('open'/);
  assert.match(source, /async function launchOkxExtension/);
  assert.doesNotMatch(source, /okx-keychain|readWalletCredentials/);
  assert.match(source, /async function continueCryptoAfterAmount/);
  assert.ok(source.indexOf('const amountInput = await fillAmount(page, purchase.amount)')
    < source.indexOf('const continued = await continueCryptoAfterAmount(input, page'));
  const continuation = source.slice(source.indexOf('async function continueCryptoAfterAmount('), source.indexOf('async function runCryptoRecharge('));
  assert.ok(continuation.indexOf('await openWalletExtension(checkout, input)')
    < continuation.indexOf('let wallet = walletPaymentConfirmation.confirmed'));
  assert.ok(continuation.includes("wallet.status === 'connect_submitted'"));
  assert.match(continuation, /walletStageUnrecognized[\s\S]*confirmWalletPaymentFn/);
  assert.match(continuation, /wallet.status !== 'ready'/);
  assert.doesNotMatch(source, /panel-only|probeOkxSidePanel|okx-side-panel/);
  assert.match(source, /只在仍是导入页、12 格都已输入且 Confirm 可用时提交/);
  assert.match(source, /async function readCheckoutState/);
  assert.match(source, /Insufficient funds/);
  assert.match(source, /walletConfirmationRequired: checkoutState\.insufficientFunds !== true/);
  assert.match(source, /risk_warning/);
  assert.match(source, /clickOkxTransactionButton/);
  assert.match(source, /confirm_send/);
  assert.match(source, /paymentCompleted/);
  assert.match(source, /waitForBalanceIncrease/);
  assert.match(source, /confirmWalletPayment: input.confirmWalletPayment === true/);
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
    readPayment: observedCheckoutPayment,
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
    readPayment: observedCheckoutPayment,
    submitPurchase: async () => ({clicked: true}),
    openCheckout: async () => ({checkout: blockedCheckout, target: {url: 'https://payments.coinbase.com/payment-sessions/test'}}),
    selectWallet: async () => ({selected: true}),
    launchExtension: async () => {},
    readCheckout: async () => { confirmations += 1; return {}; },
  }), /crypto_wallet_import_unverified/);
  assert.equal(confirmations, 0);
});

test('crypto checkout prioritizes insufficient funds while wallet connection is pending', async () => {
  let readOptions = null;
  const checkout = {close() {}};
  const result = await continueCryptoAfterAmount({}, {}, {amount: '150'}, {
    prepareWallet: async () => ({status: 'connect_required'}),
    readPayment: observedCheckoutPayment,
    submitPurchase: async () => ({clicked: true}),
    openCheckout: async () => ({checkout, target: {url: 'https://payments.coinbase.com/payment-sessions/test'}}),
    selectWallet: async () => ({selected: true}),
    launchExtension: async () => {},
    readCheckout: async (_checkout, options) => {
      readOptions = options;
      return {
        insufficientFunds: true,
        paymentFailed: true,
        requiredAmount: '157.50',
        requiredAsset: 'USDC',
      };
    },
    inspectTargets: async () => [],
  });

  assert.equal(readOptions.timeoutMs, 30000);
  assert.equal(result.cryptoPurchase.insufficientFunds, true);
  assert.equal(result.cryptoPurchase.paymentFailed, true);
  assert.equal(result.cryptoPurchase.walletConfirmationRequired, false);
});

test('explicit wallet payment confirmation still skips OKX when Coinbase reports insufficient funds', async () => {
  const checkout = {close() {}};
  let prepared = false;
  let confirmed = false;
  const result = await continueCryptoAfterAmount({confirmWalletPayment: true}, {}, {amount: '150'}, {
    prepareWallet: async () => {
      prepared = true;
      throw new Error('wallet preparation must not run after insufficient funds');
    },
    confirmWalletPayment: async () => {
      confirmed = true;
      throw new Error('wallet payment must not run after insufficient funds');
    },
    readPayment: observedCheckoutPayment,
    submitPurchase: async () => ({clicked: true}),
    openCheckout: async () => ({checkout, target: {url: 'https://payments.coinbase.com/payment-sessions/test'}}),
    selectWallet: async () => ({selected: true}),
    launchExtension: async () => ({
      checkoutState: {insufficientFunds: true, requiredAmount: '157.50', requiredAsset: 'USDC'},
    }),
    inspectTargets: async () => [],
  });
  assert.equal(prepared, false);
  assert.equal(confirmed, false);
  assert.equal(result.cryptoPurchase.insufficientFunds, true);
  result.checkout.close();
});

test('crypto checkout uses Coinbase insufficient funds even when OKX did not expand', async () => {
  const checkout = {close() {}};
  let prepared = false;
  const result = await continueCryptoAfterAmount({}, {}, {amount: '150'}, {
    prepareWallet: async () => {
      prepared = true;
      throw new Error('OKX should not be required after Coinbase insufficient funds');
    },
    readPayment: observedCheckoutPayment,
    submitPurchase: async () => ({clicked: true}),
    openCheckout: async () => ({checkout, target: {url: 'https://payments.coinbase.com/payment-sessions/test'}}),
    selectWallet: async () => ({selected: true}),
    launchExtension: async () => ({
      checkoutState: {
        insufficientFunds: true,
        requiredAmount: '157.50',
        requiredAsset: 'USDC',
      },
    }),
    inspectTargets: async () => [],
  });

  assert.equal(prepared, false);
  assert.equal(result.cryptoPurchase.insufficientFunds, true);
  assert.equal(result.cryptoPurchase.wallet.status, 'not_required');
  assert.equal(result.cryptoPurchase.walletConfirmationRequired, false);
  assert.equal(result.cryptoPurchase.checkoutState.requiredAsset, 'USDC');
  result.checkout.close();
});

test('crypto checkout leaves a non-ready wallet at the connection boundary without payment confirmation', async () => {
  const checkout = {close() {}};
  let confirmed = false;
  let checkoutReads = 0;
  const result = await continueCryptoAfterAmount({confirmWalletPayment: true}, {}, {amount: '10'}, {
    readPayment: observedCheckoutPayment,
    submitPurchase: async () => ({clicked: true}),
    openCheckout: async () => ({checkout, target: {url: 'https://payments.coinbase.com/payment-sessions/test'}}),
    selectWallet: async () => ({selected: true}),
    launchExtension: async () => ({targetCount: 1}),
    prepareWallet: async () => ({status: 'connect_required'}),
    confirmWalletPayment: async (_input, _amount, _asset, _network, options) => {
      confirmed = true;
      assert.equal(options.timeoutMs, 1000);
      throw new Error('manual_security_blocker: crypto_wallet_transaction_confirmation_unavailable:unknown');
    },
    readCheckout: async () => {
      checkoutReads += 1;
      return {walletConnected: false};
    },
    inspectTargets: async () => [],
  });
  assert.equal(confirmed, true);
  assert.equal(checkoutReads, 2);
  assert.equal(result.cryptoPurchase.walletConfirmationRequired, true);
  result.checkout.close();
});

test('crypto checkout can confirm OKX risk warning and payment confirmation before completion verification', async () => {
  const checkout = {close() {}};
  const calls = [];
  const result = await continueCryptoAfterAmount({confirmWalletPayment: true}, {}, {
    amount: '10',
    beforeBalance: {balance: 20},
    requiredAsset: 'USDC',
    network: 'Arbitrum One',
  }, {
    readPayment: observedCheckoutPayment,
    submitPurchase: async () => ({clicked: true}),
    openCheckout: async () => ({checkout, target: {url: 'https://payments.coinbase.com/payment-sessions/test'}}),
    selectWallet: async () => ({selected: true}),
    launchExtension: async () => ({targetCount: 1}),
    prepareWallet: async () => ({status: 'ready'}),
    confirmWalletPayment: async (_input, amount, asset, network) => {
      calls.push(['confirm-wallet-payment', amount, asset, network]);
      return {confirmed: true, riskWarningClicked: true, confirmationClicked: true, network};
    },
    readCheckout: async (_checkout, options) => {
      calls.push(['read-checkout', options.timeoutMs]);
      return {paymentCompleted: true};
    },
    inspectTargets: async () => [],
  });
  assert.deepEqual(calls, [['confirm-wallet-payment', '10.50', 'USDC', 'Arbitrum One'], ['read-checkout', 1000], ['read-checkout', 60000]]);
  assert.equal(result.cryptoPurchase.walletPaymentConfirmation.confirmed, true);
  assert.equal(result.cryptoPurchase.checkoutState.paymentCompleted, true);
  result.checkout.close();
});

test('crypto checkout does not fall back to recharge or cached total when payment cannot be observed', async () => {
  let confirmed = false;
  await assert.rejects(continueCryptoAfterAmount({confirmWalletPayment: true}, {}, {
    amount: '10', totalDue: '10.50', requiredAsset: 'USDC',
  }, {
    submitPurchase: async () => ({clicked: true}),
    openCheckout: async () => ({checkout: {close() {}}, target: {url: 'https://payments.coinbase.com/payment-sessions/test'}}),
    selectWallet: async () => ({selected: true}),
    launchExtension: async () => ({targetCount: 1}),
    readPayment: async () => { throw new Error('crypto_checkout_payment_amount_unverified'); },
    confirmWalletPayment: async () => { confirmed = true; return {confirmed: true}; },
  }), /crypto_checkout_payment_amount_unverified/);
  assert.equal(confirmed, false);
});

test('crypto payment completion from wallet stage handler is carried through to Coinbase verification', async () => {
  const checkout = {close() {}};
  const reads = [];
  const result = await continueCryptoAfterAmount({confirmWalletPayment: true}, {}, {
    amount: '10',
    totalDue: '10.50',
    beforeBalance: {balance: 20},
    requiredAsset: 'USDC',
  }, {
    readPayment: observedCheckoutPayment,
    submitPurchase: async () => ({clicked: true}),
    openCheckout: async () => ({checkout, target: {url: 'https://payments.coinbase.com/payment-sessions/test'}}),
    selectWallet: async () => ({selected: true}),
    launchExtension: async () => ({targetCount: 1}),
    confirmWalletPayment: async (_input, _amount, _asset, _network, options) => {
      if (options.timeoutMs === 1000) throw new Error('manual_security_blocker: crypto_wallet_transaction_confirmation_unavailable:unknown');
      return {confirmed: true, riskWarningClicked: true, confirmationClicked: true};
    },
    prepareWallet: async () => ({
      status: 'payment_confirmed',
      walletPaymentConfirmation: {confirmed: true, riskWarningClicked: true, confirmationClicked: true},
    }),
    readCheckout: async (_checkout, options) => {
      reads.push(options.timeoutMs);
      return {paymentCompleted: true};
    },
    inspectTargets: async () => [],
  });
  assert.deepEqual(reads, [1000, 60000]);
  assert.equal(result.cryptoPurchase.walletPaymentConfirmation.confirmed, true);
  assert.equal(result.cryptoPurchase.checkoutState.paymentCompleted, true);
  result.checkout.close();
});

test('crypto transaction risk page appearing after wallet-page inspection error gets a second detection window', async () => {
  const checkout = {close() {}};
  const confirmTimeouts = [];
  let prepareAttempts = 0;
  const result = await continueCryptoAfterAmount({confirmWalletPayment: true}, {}, {
    amount: '10',
    totalDue: '10.50',
    requiredAsset: 'USDC',
    network: 'Arbitrum One',
  }, {
    readPayment: observedCheckoutPayment,
    submitPurchase: async () => ({clicked: true}),
    openCheckout: async () => ({checkout, target: {url: 'https://payments.coinbase.com/payment-sessions/test'}}),
    selectWallet: async () => ({selected: true}),
    launchExtension: async () => ({targetCount: 1}),
    confirmWalletPayment: async (_input, _amount, _asset, _network, options) => {
      confirmTimeouts.push(options.timeoutMs);
      if (options.timeoutMs === 1000) {
        throw new Error('manual_security_blocker: crypto_wallet_transaction_confirmation_unavailable:unknown');
      }
      return {confirmed: true, riskWarningClicked: true, confirmationClicked: true};
    },
    prepareWallet: async () => {
      prepareAttempts += 1;
      throw new Error('manual_security_blocker: crypto_wallet_import_unknown_page');
    },
    readCheckout: async (_checkout, options) => {
      assert.ok([1000, 60000].includes(options.timeoutMs));
      return {paymentCompleted: true};
    },
    inspectTargets: async () => [],
  });
  assert.deepEqual(confirmTimeouts, [1000, 30000]);
  assert.equal(prepareAttempts, 1);
  assert.equal(result.cryptoPurchase.walletPaymentConfirmation.confirmed, true);
  result.checkout.close();
});


test('unverified crypto payment preserves the browser and pauses without a payment retry', async () => {
  let stops = 0;
  let submissions = 0;
  const result = await executeRowWithAdapters(CRYPTO_CSV, 0, {...CRYPTO_OPTIONS, stopProfiles: true}, {
    common: {cardLast4: () => ''},
    runClosedLoopChildAsync: async () => {
      submissions++;
      return {ok: false, error: 'purchase_unverified: Coinbase did not show payment completion after wallet Confirm'};
    },
    adspower: {stopProfile: async () => {stops++; return {attempted: true, ok: true};}},
  });
  assert.equal(result.status, 'purchase_unverified');
  assert.equal(result.stopProfile, false);
  assert.equal(result.safeToContinue, false);
  assert.equal(stops, 0);
  assert.equal(submissions, 1);
});
