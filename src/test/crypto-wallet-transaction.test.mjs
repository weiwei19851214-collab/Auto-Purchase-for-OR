import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyOkxTransactionSnapshot,
  checkoutPaymentFingerprint,
  extractTransactionAmountAssets,
  extractWalletNetworkFee,
  normalizeTransactionAmount,
} from '../automation/lib/crypto-wallet-transaction.mjs';

const origin = 'chrome-extension://mcohilncbfahbmgdjkbpemcciiolgcge';
const buttons = (...items) => items.map((label) => ({label, visible: true, disabled: false, ariaDisabled: ''}));

const warningText = 'Suspicious Receiving address\nThe receiving address is a contract address instead of a typical private address.';
const confirmText = '1 of 2 confirmations\nConfirm Send\n-10.50 USDC\nNetwork\nArbitrum One';

function snapshot(text, controls, targetOrigin = origin) {
  return {origin: targetOrigin, text, buttons: controls};
}

test('normalizes decimal amounts and extracts wallet asset values', () => {
  assert.equal(normalizeTransactionAmount('10.50'), 10.5);
  assert.deepEqual(extractTransactionAmountAssets('-10.50 USDC'), [{amount: 10.5, asset: 'USDC'}]);
  assert.equal(normalizeTransactionAmount('-10.50'), null);
});

test('checkout fingerprint keeps the Coinbase fee-inclusive payment amount', () => {
  assert.deepEqual(checkoutPaymentFingerprint('Pay $10.50 to OpenRouter, Inc'), {
    amount: '10.50', asset: '', network: '',
  });
  assert.deepEqual(checkoutPaymentFingerprint('Pay 10.50 USDC to OpenRouter, Inc'), {
    amount: '10.50', asset: 'USDC', network: '',
  });
  assert.deepEqual(checkoutPaymentFingerprint('Total due $10.5'), {
    amount: '10.5', asset: '', network: '',
  });
});

test('recognizes the warning page without requiring transaction details', () => {
  const result = classifyOkxTransactionSnapshot(snapshot(warningText, buttons('Cancel', 'Continue (Unsafe)')), {amount: '10.50', asset: 'USDC', network: 'Arbitrum One'});
  assert.equal(result.stage, 'risk_warning');
  assert.equal(result.originOk, true);
});

test('recognizes the confirm page only when amount, asset, and network match', () => {
  const result = classifyOkxTransactionSnapshot(snapshot(confirmText, buttons('Cancel', 'Confirm')), {amount: '10.5', asset: 'USDC', network: 'Arbitrum One'});
  assert.equal(result.stage, 'confirm_send');
  assert.equal(result.hasAmount, true);
  assert.equal(result.hasNetwork, true);
});

test('rejects wrong origin, amount, asset, network, duplicate, and disabled controls', () => {
  const expected = {amount: '10.50', asset: 'USDC', network: 'Arbitrum One'};
  assert.equal(classifyOkxTransactionSnapshot(snapshot(confirmText, buttons('Confirm'), 'chrome-extension://other'), expected).stage, 'unknown');
  assert.equal(classifyOkxTransactionSnapshot(snapshot(confirmText.replace('-10.50 USDC', '-9 USDC'), buttons('Confirm')), expected).stage, 'unknown');
  assert.equal(classifyOkxTransactionSnapshot(snapshot(confirmText.replace('USDC', 'DAI'), buttons('Confirm')), expected).stage, 'unknown');
  assert.equal(classifyOkxTransactionSnapshot(snapshot(confirmText.replace('Arbitrum One', 'Base'), buttons('Confirm')), expected).stage, 'unknown');
  assert.equal(classifyOkxTransactionSnapshot(snapshot(confirmText, buttons('Confirm', 'Confirm')), expected).stage, 'unknown');
  assert.equal(classifyOkxTransactionSnapshot(snapshot(confirmText, [{label: 'Confirm', visible: true, disabled: true}]), expected).stage, 'unknown');
});

test('rejects a conflicting transaction detail on the warning page', () => {
  const text = `${warningText}\n-9 USDC\nNetwork\nArbitrum One`;
  assert.equal(classifyOkxTransactionSnapshot(snapshot(text, buttons('Continue (Unsafe)')), {amount: '10.50', asset: 'USDC', network: 'Arbitrum One'}).stage, 'unknown');
});

test('requires an observed network and does not silently default a chain', () => {
  const withoutNetwork = classifyOkxTransactionSnapshot(snapshot('Confirm Send\n-10.50 USDC', buttons('Confirm')), {amount: '10.50', asset: 'USDC'});
  assert.equal(withoutNetwork.stage, 'unknown');
  const unknownNetwork = classifyOkxTransactionSnapshot(snapshot(`${confirmText.replace('Arbitrum One', 'Unknown Chain')}`, buttons('Confirm')), {amount: '10.50', asset: 'USDC'});
  assert.equal(unknownNetwork.stage, 'unknown');
});

test('excludes explicitly labelled fee and balance from payment conflicts', () => {
  const expected = {amount: '10.50', asset: 'USDC', network: 'Arbitrum One'};
  for (const details of [
    'Fee 0.01 USDC\nBalance 99 USDC',
    'Network fee\n0.01 USDC\nAvailable balance\n99 USDC',
    'Gas fee 0.000001 ETH\n<$0.01',
    'Fee\n0.000001\nETH\n(<$0.01)',
  ]) {
    assert.equal(classifyOkxTransactionSnapshot(snapshot(`${confirmText}\n${details}`, buttons('Confirm')), expected).stage, 'confirm_send');
  }
  for (const conflict of ['Send 9 USDC', 'Amount 10.50 DAI', '9 USDC', '9\nUSDC']) {
    assert.equal(classifyOkxTransactionSnapshot(snapshot(`${confirmText}\nFee 0.01 USDC\n${conflict}`, buttons('Confirm')), expected).stage, 'unknown');
  }
});

test('extracts exact native and same-asset fees independently of payment amount', () => {
  assert.deepEqual(extractWalletNetworkFee(`${confirmText}\nFee 0.01 USDC`), {
    amount: '0.01', asset: 'USDC', usd: '', display: '0.01 USDC',
    status: 'observed', source: 'okx_confirm',
  });
  assert.deepEqual(extractWalletNetworkFee('Network fee\n0.000001 ETH\n($0.002)'), {
    amount: '0.000001', asset: 'ETH', usd: '0.002', display: '0.000001 ETH ($0.002)',
    status: 'observed', source: 'okx_confirm',
  });
  assert.equal(extractWalletNetworkFee('Gas fee 0 ETH').amount, '0');
  assert.equal(extractWalletNetworkFee('Fee $0.00').usd, '0.00');
});

test('records displayed fee estimates numerically while preserving original comparison text', () => {
  const fee = extractWalletNetworkFee('Gas fee\n0.000001 ETH\n<$0.01');
  assert.equal(fee.amount, '0.000001');
  assert.equal(fee.usd, '0.01');
  assert.equal(fee.display, '0.000001 ETH <$0.01');
  const upperNative = extractWalletNetworkFee('Fee <0.01 USDC');
  assert.equal(upperNative.amount, '0.01');
  assert.deepEqual(extractWalletNetworkFee('Fee <$0.01'), {
    amount: '0.01', asset: 'USD', usd: '0.01', display: '<$0.01',
    status: 'observed', source: 'okx_confirm',
  });
  const approximate = extractWalletNetworkFee('Network fee ≈0.000001 ETH');
  assert.equal(approximate.amount, '0.000001');
  assert.equal(approximate.display, '≈0.000001 ETH');
});

test('extracts adjacent standalone asset fee lines without absorbing payment or network labels', () => {
  const feeText = 'Fee\n0.000001\nETH\n(<$0.01)';
  for (const suffix of ['', '\nAmount 10.50 USDC', '\nNetwork\nArbitrum One']) {
    assert.deepEqual(extractWalletNetworkFee(feeText + suffix), {
      amount: '0.000001', asset: 'ETH', usd: '0.01', display: '0.000001 ETH (<$0.01)',
      status: 'observed', source: 'okx_confirm',
    });
  }
  const expected = {amount: '10.50', asset: 'USDC', network: 'Arbitrum One'};
  assert.equal(classifyOkxTransactionSnapshot(snapshot(`${confirmText}\n${feeText}\n9\nUSDC`, buttons('Confirm')), expected).stage, 'unknown');
  assert.equal(extractWalletNetworkFee(`${feeText}\n0.000002\nETH`).status, 'unavailable');
  assert.equal(extractWalletNetworkFee('Fee\n0.000001\nUNKNOWN').status, 'unavailable');
});

test('does not guess fees from missing, unsupported, or ambiguous evidence', () => {
  for (const text of [confirmText, 'Fee unavailable', 'Fee 0.01 USDC\nFee 0.02 USDC', 'Fee 0.01 USDC 0.02 USDC', 'Network fee\nEstimate unavailable\n0.01 ETH']) {
    const fee = extractWalletNetworkFee(text);
    assert.equal(fee.status, 'unavailable', text);
    assert.equal(fee.amount, '', text);
    assert.equal(fee.usd, '', text);
  }
});
