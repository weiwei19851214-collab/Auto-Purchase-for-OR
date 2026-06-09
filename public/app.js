let selectedJobId = '';
let lastDryRun = null;
let selectedFile = null;
let selectedCsvText = '';
let opomRows = [];
let opomNextCursor = '';
let dryRunSignature = '';
let liveConfirmationToken = '';
let loadSequence = 0;
let sessionToken = '';
let sessionConfig = {};
let lastAdsPowerTargets = null;
let jobsPage = 1;
let lastJobs = [];
const JOBS_PAGE_SIZE = 10;

const els = {
  file: document.querySelector('#csvFile'),
  opomReady: document.querySelector('#opomReadyBtn'),
  opomLoadMore: document.querySelector('#opomLoadMoreBtn'),
  adsPowerMatch: document.querySelector('#adsPowerMatchBtn'),
  allocateCards: document.querySelector('#allocateCardsBtn'),
  createCards: document.querySelector('#createCardsBtn'),
  opomGroup: document.querySelector('#opomGroup'),
  opomStatus: document.querySelector('#opomStatus'),
  opomLimit: document.querySelector('#opomLimit'),
  opomWriteback: document.querySelector('#opomWriteback'),
  defaultAmount: document.querySelector('#defaultAmount'),
  defaultBalanceThreshold: document.querySelector('#defaultBalanceThreshold'),
  defaultAmountBelow: document.querySelector('#defaultAmountBelow'),
  defaultAmountAtOrAbove: document.querySelector('#defaultAmountAtOrAbove'),
  defaultAutoTopupThreshold: document.querySelector('#defaultAutoTopupThreshold'),
  defaultAutoTopupAmount: document.querySelector('#defaultAutoTopupAmount'),
  addressMappingCsv: document.querySelector('#addressMappingCsv'),
  ejhAmount: document.querySelector('#ejhAmount'),
  ejhActiveDate: document.querySelector('#ejhActiveDate'),
  ejhCardholder: document.querySelector('#ejhCardholder'),
  ejhSafeCsv: document.querySelector('#ejhSafeCsv'),
  opomSummary: document.querySelector('#opomSummary'),
  liveRun: document.querySelector('#liveRunBtn'),
  refresh: document.querySelector('#refreshBtn'),
  dryRunSummary: document.querySelector('#dryRunSummary'),
  opomPreviewMeta: document.querySelector('#opomPreviewMeta'),
  opomPreviewBody: document.querySelector('#opomPreviewBody'),
  jobsBody: document.querySelector('#jobsBody'),
  jobsPrevPage: document.querySelector('#jobsPrevPageBtn'),
  jobsNextPage: document.querySelector('#jobsNextPageBtn'),
  jobsPageInfo: document.querySelector('#jobsPageInfo'),
  rowsBody: document.querySelector('#rowsBody'),
  eventsBody: document.querySelector('#eventsBody'),
  worker: document.querySelector('#worker'),
  jobMeta: document.querySelector('#jobMeta'),
  cancel: document.querySelector('#cancelBtn'),
  download: document.querySelector('#downloadLink'),
  removeExisting: document.querySelector('#removeExisting'),
  stopProfiles: document.querySelector('#stopProfiles'),
  noPurchaseMode: document.querySelector('#noPurchaseMode'),
  concurrency: document.querySelector('#concurrency'),
  adspowerStatusMode: document.querySelector('#adspowerStatusMode'),
  adspowerSuccessGroupId: document.querySelector('#adspowerSuccessGroupId'),
  adspowerFailureGroupId: document.querySelector('#adspowerFailureGroupId'),
  adspowerBlockerGroupId: document.querySelector('#adspowerBlockerGroupId'),
  adspowerDiscoverTargets: document.querySelector('#adspowerDiscoverTargetsBtn'),
  adspowerUseDiscoveredTargets: document.querySelector('#adspowerUseDiscoveredTargetsBtn'),
  adspowerTargetsSummary: document.querySelector('#adspowerTargetsSummary'),
  scopeBillingAddress: document.querySelector('#scopeBillingAddress'),
  scopePaymentMethod: document.querySelector('#scopePaymentMethod'),
  scopePurchase: document.querySelector('#scopePurchase'),
  scopeAutoTopup: document.querySelector('#scopeAutoTopup'),
  confirmLive: document.querySelector('#confirmLive'),
  confirmLiveText: document.querySelector('#confirmLiveText'),
  confirmationState: document.querySelector('#confirmationState'),
  preflight: document.querySelector('#preflight'),
  alert: document.querySelector('#alert'),
  statQueue: document.querySelector('#statQueue'),
  statMatch: document.querySelector('#statMatch'),
  statBilling: document.querySelector('#statBilling'),
  statCards: document.querySelector('#statCards'),
  statDryRun: document.querySelector('#statDryRun'),
};

const CANONICAL_HEADER = [
  'status',
  'opom_account_id',
  'login_email',
  'ads_power_user_id',
  'ads_power_serial_number',
  'ads_power_group_name',
  'opom_health_status',
  'opom_health_reason',
  'ads_match_status',
  'order_no',
  'card_no',
  'exp_month',
  'exp_year',
  'cvv',
  'amount',
  'postal_code',
  'holder_name',
  'country',
  'address_line1',
  'city',
  'state',
  'balance_threshold',
  'amount_below_threshold',
  'amount_at_or_above_threshold',
  'auto_topup_threshold',
  'auto_topup_amount',
  'idempotency_key',
];

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionToken ? {'X-Runner-Session': sessionToken} : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function initSession() {
  const res = await fetch('/api/session');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error(data.error || '无法初始化本地会话');
  sessionToken = data.token;
  sessionConfig = data.integrations || {};
  els.opomWriteback.disabled = !sessionConfig.opomWritebackConfigured;
  if (!sessionConfig.opomWritebackConfigured) els.opomWriteback.checked = false;
}

function optionsPayload() {
  const scopePurchase = els.scopePurchase.checked;
  return {
    scopeBillingAddress: els.scopeBillingAddress.checked,
    scopePaymentMethod: els.scopePaymentMethod.checked,
    scopePurchase,
    scopeAutoTopup: els.scopeAutoTopup.checked,
    removeExisting: els.removeExisting.checked,
    stopProfiles: els.stopProfiles.checked,
    concurrency: els.concurrency.value.trim(),
    confirmPurchase: scopePurchase && !els.noPurchaseMode.checked,
    preparePurchaseOnly: scopePurchase && els.noPurchaseMode.checked,
    autoTopupThreshold: els.defaultAutoTopupThreshold.value.trim(),
    autoTopupAmount: els.defaultAutoTopupAmount.value.trim(),
    opomWriteback: els.opomWriteback.checked && !els.opomWriteback.disabled,
    adspowerStatusMode: els.adspowerStatusMode?.value || 'disabled',
    adspowerSuccessGroupId: els.adspowerSuccessGroupId?.value.trim() || '',
    adspowerFailureGroupId: els.adspowerFailureGroupId?.value.trim() || '',
    adspowerBlockerGroupId: els.adspowerBlockerGroupId?.value.trim() || '',
  };
}

function selectedScopeLabels() {
  const labels = [];
  if (els.scopeBillingAddress.checked) labels.push('添加付款地址');
  if (els.scopePaymentMethod.checked) labels.push('换卡');
  if (els.scopePurchase.checked) labels.push(els.noPurchaseMode.checked ? '预填充值' : '充值');
  if (els.scopeAutoTopup.checked) labels.push('自动充值规则');
  return labels;
}

function executionMode() {
  if (!els.scopePurchase.checked) {
    return {
      label: '非充值执行',
      button: '启动执行',
      confirm: '我确认待执行清单无误，允许启动前自动预检并执行所选非充值步骤。',
      requireText: '请先勾选执行确认',
      action: '即将启动所选非充值步骤',
    };
  }
  if (els.noPurchaseMode.checked) {
    return {
      label: 'No-purchase 测试',
      button: '启动 No-purchase Run',
      confirm: '我确认待充值清单和金额规则无误，允许启动前自动预检并执行 no-purchase 测试；不会点击 Purchase。',
      requireText: '请先勾选 no-purchase 执行确认',
      action: '即将启动 no-purchase 测试；不会点击 Purchase',
    };
  }
  return {
    label: 'Live Run',
    button: '启动 Live Run',
    confirm: '我确认待充值清单和金额规则无误，允许启动前自动预检并执行真实充值闭环。',
    requireText: '请先勾选真实充值确认',
    action: '即将启动真实充值 Live Run',
  };
}

function syncExecutionCopy() {
  const mode = executionMode();
  els.liveRun.textContent = mode.button;
  els.confirmLiveText.textContent = mode.confirm;
}

function updateRunStats() {
  if (!els.statQueue) return;
  const total = opomRows.length;
  const matched = opomRows.filter((row) => row.ads_match_status === 'matched').length;
  const billing = opomRows.filter((row) => isAddressReady(row)).length;
  const cards = opomRows.filter((row) => row.card_no || row.order_no).length;
  els.statQueue.textContent = total ? `${total} 行` : (selectedFile ? 'CSV' : '未拉取');
  els.statMatch.textContent = total ? `${matched}/${total}` : '0/0';
  els.statBilling.textContent = total ? `${billing}/${total}` : '0/0';
  els.statCards.textContent = total ? `${cards}/${total}` : '0/0';
  els.statDryRun.textContent = lastDryRun
    ? `${lastDryRun.ready || 0} ready / ${lastDryRun.blocked || 0} blocked`
    : '未执行';
}

function canAttemptExecution() {
  return Boolean(selectedCsvText.trim()) && selectedScopeLabels().length > 0;
}

function syncExecutionAvailability() {
  const canAttempt = canAttemptExecution();
  els.confirmLive.disabled = !canAttempt;
  if (!canAttempt) els.confirmLive.checked = false;
  els.liveRun.disabled = !canAttempt || !els.confirmLive.checked;
}

function syncScopeControls() {
  const purchaseEnabled = els.scopePurchase.checked;
  els.noPurchaseMode.disabled = !purchaseEnabled;
  if (!purchaseEnabled) els.noPurchaseMode.checked = false;
  els.removeExisting.disabled = !els.scopePaymentMethod.checked;
  syncExecutionCopy();
}

function currentSignature() {
  return JSON.stringify({
    fileName: selectedFile?.name || '',
    csvText: selectedCsvText,
    options: optionsPayload(),
  });
}

function invalidateDryRun(reason = '选项已变化，启动执行时会重新预检。') {
  lastDryRun = null;
  dryRunSignature = '';
  liveConfirmationToken = '';
  syncExecutionCopy();
  els.confirmationState.textContent = reason;
  syncExecutionAvailability();
  updateRunStats();
}

function statusBadge(status) {
  return `<span class="status ${escapeHtml(status)}">${escapeHtml(status || '-')}</span>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < String(text || '').length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((line) => line.some((value) => String(value || '').trim() !== ''));
}

function rowObject(header, line) {
  return Object.fromEntries(header.map((key, index) => [String(key || '').trim(), line[index] ?? '']));
}

function valueFrom(row, keys) {
  for (const key of keys) {
    const value = String(row[key] ?? '').trim();
    if (value) return value;
  }
  return '';
}

function normalizedHeaderKeys(line) {
  return new Set(line.map((value) => String(value || '').trim().toLowerCase()));
}

function looksLikeAccountSelectorHeader(line) {
  const keys = normalizedHeaderKeys(line);
  return [
    'login_email',
    'loginemail',
    'email',
    'username',
    'ads_power_serial_number',
    'adspowerserialnumber',
    'serial_number',
    'serialnumber',
    'id',
    'ads_id',
    'adsid',
    'profile_no',
    'profileno',
    'ads_power_user_id',
    'adspoweruserid',
    'user_id',
    'userid',
    'opom_account_id',
    'opomaccountid',
  ].some((key) => keys.has(key));
}

function canonicalCsvFromRows(rows) {
  return `${[CANONICAL_HEADER, ...rows.map((row) => CANONICAL_HEADER.map((key) => row[key] || ''))]
    .map((row) => row.map(csvEscape).join(','))
    .join('\r\n')}\r\n`;
}

function sanitizeMessage(value) {
  return String(value || '')
    .replace(/\b\d{3,4}\b/g, (digits) => (digits.length <= 4 ? '***' : digits))
    .replace(/([A-Z0-9._%+-]{2})[A-Z0-9._%+-]*(@[A-Z0-9.-]+\.[A-Z]{2,})/gi, '$1***$2');
}

function formatChinaTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} UTC+8`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}

function maskEmail(value) {
  return String(value || '');
}

function cardNoLabel(row = {}) {
  const cardNo = row.cardNo || row.cardno || row.card_no || row.card_number || '';
  const last4 = row.cardLast4 || String(cardNo).replace(/\D/g, '').slice(-4);
  const cardLabel = cardNo ? `card ${cardNo}` : (last4 ? `card ****${last4}` : '');
  return [row.ejhOrderNo || row.order_no || '', cardLabel].filter(Boolean).join(' / ');
}

function purchaseRuleLabel(row) {
  if (row.balance_threshold || row.amount_below_threshold || row.amount_at_or_above_threshold) {
    const complete = row.balance_threshold && row.amount_below_threshold && row.amount_at_or_above_threshold;
    return complete
      ? `balance ${row.balance_threshold}: ${row.amount_below_threshold}/${row.amount_at_or_above_threshold}`
      : 'balance rule incomplete';
  }
  return row.amount ? `fixed ${row.amount}` : 'missing';
}

function rowBadgeState(value, okValue = 'ready') {
  if (value === true || value === okValue) return 'completed';
  if (!value || value === 'missing' || value === 'not_verified') return 'missing_fields';
  if (String(value).includes('mismatch') || String(value).includes('failed')) return 'failed';
  return String(value);
}

function opomHealthBadge(row) {
  const status = String(row.opom_health_status || 'ok').trim() || 'ok';
  const reason = String(row.opom_health_reason || '').trim();
  const badgeState = status === 'ok' ? 'completed' : status;
  return `${statusBadge(badgeState)}${reason ? ` <span class="muted">${escapeHtml(reason)}</span>` : ''}`;
}

function isAddressReady(row) {
  return ADDRESS_FIELDS.every((field) => String(row[field] || '').trim());
}

function renderOpomPreview(stage = '') {
  if (!opomRows.length) {
    els.opomPreviewMeta.textContent = 'Load OPOM group 或上传 CSV 后显示。';
    els.opomPreviewBody.innerHTML = '';
    updateRunStats();
    return;
  }
  const matched = opomRows.filter((row) => row.ads_match_status === 'matched').length;
  const cards = opomRows.filter((row) => row.card_no || row.order_no).length;
  els.opomPreviewMeta.textContent = `${stage || 'snapshot'} rows=${opomRows.length} matched=${matched} cards=${cards}`;
  els.opomPreviewBody.innerHTML = opomRows.map((row) => {
    const adspower = row.ads_power_serial_number || row.ads_power_user_id || '';
    const matchStatus = row.ads_match_status || (adspower ? 'not_verified' : 'missing');
    const addressReady = isAddressReady(row);
    const cardReady = row.order_no && row.card_no && row.exp_month && row.exp_year && row.cvv;
    return `
      <tr>
        <td>${escapeHtml(row.opom_account_id || '-')}</td>
        <td>${escapeHtml(maskEmail(row.login_email || ''))}</td>
        <td>${opomHealthBadge(row)}</td>
        <td>${escapeHtml(adspower || '-')}</td>
        <td>${statusBadge(rowBadgeState(matchStatus, 'matched'))}${matchStatus !== 'matched' ? ` <span class="muted">${escapeHtml(matchStatus)}</span>` : ''}</td>
        <td>${escapeHtml(purchaseRuleLabel(row))}</td>
        <td>${escapeHtml(row.auto_topup_threshold || '-')}/${escapeHtml(row.auto_topup_amount || '-')}</td>
        <td>${statusBadge(addressReady ? 'completed' : 'missing_fields')}</td>
        <td>${statusBadge(cardReady ? 'completed' : 'missing_fields')} ${escapeHtml(cardNoLabel(row))}</td>
      </tr>
    `;
  }).join('');
  updateRunStats();
}

function opomDefaultsPayload() {
  return {
    amount: els.defaultAmount.value.trim(),
    balanceThreshold: els.defaultBalanceThreshold.value.trim(),
    amountBelowThreshold: els.defaultAmountBelow.value.trim(),
    amountAtOrAboveThreshold: els.defaultAmountAtOrAbove.value.trim(),
    autoTopupThreshold: els.defaultAutoTopupThreshold.value.trim(),
    autoTopupAmount: els.defaultAutoTopupAmount.value.trim(),
  };
}

async function addressCsvTextRequired() {
  const file = els.addressMappingCsv.files?.[0] || null;
  if (!file) throw new Error('请先上传 Billing address CSV');
  return file.text();
}

async function optionalAddressCsvText() {
  const file = els.addressMappingCsv.files?.[0] || null;
  return file ? file.text() : '';
}

const ADDRESS_FIELDS = ['postal_code', 'holder_name', 'country', 'address_line1', 'city', 'state'];

function addressMappingsFromCsv(text = '') {
  const parsed = parseCsv(text);
  if (parsed.length < 2) return [];
  const header = parsed[0].map((key) => String(key || '').trim());
  return parsed.slice(1).map((line) => {
    const source = rowObject(header, line);
    return {
      opom_account_id: valueFrom(source, ['opom_account_id', 'opomAccountId', 'account_id']),
      login_email: valueFrom(source, ['login_email', 'loginEmail', 'username', 'email']),
      postal_code: valueFrom(source, ['postal_code', 'postalCode', 'Zip', 'zip']),
      holder_name: valueFrom(source, ['holder_name', 'holderName', 'name', 'FirstName', 'firstName', 'first_name']),
      country: valueFrom(source, ['country']) || 'US',
      address_line1: valueFrom(source, ['address_line1', 'addressLine1', 'address', 'Street', 'street']),
      city: valueFrom(source, ['city', 'City']),
      state: valueFrom(source, ['state', 'State']),
    };
  }).filter((mapping) => mapping.opom_account_id || mapping.login_email || ADDRESS_FIELDS.some((field) => mapping[field]));
}

function applyAddressMappings(rows, mappings = []) {
  if (!mappings.length) return rows;
  const byAccountId = new Map();
  const byEmail = new Map();
  const sequentialMappings = [];
  for (const mapping of mappings) {
    if (mapping.opom_account_id) byAccountId.set(String(mapping.opom_account_id), mapping);
    if (mapping.login_email) byEmail.set(String(mapping.login_email).toLowerCase(), mapping);
    if (!mapping.opom_account_id && !mapping.login_email) sequentialMappings.push(mapping);
  }
  let sequentialIndex = 0;
  return rows.map((row) => {
    const mapping = byAccountId.get(String(row.opom_account_id || ''))
      || byEmail.get(String(row.login_email || '').toLowerCase())
      || sequentialMappings[sequentialIndex++];
    if (!mapping) return row;
    const next = {...row};
    for (const field of ADDRESS_FIELDS) {
      if (mapping[field]) next[field] = mapping[field];
    }
    return next;
  });
}

function selectorRowFromObject(source, index) {
  const loginEmail = valueFrom(source, ['login_email', 'loginEmail', 'email', 'username']);
  const serialNumber = valueFrom(source, [
    'ads_power_serial_number',
    'adsPowerSerialNumber',
    'serial_number',
    'serialNumber',
    'ID',
    'id',
    'ads_id',
    'adsId',
    'profile_no',
    'profileNo',
  ]);
  const userId = valueFrom(source, ['ads_power_user_id', 'adsPowerUserId', 'user_id', 'userId']);
  const opomAccountId = valueFrom(source, ['opom_account_id', 'opomAccountId', 'account_id']);
  if (!loginEmail && !serialNumber && !userId && !opomAccountId) return null;
  const defaults = opomDefaultsPayload();
  const identifier = opomAccountId || loginEmail || serialNumber || userId || `row-${index + 1}`;
  return {
    source: 'local_selector',
    status: '',
    opom_account_id: opomAccountId,
    login_email: loginEmail,
    ads_power_user_id: userId,
    ads_power_serial_number: serialNumber,
    ads_power_group_name: '',
    opom_health_status: opomAccountId ? 'ok' : 'local_selector',
    opom_health_reason: opomAccountId ? '' : 'selected from local CSV',
    ads_match_status: 'not_verified',
    order_no: '',
    card_no: '',
    exp_month: '',
    exp_year: '',
    cvv: '',
    amount: defaults.amount,
    postal_code: '',
    holder_name: '',
    country: '',
    address_line1: '',
    city: '',
    state: '',
    balance_threshold: defaults.balanceThreshold,
    amount_below_threshold: defaults.amountBelowThreshold,
    amount_at_or_above_threshold: defaults.amountAtOrAboveThreshold,
    auto_topup_threshold: defaults.autoTopupThreshold,
    auto_topup_amount: defaults.autoTopupAmount,
    idempotency_key: `local_selector:${String(identifier).trim().toLowerCase()}:${index + 1}`,
  };
}

function selectorRowsFromCsv(text, addressCsvText) {
  const parsed = parseCsv(text);
  if (!parsed.length) return [];
  const hasHeader = looksLikeAccountSelectorHeader(parsed[0]);
  const rows = hasHeader
    ? parsed.slice(1).map((line, index) => selectorRowFromObject(rowObject(parsed[0], line), index))
    : parsed.map((line, index) => {
      const identifier = String(line.find((value) => String(value || '').trim()) || '').trim();
      if (!identifier) return null;
      const source = identifier.includes('@')
        ? {login_email: identifier}
        : (/^\d+$/.test(identifier) ? {ads_power_serial_number: identifier} : {ads_power_user_id: identifier});
      return selectorRowFromObject(source, index);
    });
  const unique = [];
  const seen = new Set();
  for (const row of rows.filter(Boolean)) {
    const key = String(row.opom_account_id || row.login_email || row.ads_power_serial_number || row.ads_power_user_id || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return applyAddressMappings(unique, addressMappingsFromCsv(addressCsvText));
}

async function applyUploadedAddressCsvToRows() {
  if (!opomRows.length) return;
  const addressCsvText = await addressCsvTextRequired();
  opomRows = applyAddressMappings(opomRows, addressMappingsFromCsv(addressCsvText));
  selectedCsvText = canonicalCsvFromRows(opomRows);
  renderOpomPreview('address_applied');
}

function hasValue(value) {
  return String(value ?? '').trim() !== '';
}

function applyCurrentDefaultsToRows(rows) {
  const defaults = opomDefaultsPayload();
  return rows.map((row) => {
    const next = {...row};
    const overwriteDefaults = next.source === 'local_selector' || next.opom_health_status === 'local_selector';
    const fill = (key, value) => {
      if ((overwriteDefaults || !hasValue(next[key])) && hasValue(value)) next[key] = value;
    };
    fill('amount', defaults.amount);
    fill('balance_threshold', defaults.balanceThreshold);
    fill('amount_below_threshold', defaults.amountBelowThreshold);
    fill('amount_at_or_above_threshold', defaults.amountAtOrAboveThreshold);
    fill('auto_topup_threshold', defaults.autoTopupThreshold);
    fill('auto_topup_amount', defaults.autoTopupAmount);
    return next;
  });
}

function syncRowsWithCurrentDefaults() {
  if (!opomRows.length) return;
  opomRows = applyCurrentDefaultsToRows(opomRows);
  selectedCsvText = canonicalCsvFromRows(opomRows);
  renderOpomPreview('defaults_applied');
}

async function loadOpomReady() {
  return loadOpomPage({append: false});
}

async function loadMoreOpomRows() {
  if (!opomNextCursor) throw new Error('没有更多 OPOM 队列页');
  return loadOpomPage({append: true});
}

function mergeOpomRows(existing, incoming) {
  const seen = new Set();
  const output = [];
  for (const row of [...existing, ...incoming]) {
    const key = row.opom_account_id || row.login_email || `${row.ads_power_user_id}:${row.ads_power_serial_number}`;
    const normalized = String(key || '').trim().toLowerCase();
    if (normalized && seen.has(normalized)) continue;
    if (normalized) seen.add(normalized);
    output.push(row);
  }
  return output;
}

function syncOpomPagination() {
  els.opomLoadMore.disabled = !opomNextCursor;
}

async function loadOpomPage({append = false} = {}) {
  const group = els.opomGroup.value.trim() || 'recharge';
  const status = els.opomStatus.value || 'needs_recharge';
  const rawLimit = Number(els.opomLimit.value || 100);
  const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 100));
  els.opomLimit.value = String(limit);
  const addressCsvText = await optionalAddressCsvText();
  const data = await api('/api/opom/ready', {
    method: 'POST',
    body: JSON.stringify({
      group,
      status,
      limit,
      cursor: append ? opomNextCursor : '',
      defaults: opomDefaultsPayload(),
      addressCsvText,
    }),
  });
  selectedFile = {name: `opom-${group}.csv`};
  const incomingRows = data.rows || [];
  opomRows = append ? mergeOpomRows(opomRows, incomingRows) : incomingRows;
  opomNextCursor = data.nextCursor || '';
  selectedCsvText = canonicalCsvFromRows(opomRows);
  renderOpomPreview(append ? 'opom_page_appended' : 'opom_ready');
  invalidateDryRun(append
    ? `已追加 OPOM ${incomingRows.length} 行，累计 ${opomRows.length} 行，请重新 AdsPower 匹配。`
    : `已从 OPOM 拉取 ${data.count || 0} 行，请先执行 AdsPower 匹配。`);
  els.file.value = '';
  els.opomSummary.textContent = `group=${group} status=${status} rows=${opomRows.length} pageRows=${incomingRows.length} addressMaps=${data.addressMappingCount || 0}${opomNextCursor ? ' hasMore=true' : ''}`;
  els.dryRunSummary.textContent = `已生成 ${selectedFile.name}，请先 Match AdsPower；启动执行时会自动预检。`;
  syncOpomPagination();
}

async function matchAdsPower() {
  if (!opomRows.length) throw new Error('请先从 OPOM 拉取待充值账号，或上传账号选择 CSV');
  syncRowsWithCurrentDefaults();
  const needsOpomResolve = opomRows.some((row) => !row.opom_account_id && (
    row.login_email || row.ads_power_user_id || row.ads_power_serial_number
  ));
  let opomResolved = null;
  if (needsOpomResolve && sessionConfig.opomWritebackConfigured) {
    opomResolved = await api('/api/opom/resolve', {
      method: 'POST',
      body: JSON.stringify({rows: opomRows}),
    });
    opomRows = opomResolved.rows || opomRows;
    selectedCsvText = opomResolved.csvText || canonicalCsvFromRows(opomRows);
    renderOpomPreview('opom_resolve');
  }
  const data = await api('/api/adspower/match', {
    method: 'POST',
    body: JSON.stringify({
      rows: opomRows.map((row) => ({
        loginEmail: row.login_email,
        ads_power_user_id: row.ads_power_user_id,
        ads_power_serial_number: row.ads_power_serial_number,
      })),
      options: optionsPayload(),
    }),
  });
  for (const item of data.results || []) {
    if (!opomRows[item.index]) continue;
    opomRows[item.index].ads_match_status = item.status || 'failed';
    if (item.status !== 'matched') continue;
    opomRows[item.index].ads_power_user_id = item.profile?.userId || opomRows[item.index].ads_power_user_id || '';
    opomRows[item.index].ads_power_serial_number = item.profile?.serialNumber || opomRows[item.index].ads_power_serial_number || '';
    opomRows[item.index].ads_power_group_name = item.profile?.groupName || opomRows[item.index].ads_power_group_name || '';
  }
  selectedCsvText = canonicalCsvFromRows(opomRows);
  renderOpomPreview('adspower_match');
  invalidateDryRun(`AdsPower 匹配完成：matched=${data.matched || 0}, failed=${data.failed || 0}。启动执行时会自动预检。`);
  const opomResolveText = opomResolved
    ? ` OPOM resolved=${opomResolved.matched || 0}/${opomResolved.total || 0}`
    : '';
  els.opomSummary.textContent = `AdsPower matched=${data.matched || 0} failed=${data.failed || 0}${opomResolveText}`;
}

async function discoverAdsPowerStatusTargets() {
  const data = await api('/api/adspower/status-targets', {
    method: 'POST',
    body: JSON.stringify({options: optionsPayload()}),
  });
  lastAdsPowerTargets = data;
  renderAdsPowerTargets(data);
}

function renderAdsPowerTargets(data) {
  const targetLine = (role) => {
    const item = data.targets?.[role] || {};
    return `${role}: ${item.status || 'missing'}${item.groupId ? ` ${item.groupId}` : ''}${item.groupName ? ` ${item.groupName}` : ''}`;
  };
  const candidateLine = (role) => {
    const candidates = data.candidates?.[role] || [];
    return `${role} candidates: ${candidates.length ? candidates.map((item) => `${item.groupId} ${item.groupName}`).join('; ') : 'none'}`;
  };
  const lines = [
    `${data.ok ? 'OK' : 'WARN'} ${data.status || 'unknown'} base=${data.base || ''}`,
    targetLine('success'),
    targetLine('failure'),
    targetLine('blocker'),
    candidateLine('success'),
    candidateLine('failure'),
    candidateLine('blocker'),
  ];
  if (data.suggestedEnv?.length) lines.push(`suggested: ${data.suggestedEnv.join(' | ')}`);
  if (!els.adspowerTargetsSummary || !els.adspowerUseDiscoveredTargets || !els.adspowerStatusMode) return;
  els.adspowerTargetsSummary.innerHTML = lines.map((line) => escapeHtml(line)).join('<br>');
  els.adspowerTargetsSummary.classList.toggle('danger', !data.ok);
  els.adspowerUseDiscoveredTargets.disabled = els.adspowerStatusMode.value !== 'group_move'
    || !data.ok
    || !['success', 'failure', 'blocker'].some((role) => discoveredTargetValue(data, role));
}

function discoveredTargetValue(data, role) {
  return data.targets?.[role]?.groupId || data.candidates?.[role]?.[0]?.groupId || '';
}

async function useDiscoveredAdsPowerTargets() {
  if (!els.adspowerStatusMode || !els.adspowerSuccessGroupId || !els.adspowerFailureGroupId || !els.adspowerBlockerGroupId) {
    throw new Error('AdsPower 状态写入界面已隐藏');
  }
  if (els.adspowerStatusMode.value !== 'group_move') {
    throw new Error('Use discovered targets 仅适用于 group_move 模式');
  }
  if (!lastAdsPowerTargets?.ok) throw new Error('请先 Discover groups');
  const fields = {
    success: els.adspowerSuccessGroupId,
    failure: els.adspowerFailureGroupId,
    blocker: els.adspowerBlockerGroupId,
  };
  let filled = 0;
  for (const [role, input] of Object.entries(fields)) {
    const value = discoveredTargetValue(lastAdsPowerTargets, role);
    if (!value) continue;
    input.value = `id:${value}`;
    filled += 1;
  }
  if (!filled) throw new Error('没有可采用的 AdsPower 分组目标');
  invalidateDryRun(`已填入 ${filled} 个 AdsPower group_move 目标，启动执行时会自动预检。`);
  renderAdsPowerTargets(lastAdsPowerTargets);
}

async function allocateCards({createCards = false} = {}) {
  if (!opomRows.length) throw new Error('请先从 OPOM 拉取待充值账号，或上传账号选择 CSV');
  await applyUploadedAddressCsvToRows();
  syncRowsWithCurrentDefaults();
  const uploadedCardCsv = els.ejhSafeCsv.files?.[0] ? await els.ejhSafeCsv.files[0].text() : '';
  const body = {
    rows: opomRows,
    cardCsvText: uploadedCardCsv,
    defaults: opomDefaultsPayload(),
    createCards,
    confirmCreateCards: false,
    amount: els.ejhAmount.value.trim(),
    activeDate: els.ejhActiveDate.value,
    cardholder: els.ejhCardholder.value.trim(),
  };
  if (createCards) {
    const count = opomRows.filter((row) => row.ads_match_status === 'matched').length;
    if (!count) throw new Error('没有 AdsPower matched 行，不能真实 EJH 开卡');
    if (!body.amount || !body.activeDate || !body.cardholder) {
      throw new Error('真实 EJH 开卡需要填写 amount、active date、cardholder');
    }
    if (!window.confirm(`即将真实调用 EJH 开卡 ${count} 张，并输出安全开卡 CSV。未匹配行不会开卡。确认继续？`)) return;
    body.count = count;
    body.confirmCreateCards = true;
  } else if (!body.cardCsvText.trim()) {
    throw new Error('请先上传 EJH cards CSV，或使用 Create EJH cards');
  }
  const data = await api('/api/cards/allocate', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  opomRows = data.rows || [];
  selectedCsvText = data.csvText || canonicalCsvFromRows(opomRows);
  renderOpomPreview('card_allocated');
  if (!selectedFile) selectedFile = {name: 'opom-recharge.csv'};
  invalidateDryRun(`已分配卡 ${data.summary?.allocated || 0} 张，启动执行时会自动预检。`);
  const cardPath = data.cardCsvPath ? ` cardCsv=${data.cardCsvPath}` : '';
  els.opomSummary.textContent = `cards allocated=${data.summary?.allocated || 0} skipped=${data.summary?.skippedNotMatched || 0} rejected=${data.summary?.rejected || 0}${cardPath}`;
}

async function readSelectedFile() {
  const file = els.file.files?.[0] || null;
  selectedCsvText = '';
  opomNextCursor = '';
  opomRows = [];
  if (file) {
    const accountCsvText = await file.text();
    const addressFile = els.addressMappingCsv.files?.[0] || null;
    const addressCsvText = addressFile ? await addressFile.text() : '';
    const addressMappingCount = addressCsvText ? addressMappingsFromCsv(addressCsvText).length : 0;
    opomRows = selectorRowsFromCsv(accountCsvText, addressCsvText);
    if (!opomRows.length) {
      throw new Error('账号选择 CSV 至少需要 login_email/email/username、ads_power_serial_number/ID 或 ads_power_user_id');
    }
    selectedFile = {name: file.name};
    selectedCsvText = canonicalCsvFromRows(opomRows);
    els.opomSummary.textContent = `local selector rows=${opomRows.length} source=${selectedFile.name} addressMaps=${addressMappingCount}`;
  } else {
    selectedFile = null;
    els.opomSummary.textContent = '未从 OPOM 拉取。';
  }
  renderOpomPreview(file ? 'local_selector' : '');
  syncOpomPagination();
  invalidateDryRun(selectedFile ? `已从账号选择 CSV 载入 ${opomRows.length} 行，请先 Match AdsPower。` : '先选择账号选择 CSV，或从 OPOM 拉取。');
  els.dryRunSummary.textContent = selectedFile ? `已生成 ${selectedFile.name} 的内部执行 CSV，请先 Match AdsPower；启动执行时会自动预检。` : '先选择账号选择 CSV，或从 OPOM 拉取。';
  updateRunStats();
}

async function withButtonBusy(button, label, task) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await task();
  } finally {
    button.textContent = originalText;
    button.disabled = false;
    syncOpomPagination();
    if (button === els.liveRun) {
      syncExecutionAvailability();
    }
  }
}

async function runDryRun() {
  if (!selectedFile) await readSelectedFile();
  await applyUploadedAddressCsvToRows();
  syncRowsWithCurrentDefaults();
  if (!selectedCsvText.trim()) throw new Error('请选择账号选择 CSV，或从 OPOM 拉取');
  if (selectedScopeLabels().length === 0) throw new Error('请至少选择一个执行范围');
  syncExecutionCopy();
  lastDryRun = await api('/api/jobs/dry-run', {
    method: 'POST',
    body: JSON.stringify({
      fileName: selectedFile.name,
      csvText: selectedCsvText,
      options: optionsPayload(),
    }),
  });
  clearError();
  dryRunSignature = currentSignature();
  liveConfirmationToken = lastDryRun.liveConfirmationToken || '';
  els.dryRunSummary.innerHTML = [
    `scope: ${selectedScopeLabels().join(' / ')}`,
    `planned: ${lastDryRun.planned}`,
    `ready: ${lastDryRun.ready}`,
    `blocked: ${lastDryRun.blocked}`,
    `skipped: ${lastDryRun.skipped}`,
  ].map(escapeHtml).join(' | ');
  if (lastDryRun.ready < 1 || !liveConfirmationToken) {
    els.confirmLive.checked = false;
  }
  els.confirmationState.textContent = liveConfirmationToken
    ? `预检通过，确认 token 有效至 ${lastDryRun.liveConfirmationExpiresAt}`
    : '没有可执行行';
  syncExecutionAvailability();
  updateRunStats();
}

async function createLiveJob() {
  if (!selectedCsvText.trim()) throw new Error('请选择账号选择 CSV，或从 OPOM 拉取');
  const mode = executionMode();
  if (!els.confirmLive.checked) throw new Error(mode.requireText);
  if (!lastDryRun || dryRunSignature !== currentSignature()) {
    els.confirmationState.textContent = '正在自动预检...';
    await runDryRun();
  }
  if (dryRunSignature !== currentSignature()) throw new Error('CSV 或选项已变化，请重新预检');
  if (!lastDryRun || lastDryRun.ready < 1 || !liveConfirmationToken) {
    throw new Error(`预检未通过：ready=${lastDryRun?.ready || 0} blocked=${lastDryRun?.blocked || 0}`);
  }
  if (!els.confirmLive.checked) throw new Error(mode.requireText);
  const scopeText = selectedScopeLabels().join(' / ');
  const actionText = `${mode.action}，执行范围：${scopeText}。确认继续？`;
  if (!window.confirm(actionText)) return;
  const data = await api('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      fileName: selectedFile.name,
      csvText: selectedCsvText,
      options: optionsPayload(),
      liveConfirmationToken,
    }),
  });
  selectedJobId = data.job.id;
  jobsPage = 1;
  clearError();
  await refreshAll();
}

async function refreshAll() {
  const data = await api('/api/jobs');
  clearError();
  const current = data.worker?.current;
  const currentRows = data.worker?.currentRows || [];
  els.worker.textContent = data.worker?.running
    ? `Worker: running ${currentRows.length || 1} row${(currentRows.length || 1) > 1 ? 's' : ''} row=${current?.rowNumber || '-'} profile=${current?.profileId || '-'} stage=${current?.stage || '-'} elapsed=${formatDuration(current?.elapsedMs)}`
    : 'Worker: idle';
  renderJobs(data.jobs || []);
  if (selectedJobId) await loadJob(selectedJobId);
}

function renderJobs(jobs) {
  lastJobs = Array.isArray(jobs) ? jobs : [];
  const totalPages = Math.max(1, Math.ceil(lastJobs.length / JOBS_PAGE_SIZE));
  jobsPage = Math.min(Math.max(1, jobsPage), totalPages);
  const start = (jobsPage - 1) * JOBS_PAGE_SIZE;
  const pageJobs = lastJobs.slice(start, start + JOBS_PAGE_SIZE);
  els.jobsBody.innerHTML = pageJobs.map((job) => `
    <tr data-job-id="${escapeHtml(job.id)}" class="${job.id === selectedJobId ? 'selected' : ''}" tabindex="0" role="button" aria-selected="${job.id === selectedJobId ? 'true' : 'false'}">
      <td>${escapeHtml(job.fileName)}<br><span class="muted">${escapeHtml(job.id)}</span></td>
      <td>${statusBadge(job.status)}</td>
      <td>${job.totalRows}</td>
      <td>${job.completedRows}</td>
      <td>${job.failedRows}</td>
      <td>${job.blockedRows}</td>
      <td>${escapeHtml(formatChinaTime(job.createdAt))}</td>
    </tr>
  `).join('');
  if (els.jobsPageInfo) {
    const rangeStart = lastJobs.length ? start + 1 : 0;
    const rangeEnd = Math.min(start + JOBS_PAGE_SIZE, lastJobs.length);
    els.jobsPageInfo.textContent = `第 ${jobsPage} / ${totalPages} 页 · ${rangeStart}-${rangeEnd} / ${lastJobs.length}`;
  }
  if (els.jobsPrevPage) els.jobsPrevPage.disabled = jobsPage <= 1;
  if (els.jobsNextPage) els.jobsNextPage.disabled = jobsPage >= totalPages;
  for (const row of els.jobsBody.querySelectorAll('tr[data-job-id]')) {
    const select = () => {
      selectedJobId = row.dataset.jobId;
      loadJob(selectedJobId).catch(showError);
      refreshAll().catch(showError);
    };
    row.addEventListener('click', select);
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      select();
    });
  }
}

function setJobsPage(page) {
  jobsPage = page;
  renderJobs(lastJobs);
}

async function loadJob(jobId) {
  const seq = ++loadSequence;
  const data = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (seq !== loadSequence) return;
  renderJobDetail(data.job, data.rows || [], data.events || []);
}

function renderJobDetail(job, rows, events = []) {
  if (!job) return;
  const running = rows.find((row) => row.status === 'running');
  els.jobMeta.innerHTML = `
    ${statusBadge(job.status)}
    <span>总数 ${job.totalRows}</span>
    <span>完成 ${job.completedRows}</span>
    <span>失败 ${job.failedRows}</span>
    <span>阻塞 ${job.blockedRows}</span>
    ${running ? `<span>当前行 ${escapeHtml(running.rowNumber)} / ${escapeHtml(running.stage)}</span>` : ''}
    <span class="muted">${escapeHtml(job.id)}</span>
  `;
  els.cancel.disabled = !['queued', 'running'].includes(job.status);
  els.download.disabled = !job.resultCsvReady;
  els.download.classList.toggle('disabled', !job.resultCsvReady);
  els.download.setAttribute('aria-disabled', job.resultCsvReady ? 'false' : 'true');
  els.cancel.textContent = job.status === 'running' ? '请求停止后续行' : '取消排队任务';
  els.rowsBody.innerHTML = rows.map((row) => `
    <tr>
      <td>${row.rowNumber}</td>
      <td>${escapeHtml(row.profileId)}</td>
      <td>${escapeHtml(row.loginEmail || row.username)}</td>
      <td>${statusBadge(row.status)}</td>
      <td>${escapeHtml(row.stage)}</td>
      <td>${escapeHtml(row.purchaseAmount || row.amount || '')}</td>
      <td>${escapeHtml(row.balanceBefore)} → ${escapeHtml(row.balanceAfter)}</td>
      <td>${escapeHtml(row.autoTopupStatus)} ${escapeHtml(row.autoTopupThreshold)}/${escapeHtml(row.autoTopupAmount)}</td>
      <td>${escapeHtml(cardNoLabel(row))}</td>
      <td>${escapeHtml(formatChinaTime(row.updatedAt))}</td>
      <td class="message">${escapeHtml(sanitizeMessage(row.message || (row.missing || []).join(',')))}</td>
    </tr>
  `).join('');
  renderEvents(events);
}

function renderEvents(events) {
  const recent = [...events].slice(-80).reverse();
  els.eventsBody.innerHTML = recent.length
    ? recent.map((event) => `
      <div class="event-line">
        <span>${escapeHtml(formatChinaTime(event.createdAt))}</span>
        <strong>${escapeHtml(event.type || '')}</strong>
        <span>${escapeHtml(sanitizeMessage(event.message || ''))}</span>
      </div>
    `).join('')
    : '暂无事件。';
}

async function cancelSelectedJob() {
  if (!selectedJobId) return;
  if (!window.confirm('取消不会中断当前正在执行的浏览器步骤，只会停止后续排队行。确认？')) return;
  await api(`/api/jobs/${encodeURIComponent(selectedJobId)}/cancel`, {method: 'POST', body: '{}'});
  await refreshAll();
}

function showError(error) {
  els.alert.hidden = false;
  els.alert.textContent = sanitizeMessage(error.message);
  els.dryRunSummary.textContent = sanitizeMessage(error.message);
}

function clearError() {
  els.alert.hidden = true;
  els.alert.textContent = '';
}

async function refreshPreflight() {
  const data = await api('/api/preflight');
  els.preflight.innerHTML = data.checks.map((check) => {
    const mark = check.ok ? 'OK' : 'WARN';
    return `${escapeHtml(mark)} ${escapeHtml(check.label)}: ${escapeHtml(check.status)}`;
  }).join('<br>');
  if (!data.ok) els.preflight.classList.add('danger');
}

async function downloadSelectedResult(event) {
  event.preventDefault();
  if (!selectedJobId || els.download.disabled || els.download.classList.contains('disabled')) return;
  const url = `/api/jobs/${encodeURIComponent(selectedJobId)}/result.csv`;
  const res = await fetch(url, {headers: {'X-Runner-Session': sessionToken}});
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `${selectedJobId}.result.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

els.file.addEventListener('change', () => readSelectedFile().catch(showError));
els.opomReady.addEventListener('click', () => withButtonBusy(els.opomReady, 'Loading...', loadOpomReady).catch(showError));
els.opomLoadMore.addEventListener('click', () => withButtonBusy(els.opomLoadMore, 'Loading...', loadMoreOpomRows).catch(showError));
els.adsPowerMatch.addEventListener('click', () => withButtonBusy(els.adsPowerMatch, 'Matching...', matchAdsPower).catch(showError));
els.adspowerDiscoverTargets?.addEventListener('click', () => withButtonBusy(els.adspowerDiscoverTargets, 'Discovering...', discoverAdsPowerStatusTargets).catch(showError));
els.adspowerUseDiscoveredTargets?.addEventListener('click', () => useDiscoveredAdsPowerTargets().catch(showError));
els.opomWriteback.addEventListener('change', () => invalidateDryRun());
els.addressMappingCsv.addEventListener('change', () => {
  applyUploadedAddressCsvToRows()
    .then(() => invalidateDryRun('Billing address CSV 已变化，启动执行时会重新预检。'))
    .catch(showError);
});
els.allocateCards.addEventListener('click', () => withButtonBusy(els.allocateCards, 'Allocating...', () => allocateCards()).catch(showError));
els.createCards.addEventListener('click', () => withButtonBusy(els.createCards, 'Creating...', () => allocateCards({createCards: true})).catch(showError));
els.removeExisting.addEventListener('change', () => invalidateDryRun());
els.stopProfiles.addEventListener('change', () => invalidateDryRun());
els.concurrency.addEventListener('input', () => invalidateDryRun('并发数量已变化，启动执行时会重新预检。'));
els.adspowerStatusMode?.addEventListener('change', () => {
  els.adspowerUseDiscoveredTargets.disabled = true;
  invalidateDryRun();
});
for (const input of [els.adspowerSuccessGroupId, els.adspowerFailureGroupId, els.adspowerBlockerGroupId]) {
  input?.addEventListener('input', () => invalidateDryRun());
}
for (const input of [
  els.defaultAmount,
  els.defaultBalanceThreshold,
  els.defaultAmountBelow,
  els.defaultAmountAtOrAbove,
  els.defaultAutoTopupThreshold,
  els.defaultAutoTopupAmount,
]) {
  input.addEventListener('input', () => {
    syncRowsWithCurrentDefaults();
    invalidateDryRun('规则已变化，请重新 Match AdsPower；启动执行时会重新预检。');
  });
}
els.noPurchaseMode.addEventListener('change', () => {
  syncScopeControls();
  invalidateDryRun();
});
for (const checkbox of [els.scopeBillingAddress, els.scopePaymentMethod, els.scopePurchase, els.scopeAutoTopup]) {
  checkbox.addEventListener('change', () => {
    syncScopeControls();
    invalidateDryRun();
  });
}
els.confirmLive.addEventListener('change', () => {
  syncExecutionAvailability();
});
els.liveRun.addEventListener('click', () => withButtonBusy(els.liveRun, 'Starting...', createLiveJob).catch(showError));
els.refresh.addEventListener('click', () => withButtonBusy(els.refresh, 'Refreshing...', refreshAll).catch(showError));
els.jobsPrevPage?.addEventListener('click', () => setJobsPage(jobsPage - 1));
els.jobsNextPage?.addEventListener('click', () => setJobsPage(jobsPage + 1));
els.cancel.addEventListener('click', () => cancelSelectedJob().catch(showError));
els.download.addEventListener('click', (event) => downloadSelectedResult(event).catch(showError));

initSession()
  .then(async () => {
    syncScopeControls();
    await refreshPreflight();
    await refreshAll();
    setInterval(() => refreshAll().catch(showError), 3000);
  })
  .catch(showError);
