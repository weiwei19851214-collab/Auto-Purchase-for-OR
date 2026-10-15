import {readFileSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

// Accounting fields are mapped explicitly by the crypto callback builder; never spread them into external payloads.
export const CRYPTO_AMOUNT_FIELDS = Object.freeze({
  cryptoCreditAmount: 'crypto_credit_amount',
  cryptoPaymentAmount: 'crypto_payment_amount',
  cryptoPaymentAsset: 'crypto_payment_asset',
  cryptoPaymentAmountSource: 'crypto_payment_amount_source',
  cryptoNetworkFeeAmount: 'crypto_network_fee_amount',
  cryptoNetworkFeeAsset: 'crypto_network_fee_asset',
  cryptoNetworkFeeUsd: 'crypto_network_fee_usd',
  cryptoNetworkFeeDisplay: 'crypto_network_fee_display',
  cryptoNetworkFeeStatus: 'crypto_network_fee_status',
  cryptoNetworkFeeSource: 'crypto_network_fee_source',
});

export function pickCryptoAmounts(source = {}) {
  const result = {};
  for (const key of Object.keys(CRYPTO_AMOUNT_FIELDS)) {
    const value = source?.[key];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      result[key] = String(value);
    }
  }
  return result;
}

export function cryptoAmountsFromResult(result = {}) {
  return mergeObservedCryptoAmounts(result?.cryptoPurchase?.financials, result?.cryptoAmounts);
}

function mergeObservedCryptoAmounts(...sources) {
  const result = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(pickCryptoAmounts(source))) {
      if (value.trim() !== '') result[key] = value;
    }
  }
  return result;
}

export function cryptoAmountsWithCheckpoint(task = {}, parsed = {}) {
  let checkpoint = {};
  if (typeof task.confirmationDebugDir === 'string' && task.confirmationDebugDir.trim()) {
    try {
      checkpoint = JSON.parse(readFileSync(join(task.confirmationDebugDir, 'crypto-financials.json'), 'utf8'));
      if (task.cryptoAccountingAttemptId && checkpoint?.attemptId !== task.cryptoAccountingAttemptId) checkpoint = {};
    } catch {
      // Missing or incomplete diagnostic files must not change the task outcome.
    }
  }
  return mergeObservedCryptoAmounts(checkpoint?.cryptoAmounts, cryptoAmountsFromResult(parsed));
}

export function beginCryptoAccountingAttempt(task) {
  task.cryptoAccountingAttemptId ||= randomUUID();
  if (typeof task.confirmationDebugDir === 'string' && task.confirmationDebugDir.trim()) {
    try {
      writeFileSync(join(task.confirmationDebugDir, 'crypto-financials.json'), JSON.stringify({
        attemptId: task.cryptoAccountingAttemptId,
        cryptoAmounts: {},
        observedAt: new Date().toISOString(),
      }), {encoding: 'utf8', mode: 0o600});
    } catch {
      // A previous attempt cannot pass the ID check even if clearing its file fails.
    }
  }
}
