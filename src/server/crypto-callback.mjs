import * as plan from '../automation/lib/recharge-plan.mjs';

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Crypto callback requires ${name}`);
  return value;
}

function decimal(value, name) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`Crypto callback requires observed decimal string ${name}`);
  }
  return value;
}

// Build once after verified credit, persist the returned object before any HTTP request.
export function buildCryptoCallbackPayload(row, details, context = {}) {
  if (details.purchaseStatus !== 'verified') throw new Error('Crypto callback requires verified purchase');
  const asset = String(details.cryptoPaymentAsset || '').toUpperCase();
  if (!['USD', 'USDC'].includes(asset)) throw new Error('Crypto callback requires USD or USDC observed payment; conversion is unavailable');
  const networkFee = details.cryptoNetworkFeeUsd ||
    (String(details.cryptoNetworkFeeAsset || '').toUpperCase() === 'USD' ? details.cryptoNetworkFeeAmount : '');
  const payload = {
    idempotencyKey: context.idempotencyKey,
    providerCode: 'RECHARGE_RUNNER',
    providerEventId: context.providerEventId,
    accountId: plan.opomAccountId(row),
    amount: decimal(details.cryptoCreditAmount || details.purchaseAmount, 'amount'),
    amountCurrency: 'USD',
    PaidAmount: decimal(details.cryptoPaymentAmount, 'PaidAmount'),
    networkFee: decimal(networkFee, 'networkFee in USD'),
    networkFeeCurrency: 'USD',
    assetSymbol: asset,
    occurredAt: context.occurredAt,
  };
  const email = plan.loginEmail(row);
  if (email && !email.includes('*') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) payload.accountEmail = email;
  // Only known fee sources and a numeric display can enter accounting remarks.
  const display = String(details.cryptoNetworkFeeDisplay || '');
  const source = String(details.cryptoNetworkFeeSource || '');
  if (/^[<>≈~\s$\d.,]+$/.test(display) && display.length <= 80) {
    payload.remark = `Network fee USD display: ${display}`;
    if (/^[a-z_]{1,60}$/.test(source)) payload.remark += `; source: ${source}`;
  }
  return validateCryptoCallbackPayload(payload, payload.accountId);
}

export function validateCryptoCallbackPayload(payload, accountId) {
  if (!payload || typeof payload !== 'object') throw new Error('Crypto callback requires persisted callbackPayload');
  const clean = {};
  for (const key of ['idempotencyKey', 'providerCode', 'providerEventId', 'accountId', 'occurredAt']) clean[key] = requiredText(payload[key], key);
  if (clean.accountId !== accountId) throw new Error('Crypto callback account identity mismatch');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(clean.occurredAt) || !Number.isFinite(Date.parse(clean.occurredAt))) throw new Error('Crypto callback requires ISO occurredAt');
  for (const key of ['amount', 'PaidAmount', 'networkFee']) clean[key] = decimal(payload[key], key);
  if (payload.amountCurrency !== 'USD' || payload.networkFeeCurrency !== 'USD') throw new Error('Crypto callback currency must be USD');
  clean.amountCurrency = 'USD';
  clean.networkFeeCurrency = 'USD';
  if (payload.assetSymbol !== 'USD' && payload.assetSymbol !== 'USDC') throw new Error('Crypto callback unsupported payment asset');
  clean.assetSymbol = payload.assetSymbol;
  if (payload.accountEmail) clean.accountEmail = requiredText(payload.accountEmail, 'accountEmail');
  if (payload.remark) clean.remark = requiredText(payload.remark, 'remark').slice(0, 1000);
  return clean;
}
