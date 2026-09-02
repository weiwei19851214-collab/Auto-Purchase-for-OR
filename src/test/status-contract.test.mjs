import assert from 'node:assert/strict';
import test from 'node:test';
import {classifyError, STATUSES} from '../automation/lib/status-contract.mjs';

test('Stripe Link save-info state is not classified as manual security blocker', () => {
  const result = classifyError('Stripe Link save-info checkbox or phone subform is still active: {"found":false,"checked":null,"phoneVisible":false,"phoneInvalidText":false}');
  assert.equal(result.status, STATUSES.FAILED);
  assert.equal(result.stage, 'payment_method.link_opt_in');
  assert.equal(result.safeToContinueBatch, true);
  assert.equal(result.stopProfile, true);
});

test('security challenge text is classified as an ordinary row failure after the window closes', () => {
  const result = classifyError('Security challenge visible: hCaptcha');
  assert.equal(result.status, STATUSES.FAILED);
  assert.equal(result.stage, 'automation');
  assert.equal(result.safeToContinueBatch, true);
  assert.equal(result.stopProfile, true);
});

test('CDP navigation timeouts are ordinary row failures and do not stop the batch', () => {
  const result = classifyError('CDP command timeout: Page.navigate');
  assert.equal(result.status, STATUSES.FAILED);
  assert.equal(result.stage, 'automation');
  assert.equal(result.safeToContinueBatch, true);
  assert.equal(result.stopProfile, true);
});

test('Stripe input rejection closes the profile after recording the failure', () => {
  const result = classifyError('Stripe payment field was not accepted: #payment-numberInput');
  assert.equal(result.status, STATUSES.FAILED);
  assert.equal(result.stage, 'payment_method.input');
  assert.equal(result.safeToContinueBatch, true);
  assert.equal(result.stopProfile, true);
});

test('all Stripe card field validation failures share the payment input result', () => {
  for (const field of ['number', 'expiry', 'cvc']) {
    const result = classifyError(`Stripe payment field was not accepted: ${field}`);
    assert.equal(result.status, STATUSES.FAILED);
    assert.equal(result.stage, 'payment_method.input');
  }
});
