import {readyToRechargePayload, canonicalCsvFromRows} from './opom-orchestrator.mjs';
import {matchAdsPowerPayload} from './adspower-match.mjs';
import {createJob, dryRunPayload} from './jobs.mjs';
import {runnerArgs} from './automation-adapter.mjs';
import {nowIso} from './ids.mjs';
import {redact} from './redact.mjs';
import {httpError} from './http-utils.mjs';

const SCHEDULER_ID = 'auto-recharge';
const DEFAULT_INTERVAL_MS = 30 * 1000;
const RECHARGE_STATUS = 'needs_recharge';

export class AutoRechargeScheduler {
  constructor(db, options = {}) {
    this.db = db;
    this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        console.error('[auto-recharge-scheduler]', redact(error.message || error));
      });
    }, this.intervalMs);
    this.tick().catch((error) => console.error('[auto-recharge-scheduler]', redact(error.message || error)));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getState() {
    return publicState(readSchedulerState(this.db));
  }

  update(payload = {}) {
    if (payload.enabled) {
      const settings = normalizeSettings(payload);
      validateEnabledSettings(settings, payload);
      writeSchedulerState(this.db, {
        enabled: 1,
        settingsJson: JSON.stringify(settings),
        status: 'enabled',
        message: '自动充值已启用；将在每小时 15 和 45 分检查 OPOM needs_recharge。',
        nextRunAt: nextScheduledDate(new Date()).toISOString(),
      });
    } else {
      const current = readSchedulerState(this.db);
      writeSchedulerState(this.db, {
        enabled: 0,
        settingsJson: current.settingsJson || '{}',
        status: 'disabled',
        message: '自动充值已关闭。',
        nextRunAt: '',
      });
    }
    return this.getState();
  }

  async tick(date = new Date()) {
    if (this.running) return;
    const state = readSchedulerState(this.db);
    if (!state.enabled) return;
    const slot = scheduleSlot(date);
    if (!slot) {
      updateSchedulerStatus(this.db, {
        nextRunAt: nextScheduledDate(date).toISOString(),
      });
      return;
    }
    if (state.lastSlot === slot) return;
    updateSchedulerStatus(this.db, {
      lastSlot: slot,
      status: 'running',
      message: `自动充值检查中：${slot}`,
      nextRunAt: nextScheduledDate(date).toISOString(),
    });
    this.running = true;
    try {
      await this.runOnce(slot);
    } catch (error) {
      updateSchedulerStatus(this.db, {
        status: 'failed',
        message: redact(error.message || 'auto recharge failed'),
        lastRunAt: nowIso(),
      });
    } finally {
      this.running = false;
    }
  }

  async runOnce(slot) {
    const state = readSchedulerState(this.db);
    const settings = JSON.parse(state.settingsJson || '{}');
    const activeJob = this.db.prepare(`
      SELECT id FROM jobs
      WHERE status IN ('queued', 'running') AND cancel_requested = 0
      ORDER BY created_at ASC
      LIMIT 1
    `).get();
    if (activeJob) {
      updateSchedulerStatus(this.db, {
        status: 'skipped_busy',
        message: `已有任务 ${activeJob.id} 在排队或执行，本轮自动充值跳过。`,
        lastRunAt: nowIso(),
      });
      return null;
    }

    const options = {
      ...settings.options,
      opomWriteback: true,
      confirmPurchase: true,
      preparePurchaseOnly: false,
      scopePurchase: true,
    };
    const readyPayload = await readyToRechargePayload({
      ...options,
      group: settings.group || 'VIP',
      status: RECHARGE_STATUS,
      limit: settings.limit || 100,
      defaults: settings.defaults || {},
    });
    let rows = readyPayload.rows || [];
    if (!rows.length) {
      updateSchedulerStatus(this.db, {
        status: 'idle_no_rows',
        message: `OPOM needs_recharge 没有返回可检查账号。`,
        lastRunAt: nowIso(),
      });
      return null;
    }

    if (!options.skipAdsPowerMatch) {
      const matched = await matchAdsPowerPayload({
        rows: rows.map((row) => ({
          loginEmail: row.login_email,
          ads_power_user_id: row.ads_power_user_id,
          ads_power_serial_number: row.ads_power_serial_number,
        })),
        options,
      });
      rows = mergeAdsPowerMatch(rows, matched.results || []);
    }

    const csvText = canonicalCsvFromRows(rows);
    const fileName = `auto-opom-${settings.group || 'VIP'}-${slot.replace(/[^0-9]/g, '')}.csv`;
    const dryRun = await dryRunPayload({fileName, csvText, options});
    if (!dryRun.ready || !dryRun.liveConfirmationToken) {
      updateSchedulerStatus(this.db, {
        status: 'idle_no_ready_rows',
        message: `自动预检未发现 ready 行：ready=${dryRun.ready || 0} blocked=${dryRun.blocked || 0} skipped=${dryRun.skipped || 0}。`,
        lastRunAt: nowIso(),
      });
      return null;
    }

    const created = await createJob(this.db, {
      fileName,
      csvText,
      options,
      liveConfirmationToken: dryRun.liveConfirmationToken,
      jobName: `auto-${slot.replace(/[:T+-]/g, '')}-${dryRun.ready}`,
    });
    updateSchedulerStatus(this.db, {
      status: 'queued',
      message: `自动充值已创建任务 ${created.job.id}，ready=${dryRun.ready}。`,
      lastRunAt: nowIso(),
    });
    return created;
  }
}

function normalizeSettings(payload = {}) {
  const options = payload.options || {};
  return {
    group: String(payload.group || 'VIP').trim() || 'VIP',
    status: RECHARGE_STATUS,
    limit: Math.min(200, Math.max(1, Math.floor(Number(payload.limit || 100) || 100))),
    options,
    defaults: payload.defaults || {},
  };
}

function validateEnabledSettings(settings, payload = {}) {
  if (payload.confirmAutomaticPurchase !== true) {
    throw httpError(409, '启用自动充值需要明确确认允许按 15/45 分自动创建真实充值任务');
  }
  const args = runnerArgs({
    ...settings.options,
    opomWriteback: true,
    confirmPurchase: true,
    preparePurchaseOnly: false,
    scopePurchase: true,
  });
  if (!args.opomBaseUrl || !args.opomRechargeToken) {
    throw httpError(409, '自动充值需要 OPOM_BASE_URL 和 RECHARGE_API_TOKEN');
  }
  if (!args.adspowerApiBase || !args.adspowerApiKey) {
    throw httpError(409, '自动充值需要 AdsPower API 地址和 API key');
  }
  if (!args.scopePurchase || !args.confirmPurchase || args.preparePurchaseOnly) {
    throw httpError(409, '自动充值必须启用真实充值范围，不能使用 no-purchase 模式');
  }
  if (!args.opomWriteback) {
    throw httpError(409, '自动充值必须启用 OPOM 结果回写');
  }
}

function mergeAdsPowerMatch(rows, results) {
  return rows.map((row, index) => {
    const item = results.find((result) => Number(result.index) === index);
    if (!item) return row;
    return {
      ...row,
      ads_match_status: item.status || 'failed',
      ads_power_user_id: item.profile?.userId || row.ads_power_user_id || '',
      ads_power_serial_number: item.profile?.serialNumber || row.ads_power_serial_number || '',
      ads_power_group_name: item.profile?.groupName || row.ads_power_group_name || '',
    };
  });
}

function readSchedulerState(db) {
  const row = db.prepare('SELECT * FROM scheduler_state WHERE id = ?').get(SCHEDULER_ID);
  if (!row) {
    return {
      enabled: 0,
      settingsJson: '{}',
      lastSlot: '',
      lastRunAt: '',
      nextRunAt: '',
      status: 'disabled',
      message: '自动充值未启用。',
      updatedAt: '',
    };
  }
  return {
    enabled: Number(row.enabled || 0),
    settingsJson: row.settings_json || '{}',
    lastSlot: row.last_slot || '',
    lastRunAt: row.last_run_at || '',
    nextRunAt: row.next_run_at || '',
    status: row.status || 'disabled',
    message: row.message || '',
    updatedAt: row.updated_at || '',
  };
}

function writeSchedulerState(db, values = {}) {
  const current = readSchedulerState(db);
  const now = nowIso();
  db.prepare(`
    INSERT INTO scheduler_state (
      id, enabled, settings_json, last_slot, last_run_at, next_run_at, status, message, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      enabled = excluded.enabled,
      settings_json = excluded.settings_json,
      last_slot = excluded.last_slot,
      last_run_at = excluded.last_run_at,
      next_run_at = excluded.next_run_at,
      status = excluded.status,
      message = excluded.message,
      updated_at = excluded.updated_at
  `).run(
    SCHEDULER_ID,
    values.enabled ?? current.enabled,
    values.settingsJson ?? current.settingsJson,
    values.lastSlot ?? current.lastSlot,
    values.lastRunAt ?? current.lastRunAt,
    values.nextRunAt ?? current.nextRunAt,
    values.status ?? current.status,
    values.message ?? current.message,
    now,
  );
}

function updateSchedulerStatus(db, values = {}) {
  writeSchedulerState(db, values);
}

function publicState(state) {
  let settings = {};
  try {
    settings = JSON.parse(state.settingsJson || '{}');
  } catch {
    settings = {};
  }
  const args = runnerArgs(settings.options || {});
  return {
    ok: true,
    enabled: !!state.enabled,
    status: state.status,
    message: state.message,
    lastSlot: state.lastSlot,
    lastRunAt: state.lastRunAt,
    nextRunAt: state.nextRunAt,
    updatedAt: state.updatedAt,
    schedule: '每小时 15 和 45 分',
    settings: {
      group: settings.group || 'VIP',
      status: RECHARGE_STATUS,
      limit: settings.limit || 100,
      confirmPurchase: args.confirmPurchase,
      opomWriteback: args.opomWriteback,
      hasOpomRechargeToken: !!args.opomRechargeToken,
      hasAdspowerApiKey: !!args.adspowerApiKey,
      concurrency: args.concurrency,
    },
  };
}

function scheduleSlot(date = new Date()) {
  const minute = date.getMinutes();
  if (minute !== 15 && minute !== 45) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}+08:00`;
}

function nextScheduledDate(date = new Date()) {
  const next = new Date(date);
  const minute = next.getMinutes();
  if (minute < 15) {
    next.setMinutes(15, 0, 0);
  } else if (minute < 45) {
    next.setMinutes(45, 0, 0);
  } else {
    next.setHours(next.getHours() + 1, 15, 0, 0);
  }
  return next;
}
