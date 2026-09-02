import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';

const source = () => readFileSync(join(process.cwd(), 'src/automation/bind_openrouter_card_cdp.mjs'), 'utf8');

test('portal exposes a mutually exclusive refund-only mode', () => {
  const html = readFileSync(join(process.cwd(), 'public/index.html'), 'utf8');
  const app = readFileSync(join(process.cwd(), 'public/app.js'), 'utf8');
  assert.match(html, /id="refundOnly"/);
  assert.match(html, /仅退款，不执行其他操作/);
  assert.match(app, /refundOnly: el\.refundOnly\.checked/);
  assert.match(app, /'disableDataTrainingOnly', 'refundOnly'/);
  assert.match(app, /仅退款属于人工专项操作，不支持自动定时执行/);
});

test('browser refund mode does not require card inputs', () => {
  const script = source();
  assert.match(script, /key === 'refund-only'/);
  assert.match(script, /refundOnly: normalizeBooleanInput\(refundOnlyInput\)/);
  assert.match(script, /&& !input\.refundOnly/);
});

test('browser refunds every initially visible transaction once and exits before payment work', () => {
  const script = source();
  const refundFunctionStart = script.indexOf('async function refundOpenRouterTransactions');
  const refundFunctionEnd = script.indexOf('async function getCurrentCreditBalance', refundFunctionStart);
  const refundFunction = script.slice(refundFunctionStart, refundFunctionEnd);
  assert.match(refundFunction, /\^Refund\$/);
  assert.match(refundFunction, /for \(const transaction of \[\.\.\.refundableTransactions\]\.reverse\(\)\)/);
  assert.match(refundFunction, /Confirm refund/);
  assert.match(refundFunction, /\^Accept\$/);
  assert.match(refundFunction, /confirmationAccepted/);
  assert.match(refundFunction, /if \(!feedback\.acceptReady\) \{[\s\S]*?await sleep\(250\);[\s\S]*?continue;/);
  assert.doesNotMatch(refundFunction, /Accept button is not clickable/);
  assert.match(refundFunction, /Accept button did not become ready/);
  assert.match(refundFunction, /Refund initiated\|Your refund has been created/);
  assert.match(refundFunction, /balanceState\.balance <= 0\.01/);
  assert.match(refundFunction, /Refund did not reduce OpenRouter credit balance to 0\.01 or below/);
  assert.match(refundFunction, /afterBalance: balanceState\.balance/);
  assert.match(refundFunction, /refundedCount: refunded\.length/);

  const identityCheck = script.indexOf('OpenRouter account mismatch: expected');
  const refundStep = script.indexOf("runLoggedStep('refund-openrouter-transactions'", identityCheck);
  const refundReturn = script.indexOf("status: refund.refundedCount ? 'refund_completed'", refundStep);
  const paymentReadiness = script.indexOf('Payment entry not ready after waiting', refundReturn);
  assert.ok(identityCheck > 0);
  assert.ok(refundStep > identityCheck);
  assert.ok(refundReturn > refundStep);
  assert.ok(paymentReadiness > refundReturn);

  const refundOnlyBody = script.slice(refundStep, paymentReadiness);
  assert.doesNotMatch(refundOnlyBody, /fillStripeCard|setPurchaseAmountInput|executeConfirmedPurchase|configureAutoTopup/);
});
