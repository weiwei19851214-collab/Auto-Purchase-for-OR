import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {readObservedCryptoPayment, continueCryptoAfterAmount, confirmOkxWalletPayment} from '../automation/crypto_recharge_openrouter_cdp.mjs';
import {extractWalletNetworkFee} from '../automation/lib/crypto-wallet-transaction.mjs';

function checkout(text, origin = 'https://payments.coinbase.com') {
  return {close() {}, async send(method, params) {
    assert.equal(method, 'Runtime.evaluate');
    return {result: {value: runInNewContext(params.expression, {
      location: {origin, pathname: '/payment-sessions/test'}, document: {body: {innerText: text}},
    })}};
  }};
}

test('checkout records actual 10.50 payment and 0.01 network estimate separately from the 0.50 tax', async () => {
  const payment = await readObservedCryptoPayment(checkout('Pay 10.50 USDC to OpenRouter, Inc\nFee $0.50\nNetwork fee\n<$0.01'));
  assert.equal(payment.amount, '10.50');
  assert.equal(payment.asset, 'USDC');
  assert.equal(payment.source, 'coinbase_checkout');
  assert.equal(payment.networkFee.usd, '0.01');
  assert.equal(payment.networkFee.display, '<$0.01');
});

test('service charge alone cannot become a fabricated chain network fee', async () => {
  const payment = await readObservedCryptoPayment(checkout('Pay 10.50 USDC to OpenRouter, Inc\nFee $0.50'));
  assert.equal(payment.networkFee.status, 'unavailable');
  assert.equal(payment.networkFee.amount, '');
});

test('unreadable payment stops after polling without returning credit amount or a tax calculation', async () => {
  let clock = 0;
  await assert.rejects(readObservedCryptoPayment(checkout('Credits 10\nFee $0.50'), {
    timeoutMs: 500, now: () => clock, sleep: async ms => {clock += ms;},
  }), /payment_amount_unreadable/);
  assert.equal(clock, 500);
});

test('a delayed checkout Pay amount can be observed without guessing during loading', async () => {
  let clock = 0;
  const page = checkout('Loading');
  const original = page.send;
  page.send = async (...args) => clock >= 250
    ? checkout('Pay 10.50 USDC to OpenRouter, Inc').send(...args) : original(...args);
  const observed = await readObservedCryptoPayment(page, {timeoutMs: 500, now: () => clock, sleep: async ms => {clock += ms;}});
  assert.equal(observed.amount, '10.50');
});

test('matching Pay text on a foreign page is rejected', async () => {
  await assert.rejects(readObservedCryptoPayment(checkout('Pay 10.50 USDC', 'https://example.invalid')), /checkout_unverified/);
});

async function execute(networkFee, failAfterConfirm = false) {
  const input = {confirmWalletPayment: true};
  let confirms = 0;
  const page = checkout('Pay 10.50 USDC to OpenRouter, Inc\nNetwork\nArbitrum One');
  const run = continueCryptoAfterAmount(input, {}, {amount: '10'}, {
    submitPurchase: async () => ({clicked: true}),
    openCheckout: async () => ({checkout: page, target: {url: 'https://payments.coinbase.com/payment-sessions/test'}}),
    selectWallet: async () => ({}), launchExtension: async () => ({}), inspectTargets: async () => [],
    prepareWallet: async () => {assert.fail('already available transaction should be used');},
    confirmWalletPayment: async (args, amount, asset, network, options) => confirmOkxWalletPayment(args, amount, asset, network, options, {
      acquire: async () => ({wallet: {close() {}}, state: {stage: 'confirm_send', originOk: true, hasAmount: true, hasNetwork: true, asset: 'USDC', network: 'arbitrum one', networkFee}}),
      click: async () => {confirms++;}, inspect: async () => ({stage: 'unknown'}),
    }),
    readCheckout: async (_page, options) => {
      if (failAfterConfirm && options.requirePaymentCompleted) throw new Error('purchase_unverified: synthetic timeout');
      return {paymentCompleted: true};
    },
  });
  return {input, run, confirms: () => confirms};
}

test('wallet amount, payment and network fee remain distinct through browser outcome', async () => {
  const fixture = await execute(extractWalletNetworkFee('Network fee\n<$0.01'));
  const result = await fixture.run;
  assert.equal(fixture.confirms(), 1);
  assert.equal(result.cryptoPurchase.amount, '10');
  assert.equal(result.cryptoPurchase.financials.cryptoCreditAmount, '10');
  assert.equal(result.cryptoPurchase.financials.cryptoPaymentAmount, '10.50');
  assert.equal(result.cryptoPurchase.financials.cryptoNetworkFeeAmount, '0.01');
  assert.equal(result.cryptoPurchase.financials.cryptoNetworkFeeAsset, 'USD');
  assert.equal(result.cryptoPurchase.financials.cryptoNetworkFeeDisplay, '<$0.01');
});

test('unread network fee permits payment but remains unavailable instead of zero', async () => {
  const fixture = await execute(extractWalletNetworkFee('Confirm Send'));
  const result = await fixture.run;
  assert.equal(fixture.confirms(), 1);
  assert.equal(result.cryptoPurchase.financials.cryptoNetworkFeeStatus, 'unavailable');
  assert.equal(result.cryptoPurchase.financials.cryptoNetworkFeeAmount, '');
  assert.equal(result.cryptoPurchase.financials.cryptoNetworkFeeUsd, '');
});

test('payment verification failure carries all observed amounts for local failure storage', async () => {
  const fixture = await execute(extractWalletNetworkFee('Fee 0.000001 ETH (<$0.01)'), true);
  await assert.rejects(fixture.run, error => {
    assert.equal(error.cryptoAmounts.cryptoCreditAmount, '10');
    assert.equal(error.cryptoAmounts.cryptoPaymentAmount, '10.50');
    assert.equal(error.cryptoAmounts.cryptoNetworkFeeAmount, '0.000001');
    assert.equal(error.cryptoAmounts.cryptoNetworkFeeUsd, '0.01');
    return true;
  });
});
