const STORAGE_UI_KEY = 'autoPurchaseUiPrefsV1';
let sessionToken = '';
let jobId = new URLSearchParams(location.search).get('job') || '';
let refreshTimer = null;
let lastJob = null;
let loadSequence = 0;

const els = {
  workerLabel: document.querySelector('#workerLabel'),
  refreshButton: document.querySelector('#refreshButton'),
  contrastButton: document.querySelector('#contrastButton'),
  alert: document.querySelector('#alert'),
  runCaption: document.querySelector('#runCaption'),
  runTitle: document.querySelector('#runTitle'),
  runMeta: document.querySelector('#runMeta'),
  summaryDone: document.querySelector('#summaryDone'),
  summaryRunning: document.querySelector('#summaryRunning'),
  summaryBlocked: document.querySelector('#summaryBlocked'),
  summaryElapsed: document.querySelector('#summaryElapsed'),
  progressFill: document.querySelector('#progressFill'),
  progressLabel: document.querySelector('#progressLabel'),
  cancelButton: document.querySelector('#cancelButton'),
  downloadButton: document.querySelector('#downloadButton'),
  executionBody: document.querySelector('#executionBody'),
  eventsBody: document.querySelector('#eventsBody'),
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function sanitizeMessage(value, limit = 800) {
  return String(value ?? '')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted-key]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(cvv|cvc)\s*[:=]\s*\d{3,4}\b/gi, '$1=[redacted]')
    .slice(0, limit);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionToken ? {'X-Runner-Session': sessionToken} : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function initSession() {
  const response = await fetch('/api/session');
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) throw new Error(data.error || '无法初始化本地会话');
  sessionToken = data.token;
}

async function loadJob() {
  if (!jobId) {
    renderMissingJob();
    return;
  }
  const sequence = ++loadSequence;
  const data = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (sequence !== loadSequence) return;
  lastJob = data.job;
  render(data.job, data.rows || [], data.events || [], data.worker || {});
  clearError();
  schedule(data.worker?.running ? 3000 : 30000);
}

function schedule(delay) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => loadJob().catch(showError), delay);
}

function renderMissingJob() {
  els.runTitle.textContent = '缺少 job 参数';
  els.runMeta.textContent = '请从准备页 Worker 状态或任务记录重新打开执行页。';
  els.executionBody.innerHTML = '<tr><td class="table-empty" colspan="11">URL 需要 ?job=&lt;jobId&gt;</td></tr>';
  els.cancelButton.disabled = true;
  els.downloadButton.disabled = true;
}

function render(job, rows, events, worker) {
  const currentRows = worker.currentRows || [];
  els.workerLabel.textContent = worker.running ? `Worker 执行中 ${currentRows.length || 1} 行` : 'Worker 空闲';
  els.runTitle.textContent = `${job.fileName || job.id}`;
  els.runCaption.textContent = `job ${job.id}`;
  const currentSummary = currentRows
    .filter((row) => row.jobId === job.id)
    .map((row) => `#${row.rowNumber} ${row.profileId || '-'} ${row.stage || '-'}`)
    .join(' · ');
  els.runMeta.textContent = [
    `范围 ${job.options?.executionScope || '-'}`,
    `并发 ${job.options?.concurrency || 1}`,
    currentSummary ? `当前 ${currentSummary}` : '',
    '关闭页面不影响后台任务',
  ].filter(Boolean).join(' · ');
  const completed = Number(job.completedRows || 0);
  const failed = Number(job.failedRows || 0);
  const blocked = Number(job.blockedRows || 0);
  const running = rows.filter((row) => row.status === 'running').length || currentRows.length;
  const total = Math.max(1, Number(job.totalRows || rows.length || 1));
  const progress = Math.round(((completed + failed + blocked + Number(job.skippedRows || 0)) / total) * 100);
  els.summaryDone.textContent = String(completed);
  els.summaryRunning.textContent = String(running);
  els.summaryBlocked.textContent = String(failed + blocked);
  els.summaryElapsed.textContent = elapsedText(job.startedAt, job.finishedAt);
  els.progressFill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  els.progressLabel.textContent = `整体进度 ${progress}%`;
  els.cancelButton.disabled = !['queued', 'running'].includes(job.status);
  els.downloadButton.disabled = !job.resultCsvReady;
  renderRows(rows, job);
  renderEvents(events);
}

function renderRows(rows, job) {
  if (!rows.length) {
    els.executionBody.innerHTML = '<tr><td class="table-empty" colspan="11">任务暂无行数据。</td></tr>';
    return;
  }
  const canOperate = !['queued', 'running'].includes(job.status);
  els.executionBody.innerHTML = rows.map((row) => {
    const canRepair = canRepairOpom(row, canOperate);
    return `
      <tr>
        <td data-label="状态">${statusPill(row.status, statusLabel(row.status))}</td>
        <td data-label="行">${escapeHtml(row.rowNumber)}</td>
        <td data-label="账号"><span class="account-cell"><strong>${escapeHtml(row.loginEmail || row.username || '-')}</strong><small>${escapeHtml(row.opomAccountId || '')}</small></span></td>
        <td data-label="AdsPower">${escapeHtml(row.adsPowerSerialNumber || '-')}<br><span class="muted">${escapeHtml(row.adsPowerUserId || '')}</span></td>
        <td data-label="阶段">${escapeHtml(row.stage || '-')}</td>
        <td data-label="充值">${escapeHtml(row.purchaseStatus || '-')}${row.purchaseAmount ? ` / ${escapeHtml(row.purchaseAmount)}` : ''}</td>
        <td data-label="余额">${escapeHtml(row.balanceBefore || '-')} → ${escapeHtml(row.balanceAfter || '-')}</td>
        <td data-label="Auto Top-Up">${escapeHtml(row.autoTopupStatus || '-')}${row.autoTopupThreshold || row.autoTopupAmount ? ` ${escapeHtml(row.autoTopupThreshold || '-')}/${escapeHtml(row.autoTopupAmount || '-')}` : ''}</td>
        <td data-label="卡 / OPOM">${cardOpomText(row)}</td>
        <td class="message" data-label="消息">${messageCell(row)}</td>
        <td data-label="操作"><div class="row-actions">
          <button type="button" class="resume-row" data-row-number="${escapeHtml(row.rowNumber)}" data-only-row="0" ${canOperate && !['completed', 'skipped'].includes(row.status) ? '' : 'disabled'}>从本行继续</button>
          <button type="button" class="resume-row" data-row-number="${escapeHtml(row.rowNumber)}" data-only-row="1" ${canOperate && !['completed', 'skipped'].includes(row.status) ? '' : 'disabled'}>重试本行</button>
          ${canRepair ? `<button type="button" class="repair-opom" data-row-number="${escapeHtml(row.rowNumber)}">补写 OPOM</button>` : ''}
        </div></td>
      </tr>
    `;
  }).join('');
  els.executionBody.querySelectorAll('.resume-row').forEach((button) => {
    button.addEventListener('click', () => resumeRow(Number(button.dataset.rowNumber), button.dataset.onlyRow === '1').catch(showError));
  });
  els.executionBody.querySelectorAll('.repair-opom').forEach((button) => {
    button.addEventListener('click', () => repairOpom(Number(button.dataset.rowNumber)).catch(showError));
  });
}

function cardOpomText(row) {
  const card = row.cardLast4 || String(row.cardNo || '').slice(-4);
  const parts = [];
  if (card) parts.push(`卡 ••••${card}`);
  if (row.opomCardWritebackStatus) parts.push(`绑卡 ${row.opomCardWritebackStatus}`);
  if (row.opomResultWritebackStatus) parts.push(`结果 ${row.opomResultWritebackStatus}`);
  if (row.adspowerTagStatus) parts.push(`AdsPower ${row.adspowerTagStatus}`);
  return escapeHtml(parts.join(' · ') || '-');
}

function canRepairOpom(row, canOperate) {
  return canOperate
    && row.status === 'failed'
    && row.stage === 'opom.writeback'
    && row.purchaseStatus === 'verified';
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function simpleMessage(message, fallback = '-') {
  const text = sanitizeMessage(normalizeText(message) || fallback);
  return escapeHtml(text || '-');
}

function technicalDetail(item = {}) {
  const raw = item.errorDetail
    ?? item.error_detail
    ?? item.data?.errorDetail
    ?? item.data?.error_detail
    ?? '';
  if (!raw) return '';
  const text = typeof raw === 'object'
    ? JSON.stringify(raw, null, 2)
    : String(raw);
  return sanitizeMessage(text, 4000);
}

function errorCode(item = {}) {
  return item.errorCode
    ?? item.error_code
    ?? item.data?.errorCode
    ?? item.data?.error_code
    ?? '';
}

function messageCell(row = {}) {
  const fallback = Array.isArray(row.missing) && row.missing.length ? row.missing.join(', ') : '-';
  const message = simpleMessage(row.message, fallback);
  const code = normalizeText(errorCode(row));
  const detail = technicalDetail(row);
  const shouldShowDetail = detail && normalizeText(detail) !== normalizeText(row.message || fallback);
  return [
    `<span class="message-primary">${message}</span>`,
    code ? `<span class="error-code">${escapeHtml(sanitizeMessage(code))}</span>` : '',
    shouldShowDetail ? `<details class="message-detail"><summary>技术详情</summary><div class="detail-body">${escapeHtml(detail)}</div></details>` : '',
  ].filter(Boolean).join('');
}

function eventMessage(event = {}) {
  const message = simpleMessage(event.message, event.type || '-');
  const code = normalizeText(errorCode(event));
  const detail = technicalDetail(event);
  const shouldShowDetail = detail && normalizeText(detail) !== normalizeText(event.message || event.type || '-');
  return [
    `<span class="message-primary">${message}</span>`,
    code ? `<span class="error-code">${escapeHtml(sanitizeMessage(code))}</span>` : '',
    shouldShowDetail ? `<details class="message-detail event-detail"><summary>技术详情</summary><div class="detail-body">${escapeHtml(detail)}</div></details>` : '',
  ].filter(Boolean).join('');
}

function renderEvents(events) {
  const recent = [...events].slice(-80).reverse();
  els.eventsBody.innerHTML = recent.length ? recent.map((event) => `
    <div class="event-line">
      <span>${escapeHtml(formatTime(event.createdAt))}</span>
      <strong>${escapeHtml(event.type || '')}</strong>
      <span>${eventMessage(event)}</span>
    </div>
  `).join('') : '暂无事件。';
}

async function resumeRow(startRowNumber, onlyRow) {
  const preview = await api(`/api/jobs/${encodeURIComponent(jobId)}/resume-preview`, {
    method: 'POST',
    body: JSON.stringify({startRowNumber, onlyRow}),
  });
  if (!preview.csvAvailability?.ok) {
    window.alert(resumeSummary(preview));
    return;
  }
  let includeRiskyRows = false;
  if (preview.skippedRiskyRows?.length) {
    includeRiskyRows = window.confirm(`${resumeSummary(preview)}\n\n包含高风险行前必须确认线下状态。是否包含？`);
  }
  const finalPreview = includeRiskyRows
    ? await api(`/api/jobs/${encodeURIComponent(jobId)}/resume-preview`, {
      method: 'POST',
      body: JSON.stringify({startRowNumber, onlyRow, includeRiskyRows: true}),
    })
    : preview;
  if (!finalPreview.queuedRows?.length && !finalPreview.alreadyQueuedRows?.length) {
    window.alert(`${resumeSummary(finalPreview)}\n\n没有可续跑行。`);
    return;
  }
  const action = onlyRow ? '重试本行' : '从本行继续';
  if (!window.confirm(`${resumeSummary(finalPreview)}\n\n确认${action}？`)) return;
  await api(`/api/jobs/${encodeURIComponent(jobId)}/resume`, {
    method: 'POST',
    body: JSON.stringify({startRowNumber, onlyRow, includeRiskyRows}),
  });
  await loadJob();
}

function resumeSummary(preview) {
  return [
    `${preview.onlyRow ? '重试本行' : '从本行继续'}：第 ${preview.startRowNumber} 行`,
    `候选 ${preview.totalCandidateRows || 0} 行`,
    `将重排 ${preview.queuedRows?.length || 0} 行`,
    `已在队列 ${preview.alreadyQueuedRows?.length || 0} 行`,
    `跳过完成 ${preview.skippedCompletedRows?.length || 0} 行`,
    `高风险 ${preview.skippedRiskyRows?.length || 0} 行`,
  ].join('\n');
}

async function repairOpom(rowNumber) {
  if (!window.confirm(`只补写第 ${rowNumber} 行 OPOM 结果，不会打开浏览器或重新购买。确认继续？`)) return;
  await api(`/api/jobs/${encodeURIComponent(jobId)}/rows/${encodeURIComponent(rowNumber)}/opom-writeback-repair`, {
    method: 'POST',
    body: '{}',
  });
  await loadJob();
}

async function cancelJob() {
  if (!lastJob || !['queued', 'running'].includes(lastJob.status)) return;
  if (!window.confirm('取消只会停止后续排队行，不会强制中断当前浏览器步骤。确认？')) return;
  await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {method: 'POST', body: '{}'});
  await loadJob();
}

async function downloadResult() {
  if (!jobId || els.downloadButton.disabled) return;
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/result.csv`, {
    headers: {'X-Runner-Session': sessionToken},
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${jobId}.result.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function statusPill(kind, text) {
  return `<span class="pill ${escapeHtml(kind || '')}">${escapeHtml(text || '-')}</span>`;
}

function statusLabel(status) {
  const map = {
    queued: '排队',
    running: '执行中',
    completed: '完成',
    failed: '失败',
    blocked: '阻断',
    canceled: '已取消',
    skipped: '已跳过',
    ready: '就绪',
    missing_fields: '缺字段',
    login_required: '需登录',
    identity_mismatch: '身份不匹配',
    payment_issue_card_declined: '支付拒绝',
    manual_security_blocker: '人工阻断',
    purchase_unverified: '购买未验证',
    credits_401_blocked: '授权阻断',
    balance_unknown: '余额未知',
  };
  return map[status] || status || '-';
}

function elapsedText(startedAt, finishedAt) {
  if (!startedAt) return '0s';
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '0s';
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function showError(error) {
  els.alert.hidden = false;
  els.alert.textContent = sanitizeMessage(error.message || error);
}

function clearError() {
  els.alert.hidden = true;
  els.alert.textContent = '';
}

function loadUiPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(STORAGE_UI_KEY) || '{}');
    if (prefs.highContrast) setContrast(true);
  } catch {
    /* noop */
  }
}

function setContrast(enabled) {
  document.body.classList.toggle('high-contrast', enabled);
  els.contrastButton.setAttribute('aria-pressed', String(enabled));
  localStorage.setItem(STORAGE_UI_KEY, JSON.stringify({highContrast: enabled}));
}

function wireEvents() {
  els.refreshButton.addEventListener('click', () => loadJob().catch(showError));
  els.cancelButton.addEventListener('click', () => cancelJob().catch(showError));
  els.downloadButton.addEventListener('click', () => downloadResult().catch(showError));
  els.contrastButton.addEventListener('click', () => setContrast(!document.body.classList.contains('high-contrast')));
}

async function boot() {
  loadUiPrefs();
  wireEvents();
  await initSession();
  await loadJob();
}

boot().catch(showError);
