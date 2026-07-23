import assert from 'node:assert/strict';
import test from 'node:test';
import {simplifyError, simplifyResult} from '../automation/lib/error-message-contract.mjs';

test('simplifyError returns empty fields for non-error states without detail', () => {
  assert.deepEqual(simplifyError('', {status: 'completed'}), {
    errorCode: '',
    message: '',
    detail: '',
  });
  assert.deepEqual(simplifyResult({status: 'queued'}), {
    errorCode: '',
    message: '',
    detail: '',
  });
});

test('simplifyError maps input and OPOM failures to stable Chinese messages', () => {
  assert.deepEqual(
    simplifyError('missing_fields: amount, card_number', {status: 'missing_fields'}),
    {
      errorCode: 'missing_fields',
      message: '执行信息不完整',
      detail: 'missing_fields: amount, card_number',
    },
  );

  const missingToken = simplifyError('OPOM_RECHARGE_TOKEN is not configured', {stage: 'opom.result'});
  assert.equal(missingToken.errorCode, 'opom_token_missing');
  assert.equal(missingToken.message, 'OPOM Token 未配置');

  const notReady = simplifyError('opom_card_not_active: card status FROZEN', {stage: 'opom.card_status'});
  assert.equal(notReady.errorCode, 'opom_card_inactive');
  assert.equal(notReady.message, 'OPOM 卡不可用');

  const binding = simplifyError('OPOM card binding requires orderNo, cardNo, and expiresAt');
  assert.equal(binding.errorCode, 'opom_card_fields_missing');
  assert.equal(binding.message, 'OPOM 绑卡信息不完整');
});

test('simplifyError maps AdsPower and CDP failures with profile-in-use before generic browser failures', () => {
  const inUse = simplifyError('AdsPower profile is being used by another user; not allowed to open');
  assert.equal(inUse.errorCode, 'adspower_profile_in_use');
  assert.equal(inUse.message, 'AdsPower 浏览器被占用');

  const rate = simplifyError('AdsPower user/list failed: too many requests, retry later');
  assert.equal(rate.errorCode, 'adspower_rate_limited');
  assert.equal(rate.message, 'AdsPower 请求过于频繁');

  const lookup = simplifyError('AdsPower user/list failed: account lookup unavailable');
  assert.equal(lookup.errorCode, 'adspower_lookup_failed');
  assert.equal(lookup.message, 'AdsPower 账号查询失败');

  const cdp = simplifyError('CDP websocket error: ECONNREFUSED 127.0.0.1:55555');
  assert.equal(cdp.errorCode, 'browser_connect_failed');
  assert.equal(cdp.message, '浏览器连接失败');
});

test('simplifyError maps identity and manual security blockers', () => {
  assert.equal(
    simplifyError('OpenRouter account mismatch: expected a@example.com got b@example.com', {status: 'identity_mismatch'}).errorCode,
    'identity_mismatch',
  );
  assert.equal(
    simplifyError('manual_security_blocker: Cloudflare security challenge visible', {stage: 'security.challenge'}).message,
    '需要人工验证',
  );
  assert.equal(
    simplifyError('login_required: Continue with Google is visible', {status: 'login_required'}).message,
    'OpenRouter 未登录',
  );
});

test('simplifyError distinguishes payment decline from frequency or amount limit', () => {
  const limit = simplifyError('Payment Issue: amount limit reached after repeated attempts; Your card was declined');
  assert.equal(limit.errorCode, 'card_rate_or_amount_limit');
  assert.equal(limit.message, '支付次数过多或超限');

  const declined = simplifyError('payment_issue_card_declined: Your card was declined');
  assert.equal(declined.errorCode, 'card_declined');
  assert.equal(declined.message, '卡被拒绝');
});

test('simplifyError maps billing and card-entry failures', () => {
  assert.equal(
    simplifyError('Missing billing address fields: billing.addressLine1, postalCode').errorCode,
    'billing_address_missing',
  );
  assert.equal(
    simplifyError('Stripe payment field was not accepted before Save payment method').message,
    '支付信息填写失败',
  );
});

test('simplifyError distinguishes Auto Top-Up pending from generic Auto Top-Up failures', () => {
  const pending = simplifyError('automatic top-up might be pending after payment');
  assert.equal(pending.errorCode, 'auto_topup_pending');
  assert.equal(pending.message, '自动充值处理中');

  const config = simplifyError('Auto top-up did not reach requested values');
  assert.equal(config.errorCode, 'auto_topup_rule_unverified');
  assert.equal(config.message, '自动充值规则未生效');

  const enable = simplifyError('Auto top-up Enable button not found: {"clicked":false,"tail":"Credits"}');
  assert.equal(enable.errorCode, 'auto_topup_not_enabled');
  assert.equal(enable.message, '自动充值未打开');
});

test('simplifyError maps recharge verification and unknown system errors', () => {
  assert.equal(
    simplifyError('purchase_unverified: balance did not increase', {status: 'purchase_unverified'}).errorCode,
    'purchase_unverified',
  );
  assert.equal(
    simplifyError('Unexpected null pointer in automation').errorCode,
    'automation_failed',
  );
  assert.equal(
    simplifyError('Navigation timeout after 60000ms').errorCode,
    'system_timeout',
  );
});

test('simplifyError detail is redacted from raw card, email, token and cvc values', () => {
  const result = simplifyError('Failed for user@example.com card 5257970000000001 token=secret cvc:456');
  assert.equal(result.errorCode, 'automation_failed');
  assert.match(result.detail, /\[card\]/);
  assert.match(result.detail, /us\*\*\*@example\.com/);
  assert.match(result.detail, /token=\[secret\]/);
  assert.match(result.detail, /cvc:\[secret\]/);
  assert.doesNotMatch(result.detail, /5257970000000001|token=secret|cvc:456/);
});

test('simplifyError treats bind-script timeouts as a row timeout', () => {
  const result = simplifyError('bind script timed out after 240000ms');
  assert.equal(result.errorCode, 'row_execution_timeout');
  assert.equal(result.message, '子任务执行超时');
});
