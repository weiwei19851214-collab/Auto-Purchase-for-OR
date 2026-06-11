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

test('real security challenges keep the profile open but no longer stop the whole batch', () => {
  const result = classifyError('manual_security_blocker: Security challenge visible: hCaptcha');
  assert.equal(result.status, STATUSES.MANUAL_SECURITY_BLOCKER);
  assert.equal(result.stage, 'security.blocker');
  assert.equal(result.safeToContinueBatch, true);
  assert.equal(result.stopProfile, false);
});
