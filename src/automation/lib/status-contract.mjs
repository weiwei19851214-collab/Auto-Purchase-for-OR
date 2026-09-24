import {redact} from './common.mjs';

export const STATUSES = Object.freeze({
  COMPLETED: 'completed',
  MISSING_FIELDS: 'missing_fields',
  LOGIN_REQUIRED: 'login_required',
  IDENTITY_MISMATCH: 'identity_mismatch',
  PAYMENT_ISSUE_CARD_DECLINED: 'payment_issue_card_declined',
  MANUAL_SECURITY_BLOCKER: 'manual_security_blocker',
  PURCHASE_UNVERIFIED: 'purchase_unverified',
  FAILED: 'failed',
});

export function classifyError(message) {
  const text = String(message || '');
  if (/crypto_wallet_import_/.test(text)) {
    return statusRecord(STATUSES.MANUAL_SECURITY_BLOCKER, {
      stage: 'crypto.wallet_import', safeToContinueBatch: false, stopProfile: false, message: text,
    });
  }
  if (/crypto_password_/i.test(text)) {
    return statusRecord(STATUSES.MANUAL_SECURITY_BLOCKER, {
      stage: 'crypto.password_verification', safeToContinueBatch: false, stopProfile: false, message: text,
    });
  }
  if (/Crypto purchase form did not become ready|Crypto amount input (?:not found or not focused|did not retain)|Crypto Purchase button not clickable/i.test(text)) {
    return statusRecord(STATUSES.FAILED, {
      stage: 'crypto.purchase_form',
      terminal: true,
      // 虚拟币页面加载或输入失败时保留浏览器现场，并暂停后续账号，避免页面刚刷新出来就被关闭。
      safeToContinueBatch: false,
      stopProfile: false,
      message: text,
    });
  }
  if (/Verification required|Enter your current password|crypto_wallet_confirmation_required|wallet confirmation required/i.test(text)) {
    return statusRecord(STATUSES.MANUAL_SECURITY_BLOCKER, {
      stage: /password/i.test(text) ? 'identity.reverification' : 'crypto.wallet_confirmation',
      terminal: true,
      safeToContinueBatch: false,
      stopProfile: false,
      message: text,
    });
  }
  if (/missing_fields|Missing .*fields|billing address is required by this account/i.test(text)) {
    return statusRecord(STATUSES.MISSING_FIELDS, {
      stage: 'input.missing_fields',
      terminal: true,
      safeToContinueBatch: true,
      stopProfile: true,
      message: text,
    });
  }
  if (/payment_issue_card_declined|Payment Issue|Your card was declined|card was declined|amount limit|repeated attempts/i.test(text)) {
    return statusRecord(STATUSES.PAYMENT_ISSUE_CARD_DECLINED, {
      stage: 'purchase.submit',
      terminal: true,
      safeToContinueBatch: true,
      stopProfile: true,
      message: text,
    });
  }
  if (/payment confirmation accepted after automation timeout/i.test(text)) {
    return statusRecord(STATUSES.PURCHASE_UNVERIFIED, {
      stage: 'purchase.verify',
      terminal: true,
      safeToContinueBatch: false,
      stopProfile: false,
      message: text,
    });
  }
  if (/purchase_unverified|balance did not increase|payment_unverified/i.test(text)) {
    return statusRecord(STATUSES.PURCHASE_UNVERIFIED, {
      stage: 'purchase.verify',
      terminal: true,
      safeToContinueBatch: true,
      stopProfile: true,
      message: text,
    });
  }
  if (/login_required|Sign in|Continue with Google|Log in/i.test(text)) {
    return statusRecord(STATUSES.LOGIN_REQUIRED, {
      stage: 'identity.login',
      terminal: true,
      safeToContinueBatch: true,
      stopProfile: true,
      message: text,
    });
  }
  if (/Stripe Link save-info checkbox or phone subform is still active/i.test(text)) {
    return statusRecord(STATUSES.FAILED, {
      stage: 'payment_method.link_opt_in',
      terminal: true,
      safeToContinueBatch: true,
      stopProfile: true,
      message: text,
    });
  }
  if (/Stripe payment field was not accepted|Stripe payment fields are not ready before Save payment method|Stripe field did not retain value/i.test(text)) {
    return statusRecord(STATUSES.FAILED, {
      stage: 'payment_method.input',
      terminal: true,
      safeToContinueBatch: true,
      // 输入错误不能自动恢复，记录现场日志后立即关闭，避免单行失败长期占用浏览器。
      stopProfile: true,
      message: text,
    });
  }
  if (/OpenRouter account mismatch|account mismatch|expected .* got/i.test(text)) {
    return statusRecord(STATUSES.IDENTITY_MISMATCH, {
      stage: 'identity.account',
      terminal: true,
      safeToContinueBatch: true,
      stopProfile: true,
      message: text,
    });
  }
  if (/AdsPower.*(is being used by|not allowed to open)|is being used by .* not allowed to open/i.test(text)) {
    return statusRecord(STATUSES.FAILED, {
      stage: 'adspower.profile_in_use',
      terminal: true,
      safeToContinueBatch: true,
      stopProfile: false,
      message: text,
    });
  }
  return statusRecord(STATUSES.FAILED, {
    stage: 'automation',
    terminal: true,
    safeToContinueBatch: true,
    stopProfile: true,
    message: text,
  });
}

export function statusRecord(status, options = {}) {
  return {
    status,
    stage: options.stage || '',
    terminal: options.terminal !== false,
    safeToContinueBatch: options.safeToContinueBatch !== false,
    stopProfile: options.stopProfile !== false,
    message: redact(options.message || ''),
    evidence: options.evidence || {},
  };
}

export function completedRecord(details) {
  return statusRecord(STATUSES.COMPLETED, {
    stage: 'closed_loop.complete',
    terminal: true,
    safeToContinueBatch: true,
    stopProfile: true,
    message: 'completed',
    evidence: {
      purchaseStatus: details.purchaseStatus,
      purchaseAmount: details.purchaseAmount,
      balanceBefore: details.balanceBefore,
      balanceAfter: details.balanceAfter,
      autoTopupStatus: details.autoTopupStatus,
    },
  });
}
