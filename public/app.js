(() => {
  'use strict';

  const RUNTIME_CONFIG_KEY = 'autoPurchaseRuntimeConfigV1';
  const UI_PREFS_KEY = 'autoPurchaseUiPrefsV1';
  const HEALTHY_OPOM = new Set(['', 'ok', 'local_selector', 'completed']);
  const CANONICAL_HEADER = [
    'status',
    'opom_account_id',
    'login_email',
    'ads_power_user_id',
    'ads_power_serial_number',
    'ads_power_group_name',
    'opom_account_status',
    'opom_health_status',
    'opom_health_reason',
    'opom_card_status',
    'ads_match_status',
    'order_no',
    'card_no',
    'card_provider',
    'card_type',
    'expires_at',
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

  const CONFIG_FIELDS = [
    'adspowerApiBase',
    'adspowerApiKey',
    'adspowerStartTimeoutMs',
    'opomBaseUrl',
    'opomRechargeToken',
    'opomSecondaryBaseUrl',
    'opomSecondaryRechargeToken',
    'opomRequestTimeoutMs',
    'opomRequestRetries',
    'opomWritebackRetries',
    'opomRetryDelayMs',
    'rowTimeoutMs',
  ];

  const el = Object.fromEntries(
    [...document.querySelectorAll('[id]')].map((node) => [node.id, node]),
  );

  const state = {
    source: 'csv',
    rows: [],
    fileName: '',
    sessionToken: '',
    sessionConfig: {},
    jobs: [],
    worker: {},
    scheduler: {},
    refreshTimer: 0,
    opomConfirmed: false,
    lastDryRun: null,
    dryRunSignature: '',
    liveConfirmationToken: '',
    pendingWindow: null,
    pendingWindowBlocked: false,
    creatingJob: false,
    cardAllocationSignature: '',
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function sanitizeMessage(value) {
    return String(value ?? '')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/\b(cvv|cvc)\s*[:=]\s*\d{3,4}\b/gi, '$1=[redacted]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[account]')
      .slice(0, 600);
  }

  function showError(error) {
    el.errorText.textContent = sanitizeMessage(error?.message || error || '操作失败');
    el.errorNotice.hidden = false;
  }

  function clearError() {
    el.errorNotice.hidden = true;
    el.errorText.textContent = '';
  }

  async function requestJson(path, {method = 'GET', body, headers = {}} = {}) {
    const response = await fetch(path, {
      method,
      headers: {
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
        ...(state.sessionToken ? {'X-Runner-Session': state.sessionToken} : {}),
        ...headers,
      },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function initSession() {
    const response = await fetch('/api/session');
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.token) throw new Error(data.error || '无法初始化本地会话');
    state.sessionToken = data.token;
    state.sessionConfig = data.integrations || {};
    renderConnectionSummary();
  }

  function numericValue(input, fallback = 0) {
    const value = Number(input.value);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  function clampInteger(input, minimum, maximum, fallback) {
    const value = Math.floor(Number(input.value));
    const normalized = Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
    input.value = String(normalized);
    return normalized;
  }

  function ruleValues() {
    return {
      threshold: numericValue(el.balanceThreshold, 145),
      below: numericValue(el.amountBelow, 150),
      atOrAbove: numericValue(el.amountAtOrAbove, 20),
    };
  }

  function ruleText() {
    const rule = ruleValues();
    return `${rule.threshold}/${rule.below}/${rule.atOrAbove}`;
  }

  function autoTopupText() {
    if (el.autoTopupEnableOnly.checked) return '仅开启';
    return `${numericValue(el.autoTopupThreshold, 100)}/${numericValue(el.autoTopupAmount, 150)}`;
  }

  function runtimeConfig() {
    return Object.fromEntries(CONFIG_FIELDS.map((key) => [key, String(el[key]?.value || '').trim()]));
  }

  function opomStatusForRequest() {
    const status = String(el.opomStatus.value || '').trim();
    return status === 'card_switch&overdue' ? 'needs_recharge' : (status || 'needs_recharge');
  }

  function loadRuntimeConfig() {
    let saved = {};
    let exists = false;
    try {
      const raw = localStorage.getItem(RUNTIME_CONFIG_KEY);
      exists = Boolean(raw);
      saved = JSON.parse(raw || '{}');
    } catch {
      saved = {};
    }
    const defaults = {
      adspowerApiBase: 'http://127.0.0.1:50325',
      opomBaseUrl: 'http://20.2.209.2',
    };
    for (const key of CONFIG_FIELDS) {
      if (el[key]) el[key].value = saved[key] ?? defaults[key] ?? '';
    }
    el.settingsState.textContent = exists ? '已读取当前浏览器保存的配置。' : '尚未保存本地配置。';
    renderConnectionSummary();
  }

  function saveRuntimeConfig() {
    localStorage.setItem(RUNTIME_CONFIG_KEY, JSON.stringify(runtimeConfig()));
    el.settingsState.textContent = '已保存到当前浏览器。';
    renderConnectionSummary();
    invalidatePreparation();
  }

  function clearRuntimeConfig() {
    if (!window.confirm('清空当前浏览器保存的连接配置？')) return;
    localStorage.removeItem(RUNTIME_CONFIG_KEY);
    loadRuntimeConfig();
    el.settingsState.textContent = '配置已清空。';
    invalidatePreparation();
  }

  function opomConfigured() {
    const config = runtimeConfig();
    return Boolean(
      (config.opomBaseUrl && config.opomRechargeToken)
      || state.sessionConfig.opomWritebackConfigured,
    );
  }

  function adsPowerConfigured() {
    const config = runtimeConfig();
    return Boolean(config.adspowerApiBase && config.adspowerApiKey);
  }

  function renderConnectionSummary() {
    if (!el.connectionSummary) return;
    const config = runtimeConfig();
    const adsState = config.adspowerApiKey ? 'AdsPower 已配置' : 'AdsPower 缺少 API Key';
    const opomState = opomConfigured() ? 'OPOM 已配置' : 'OPOM 未配置';
    el.connectionSummary.textContent = `${adsState} · ${opomState} · 配置仅保存在当前浏览器`;
  }

  function readUiPrefs() {
    try {
      return JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function setHighContrast(enabled) {
    document.body.classList.toggle('high-contrast', enabled);
    el.contrastButton.setAttribute('aria-pressed', String(enabled));
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({...readUiPrefs(), highContrast: enabled}));
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const source = String(text || '').replace(/^\uFEFF/, '');
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (quoted) {
        if (char === '"' && source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          cell += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ',') {
        row.push(cell);
        cell = '';
      } else if (char === '\n') {
        row.push(cell.replace(/\r$/, ''));
        if (row.some((value) => String(value).trim())) rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += char;
      }
    }
    row.push(cell.replace(/\r$/, ''));
    if (row.some((value) => String(value).trim())) rows.push(row);
    return rows;
  }

  function csvEscape(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function looseKey(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function valueFrom(source, aliases) {
    const direct = aliases.map((key) => String(source[key] ?? '').trim()).find(Boolean);
    if (direct) return direct;
    const wanted = new Set(aliases.map(looseKey));
    for (const [key, value] of Object.entries(source)) {
      if (!wanted.has(looseKey(key))) continue;
      const normalized = String(value ?? '').trim();
      if (normalized) return normalized;
    }
    return '';
  }

  function objectFromRow(header, row) {
    return Object.fromEntries(header.map((key, index) => [String(key || '').trim(), row[index] ?? '']));
  }

  function hasSelectorHeader(row) {
    const keys = new Set(row.map(looseKey));
    return [
      'loginemail',
      'email',
      'username',
      'adspowerserialnumber',
      'serialnumber',
      'id',
      'adspoweruserid',
      'adspowerid',
      'opomaccountid',
    ].some((key) => keys.has(key));
  }

  function noHeaderObject(row) {
    const values = row.map((value) => String(value || '').trim()).filter(Boolean);
    const email = values.find((value) => value.includes('@')) || '';
    const serial = values.find((value) => /^\d+$/.test(value)) || '';
    const userId = values.find((value) => !value.includes('@') && !/^\d+$/.test(value)) || '';
    return {
      login_email: email,
      ads_power_serial_number: serial,
      ads_power_user_id: userId,
    };
  }

  function normalizeSourceRow(source, index, sourceName) {
    const rawId = valueFrom(source, ['ID', 'id', 'ads_id', 'adsId']);
    const explicitSerial = valueFrom(source, [
      'ads_power_serial_number',
      'adsPowerSerialNumber',
      'serial_number',
      'serialNumber',
      'profile_no',
      'profileNo',
    ]);
    const explicitUserId = valueFrom(source, [
      'ads_power_user_id',
      'adsPowerUserId',
      'adsPowerId',
      'ads_power_id',
      'adspower_id',
      'user_id',
      'userId',
    ]);
    const serialNumber = explicitSerial || (/^\d+$/.test(rawId) ? rawId : '');
    const userId = explicitUserId || (rawId && !/^\d+$/.test(rawId) ? rawId : '');
    const loginEmail = valueFrom(source, ['login_email', 'loginEmail', 'email', 'username']);
    const opomId = valueFrom(source, ['opom_account_id', 'opomAccountId', 'account_id']);
    if (!loginEmail && !serialNumber && !userId && !opomId) return null;

    const normalized = Object.fromEntries(CANONICAL_HEADER.map((key) => [key, '']));
    Object.assign(normalized, {
      status: valueFrom(source, ['status']),
      opom_account_id: opomId,
      login_email: loginEmail,
      ads_power_user_id: userId,
      ads_power_serial_number: serialNumber,
      ads_power_group_name: valueFrom(source, ['ads_power_group_name', 'group_name']),
      opom_account_status: valueFrom(source, ['opom_account_status', 'account_status']),
      opom_health_status: valueFrom(source, ['opom_health_status']) || (opomId ? 'ok' : 'local_selector'),
      opom_health_reason: valueFrom(source, ['opom_health_reason']),
      opom_card_status: valueFrom(source, ['opom_card_status', 'card_status', 'bank_card_status']),
      ads_match_status: valueFrom(source, ['ads_match_status']) || 'not_verified',
      order_no: valueFrom(source, ['order_no', 'ejh_order_no']),
      card_no: valueFrom(source, ['card_no', 'card_number', 'cardno']),
      card_provider: valueFrom(source, ['card_provider']),
      card_type: valueFrom(source, ['card_type']),
      expires_at: valueFrom(source, ['expires_at', 'validityDate', 'expiry']),
      exp_month: valueFrom(source, ['exp_month']),
      exp_year: valueFrom(source, ['exp_year']),
      cvv: valueFrom(source, ['cvv', 'cvc']),
      postal_code: valueFrom(source, ['postal_code', 'postalCode', 'zip']),
      holder_name: valueFrom(source, ['holder_name', 'holderName']),
      country: valueFrom(source, ['country']),
      address_line1: valueFrom(source, ['address_line1', 'addressLine1', 'address']),
      city: valueFrom(source, ['city']),
      state: valueFrom(source, ['state']),
      auto_topup_threshold: valueFrom(source, ['auto_topup_threshold']),
      auto_topup_amount: valueFrom(source, ['auto_topup_amount']),
      idempotency_key: valueFrom(source, ['idempotency_key'])
        || `${sourceName}:${String(opomId || loginEmail || userId || serialNumber).toLowerCase()}:${index + 1}`,
      execute: source.execute !== false,
      source: sourceName,
    });
    return normalized;
  }

  function rowsFromCsv(text) {
    const parsed = parseCsv(text);
    if (!parsed.length) return [];
    const headerPresent = hasSelectorHeader(parsed[0]);
    const sourceRows = headerPresent
      ? parsed.slice(1).map((row) => objectFromRow(parsed[0], row))
      : parsed.map(noHeaderObject);
    const unique = [];
    const seen = new Set();
    sourceRows.forEach((source, index) => {
      const row = normalizeSourceRow(source, index, 'local_selector');
      if (!row) return;
      const identity = row.opom_account_id || row.login_email || row.ads_power_user_id || row.ads_power_serial_number;
      const key = String(identity || '').trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      unique.push(row);
    });
    return unique;
  }

  function assertValidSelectorEmails(rows) {
    const invalidRows = rows
      .map((row, index) => ({index: index + 1, email: String(row.login_email || '').trim()}))
      .filter((row) => row.email && !/^[^\s@]+@[^\s@]+$/.test(row.email));
    if (!invalidRows.length) return;
    const preview = invalidRows.slice(0, 10).map((row) => row.index).join('、');
    const suffix = invalidRows.length > 10 ? ' 等' : '';
    throw new Error(`账号 CSV 邮箱格式不正确：第 ${preview}${suffix} 行`);
  }

  function normalizeApiRows(rows, sourceName) {
    return (Array.isArray(rows) ? rows : [])
      .map((row, index) => normalizeSourceRow(row, index, sourceName))
      .filter(Boolean);
  }

  const OREGON_ADDRESSES = [
    ['Avery Stone', '451 NW Everett St', 'Portland', '97209'],
    ['Mila Carter', '1275 Oak St', 'Eugene', '97401'],
    ['Ethan Brooks', '820 Liberty St SE', 'Salem', '97301'],
    ['Nora Bennett', '1415 NE 3rd St', 'Bend', '97701'],
    ['Leo Foster', '310 SW 4th Ave', 'Corvallis', '97333'],
    ['Clara Hayes', '625 Marine Dr', 'Astoria', '97103'],
    ['Owen Reed', '940 SE Cass Ave', 'Roseburg', '97470'],
    ['Ivy Collins', '215 E Main St', 'Ashland', '97520'],
    ['Miles Turner', '730 Biddle Rd', 'Medford', '97504'],
    ['Ruby Walker', '1180 Pacific Ave', 'Forest Grove', '97116'],
  ];

  function applyAddresses(rows) {
    return rows.map((row, index) => {
      const [holder, line1, city, zip] = OREGON_ADDRESSES[index % OREGON_ADDRESSES.length];
      const cycle = Math.floor(index / OREGON_ADDRESSES.length);
      const addressLine = cycle ? `${line1} Apt ${cycle + 1}` : line1;
      return {
        ...row,
        holder_name: holder,
        address_line1: addressLine,
        city,
        state: 'OR',
        postal_code: zip,
        country: 'US',
      };
    });
  }

  function applyCurrentRules(rows = state.rows) {
    const rule = ruleValues();
    const onlyEnable = el.autoTopupEnableOnly.checked;
    const topupThreshold = String(numericValue(el.autoTopupThreshold, 100));
    const topupAmount = String(numericValue(el.autoTopupAmount, 150));
    return rows.map((row) => ({
      ...row,
      amount: '',
      balance_threshold: String(rule.threshold),
      amount_below_threshold: String(rule.below),
      amount_at_or_above_threshold: String(rule.atOrAbove),
      ...(!onlyEnable ? {
        auto_topup_threshold: topupThreshold,
        auto_topup_amount: topupAmount,
      } : {}),
    }));
  }

  function selectedRows() {
    return state.rows.filter((row) => row.execute !== false);
  }

  function canonicalCsv(rows = selectedRows()) {
    const normalized = applyCurrentRules(rows);
    const lines = [
      CANONICAL_HEADER,
      ...normalized.map((row) => CANONICAL_HEADER.map((key) => row[key] ?? '')),
    ];
    return `${lines.map((line) => line.map(csvEscape).join(',')).join('\r\n')}\r\n`;
  }

  function rowKeys(row) {
    return [
      row.opom_account_id,
      row.login_email,
      row.ads_power_user_id,
      row.ads_power_serial_number,
    ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  }

  function mergeRows(current, updates) {
    const byKey = new Map();
    for (const update of updates || []) {
      for (const key of rowKeys(update)) byKey.set(key, update);
    }
    return current.map((row) => {
      const match = rowKeys(row).map((key) => byKey.get(key)).find(Boolean);
      return match ? {...row, ...match, execute: row.execute !== false} : row;
    });
  }

  function cardLast4(row) {
    return String(row.card_no || '').replace(/\D/g, '').slice(-4);
  }

  function addressReady(row) {
    return ['holder_name', 'country', 'postal_code', 'address_line1', 'city', 'state']
      .every((key) => String(row[key] || '').trim());
  }

  function healthOk(row) {
    return HEALTHY_OPOM.has(String(row.opom_health_status || '').trim().toLowerCase());
  }

  function matchOk(row) {
    if (el.skipMatch.checked) return Boolean(row.ads_power_user_id || row.ads_power_serial_number);
    return row.ads_match_status === 'matched';
  }

  function rowReady(row) {
    return Boolean(
      row.login_email
      && (row.ads_power_user_id || row.ads_power_serial_number)
      && healthOk(row)
      && matchOk(row),
    );
  }

  function rowBlockReason(row) {
    const reasons = [];
    if (!row.login_email) reasons.push('缺少账号');
    if (!row.ads_power_user_id && !row.ads_power_serial_number) reasons.push('缺少 AdsPower');
    if (!healthOk(row)) reasons.push(row.opom_health_reason || row.opom_health_status || 'OPOM 异常');
    if (!el.skipMatch.checked && row.ads_match_status !== 'matched') reasons.push('Ads 匹配未完成');
    if (row.opom_card_status && !/^(active|激活|1)$/i.test(row.opom_card_status)) {
      reasons.push(`卡状态 ${row.opom_card_status}，执行时跳过`);
    }
    return reasons.join(' · ');
  }

  function pill(kind, text) {
    return `<span class="pill ${kind}">${escapeHtml(text)}</span>`;
  }

  function renderRows() {
    const rows = state.rows;
    if (!rows.length) {
      el.matchBody.innerHTML = '<tr><td class="empty-row" colspan="11">选择账号来源后开始准备</td></tr>';
      el.detailTitle.textContent = state.source === 'opom' && !state.opomConfirmed
        ? '等待确认 OPOM 参数'
        : '等待导入账号';
      renderCounts();
      return;
    }

    el.detailTitle.textContent = `${rows.length} 个账号 · ${state.source === 'opom' ? 'OPOM' : state.fileName || 'CSV'}`;
    el.matchBody.innerHTML = rows.map((row, index) => {
      const ready = rowReady(row);
      const health = healthOk(row)
        ? pill('ok', row.opom_health_status || 'ok')
        : pill('error', row.opom_health_status || 'error');
      const match = el.skipMatch.checked
        ? pill('warning', '人工确认')
        : ready
          ? pill('ok', '成功')
          : pill('error', '报错');
      const billing = addressReady(row) ? pill('ok', 'OR · 就绪') : pill('error', '缺失');
      const last4 = cardLast4(row);
      const card = el.cardFile.files?.length
        ? (last4 ? pill('ok', `已分配 ••••${last4}`) : pill('warning', '待分配'))
        : pill('neutral', '不替换');
      return `
        <tr>
          <td>
            <label class="row-check-target">
              <input class="row-check" type="checkbox" data-index="${index}" aria-label="选择 ${escapeHtml(row.login_email || `第 ${index + 1} 行`)}" ${row.execute !== false ? 'checked' : ''}>
            </label>
          </td>
          <td title="${escapeHtml(row.login_email)}"><strong>${escapeHtml(row.login_email || '—')}</strong></td>
          <td>${health}</td>
          <td>${escapeHtml(row.ads_power_serial_number || '—')}</td>
          <td>${escapeHtml(row.ads_power_user_id || '—')}</td>
          <td>${match}</td>
          <td>${escapeHtml(ruleText())}</td>
          <td>${escapeHtml(autoTopupText())}</td>
          <td>${billing}</td>
          <td>${card}</td>
          <td title="${escapeHtml(rowBlockReason(row))}">${escapeHtml(rowBlockReason(row) || '—')}</td>
        </tr>
      `;
    }).join('');

    for (const checkbox of el.matchBody.querySelectorAll('.row-check')) {
      checkbox.addEventListener('change', () => {
        const row = state.rows[Number(checkbox.dataset.index)];
        if (row) row.execute = checkbox.checked;
        state.cardAllocationSignature = '';
        invalidatePreparation();
        renderCounts();
      });
    }
    renderCounts();
  }

  function renderCounts() {
    const ready = state.rows.filter(rowReady).length;
    const selected = selectedRows().length;
    const blocked = state.rows.length - ready;
    el.readyCount.textContent = String(ready);
    el.selectedCount.textContent = String(selected);
    el.blockedCount.textContent = String(blocked);
    el.startButton.disabled = !canStart();
    el.matchButton.disabled = !state.rows.length || el.skipMatch.checked;
    el.matchButton.textContent = el.skipMatch.checked ? '已跳过匹配' : '匹配 AdsPower';
  }

  function canStart() {
    if (!selectedRows().length) return false;
    if (el.skipMatch.checked) {
      return selectedRows().some((row) => row.ads_power_user_id || row.ads_power_serial_number);
    }
    return selectedRows().some((row) => row.ads_match_status === 'matched');
  }

  function renderControls() {
    const opom = state.source === 'opom';
    el.csvSource.hidden = opom;
    el.opomSource.hidden = !opom;
    el.ruleSummary.textContent = ruleText();
    el.autoTopupSummary.textContent = autoTopupText();
    el.autoTopupThreshold.disabled = el.autoTopupEnableOnly.checked;
    el.autoTopupAmount.disabled = el.autoTopupEnableOnly.checked;
    for (const button of document.querySelectorAll('[data-source]')) {
      const selected = button.dataset.source === state.source;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    renderRows();
  }

  function invalidatePreparation() {
    state.lastDryRun = null;
    state.dryRunSignature = '';
    state.liveConfirmationToken = '';
  }

  function setSource(source) {
    if (source === state.source) return;
    state.source = source;
    state.rows = [];
    state.fileName = '';
    state.opomConfirmed = false;
    state.cardAllocationSignature = '';
    if (source === 'opom') {
      el.autoTopupEnableOnly.checked = true;
      el.skipMatch.checked = true;
      el.opomLoadState.textContent = '尚未获取';
    } else {
      el.autoTopupEnableOnly.checked = false;
      el.skipMatch.checked = false;
    }
    invalidatePreparation();
    renderControls();
  }

  function markOpomDirty() {
    if (state.source !== 'opom') return;
    state.opomConfirmed = false;
    state.rows = [];
    state.fileName = '';
    state.cardAllocationSignature = '';
    el.opomLoadState.textContent = '参数已变更';
    invalidatePreparation();
    renderRows();
  }

  function opomDefaults() {
    const rule = ruleValues();
    const enableOnly = el.autoTopupEnableOnly.checked;
    return {
      amount: '',
      balanceThreshold: String(rule.threshold),
      amountBelowThreshold: String(rule.below),
      amountAtOrAboveThreshold: String(rule.atOrAbove),
      autoTopupThreshold: enableOnly ? '' : String(numericValue(el.autoTopupThreshold, 100)),
      autoTopupAmount: enableOnly ? '' : String(numericValue(el.autoTopupAmount, 150)),
    };
  }

  async function loadOpom() {
    const group = el.opomGroup.value.trim();
    if (!group) throw new Error('请输入 OPOM Group');
    const limit = clampInteger(el.opomLimit, 1, 200, 50);
    const data = await requestJson('/api/opom/ready', {
      method: 'POST',
      body: {
        group,
        status: opomStatusForRequest(),
        limit,
        cursor: '',
        ...runtimeConfig(),
        defaults: opomDefaults(),
        addressCsvText: '',
      },
    });
    state.rows = applyCurrentRules(applyAddresses(normalizeApiRows(data.rows, 'opom')));
    state.fileName = `opom-${group}.csv`;
    state.opomConfirmed = true;
    state.cardAllocationSignature = '';
    el.opomLoadState.textContent = `已获取 ${state.rows.length} 条`;
    invalidatePreparation();
    renderRows();
    if (el.cardFile.files?.length) await ensureCardsAllocated();
  }

  async function loadAccountCsv(file) {
    const rows = rowsFromCsv(await file.text());
    if (!rows.length) {
      throw new Error('账号 CSV 需要包含邮箱、AdsPowerId、AdsPower 编号或 OPOM 账号 ID');
    }
    assertValidSelectorEmails(rows);
    state.rows = applyCurrentRules(applyAddresses(rows));
    state.fileName = file.name;
    state.cardAllocationSignature = '';
    el.accountFileLabel.textContent = `${rows.length} 行 · ${file.name}`;
    invalidatePreparation();
    renderRows();
  }

  function optionsPayload() {
    const replaceCard = Boolean(el.cardFile.files?.length);
    return {
      scopeBillingAddress: replaceCard,
      scopePaymentMethod: replaceCard,
      scopePurchase: true,
      scopeAutoTopup: true,
      removeExisting: replaceCard,
      stopProfiles: true,
      skipAdsPowerMatch: el.skipMatch.checked,
      concurrency: String(clampInteger(el.concurrency, 1, 10, 1)),
      confirmPurchase: true,
      preparePurchaseOnly: false,
      autoTopupThreshold: String(numericValue(el.autoTopupThreshold, 100)),
      autoTopupAmount: String(numericValue(el.autoTopupAmount, 150)),
      autoTopupEnableOnly: el.autoTopupEnableOnly.checked,
      cardProvider: 'EJH',
      ...runtimeConfig(),
      opomWriteback: true,
      adspowerStatusMode: 'disabled',
      adspowerSuccessGroupId: '',
      adspowerFailureGroupId: '',
      adspowerBlockerGroupId: '',
      adspowerSuccessGroupName: '',
      adspowerFailureGroupName: '',
      adspowerBlockerGroupName: '',
    };
  }

  async function matchAdsPower() {
    if (!state.rows.length) throw new Error('请先导入账号');
    state.rows = applyCurrentRules(state.rows);
    const needsResolve = state.rows.some((row) => !row.opom_account_id && (
      row.login_email || row.ads_power_user_id || row.ads_power_serial_number
    ));
    if (needsResolve && opomConfigured()) {
      try {
        const resolved = await requestJson('/api/opom/resolve', {
          method: 'POST',
          body: {
            rows: state.rows,
            group: el.opomGroup.value.trim() || 'VIP',
            status: state.source === 'opom' ? opomStatusForRequest() : 'needs_recharge',
            ...runtimeConfig(),
          },
        });
        state.rows = mergeRows(state.rows, resolved.rows || []);
      } catch (error) {
        const reason = sanitizeMessage(error.message);
        state.rows = state.rows.map((row) => row.opom_account_id ? row : {
          ...row,
          opom_health_status: 'opom_resolve_failed',
          opom_health_reason: reason,
        });
      }
    }

    const data = await requestJson('/api/adspower/match', {
      method: 'POST',
      body: {
        rows: state.rows.map((row) => ({
          loginEmail: row.login_email,
          ads_power_user_id: row.ads_power_user_id,
          ads_power_serial_number: row.ads_power_serial_number,
        })),
        options: optionsPayload(),
      },
    });
    for (const result of data.results || []) {
      const row = state.rows[result.index];
      if (!row) continue;
      row.ads_match_status = result.status === 'matched' ? 'matched' : 'failed';
      if (result.status === 'matched') {
        row.ads_power_user_id = result.profile?.userId || row.ads_power_user_id;
        row.ads_power_serial_number = result.profile?.serialNumber || row.ads_power_serial_number;
        row.ads_power_group_name = result.profile?.groupName || row.ads_power_group_name;
      }
    }
    state.cardAllocationSignature = '';
    invalidatePreparation();
    renderRows();
    if (el.cardFile.files?.length) await ensureCardsAllocated();
  }

  function allocationSignature() {
    const file = el.cardFile.files?.[0];
    if (!file) return '';
    return JSON.stringify({
      file: [file.name, file.size, file.lastModified],
      rows: selectedRows().map((row) => rowKeys(row)[0] || ''),
      skip: el.skipMatch.checked,
    });
  }

  async function ensureCardsAllocated() {
    const file = el.cardFile.files?.[0];
    if (!file) {
      state.cardAllocationSignature = '';
      return;
    }
    if (!selectedRows().length) throw new Error('请先选择执行账号');
    const signature = allocationSignature();
    if (signature === state.cardAllocationSignature) return;
    if (!el.skipMatch.checked && !selectedRows().some((row) => row.ads_match_status === 'matched')) {
      throw new Error('请先完成 AdsPower 匹配');
    }
    const data = await requestJson('/api/cards/allocate', {
      method: 'POST',
      body: {
        rows: applyCurrentRules(selectedRows()),
        skipAdsPowerMatch: el.skipMatch.checked,
        cardCsvText: await file.text(),
        defaults: opomDefaults(),
        ...runtimeConfig(),
        createCards: false,
        confirmCreateCards: false,
        amount: '',
        activeDate: '',
        cardholder: '',
      },
    });
    state.rows = mergeRows(state.rows, data.rows || []);
    state.cardAllocationSignature = signature;
    invalidatePreparation();
    renderRows();
  }

  function currentSignature() {
    return JSON.stringify({
      source: state.source,
      fileName: state.fileName,
      csvText: canonicalCsv(),
      options: optionsPayload(),
      card: allocationSignature(),
    });
  }

  function validateExecutionInput() {
    if (!selectedRows().length) throw new Error('请至少选择一个账号');
    if (!canStart()) throw new Error('请先完成 AdsPower 匹配，或确认跳过匹配');
    const rule = ruleValues();
    if (!Number.isFinite(rule.threshold) || rule.threshold <= 0) {
      throw new Error('余额阈值必须大于 0');
    }
    if (![rule.below, rule.atOrAbove].every((value) => Number.isFinite(value) && value >= 0)) {
      throw new Error('分支充值金额必须大于等于 0');
    }
    if (!el.autoTopupEnableOnly.checked) {
      if (numericValue(el.autoTopupThreshold, 0) <= 0) throw new Error('Auto Top-Up 阈值必须大于 0');
      if (numericValue(el.autoTopupAmount, 0) <= 0) throw new Error('Auto Top-Up 充值金额必须大于 0');
    }
  }

  async function runAutomaticSafetyCheck() {
    const csvText = canonicalCsv();
    const signature = currentSignature();
    state.lastDryRun = await requestJson('/api/jobs/dry-run', {
      method: 'POST',
      body: {
        fileName: state.fileName || `${state.source}-recharge.csv`,
        csvText,
        options: optionsPayload(),
      },
    });
    state.dryRunSignature = signature;
    state.liveConfirmationToken = state.lastDryRun.liveConfirmationToken || '';
    if (!state.liveConfirmationToken || Number(state.lastDryRun.ready || 0) < 1) {
      throw new Error(`没有可执行账号：可执行 ${state.lastDryRun.ready || 0}，阻塞 ${state.lastDryRun.blocked || 0}`);
    }
    return state.lastDryRun;
  }

  function openPendingWindow() {
    state.pendingWindowBlocked = false;
    state.pendingWindow = window.open('about:blank', '_blank');
    if (!state.pendingWindow) {
      state.pendingWindowBlocked = true;
      return;
    }
    try {
      state.pendingWindow.document.title = '正在创建任务';
      state.pendingWindow.document.body.style.cssText = 'font:16px -apple-system,sans-serif;padding:32px;color:CanvasText;background:Canvas;';
      state.pendingWindow.document.body.textContent = '正在创建任务，完成后将自动打开执行页…';
    } catch {
      // The placeholder is best effort; the job remains recoverable from task history.
    }
  }

  function closePendingWindow() {
    if (state.pendingWindow && !state.pendingWindow.closed) state.pendingWindow.close();
    state.pendingWindow = null;
  }

  async function beginExecution() {
    clearError();
    validateExecutionInput();
    try {
      el.startButton.disabled = true;
      el.startButton.textContent = '检查中…';
      await ensureCardsAllocated();
      const dryRun = await runAutomaticSafetyCheck();
      el.confirmSource.textContent = state.source === 'opom' ? 'OPOM' : 'CSV';
      el.confirmRows.textContent = String(selectedRows().length);
      el.confirmRule.textContent = ruleText();
      el.confirmReadiness.textContent = `${dryRun.ready} 可执行 / ${dryRun.blocked} 阻塞`;
      el.confirmDialog.showModal();
    } finally {
      el.startButton.textContent = '开始执行';
      renderCounts();
    }
  }

  async function createJob() {
    if (state.creatingJob) return;
    openPendingWindow();
    state.creatingJob = true;
    el.createJobButton.disabled = true;
    el.createJobButton.textContent = '创建中…';
    try {
      if (state.dryRunSignature !== currentSignature()) {
        throw new Error('准备内容已变化，请关闭确认窗口后重新开始');
      }
      const data = await requestJson('/api/jobs', {
        method: 'POST',
        body: {
          fileName: state.fileName || `${state.source}-recharge.csv`,
          csvText: canonicalCsv(),
          options: optionsPayload(),
          liveConfirmationToken: state.liveConfirmationToken,
        },
      });
      const jobId = data.job?.id;
      if (!jobId) throw new Error('任务创建成功但未返回任务 ID');
      state.confirmDialogResult = 'created';
      el.confirmDialog.close('created');
      const url = `/execution.html?job=${encodeURIComponent(jobId)}`;
      if (state.pendingWindow && !state.pendingWindow.closed) {
        state.pendingWindow.location.replace(url);
        state.pendingWindow.focus();
      } else {
        el.executionFallbackLink.href = url;
        el.executionFallback.hidden = false;
      }
      state.pendingWindow = null;
      await refreshJobs();
    } catch (error) {
      closePendingWindow();
      throw error;
    } finally {
      state.creatingJob = false;
      el.createJobButton.disabled = false;
      el.createJobButton.textContent = '确认并创建任务';
    }
  }

  function formatTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }

  function openExecution(jobId) {
    if (!jobId) return;
    const url = `/execution.html?job=${encodeURIComponent(jobId)}`;
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) {
      el.executionFallbackLink.href = url;
      el.executionFallback.hidden = false;
    }
  }

  function renderWorkerAndJobs() {
    const currentRows = Array.isArray(state.worker.currentRows) ? state.worker.currentRows : [];
    if (state.worker.running) {
      el.workerButton.classList.add('is-running');
      el.workerLabel.textContent = `Worker 执行中 · ${currentRows.length || 1} 个子任务`;
    } else {
      el.workerButton.classList.remove('is-running');
      el.workerLabel.textContent = 'Worker 空闲';
    }

    if (!state.jobs.length) {
      el.recordList.innerHTML = '<p class="confirmation-warning">暂无任务记录。</p>';
      return;
    }
    el.recordList.innerHTML = state.jobs.map((job) => `
      <button class="record-button" type="button" data-job-id="${escapeHtml(job.id)}">
        <strong>${escapeHtml(job.fileName || job.id)}</strong>
        ${pill(job.status === 'completed' ? 'ok' : ['queued', 'running'].includes(job.status) ? 'warning' : 'error', job.status)}
        <span>${job.completedRows || 0}/${job.totalRows || 0} 完成 · ${job.failedRows || 0} 失败 · ${job.blockedRows || 0} 阻塞</span>
        <small>${escapeHtml(formatTime(job.createdAt))} · ${escapeHtml(job.id)}</small>
      </button>
    `).join('');
    for (const button of el.recordList.querySelectorAll('[data-job-id]')) {
      button.addEventListener('click', () => openExecution(button.dataset.jobId));
    }
  }

  function schedulerPayload(enabled) {
    return {
      enabled,
      confirmAutomaticPurchase: enabled,
      group: el.opomGroup.value.trim() || 'VIP',
      status: 'needs_recharge',
      limit: String(clampInteger(el.opomLimit, 1, 200, 50)),
      options: {
        ...optionsPayload(),
        opomWriteback: true,
        confirmPurchase: true,
        preparePurchaseOnly: false,
        scopePurchase: true,
      },
      defaults: opomDefaults(),
    };
  }

  function renderSchedulerState(scheduler = {}) {
    if (!el.autoRechargeEnabled || !el.autoRechargeSummary || !scheduler.ok) return;
    state.scheduler = scheduler;
    el.autoRechargeEnabled.checked = Boolean(scheduler.enabled);
    el.autoRechargeEnabled.disabled = !scheduler.enabled && (!opomConfigured() || !adsPowerConfigured());
    el.autoRechargeEnabled.title = el.autoRechargeEnabled.disabled
      ? '请先在设置中配置 OPOM 和 AdsPower'
      : '';
    const summary = [
      scheduler.enabled ? '自动充值已启用。' : '自动充值未启用。',
      scheduler.schedule || '每小时 15 和 45 分',
      scheduler.nextRunAt ? `下次 ${formatTime(scheduler.nextRunAt)}` : '',
      scheduler.lastRunAt ? `上次 ${formatTime(scheduler.lastRunAt)}` : '',
      scheduler.message || '',
    ].filter(Boolean).join(' ');
    el.autoRechargeSummary.textContent = summary;
    el.autoRechargeSummary.classList.toggle('success', Boolean(scheduler.enabled) && !/failed/i.test(scheduler.status || ''));
    el.autoRechargeSummary.classList.toggle('warning', /failed|skipped|idle_no_ready/i.test(scheduler.status || ''));
  }

  async function toggleAutoRecharge() {
    const enabled = el.autoRechargeEnabled.checked;
    if (enabled && !window.confirm('启用后，服务端将在每小时 15 和 45 分按当前页面参数自动创建真实充值任务。确认启用？')) {
      el.autoRechargeEnabled.checked = false;
      return;
    }
    const scheduler = await requestJson('/api/scheduler', {
      method: 'POST',
      body: schedulerPayload(enabled),
    });
    renderSchedulerState(scheduler);
  }

  async function refreshJobs() {
    const data = await requestJson('/api/jobs');
    state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
    state.worker = data.worker || {};
    renderSchedulerState(data.scheduler || {});
    renderWorkerAndJobs();
    if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(
      () => refreshJobs().catch(showError),
      state.worker.running ? 3000 : 30000,
    );
  }

  function workerJobId() {
    const currentRows = Array.isArray(state.worker.currentRows) ? state.worker.currentRows : [];
    return currentRows.find((row) => row.jobId)?.jobId
      || state.jobs.find((job) => ['running', 'queued'].includes(job.status))?.id
      || '';
  }

  async function withBusy(button, busyText, action) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    try {
      return await action();
    } finally {
      button.textContent = original;
      renderCounts();
    }
  }

  function resetPreparation() {
    state.source = 'csv';
    state.rows = [];
    state.fileName = '';
    state.opomConfirmed = false;
    state.cardAllocationSignature = '';
    el.accountFile.value = '';
    el.cardFile.value = '';
    el.accountFileLabel.textContent = '未选择';
    el.cardFileLabel.textContent = '不替换卡片';
    el.opomGroup.value = 'VIP';
    el.opomStatus.value = 'card_switch&overdue';
    el.opomLimit.value = '50';
    el.opomLoadState.textContent = '尚未获取';
    el.balanceThreshold.value = '145';
    el.amountBelow.value = '150';
    el.amountAtOrAbove.value = '20';
    el.autoTopupThreshold.value = '100';
    el.autoTopupAmount.value = '150';
    el.autoTopupEnableOnly.checked = false;
    el.skipMatch.checked = false;
    el.concurrency.value = '1';
    invalidatePreparation();
    renderControls();
  }

  function bindSourceControl() {
    const buttons = [...document.querySelectorAll('[data-source]')];
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => setSource(button.dataset.source));
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const nextIndex = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[nextIndex].focus();
        setSource(buttons[nextIndex].dataset.source);
      });
    });
  }

  function bindEvents() {
    bindSourceControl();
    el.accountFileButton.addEventListener('click', () => el.accountFile.click());
    el.accountFile.addEventListener('change', () => {
      const file = el.accountFile.files?.[0];
      if (!file) return;
      withBusy(el.accountFileButton, '读取中…', () => loadAccountCsv(file)).catch(showError);
    });
    el.cardFileButton.addEventListener('click', () => el.cardFile.click());
    el.cardFile.addEventListener('change', () => {
      const file = el.cardFile.files?.[0];
      el.cardFileLabel.textContent = file ? `替换 · ${file.name}` : '不替换卡片';
      state.cardAllocationSignature = '';
      invalidatePreparation();
      renderRows();
      if (file && state.rows.length && canStart()) {
        withBusy(el.cardFileButton, '分配中…', ensureCardsAllocated).catch(showError);
      }
    });

    ['opomGroup', 'opomStatus', 'opomLimit'].forEach((key) => {
      el[key].addEventListener('input', markOpomDirty);
      el[key].addEventListener('change', markOpomDirty);
    });

    ['balanceThreshold', 'amountBelow', 'amountAtOrAbove', 'autoTopupThreshold', 'autoTopupAmount']
      .forEach((key) => {
        el[key].addEventListener('input', () => {
          state.cardAllocationSignature = '';
          invalidatePreparation();
          renderControls();
        });
      });

    el.autoTopupEnableOnly.addEventListener('change', () => {
      invalidatePreparation();
      renderControls();
    });
    el.skipMatch.addEventListener('change', () => {
      state.cardAllocationSignature = '';
      invalidatePreparation();
      renderRows();
    });
    el.concurrency.addEventListener('input', invalidatePreparation);
    el.billingState.addEventListener('change', invalidatePreparation);

    for (const key of CONFIG_FIELDS) {
      el[key].addEventListener('input', () => {
        el.settingsState.textContent = '配置有未保存的修改。';
        renderConnectionSummary();
        renderSchedulerState(state.scheduler);
        invalidatePreparation();
      });
    }

    el.loadOpomButton.addEventListener('click', () => {
      withBusy(el.loadOpomButton, '获取中…', loadOpom).catch(showError);
    });
    el.matchButton.addEventListener('click', () => {
      withBusy(el.matchButton, '匹配中…', matchAdsPower).catch(showError);
    });
    el.startButton.addEventListener('click', () => beginExecution().catch(showError));
    el.createJobButton.addEventListener('click', () => createJob().catch(showError));
    el.confirmDialog.addEventListener('close', () => {
      if (el.confirmDialog.returnValue !== 'created') closePendingWindow();
    });

    el.selectReadyButton.addEventListener('click', () => {
      state.rows.forEach((row) => { row.execute = rowReady(row); });
      state.cardAllocationSignature = '';
      invalidatePreparation();
      renderRows();
    });
    el.resetButton.addEventListener('click', resetPreparation);
    el.dismissError.addEventListener('click', clearError);

    el.settingsButton.addEventListener('click', () => el.settingsDialog.showModal());
    el.recordsButton.addEventListener('click', () => {
      renderWorkerAndJobs();
      el.recordsDialog.showModal();
    });
    el.workerButton.addEventListener('click', () => {
      const jobId = workerJobId();
      if (jobId) openExecution(jobId);
      else {
        renderWorkerAndJobs();
        el.recordsDialog.showModal();
      }
    });
    el.saveSettingsButton.addEventListener('click', saveRuntimeConfig);
    el.clearSettingsButton.addEventListener('click', clearRuntimeConfig);
    el.autoRechargeEnabled.addEventListener('change', () => {
      toggleAutoRecharge().catch((error) => {
        el.autoRechargeEnabled.checked = Boolean(state.scheduler.enabled);
        showError(error);
      });
    });
    el.contrastButton.addEventListener('click', () => {
      setHighContrast(!document.body.classList.contains('high-contrast'));
    });
  }

  async function init() {
    loadRuntimeConfig();
    setHighContrast(Boolean(readUiPrefs().highContrast));
    bindEvents();
    renderControls();
    try {
      await initSession();
      await refreshJobs();
    } catch (error) {
      showError(error);
    }
  }

  init();
})();
