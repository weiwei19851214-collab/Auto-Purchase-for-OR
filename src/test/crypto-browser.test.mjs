import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {executeRowWithAdapters, parsePlan} from '../server/automation-adapter.mjs';
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
  assert.equal(capturedTask.card.number, '');
  assert.equal(result.status, 'manual_security_blocker');
  assert.equal(result.stage, 'crypto.wallet_confirmation');
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

test('crypto browser flow uses human amount input and stops after Launch extension', () => {
  const source = readFileSync(join(process.cwd(), 'src/automation/crypto_recharge_openrouter_cdp.mjs'), 'utf8');
  const bankCardSource = readFileSync(join(process.cwd(), 'src/automation/bind_openrouter_card_cdp.mjs'), 'utf8');
  assert.match(source, /async function ensureUseCrypto/);
  assert.match(source, /const amountInput = await fillAmount\(page, purchase\.amount\)/);
  assert.ok(source.includes('payments\\.coinbase\\.com'));
  assert.match(source, /async function selectOkxWallet/);
  assert.match(source, /async function launchOkxExtension/);
  assert.match(source, /async function readCheckoutState/);
  assert.match(source, /Insufficient funds/);
  assert.match(source, /walletConfirmationRequired: checkoutState\.insufficientFunds !== true/);
  assert.match(source, /Verification required; Enter your current password/);
  assert.doesNotMatch(bankCardSource, /OKX Wallet|payments\.coinbase\.com|Use crypto|cryptoOnly/);
});
