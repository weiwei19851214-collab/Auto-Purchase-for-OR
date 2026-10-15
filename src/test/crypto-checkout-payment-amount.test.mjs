import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {continueCryptoAfterAmount} from '../automation/crypto_recharge_openrouter_cdp.mjs';

test('early OKX confirmation uses Coinbase displayed payment including fees rather than credit amount', async () => {
  const calls = [];
  const checkout = {
    close() {},
    async send(method, params) {
      assert.equal(method, 'Runtime.evaluate');
      return {result: {value: runInNewContext(params.expression, {
        location: {origin: 'https://payments.coinbase.com', pathname: '/payment-sessions/fixture'},
        document: {body: {innerText: 'Pay 10.50 USDC to OpenRouter, Inc\nNetwork\nArbitrum One'}},
      })}};
    },
  };
  const input = {confirmWalletPayment: true};
  const result = await continueCryptoAfterAmount(input, {}, {amount: '10'}, {
    submitPurchase: async () => ({clicked: true}),
    openCheckout: async () => ({checkout, target: {url: 'https://payments.coinbase.com/payment-sessions/fixture'}}),
    selectWallet: async () => ({selected: true}),
    launchExtension: async () => ({targetCount: 1}),
    prepareWallet: async () => {assert.fail('early payment confirmation must skip wallet preparation');},
    confirmWalletPayment: async (_input, amount, asset, network, options) => {
      calls.push({amount, asset, network, timeoutMs: options.timeoutMs});
      return {confirmed: true, riskWarningClicked: true, confirmationClicked: true, network};
    },
    readCheckout: async () => ({paymentCompleted: true}),
    inspectTargets: async () => [],
  });
  assert.deepEqual(calls, [{amount: '10.50', asset: 'USDC', network: 'arbitrum one', timeoutMs: 1000}]);
  assert.deepEqual(input.expectedCryptoPayment, {amount: '10.50', asset: 'USDC', network: 'arbitrum one'});
  assert.equal(result.cryptoPurchase.amount, '10');
  assert.equal(result.cryptoPurchase.walletPaymentConfirmation.confirmed, true);
  assert.equal(result.cryptoPurchase.checkoutState.paymentCompleted, true);
});

for (const insufficientRead of [1, 2]) {
  test(`late insufficient-funds read ${insufficientRead} cannot erase submitted wallet confirmation`, async () => {
    let confirms = 0, reads = 0;
    const checkout = {close() {}};
    await assert.rejects(continueCryptoAfterAmount({confirmWalletPayment: true}, {}, {amount: '150'}, {
      submitPurchase: async () => ({clicked: true}),
      openCheckout: async () => ({checkout, target: {url: 'https://payments.coinbase.com/payment-sessions/fixture'}}),
      selectWallet: async () => ({selected: true}),
      launchExtension: async () => ({targetCount: 1}),
      readPayment: async () => ({amount: '157.50', asset: 'USDC', network: 'arbitrum one'}),
      prepareWallet: async () => {assert.fail('confirmed transaction must skip wallet preparation');},
      confirmWalletPayment: async () => { confirms++; return {confirmed: true, confirmationClicked: true}; },
      readCheckout: async () => ({insufficientFunds: ++reads === insufficientRead}),
      inspectTargets: async () => [],
    }), /purchase_unverified: insufficient funds text appeared after wallet confirmation/);
    assert.equal(confirms, 1);
  });
}
