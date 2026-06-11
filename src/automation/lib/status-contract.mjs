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
  if (/OpenRouter account mismatch|account mismatch|expected .* got/i.test(text)) {
    return statusRecord(STATUSES.IDENTITY_MISMATCH, {
      stage: 'identity.account',
      terminal: true,
      safeToContinueBatch: true,
      stopProfile: true,
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
