import {redact} from './common.mjs';

const NON_ERROR_STATUSES = new Set(['', 'queued', 'running', 'completed', 'ready', 'ok']);

const UNKNOWN_ERROR = Object.freeze({
  errorCode: 'automation_failed',
  message: '自动化执行失败',
});

const RULES = [
  {
    errorCode: 'worker_interrupted',
    message: '执行中断，结果待确认',
    matches: ({text, stage}) => /server restarted during row execution/i.test(text) || /^worker\.interrupted$/i.test(stage),
  },
  {
    errorCode: 'csv_empty',
    message: 'CSV 为空',
    matches: ({text}) => /CSV is empty/i.test(text),
  },
  {
    errorCode: 'csv_columns_missing',
    message: 'CSV 缺少必要字段',
    matches: ({text}) => /CSV missing required columns/i.test(text),
  },
  {
    errorCode: 'purchase_amount_missing',
    message: '充值金额缺失',
    matches: ({text, status}) => /Purchase amount is required/i.test(text)
      || (status === 'missing_fields' && /^\s*amount\s*$/i.test(text)),
  },
  {
    errorCode: 'billing_address_missing',
    message: 'Billing 地址缺失',
    matches: ({text}) => /billing address is required|Missing billing address fields|card postalCode is required/i.test(text),
  },
  {
    errorCode: 'missing_fields',
    message: '执行信息不完整',
    matches: ({text, status, stage}) => status === 'missing_fields'
      || /missing_fields|Missing .*fields|required field/i.test(text)
      || /^input\.missing_fields$/i.test(stage),
  },
  {
    errorCode: 'opom_card_fields_missing',
    message: 'OPOM 绑卡信息不完整',
    matches: ({text}) => /OPOM card binding requires orderNo, cardNo, and expiresAt/i.test(text),
  },
  {
    errorCode: 'opom_url_missing',
    message: 'OPOM 地址未配置',
    matches: ({text}) => /OPOM_BASE_URL is not configured/i.test(text),
  },
  {
    errorCode: 'opom_token_missing',
    message: 'OPOM Token 未配置',
    matches: ({text}) => /OPOM_RECHARGE_TOKEN|RECHARGE_API_TOKEN.*not configured/i.test(text),
  },
  {
    errorCode: 'opom_card_inactive',
    message: 'OPOM 卡不可用',
    matches: ({text, stage}) => /OPOM card status .* is not ACTIVE|opom_card_not_active/i.test(text)
      || /^opom\.card_status$/i.test(stage),
  },
  {
    errorCode: 'opom_card_writeback_failed',
    message: 'OPOM 绑卡写回失败',
    matches: ({text}) => /OPOM .*card-binding|card binding.*(?:failed|error)|\/card-binding/i.test(text),
  },
  {
    errorCode: 'opom_auth_failed',
    message: 'OPOM 认证失败',
    matches: ({text}) => /OPOM.*(?:401|403|Unauthorized|Forbidden)/i.test(text),
  },
  {
    errorCode: 'opom_writeback_failed',
    message: 'OPOM 写回失败',
    matches: ({text, stage}) => /OPOM writeback failed/i.test(text)
      || /^opom\.writeback$/i.test(stage),
  },
  {
    errorCode: 'opom_request_failed',
    message: 'OPOM 连接失败',
    matches: ({text}) => /OPOM request failed|OPOM network failed/i.test(text),
  },
  {
    errorCode: 'adspower_rate_limited',
    message: 'AdsPower 请求过于频繁',
    matches: ({text}) => /AdsPower.*(?:too many requests?|rate limit|请求过于频繁)/i.test(text),
  },
  {
    errorCode: 'adspower_lookup_failed',
    message: 'AdsPower 账号查询失败',
    matches: ({text}) => /AdsPower user\/list failed|AdsPower match failed|AdsPower email index failed/i.test(text),
  },
  {
    errorCode: 'adspower_profile_missing',
    message: 'AdsPower 浏览器不存在',
    matches: ({text}) => /Profile does not exist/i.test(text),
  },
  {
    errorCode: 'adspower_profile_in_use',
    message: 'AdsPower 浏览器被占用',
    matches: ({text, stage}) => /AdsPower.*(?:is being used by|not allowed to open)|profile is being used|browser.*in use/i.test(text)
      || /^adspower\.profile_in_use/i.test(stage),
  },
  {
    errorCode: 'adspower_start_timeout',
    message: 'AdsPower 浏览器启动超时',
    matches: ({text}) => /Could not start AdsPower profile.*HTTP timeout|AdsPower.*start.*timeout/i.test(text),
  },
  {
    errorCode: 'adspower_start_failed',
    message: 'AdsPower 浏览器启动失败',
    matches: ({text}) => /Could not start AdsPower profile or attach CDP endpoint|Provided AdsPower debug endpoint is not ready/i.test(text),
  },
  {
    errorCode: 'row_execution_timeout',
    message: '子任务执行超时',
    matches: ({text}) => /bind script timed out after/i.test(text),
  },
  {
    errorCode: 'page_navigation_failed',
    message: 'OpenRouter 页面加载失败',
    matches: ({text}) => /navigation ready timeout|CDP navigation failed|OpenRouter Credits page target not found|No page target available/i.test(text),
  },
  {
    errorCode: 'browser_command_timeout',
    message: '浏览器操作超时',
    matches: ({text}) => /CDP command timeout/i.test(text),
  },
  {
    errorCode: 'browser_connect_failed',
    message: '浏览器连接失败',
    matches: ({text}) => /CDP connect timeout|CDP websocket error|ECONNREFUSED|Target closed/i.test(text),
  },
  {
    errorCode: 'identity_mismatch',
    message: 'OpenRouter 账号不匹配',
    matches: ({text, status, stage}) => status === 'identity_mismatch'
      || /identity_mismatch|OpenRouter account mismatch|account mismatch|expected .* got|belongs to a different OpenRouter account/i.test(text)
      || /^identity\.(account|mismatch)/i.test(stage),
  },
  {
    errorCode: 'login_required',
    message: 'OpenRouter 未登录',
    matches: ({text, status, stage}) => status === 'login_required'
      || /login_required|Sign in|Continue with Google|Log in|passkey/i.test(text)
      || /^identity\.login/i.test(stage),
  },
  {
    errorCode: 'manual_security_incomplete',
    message: '人工验证未完成',
    matches: ({text}) => /security challenge.*(?:closed|not completed)|manual verification.*(?:closed|not completed)/i.test(text),
  },
  {
    errorCode: 'manual_security_blocker',
    message: '需要人工验证',
    matches: ({text, status, stage}) => status === 'manual_security_blocker'
      || /manual_security_blocker|captcha|hcaptcha|cloudflare|3DS|security challenge|bank verification|短信|验证码|风控/i.test(text)
      || /security|challenge/i.test(stage),
  },
  {
    errorCode: 'billing_address_failed',
    message: 'Billing 地址填写失败',
    matches: ({text}) => /Billing address form was not completely filled|Billing address was submitted but card form is not ready/i.test(text),
  },
  {
    errorCode: 'payment_form_not_ready',
    message: '支付表单未加载',
    matches: ({text}) => /Stripe .*iframe.*(?:not ready|not found)|Stripe payment fields are not ready|Missing Stripe field/i.test(text),
  },
  {
    errorCode: 'payment_input_rejected',
    message: '支付信息填写失败',
    matches: ({text, stage}) => /Stripe payment field was not accepted|Stripe field did not retain value/i.test(text)
      || /^payment_method\.input/i.test(stage),
  },
  {
    errorCode: 'stripe_link_active',
    message: 'Stripe Link 未关闭',
    matches: ({text, stage}) => /Stripe Link save-info checkbox|phone subform is still active/i.test(text)
      || /^payment_method\.link_opt_in/i.test(stage),
  },
  {
    errorCode: 'payment_entry_unavailable',
    message: '支付卡入口不可用',
    matches: ({text}) => /Payment (?:method )?entry not (?:found|ready)|Add a Payment Method.*(?:not found|not ready|could not be clicked)/i.test(text),
  },
  {
    errorCode: 'stripe_customer_mismatch',
    message: '支付卡账号不匹配',
    matches: ({text}) => /Stripe customer mismatch/i.test(text),
  },
  {
    errorCode: 'saved_card_missing',
    message: '没有可用支付卡',
    matches: ({text}) => /Saved payment method is required/i.test(text),
  },
  {
    errorCode: 'saved_card_unverified',
    message: '未检测到可用支付卡',
    matches: ({text}) => /Could not verify saved payment method/i.test(text),
  },
  {
    errorCode: 'card_save_failed',
    message: '支付卡保存失败',
    matches: ({text}) => /Save modal did not close|did not expose Save payment method/i.test(text),
  },
  {
    errorCode: 'card_save_unverified',
    message: '支付卡保存未确认',
    matches: ({text}) => /Saved card was not visible/i.test(text),
  },
  {
    errorCode: 'expected_card_missing',
    message: '指定支付卡未找到',
    matches: ({text}) => /Saved payment method not found for last4/i.test(text),
  },
  {
    errorCode: 'old_card_removal_failed',
    message: '旧支付卡删除失败',
    matches: ({text}) => /Could not clear default payment method|Saved payment-method removal/i.test(text),
  },
  {
    errorCode: 'purchase_modal_not_open',
    message: '充值弹窗未打开',
    matches: ({text}) => /Add Credits was clicked but Purchase Credits amount modal did not open/i.test(text),
  },
  {
    errorCode: 'balance_read_failed',
    message: '余额读取失败',
    matches: ({text}) => /Could not parse current OpenRouter credit balance/i.test(text),
  },
  {
    errorCode: 'card_identity_unavailable',
    message: '支付卡信息识别失败',
    matches: ({text}) => /Could not determine card (?:last4|expiry display value)/i.test(text),
  },
  {
    errorCode: 'purchase_amount_not_retained',
    message: '充值金额填写失败',
    matches: ({text}) => /Purchase amount input did not retain/i.test(text),
  },
  {
    errorCode: 'payment_option_unconfirmed',
    message: '支付选项确认失败',
    matches: ({text}) => /Use one-time payment methods|Send me invoices/i.test(text),
  },
  {
    errorCode: 'purchase_button_unavailable',
    message: '购买按钮不可用',
    matches: ({text}) => /Purchase modal is not ready|Purchase button not clickable/i.test(text),
  },
  {
    errorCode: 'auto_topup_pending',
    message: '自动充值处理中',
    matches: ({text}) => /automatic top[- ]up might be pending/i.test(text),
  },
  {
    errorCode: 'card_rate_or_amount_limit',
    message: '支付次数过多或超限',
    matches: ({text, stage}) => /amount limit|repeated attempts|too many attempts|rate limit|limit exceeded|额度|频率|次数过多/i.test(text)
      || /^purchase\.(limit|rate)/i.test(stage),
  },
  {
    errorCode: 'card_declined',
    message: '卡被拒绝',
    matches: ({text, status, stage}) => status === 'payment_issue_card_declined'
      || /payment_issue_card_declined|Payment Issue|Your card was declined|card was declined|declined/i.test(text)
      || /^purchase\.(submit|declined)/i.test(stage),
  },
  {
    errorCode: 'purchase_result_uncertain',
    message: '付款可能成功，结果待确认',
    matches: ({text}) => /payment confirmation accepted after automation timeout/i.test(text),
  },
  {
    errorCode: 'purchase_unverified',
    message: '充值结果未确认',
    matches: ({text, status, stage}) => status === 'purchase_unverified'
      || /purchase_unverified|balance did not increase|payment_unverified/i.test(text)
      || /^purchase\.verify/i.test(stage),
  },
  {
    errorCode: 'auto_topup_not_enabled',
    message: '自动充值未打开',
    matches: ({text}) => /Auto top-up Enable button not found/i.test(text),
  },
  {
    errorCode: 'auto_topup_manage_missing',
    message: '自动充值管理入口未找到',
    matches: ({text}) => /Auto top-up Manage button.*not found/i.test(text),
  },
  {
    errorCode: 'auto_topup_form_not_ready',
    message: '自动充值设置未加载',
    matches: ({text}) => /Auto top-up (?:form|form inputs).*not (?:found|ready)|did not open the settings form/i.test(text),
  },
  {
    errorCode: 'auto_topup_switch_missing',
    message: '自动充值开关未找到',
    matches: ({text}) => /Auto top-up switch not found/i.test(text),
  },
  {
    errorCode: 'auto_topup_enable_failed',
    message: '自动充值开启失败',
    matches: ({text}) => /Auto top-up switch (?:did not reach|did not stay enabled)/i.test(text),
  },
  {
    errorCode: 'auto_topup_save_button_missing',
    message: '自动充值保存按钮不可用',
    matches: ({text}) => /Auto top-up save button not found/i.test(text),
  },
  {
    errorCode: 'auto_topup_save_unavailable',
    message: '自动充值无法保存',
    matches: ({text}) => /Auto top-up save (?:button )?stayed unavailable/i.test(text),
  },
  {
    errorCode: 'auto_topup_rule_unverified',
    message: '自动充值规则未生效',
    matches: ({text}) => /Auto top-up did not reach requested values/i.test(text),
  },
  {
    errorCode: 'auto_topup_config_failed',
    message: '自动充值设置失败',
    matches: ({text, stage}) => /auto[-_ ]?top[-_ ]?up|auto_topup/i.test(text) || /^auto_topup\./i.test(stage),
  },
  {
    errorCode: 'page_script_error',
    message: '页面执行异常',
    matches: ({text}) => /"exceptionId"\s*:|Uncaught|exceptionDetails/i.test(text),
  },
  {
    errorCode: 'system_timeout',
    message: '执行超时',
    matches: ({text, stage}) => /timeout|timed out|AbortError|ETIMEDOUT|超时/i.test(text)
      || /timeout/i.test(stage),
  },
];

export function simplifyError(message, context = {}) {
  const status = String(context.status || '').trim();
  const stage = String(context.stage || '').trim();
  const raw = message == null ? '' : String(message);
  if (!raw && NON_ERROR_STATUSES.has(status.toLowerCase())) {
    return {errorCode: '', message: '', detail: ''};
  }
  if (!raw && !status && !stage) {
    return {errorCode: '', message: '', detail: ''};
  }

  const input = {text: raw, status: status.toLowerCase(), stage};
  const match = RULES.find((rule) => rule.matches(input)) || UNKNOWN_ERROR;
  return {
    errorCode: match.errorCode,
    message: match.message,
    detail: redact(raw || status || stage).slice(0, 12000),
  };
}

export function simplifyResult(result = {}) {
  return simplifyError(result.error || result.message || '', {
    status: result.status || '',
    stage: result.stage || '',
  });
}
