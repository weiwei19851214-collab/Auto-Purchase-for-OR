import {cardLast4, normalizeExpiry, normalizeMoneyValue, redact} from './common.mjs';
import {setCell} from './csv.mjs';

export function loginEmail(row) {
  return String(row.login_email || row.username || '').trim();
}

export function adsPowerSerialNumber(row) {
  return String(row.ads_power_serial_number || row.ID || '').trim();
}

export function adsPowerUserId(row) {
  return String(row.ads_power_user_id || row.profile_id || '').trim();
}

export function profileDisplayId(row) {
  return adsPowerSerialNumber(row) || adsPowerUserId(row);
}

export function cardNumber(row) {
  return String(row.card_number || row.card_no || '').trim();
}

export function ejhOrderNo(row) {
  return String(row.ejh_order_no || row.order_no || '').trim();
}

export function opomAccountId(row) {
  return String(row.opom_account_id || '').trim();
}

export function adsMatchStatus(row) {
  return String(row.ads_match_status || '').trim().toLowerCase();
}

export function opomHealthStatus(row) {
  return String(row.opom_health_status || '').trim().toLowerCase();
}

export function requiredColumns() {
  return [
    'status',
    'ID',
    'username',
    'amount',
    'card_number',
    'exp_month',
    'exp_year',
    'cvv',
    'holder_name',
    'country',
    'postal_code',
    'address_line1',
    'city',
    'state',
  ];
}

export function resultColumns() {
  return [
    'task_status',
    'task_message',
    'purchase_status',
    'purchase_amount',
    'balance_before',
    'balance_after',
    'card_last4',
    'auto_topup_status',
    'auto_topup_threshold',
    'auto_topup_amount',
    'task_updated_at',
    'run_id',
    'opom_account_id',
    'username',
    'login_email',
    'ads_power_user_id',
    'ads_power_serial_number',
    'opom_health_status',
    'opom_health_reason',
    'ads_match_status',
    'ejh_order_no',
    'cardno',
    'opom_card_writeback_status',
    'opom_result_writeback_status',
    'adspower_tag_status',
    'adspower_status_mode',
    'adspower_status_target',
    'adspower_status_reason',
    'completion_evidence_status',
    'completion_evidence_missing',
  ];
}

export function isEligible(row) {
  const status = String(row.status || '').trim();
  const taskStatus = String(row.task_status || '').trim();
  if (/充值.*已完成|completed/i.test(status)) return false;
  if (/^completed$/i.test(taskStatus)) return false;
  return true;
}

export function autoTopupPlan(row, args) {
  const threshold = normalizeMoneyValue(args.autoTopupThreshold || row.auto_topup_threshold || '');
  const amount = normalizeMoneyValue(args.autoTopupAmount || row.auto_topup_amount || '');
  const missing = [];
  if (!threshold) missing.push('auto_topup_threshold');
  if (!amount) missing.push('auto_topup_amount');
  return {threshold, amount, missing};
}

export function purchasePlan(row) {
  const thresholdRaw = row.balance_threshold || '';
  const belowRaw = row.amount_below_threshold || '';
  const atOrAboveRaw = row.amount_at_or_above_threshold || '';
  const anyRule = !!(thresholdRaw || belowRaw || atOrAboveRaw);
  const allRule = !!(thresholdRaw && belowRaw && atOrAboveRaw);
  if (allRule) {
    return {
      purchase: {
        confirmed: true,
        rule: {
          threshold: normalizeMoneyValue(thresholdRaw),
          belowAmount: normalizeMoneyValue(belowRaw),
          atOrAboveAmount: normalizeMoneyValue(atOrAboveRaw),
        },
      },
      missing: [],
      mode: 'balance_rule',
    };
  }
  if (anyRule) {
    return {
      purchase: {confirmed: true},
      missing: ['balance_threshold', 'amount_below_threshold', 'amount_at_or_above_threshold'].filter((key) => !row[key]),
      mode: 'incomplete_balance_rule',
    };
  }
  const amount = normalizeMoneyValue(row.amount || '');
  return {
    purchase: amount ? {confirmed: true, amount} : {confirmed: true},
    missing: amount ? [] : ['amount'],
    mode: 'fixed_amount',
  };
}

export function safePurchasePlan(row) {
  try {
    return purchasePlan(row);
  } catch (error) {
    return {
      purchase: {confirmed: true},
      missing: [`purchase:${error.message}`],
      mode: 'invalid_purchase',
      error: error.message,
    };
  }
}

export function safeAutoTopupPlan(row, args) {
  try {
    return autoTopupPlan(row, args);
  } catch (error) {
    return {threshold: '', amount: '', missing: [`auto_topup:${error.message}`], error: error.message};
  }
}

export function executionScope(args = {}) {
  return {
    billingAddress: args.scopeBillingAddress !== false,
    paymentMethod: args.scopePaymentMethod !== false,
    purchase: args.scopePurchase !== false,
    autoTopup: args.scopeAutoTopup !== false,
  };
}

export function validateScope(args = {}) {
  const scope = executionScope(args);
  const missing = [];
  if (!scope.billingAddress && !scope.paymentMethod && !scope.purchase && !scope.autoTopup) {
    missing.push('execution_scope');
  }
  if (scope.billingAddress && !scope.paymentMethod && (scope.purchase || scope.autoTopup)) {
    missing.push('execution_scope:billing_address_without_card_must_run_alone');
  }
  return missing;
}

export function scopeSummary(args = {}) {
  const scope = executionScope(args);
  const labels = [];
  if (scope.billingAddress) labels.push('billing_address');
  if (scope.paymentMethod) labels.push('payment_method');
  if (scope.purchase) labels.push(args.confirmPurchase === false ? 'purchase_prepare' : 'purchase');
  if (scope.autoTopup) labels.push('auto_topup');
  return labels.join('+') || 'none';
}

export function validateRow(row, args) {
  const missing = validateScope(args);
  const scope = executionScope(args);
  if (!adsPowerSerialNumber(row) && !adsPowerUserId(row)) missing.push('ads_power_user_id_or_serial_number');
  if (adsMatchStatus(row) && adsMatchStatus(row) !== 'matched') missing.push(`ads_match_status:${adsMatchStatus(row)}`);
  if (opomHealthStatus(row) && !['ok', 'local_selector'].includes(opomHealthStatus(row))) missing.push(`opom_health_status:${opomHealthStatus(row)}`);
  if (!loginEmail(row)) missing.push('login_email');
  if (scope.paymentMethod) {
    if (!cardNumber(row)) missing.push('card_number');
    for (const key of ['exp_month', 'exp_year', 'cvv', 'postal_code']) if (!row[key]) missing.push(key);
  }
  if (scope.billingAddress && !scope.paymentMethod) {
    for (const key of ['holder_name', 'country', 'postal_code', 'address_line1', 'city', 'state']) {
      if (!row[key]) missing.push(key);
    }
  }
  if (scope.purchase) {
    missing.push(...safePurchasePlan(row).missing);
  }
  if (opomAccountId(row) && scope.purchase && args.confirmPurchase !== false && !args.opomWriteback) {
    missing.push('opom_writeback');
  }
  if (args.opomWriteback && scope.purchase && args.confirmPurchase !== false) {
    if (!ejhOrderNo(row)) missing.push('order_no');
    if (!cardNumber(row)) missing.push('card_number');
    if (!row.exp_month) missing.push('exp_month');
    if (!row.exp_year) missing.push('exp_year');
  }
  if (scope.autoTopup) {
    missing.push(...safeAutoTopupPlan(row, args).missing);
  }
  return [...new Set(missing)];
}

export function buildClosedLoopTask(row, args) {
  const scope = executionScope(args);
  const autoTopup = scope.autoTopup ? autoTopupPlan(row, args) : {threshold: '', amount: ''};
  const billingComplete = !!(row.holder_name && row.country && row.address_line1 && row.city && row.state && row.postal_code);
  const billingAddressOnly = scope.billingAddress && !scope.paymentMethod && !scope.purchase && !scope.autoTopup;
  const autoTopupOnly = scope.autoTopup && !scope.paymentMethod && !scope.purchase && !scope.billingAddress;
  const purchaseOnly = scope.purchase && !scope.paymentMethod;
  const purchase = scope.purchase ? purchasePlan(row).purchase : {confirmed: false};
  return {
    profileNo: adsPowerSerialNumber(row) || undefined,
    profileId: adsPowerUserId(row) || undefined,
    expectedAccount: loginEmail(row),
    removeExistingPaymentMethod: scope.paymentMethod && args.removeExisting,
    existingBillingAddress: !scope.billingAddress || !billingComplete,
    billingAddressOnly,
    autoTopupOnly,
    purchaseOnly,
    autoTopup: {enabled: scope.autoTopup, threshold: autoTopup.threshold, amount: autoTopup.amount},
    purchase,
    card: {
      number: cardNumber(row),
      expMonth: row.exp_month,
      expYear: row.exp_year,
      expiry: normalizeExpiry(row.exp_month, row.exp_year),
      cvc: row.cvv,
      postalCode: row.postal_code,
    },
    billing: {
      name: row.holder_name,
      country: row.country || 'US',
      addressLine1: row.address_line1,
      city: row.city,
      state: row.state,
      postalCode: row.postal_code,
    },
  };
}

export function baseRowResult(rowNumber, row) {
  return {
    rowNumber,
    id: profileDisplayId(row),
    opomAccountId: opomAccountId(row),
    loginEmail: loginEmail(row),
    loginEmailMasked: loginEmail(row),
    username: loginEmail(row),
    adsPowerUserId: adsPowerUserId(row),
    adsPowerSerialNumber: adsPowerSerialNumber(row),
    adsMatchStatus: adsMatchStatus(row) || '',
    ejhOrderNo: ejhOrderNo(row),
    purchasePlan: safePurchasePlan(row).mode,
    amount: row.amount || '',
    cardNo: cardNumber(row),
    cardLast4: cardLast4(cardNumber(row)),
  };
}

export function dryRunResult(rowNumber, row, args) {
  const missing = validateRow(row, args);
  return {
    ...baseRowResult(rowNumber, row),
    executionScope: scopeSummary(args),
    autoTopup: executionScope(args).autoTopup ? safeAutoTopupPlan(row, args) : {threshold: '', amount: '', skipped: true},
    ready: missing.length === 0,
    missing,
  };
}

export function rowMetadata(row, extra = {}) {
  return {
    opomAccountId: opomAccountId(row),
    username: loginEmail(row),
    loginEmail: loginEmail(row),
    loginEmailMasked: loginEmail(row),
    adsPowerUserId: adsPowerUserId(row),
    adsPowerSerialNumber: adsPowerSerialNumber(row),
    opomHealthStatus: extra.opomHealthStatus || opomHealthStatus(row) || '',
    opomHealthReason: extra.opomHealthReason || row.opom_health_reason || '',
    adsMatchStatus: extra.adsMatchStatus || adsMatchStatus(row) || (adsPowerSerialNumber(row) || adsPowerUserId(row) ? 'not_verified' : ''),
    ejhOrderNo: ejhOrderNo(row),
    cardNo: extra.cardNo || cardNumber(row),
    opomCardWritebackStatus: extra.opomCardWritebackStatus || '',
    opomResultWritebackStatus: extra.opomResultWritebackStatus || '',
    adspowerTagStatus: extra.adspowerTagStatus || 'skipped_user_waived',
    adspowerStatusMode: extra.adspowerStatusMode || 'disabled',
    adspowerStatusTarget: extra.adspowerStatusTarget || 'waived_by_user',
    adspowerStatusReason: extra.adspowerStatusReason || 'user_waived_status_writeback',
  };
}

function detailValue(details, key) {
  const value = details?.[key];
  return value === undefined || value === null ? '' : String(value).trim();
}

function missingIfEmpty(details, missing, key, label = key) {
  if (!detailValue(details, key)) missing.push(label);
}

export function completionEvidence(status, details = {}) {
  if (status !== 'completed') {
    return {status: 'not_completed', missing: []};
  }

  const purchaseStatus = detailValue(details, 'purchaseStatus');
  if (purchaseStatus === 'prepared_without_submission') {
    return {status: 'test_mode_complete', missing: ['purchase_not_submitted']};
  }
  if (purchaseStatus === 'skipped') {
    return {status: 'scope_complete_without_purchase', missing: ['purchase_not_in_scope']};
  }

  const missing = [];
  if (purchaseStatus !== 'verified') missing.push('purchase_status');
  missingIfEmpty(details, missing, 'balanceBefore', 'balance_before');
  missingIfEmpty(details, missing, 'balanceAfter', 'balance_after');
  missingIfEmpty(details, missing, 'cardLast4', 'card_last4');

  const autoTopupStatus = detailValue(details, 'autoTopupStatus');
  if (!/^(updated|unchanged)$/.test(autoTopupStatus)) {
    missing.push('auto_topup_status');
  }

  const adspowerTagStatus = detailValue(details, 'adspowerTagStatus');
  const adsPowerStatusTarget = detailValue(details, 'adspowerStatusTarget');
  const adsPowerStatusWaived = adspowerTagStatus === 'skipped_user_waived' && adsPowerStatusTarget === 'waived_by_user';
  if (adspowerTagStatus !== 'completed' && !adsPowerStatusWaived) {
    missing.push('adspower_tag_status');
  }
  if (!adsPowerStatusWaived && (!adsPowerStatusTarget || /^(disabled|pending_tag_api|skipped_waiting_tag_api|missing_ads_power_user_id)$/i.test(adsPowerStatusTarget))) {
    missing.push('adspower_status_target');
  }

  if (detailValue(details, 'opomAccountId')) {
    if (detailValue(details, 'adsMatchStatus') !== 'matched') missing.push('ads_match_status');
    missingIfEmpty(details, missing, 'ejhOrderNo', 'ejh_order_no');
    if (detailValue(details, 'opomCardWritebackStatus') !== 'written') missing.push('opom_card_writeback_status');
    if (detailValue(details, 'opomResultWritebackStatus') !== 'written') missing.push('opom_result_writeback_status');
  }

  return {
    status: missing.length ? 'incomplete' : 'production_complete',
    missing,
  };
}

export function successDetails(row, result, args) {
  const purchase = result.purchase || {};
  const verification = purchase.balanceVerification || {};
  const autoTopup = result.autoTopup || {};
  const scope = executionScope(args);
  const requestedAutoTopup = scope.autoTopup ? (autoTopup.requested || autoTopupPlan(row, args)) : {threshold: '', amount: ''};
  return {
    ...rowMetadata(row),
    purchaseStatus: scope.purchase ? (verification.verified ? 'verified' : 'purchase_unverified') : 'skipped',
    purchaseAmount: purchase.amount || purchase.ruleDecision?.selectedAmount || '',
    balanceBefore: verification.beforeBalance ?? purchase.beforeBalance?.balance ?? '',
    balanceAfter: verification.afterBalance ?? '',
    cardLast4: result.card?.last4 || cardLast4(cardNumber(row)),
    autoTopupStatus: scope.autoTopup
      ? (autoTopup.configured ? (autoTopup.changed ? 'updated' : 'unchanged') : 'not_configured')
      : 'skipped',
    autoTopupThreshold: requestedAutoTopup.threshold || '',
    autoTopupAmount: requestedAutoTopup.amount || '',
  };
}

export function writeOutcome(header, row, status, message, details = {}) {
  const evidence = completionEvidence(status, details);
  setCell(header, row, 'task_status', status === 'completed' ? 'completed' : status);
  setCell(header, row, 'task_message', redact(message || ''));
  setCell(header, row, 'purchase_status', details.purchaseStatus || '');
  setCell(header, row, 'purchase_amount', details.purchaseAmount || '');
  setCell(header, row, 'balance_before', details.balanceBefore ?? '');
  setCell(header, row, 'balance_after', details.balanceAfter ?? '');
  setCell(header, row, 'card_last4', details.cardLast4 || '');
  setCell(header, row, 'auto_topup_status', details.autoTopupStatus || '');
  setCell(header, row, 'auto_topup_threshold', details.autoTopupThreshold || '');
  setCell(header, row, 'auto_topup_amount', details.autoTopupAmount || '');
  setCell(header, row, 'task_updated_at', new Date().toISOString());
  setCell(header, row, 'run_id', details.runId || '');
  setCell(header, row, 'opom_account_id', details.opomAccountId || '');
  setCell(header, row, 'username', details.username || details.loginEmail || details.loginEmailMasked || '');
  setCell(header, row, 'login_email', details.loginEmail || details.username || details.loginEmailMasked || '');
  setCell(header, row, 'ads_power_user_id', details.adsPowerUserId || '');
  setCell(header, row, 'ads_power_serial_number', details.adsPowerSerialNumber || '');
  setCell(header, row, 'opom_health_status', details.opomHealthStatus || '');
  setCell(header, row, 'opom_health_reason', details.opomHealthReason || '');
  setCell(header, row, 'ads_match_status', details.adsMatchStatus || '');
  setCell(header, row, 'ejh_order_no', details.ejhOrderNo || '');
  setCell(header, row, 'cardno', details.cardNo || '');
  setCell(header, row, 'opom_card_writeback_status', details.opomCardWritebackStatus || '');
  setCell(header, row, 'opom_result_writeback_status', details.opomResultWritebackStatus || '');
  setCell(header, row, 'adspower_tag_status', details.adspowerTagStatus || '');
  setCell(header, row, 'adspower_status_mode', details.adspowerStatusMode || '');
  setCell(header, row, 'adspower_status_target', details.adspowerStatusTarget || '');
  setCell(header, row, 'adspower_status_reason', details.adspowerStatusReason || '');
  setCell(header, row, 'completion_evidence_status', evidence.status);
  setCell(header, row, 'completion_evidence_missing', evidence.missing.join('|'));
}
