import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyOkxTransactionSnapshot,
  extractTransactionAmountAssets,
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
