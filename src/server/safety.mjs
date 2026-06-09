import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {httpError} from './http-utils.mjs';
import {runnerArgs} from './automation-adapter.mjs';

const TOKEN_SECRET = process.env.OR_RUNNER_TOKEN_SECRET || randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 10 * 60 * 1000;

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function normalizedOptions(options = {}) {
  const args = runnerArgs(options);
  return {
    removeExisting: args.removeExisting,
    stopProfiles: args.stopProfiles,
    confirmPurchase: args.confirmPurchase,
    preparePurchaseOnly: args.preparePurchaseOnly,
    scopeBillingAddress: args.scopeBillingAddress,
    scopePaymentMethod: args.scopePaymentMethod,
    scopePurchase: args.scopePurchase,
    scopeAutoTopup: args.scopeAutoTopup,
    autoTopupThreshold: args.autoTopupThreshold,
    autoTopupAmount: args.autoTopupAmount,
    rowTimeoutMs: args.rowTimeoutMs,
    adspowerApiBase: args.adspowerApiBase,
    hasAdspowerApiKey: !!args.adspowerApiKey,
    opomWriteback: args.opomWriteback,
    opomBaseUrl: args.opomBaseUrl,
    hasOpomRechargeToken: !!args.opomRechargeToken,
    runId: args.runId,
    adspowerStatusMode: args.adspowerStatusMode,
    hasAdspowerSuccessGroupTarget: !!(args.adspowerSuccessGroupId || args.adspowerSuccessGroupName),
    hasAdspowerFailureGroupTarget: !!(args.adspowerFailureGroupId || args.adspowerFailureGroupName),
    hasAdspowerBlockerGroupTarget: !!(args.adspowerBlockerGroupId || args.adspowerBlockerGroupName),
  };
}

export function createLiveConfirmation({csvText, options, ready}) {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = {
    csvHash: sha256(csvText),
    optionsHash: sha256(stableStringify(normalizedOptions(options))),
    ready,
    expiresAt,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', TOKEN_SECRET).update(encoded).digest('base64url');
  return {
    token: `${encoded}.${signature}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function verifyLiveConfirmation(token, {csvText, options}) {
  if (!token) throw httpError(409, 'Live run requires a dry-run confirmation token');
  const [encoded, signature] = String(token).split('.');
  if (!encoded || !signature) throw httpError(409, 'Invalid dry-run confirmation token');
  const expected = createHmac('sha256', TOKEN_SECRET).update(encoded).digest('base64url');
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw httpError(409, 'Invalid dry-run confirmation token');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw httpError(409, 'Invalid dry-run confirmation token');
  }
  if (Date.now() > Number(payload.expiresAt || 0)) {
    throw httpError(409, 'Dry-run confirmation token has expired; run dry-run again');
  }
  const csvHash = sha256(csvText);
  const optionsHash = sha256(stableStringify(normalizedOptions(options)));
  if (payload.csvHash !== csvHash || payload.optionsHash !== optionsHash) {
    throw httpError(409, 'CSV or options changed after dry-run; run dry-run again');
  }
  if (!Number(payload.ready)) {
    throw httpError(409, 'Dry-run has no ready rows to execute');
  }
  return payload;
}
