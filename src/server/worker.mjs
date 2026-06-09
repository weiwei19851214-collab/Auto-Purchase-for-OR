import {readFileSync} from 'node:fs';
import {addEvent, getJob, listRows, updateJobCounts} from './db.mjs';
import {nowIso} from './ids.mjs';
import {redact} from './redact.mjs';
import {cleanupJobUpload, executeRow, runnerArgs, writeResultCsv} from './automation-adapter.mjs';
import {writeAdsPowerStatus} from './adspower-status.mjs';
import {writeRowResult} from './opom-client.mjs';
import * as statusContract from '../automation/lib/status-contract.mjs';

export class JobWorker {
  constructor(db, options = {}) {
    this.db = db;
    this.intervalMs = options.intervalMs || 1500;
    this.heartbeatMs = options.heartbeatMs || 10000;
    this.executeRowFn = options.executeRowFn || executeRow;
    this.adsPowerStatusFetch = options.adsPowerStatusFetch || globalThis.fetch?.bind(globalThis);
    this.timer = null;
    this.running = false;
    this.current = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        console.error('[worker]', error);
      });
    }, this.intervalMs);
    this.tick().catch((error) => console.error('[worker]', error));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    const current = this.current
      ? {
          ...this.current,
          elapsedMs: this.current.startedAtMs ? Date.now() - this.current.startedAtMs : 0,
        }
      : null;
    return {
      running: this.running,
      current,
    };
  }

  async tick() {
    if (this.running) return;
    const job = this.db.prepare(`
      SELECT * FROM jobs
      WHERE status = 'queued' AND cancel_requested = 0
      ORDER BY created_at ASC
      LIMIT 1
    `).get();
    if (!job) return;
    await this.runJob(job.id);
  }

  async runJob(jobId) {
    this.running = true;
    this.current = {jobId, rowId: ''};
    const startedAt = nowIso();
    this.db.prepare(`
      UPDATE jobs
      SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ?
    `).run(startedAt, startedAt, jobId);
    addEvent(this.db, jobId, 'job.started', 'worker started job');

    try {
      let job = getJob(this.db, jobId);
      const csvText = readFileSync(job.csv_path, 'utf8');
      const rows = listRows(this.db, jobId).filter((row) => row.status === 'queued');
      for (const row of rows) {
        job = getJob(this.db, jobId);
        if (job.cancel_requested) {
          addEvent(this.db, jobId, 'job.canceled', 'job canceled before next row');
          break;
        }
        await this.runRow(job, row, csvText);
        const afterRow = getJob(this.db, jobId);
        if (afterRow.status === 'blocked') break;
      }
      await this.finishJob(jobId);
    } catch (error) {
      const now = nowIso();
      this.markRunningRowsFailed(jobId, error.message || 'worker failed');
      this.db.prepare(`
        UPDATE jobs
        SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
        WHERE id = ?
      `).run(redact(error.message), now, now, jobId);
      addEvent(this.db, jobId, 'job.failed', redact(error.message));
      const failedJob = getJob(this.db, jobId);
      if (failedJob) cleanupJobUpload(failedJob);
    } finally {
      this.current = null;
      this.running = false;
    }
  }

  async runRow(job, row, csvText) {
    const now = nowIso();
    this.current = {
      jobId: job.id,
      rowId: row.id,
      rowNumber: row.row_number,
      profileId: row.profile_id,
      stage: 'worker.running',
      startedAt: now,
      startedAtMs: Date.now(),
    };
    this.db.prepare(`
      UPDATE job_rows
      SET status = 'running', stage = 'worker.running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ?
    `).run(now, now, row.id);
    addEvent(this.db, job.id, 'row.started', `row ${row.row_number} started`, {}, row.id);

    const options = JSON.parse(job.options_json || '{}');
    const heartbeat = this.startRowHeartbeat(job, row);
    let result;
    try {
      result = await this.executeRowFn(csvText, row.raw_index, options);
    } catch (error) {
      result = this.resultFromUnexpectedRowError(error, row);
      await this.writeUnexpectedRowOpomResult(row, result, options);
      addEvent(this.db, job.id, 'row.error', `row ${row.row_number}: ${result.message}`, {
        status: result.status,
        stage: result.stage,
      }, row.id);
    } finally {
      clearInterval(heartbeat);
    }
    const finishedAt = nowIso();
    const adsPowerStatus = await this.recordAdsPowerStatus(job, row, result, options);
    const adspowerStatusTarget = adsPowerStatus.target || result.details?.adspowerStatusTarget || 'waived_by_user';
    result.details = {
      ...(result.details || {}),
      adspowerTagStatus: adsPowerStatus.status || result.details?.adspowerTagStatus || 'skipped_user_waived',
      adspowerStatusMode: adsPowerStatus.mode || options.adspowerStatusMode || 'disabled',
      adspowerStatusTarget,
      adspowerStatusReason: adsPowerStatus.reason || result.details?.adspowerStatusReason || (adspowerStatusTarget === 'waived_by_user' ? 'user_waived_status_writeback' : ''),
    };
    this.db.prepare(`
      UPDATE job_rows
      SET status = ?, stage = ?, message = ?, purchase_status = ?, purchase_amount = ?,
        balance_before = ?, balance_after = ?, card_last4 = COALESCE(NULLIF(?, ''), card_last4),
        auto_topup_status = ?, auto_topup_threshold = ?, auto_topup_amount = ?,
        opom_card_writeback_status = COALESCE(NULLIF(?, ''), opom_card_writeback_status),
        opom_result_writeback_status = COALESCE(NULLIF(?, ''), opom_result_writeback_status),
        adspower_tag_status = COALESCE(NULLIF(?, ''), adspower_tag_status),
        adspower_status_mode = COALESCE(NULLIF(?, ''), adspower_status_mode),
        adspower_status_target = COALESCE(NULLIF(?, ''), adspower_status_target),
        adspower_status_reason = COALESCE(NULLIF(?, ''), adspower_status_reason),
        finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      result.status,
      result.stage || '',
      result.message || '',
      result.details?.purchaseStatus || '',
      result.details?.purchaseAmount || '',
      String(result.details?.balanceBefore ?? ''),
      String(result.details?.balanceAfter ?? ''),
      result.details?.cardLast4 || '',
      result.details?.autoTopupStatus || '',
      result.details?.autoTopupThreshold || '',
      result.details?.autoTopupAmount || '',
      result.details?.opomCardWritebackStatus || '',
      result.details?.opomResultWritebackStatus || '',
      result.details?.adspowerTagStatus || '',
      result.details?.adspowerStatusMode || '',
      result.details?.adspowerStatusTarget || '',
      result.details?.adspowerStatusReason || '',
      finishedAt,
      finishedAt,
      row.id,
    );
    addEvent(this.db, job.id, 'row.finished', `row ${row.row_number}: ${result.status}`, {
      status: result.status,
      stage: result.stage,
      profileStop: result.profileStop,
      adsPowerStatus,
    }, row.id);
    updateJobCounts(this.db, job.id);
    await this.writeCurrentResult(job.id);

    if (!result.safeToContinue) {
      this.db.prepare(`
        UPDATE jobs
        SET status = 'blocked', error = ?, updated_at = ?
        WHERE id = ?
      `).run(result.message || result.status, nowIso(), job.id);
      addEvent(this.db, job.id, 'job.blocked', result.message || result.status, {}, row.id);
    }
  }

  async recordAdsPowerStatus(job, row, result, options) {
    try {
      const args = runnerArgs(JSON.parse(job.options_json || '{}'));
      const adsPowerStatus = await writeAdsPowerStatus(row, {
        status: result.status,
        stage: result.stage,
        message: result.message,
      }, {
        mode: args.adspowerStatusMode || options.adspowerStatusMode,
        adspowerApiBase: args.adspowerApiBase || options.adspowerApiBase,
        adspowerApiKey: args.adspowerApiKey || options.adspowerApiKey,
        successGroupId: args.adspowerSuccessGroupId || options.adspowerSuccessGroupId,
        failureGroupId: args.adspowerFailureGroupId || options.adspowerFailureGroupId,
        blockerGroupId: args.adspowerBlockerGroupId || options.adspowerBlockerGroupId,
        successGroupName: args.adspowerSuccessGroupName || options.adspowerSuccessGroupName,
        failureGroupName: args.adspowerFailureGroupName || options.adspowerFailureGroupName,
        blockerGroupName: args.adspowerBlockerGroupName || options.adspowerBlockerGroupName,
        fetch: this.adsPowerStatusFetch,
      });
      if (adsPowerStatus.attempted) {
        addEvent(this.db, job.id, 'adspower.status', `row ${row.row_number}: ${adsPowerStatus.status}`, {
          mode: adsPowerStatus.mode,
          target: adsPowerStatus.target || '',
          groupRole: adsPowerStatus.groupRole,
          groupId: adsPowerStatus.groupId,
          ok: adsPowerStatus.ok,
          message: adsPowerStatus.message || '',
        }, row.id);
      }
      return adsPowerStatus;
    } catch (error) {
      const message = redact(error.message || 'AdsPower status write failed');
      addEvent(this.db, job.id, 'adspower.status_failed', `row ${row.row_number}: ${message}`, {}, row.id);
      return {
        attempted: true,
        ok: false,
        status: 'failed',
        message,
      };
    }
  }

  startRowHeartbeat(job, row) {
    const startedAtMs = Date.now();
    return setInterval(() => {
      const now = nowIso();
      const elapsedMs = Date.now() - startedAtMs;
      this.current = {
        ...(this.current || {}),
        jobId: job.id,
        rowId: row.id,
        rowNumber: row.row_number,
        profileId: row.profile_id,
        stage: 'worker.running',
        elapsedMs,
        startedAtMs,
      };
      try {
        this.db.prepare(`
          UPDATE job_rows
          SET stage = CASE WHEN status = 'running' THEN 'worker.running' ELSE stage END,
            updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(now, row.id);
      } catch (error) {
        console.warn('[worker heartbeat]', redact(error.message));
      }
    }, this.heartbeatMs);
  }

  resultFromUnexpectedRowError(error, row) {
    const contract = statusContract.classifyError(error?.message || error || 'row execution failed');
    return {
      status: contract.status,
      stage: contract.stage || 'worker.error',
      message: contract.message || redact(error?.message || 'row execution failed'),
      details: {
        cardLast4: row.card_last4 || '',
        cardNoLast4: row.card_last4 || '',
        opomAccountId: row.opom_account_id || '',
        username: row.username_masked || row.login_email_masked || '',
        loginEmail: row.login_email_masked || row.username_masked || '',
        loginEmailMasked: row.login_email_masked || row.username_masked || '',
        adsPowerUserId: row.ads_power_user_id || '',
        adsPowerSerialNumber: row.ads_power_serial_number || '',
        adsMatchStatus: row.ads_match_status || '',
        ejhOrderNo: row.ejh_order_no || '',
        adspowerTagStatus: row.adspower_tag_status || 'skipped_user_waived',
        adspowerStatusMode: row.adspower_status_mode || 'disabled',
        adspowerStatusTarget: row.adspower_status_target || 'waived_by_user',
        adspowerStatusReason: row.adspower_status_reason || 'user_waived_status_writeback',
      },
      safeToContinue: contract.safeToContinueBatch,
      stopProfile: contract.stopProfile,
      profileStop: {attempted: false, reason: 'row_error_before_profile_stop'},
    };
  }

  async writeUnexpectedRowOpomResult(row, result, options) {
    if (!options.opomWriteback || !row.opom_account_id) return;
    const opomRow = {
      opom_account_id: row.opom_account_id,
      login_email: row.login_email_masked || row.username_masked || '',
      ads_power_user_id: row.ads_power_user_id || '',
      ads_power_serial_number: row.ads_power_serial_number || '',
      order_no: row.ejh_order_no || '',
    };
    try {
      await writeRowResult(options, opomRow, result.details || {}, {
        rowNumber: row.row_number,
        status: result.status,
        message: result.message,
        errorCode: result.status,
      });
      result.details = {...(result.details || {}), opomResultWritebackStatus: 'written'};
    } catch {
      result.details = {...(result.details || {}), opomResultWritebackStatus: 'failed'};
    }
  }

  markRunningRowsFailed(jobId, message) {
    const now = nowIso();
    const rows = this.db.prepare(`
      SELECT id, row_number FROM job_rows
      WHERE job_id = ? AND status = 'running'
    `).all(jobId);
    if (!rows.length) return;
    const safeMessage = redact(message || 'worker failed during row execution');
    this.db.prepare(`
      UPDATE job_rows
      SET status = 'failed',
        stage = 'worker.error',
        message = ?,
        finished_at = COALESCE(finished_at, ?),
        updated_at = ?
      WHERE job_id = ? AND status = 'running'
    `).run(safeMessage, now, now, jobId);
    for (const row of rows) {
      addEvent(this.db, jobId, 'row.error', `row ${row.row_number}: ${safeMessage}`, {}, row.id);
    }
    updateJobCounts(this.db, jobId);
  }

  async writeCurrentResult(jobId) {
    const job = getJob(this.db, jobId);
    const rows = listRows(this.db, jobId);
    const rowsByRawIndex = rows
      .filter((row) => !['queued', 'running', 'ready'].includes(row.status))
      .map((row) => ({
        rawIndex: row.raw_index,
        status: row.status,
        message: row.message,
        details: {
          purchaseStatus: row.purchase_status,
          purchaseAmount: row.purchase_amount,
          balanceBefore: row.balance_before,
          balanceAfter: row.balance_after,
          cardLast4: row.card_last4,
          cardNoLast4: row.card_last4,
          autoTopupStatus: row.auto_topup_status,
          autoTopupThreshold: row.auto_topup_threshold,
          autoTopupAmount: row.auto_topup_amount,
          opomAccountId: row.opom_account_id,
          username: row.username_masked || row.login_email_masked,
          loginEmail: row.login_email_masked || row.username_masked,
          loginEmailMasked: row.login_email_masked || row.username_masked,
          adsPowerUserId: row.ads_power_user_id,
          adsPowerSerialNumber: row.ads_power_serial_number,
          adsMatchStatus: row.ads_match_status,
          ejhOrderNo: row.ejh_order_no,
          opomCardWritebackStatus: row.opom_card_writeback_status,
          opomResultWritebackStatus: row.opom_result_writeback_status,
          adspowerTagStatus: row.adspower_tag_status,
          adspowerStatusMode: row.adspower_status_mode,
          adspowerStatusTarget: row.adspower_status_target,
          adspowerStatusReason: row.adspower_status_reason,
        },
      }));
    await writeResultCsv({
      csvPath: job.csv_path,
      resultCsvPath: job.result_csv_path,
      rowsByRawIndex,
      runId: JSON.parse(job.options_json || '{}').runId || job.id,
    });
  }

  async finishJob(jobId) {
    await this.writeCurrentResult(jobId);
    updateJobCounts(this.db, jobId);
    const job = getJob(this.db, jobId);
    if (job.status === 'blocked' || job.status === 'failed') {
      cleanupJobUpload(job);
      return;
    }
    const queued = this.db.prepare(`
      SELECT COUNT(*) AS count FROM job_rows
      WHERE job_id = ? AND status IN ('queued', 'running')
    `).get(jobId).count;
    const now = nowIso();
    const finalStatus = job.cancel_requested ? 'canceled' : (queued > 0 ? 'running' : 'completed');
    this.db.prepare(`
      UPDATE jobs
      SET status = ?, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(finalStatus, now, now, jobId);
    addEvent(this.db, jobId, `job.${finalStatus}`, `job ${finalStatus}`);
    if (['completed', 'canceled'].includes(finalStatus)) cleanupJobUpload(getJob(this.db, jobId));
  }
}
