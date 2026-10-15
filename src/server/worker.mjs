import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {addEvent, getJob, listRows, updateJobCounts} from './db.mjs';
import {nowIso} from './ids.mjs';
import {redact} from './redact.mjs';
import {executeRow, runnerArgs, writeResultCsv, automationLogDirForRow} from './automation-adapter.mjs';
import {writeAdsPowerStatus} from './adspower-status.mjs';
import {writeRowResult, writeCryptoCompletedRow} from './opom-client.mjs';
import * as statusContract from '../automation/lib/status-contract.mjs';
import {simplifyError} from '../automation/lib/error-message-contract.mjs';
import {CRYPTO_TASK_TIMEOUT_MS} from './config.mjs';
import * as adspower from '../automation/lib/adspower.mjs';
import {CRYPTO_AMOUNT_FIELDS, cryptoAmountsWithCheckpoint} from '../automation/lib/crypto-amount-fields.mjs';

import {walletPasswordForRow, walletSeedForRow} from './crypto-wallet-secrets.mjs';
import {getCryptoPayment, beginCryptoPayment, updateCryptoPayment} from './crypto-payment-ledger.mjs';

// Store observed accounting values as text; never infer missing amounts.
const CRYPTO_ACCOUNTING_FIELDS = Object.entries(CRYPTO_AMOUNT_FIELDS).map(([key, column]) => [column, key]);

const ERROR_ROW_STATUSES = new Set([
  'failed',
  'missing_fields',
  'login_required',
  'identity_mismatch',
  'payment_issue_card_declined',
  'manual_security_blocker',
  'purchase_unverified',
]);

export function normalizeResultError(result = {}) {
  if (!ERROR_ROW_STATUSES.has(result.status)) {
    return {
      ...result,
      errorCode: '',
      errorDetail: '',
    };
  }
  const normalized = simplifyError(result.errorDetail || result.message || result.status, {
    status: result.status,
    stage: result.stage,
  });
  const preserveBusinessMessage = result.errorCode === 'crypto_insufficient_funds';
  return {
    ...result,
    errorCode: result.errorCode || normalized.errorCode,
    // 虚拟币余额不足要在“阻塞原因”直接展示币种和所需金额，不能被通用错误文案覆盖。
    message: preserveBusinessMessage ? redact(result.message) : normalized.message,
    errorDetail: result.errorDetail || normalized.detail,
    details: {
      ...(result.details || {}),
      errorCode: result.errorCode || normalized.errorCode,
    },
  };
}

export class JobWorker {
  constructor(db, options = {}) {
    this.db = db;
    this.intervalMs = options.intervalMs || 1500;
    this.heartbeatMs = options.heartbeatMs || 10000;
    this.cryptoTaskTimeoutMs = options.cryptoTaskTimeoutMs || CRYPTO_TASK_TIMEOUT_MS;
    this.executeRowFn = options.executeRowFn || executeRow;
    this.writeRowResultFn = options.writeRowResultFn || writeCryptoCompletedRow;
    this.adsPowerStatusFetch = options.adsPowerStatusFetch || globalThis.fetch?.bind(globalThis);
    this.timer = null;
    this.running = false;
    this.current = null;
    this.currentRows = new Map();
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
    const currentRows = [...this.currentRows.values()].map((row) => ({
      ...row,
      elapsedMs: row.startedAtMs ? Date.now() - row.startedAtMs : 0,
    })).sort((a, b) => Number(a.rowNumber || 0) - Number(b.rowNumber || 0));
    const current = currentRows[0] || null;
    return {
      running: this.running,
      current,
      currentRows,
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
      await this.runRows(jobId, rows, csvText);
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
    } finally {
      this.current = null;
      this.currentRows.clear();
      this.running = false;
    }
  }

  async runRows(jobId, rows, csvText) {
    if (!rows.length) return;
    const options = JSON.parse(getJob(this.db, jobId)?.options_json || '{}');
    const args = runnerArgs(options);
    // 本批按创建任务时保存的并发数执行；恢复任务不读取页面临时状态。
    const concurrency = options.cryptoScheduled ? 1 : Math.min(rows.length, args.concurrency || 1);
    addEvent(this.db, jobId, 'job.concurrency', `worker concurrency ${concurrency}/${args.concurrency}`, {
      requested: args.concurrency,
      effective: concurrency,
      queuedRows: rows.length,
    });
    let nextIndex = 0;
    const takeNextRow = () => rows[nextIndex++];
    const workers = Array.from({length: concurrency}, async () => {
      while (nextIndex < rows.length) {
        const job = getJob(this.db, jobId);
        if (!job || job.cancel_requested || ['blocked', 'failed'].includes(job.status)) {
          if (job?.cancel_requested) addEvent(this.db, jobId, 'job.canceled', 'job canceled before next row');
          break;
        }
        const row = takeNextRow();
        if (!row) break;
        if (options.cryptoScheduled) {
          const schedule = this.db.prepare("SELECT enabled FROM scheduler_state WHERE id='auto-recharge:crypto'").get();
          if (!schedule?.enabled || !walletPasswordForRow(job.id, row.raw_index)) {
            this.db.prepare("UPDATE jobs SET status='blocked',error='crypto_schedule_paused',updated_at=? WHERE id=?").run(nowIso(), job.id);
            addEvent(this.db, job.id, 'job.blocked', '虚拟币计划已停用或钱包密码缺失，尚未开始的行保持排队');
            break;
          }
        }
        await this.runRow(job, row, csvText);
        const afterRow = getJob(this.db, jobId);
        if (!afterRow || ['blocked', 'failed'].includes(afterRow.status)) break;
      }
    });
    await Promise.all(workers);
  }

  async runRow(job, row, csvText) {
    const now = nowIso();
    const current = {
      jobId: job.id,
      rowId: row.id,
      rowNumber: row.row_number,
      taskRowNumber: Math.max(1, Number(row.row_number || 0) - 1),
      profileId: row.profile_id,
      stage: 'worker.running',
      startedAt: now,
      startedAtMs: Date.now(),
    };
    this.currentRows.set(row.id, current);
    this.refreshCurrent();
    this.db.prepare(`
      UPDATE job_rows
      SET status = 'running', stage = 'worker.running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ?
    `).run(now, now, row.id);
    addEvent(this.db, job.id, 'row.started', `row ${row.row_number} started`, {}, row.id);

    const options = JSON.parse(job.options_json || '{}');
    const rowArgs = runnerArgs(options);
    const heartbeat = this.startRowHeartbeat(job, row);
    let result;
    let unexpectedError = false;
    const runtimeLog = {jobId: job.id, rowId: row.id, rowNumber: row.row_number};
    const cryptoAccountingAttemptId = rowArgs.rechargeMode === 'crypto' ? randomUUID() : '';
    const accountKey = row.opom_account_id || row.ads_power_user_id || row.profile_id || '';
    const guardedCrypto = rowArgs.rechargeMode === 'crypto' && options.confirmWalletPayment === true;
    const previousPayment = guardedCrypto ? getCryptoPayment(this.db, accountKey) : null;
    const executionAbort = new AbortController();
    try {
      if (guardedCrypto && !accountKey) throw new Error('manual_security_blocker: missing crypto account identity');
      if (guardedCrypto && previousPayment?.phase !== 'credited') {
        beginCryptoPayment(this.db, accountKey, job.id, row.id, options.cryptoCycleId || '');
      }
      const executionPromise = previousPayment?.phase === 'credited'
        ? Promise.resolve({status: 'completed', details: JSON.parse(previousPayment.details_json), safeToContinue: true})
        : this.executeRowFn(csvText, row.raw_index, {
        ...options,
        runtimeLog,
        runtimeAbortSignal: executionAbort.signal,
        runtimeWalletPassword: walletPasswordForRow(job.id, row.raw_index) || options.runtimeWalletPassword || '',
        runtimeSeedPhrase: options.cryptoScheduled ? '' : walletSeedForRow(job.id, row.raw_index) || options.runtimeSeedPhrase || '',
        ...(cryptoAccountingAttemptId ? {cryptoAccountingAttemptId} : {}),
      });
      if (rowArgs.rechargeMode !== 'crypto') {
        result = await executionPromise;
      } else {
        const elapsedMs = Date.now() - current.startedAtMs;
        const remainingMs = Math.max(1, this.cryptoTaskTimeoutMs - elapsedMs);
        let timeoutHandle;
        const timeoutPromise = new Promise((resolve) => {
          timeoutHandle = setTimeout(() => resolve({timedOut: true}), remainingMs);
        });
        let outcome;
        try {
          outcome = await Promise.race([executionPromise, timeoutPromise]);
        } finally {
          clearTimeout(timeoutHandle);
        }
        if (!outcome?.timedOut) {
          result = outcome;
        } else {
          executionAbort.abort();
          executionPromise.catch(() => {});
          result = {
            status: 'purchase_unverified', stage: 'crypto.timeout', errorCode: 'crypto_task_timeout',
            message: '虚拟币流程超时，已暂停并保留浏览器，请核验本次付款后再处理',
            details: cryptoAmountsWithCheckpoint({confirmationDebugDir: automationLogDirForRow(runtimeLog, row.raw_index), cryptoAccountingAttemptId}),
            safeToContinue: false, stopProfile: false,
          };
        }
      }
    } catch (error) {
      unexpectedError = true;
      result = this.resultFromUnexpectedRowError(error, row);
      if (guardedCrypto) result = {...result, status: 'purchase_unverified', safeToContinue: false, stopProfile: false};
    } finally {
      clearInterval(heartbeat);
    }
    if (guardedCrypto) {
      const owned = getCryptoPayment(this.db, accountKey);
      const canUpdate = owned?.row_id === row.id || previousPayment?.phase === 'credited';
      if (result.status === 'completed' && canUpdate) {
        const details = result.details || {};
        const verified = Number.isFinite(Number(details.balanceAfter)) && details.balanceAfter !== ''
          && Number.isFinite(Number(details.balanceBefore)) && details.balanceBefore !== ''
          && Number(details.balanceAfter) > Number(details.balanceBefore);
        if (!verified) {
          result = {...result, status: 'purchase_unverified', message: '虚拟币到账余额未验证', safeToContinue: false, stopProfile: false};
          updateCryptoPayment(this.db, accountKey, 'unverified', details);
        } else {
          updateCryptoPayment(this.db, accountKey, 'credited', details);
          try {
            if (options.opomWriteback && row.opom_account_id) {
              const written = await (this.writeRowResultFn || writeCryptoCompletedRow)({...options, runId: owned.job_id}, {
                opom_account_id: row.opom_account_id, ads_power_user_id: row.ads_power_user_id,
                ads_power_serial_number: row.ads_power_serial_number,
                result_idempotency_key: 'crypto:' + owned.job_id + ':' + owned.row_id,
              }, details, {runId: owned.job_id, rowNumber: row.row_number, status: 'completed', stage: 'closed_loop.complete'});
              if (written.resultStatus !== 'written') throw new Error('OPOM result not written');
              result.details = {...details, opomResultWritebackStatus: 'written'};
            } else if (options.cryptoScheduled) throw new Error('scheduled crypto requires OPOM writeback');
            updateCryptoPayment(this.db, accountKey, 'completed', details);
          } catch (error) {
            result = {...result, status: 'failed', stage: 'opom.writeback',
              errorCode: /^OPOM network failed/i.test(error.message || '') ? 'opom_writeback_network_failed' : 'opom_writeback_failed',
              errorDetail: redact(error.message || String(error)),
              message: '充值已到账，OPOM 写回待重试；禁止再次付款',
              details: {...details, opomResultWritebackStatus: 'failed'}, safeToContinue: false, stopProfile: false};
          }
        }
      } else if (canUpdate && !['completed', 'credited'].includes(owned.phase)) {
        const confirmationSubmitted = result.details?.cryptoPurchase?.walletPaymentConfirmation?.confirmed === true
          || result.details?.cryptoPurchase?.walletPaymentConfirmation?.confirmationClicked === true
          || result.details?.walletPaymentConfirmation?.confirmed === true || result.details?.walletPaymentConfirmation?.confirmationClicked === true;
        const unpaid = !confirmationSubmitted && result.details?.cryptoPaymentNotStarted === true;
        updateCryptoPayment(this.db, accountKey, unpaid ? 'not_paid' : 'unverified', result.details);
        if (!unpaid) result = {...result, safeToContinue: false, stopProfile: false};
        else if (result.status !== 'manual_security_blocker' && result.errorCode !== 'crypto_insufficient_funds') result = {...result, safeToContinue: true};
      }
    }
    const explicitInsufficientFunds = !unexpectedError && (result.errorCode === 'crypto_insufficient_funds'
      || result.status === 'crypto_insufficient_funds');
    result = normalizeResultError(result);
    if (options.cryptoScheduled && rowArgs.rechargeMode === 'crypto') {
      // A blocked account retains its payment ledger and browser for reconciliation;
      // it must not prevent independent accounts from being processed.
      result.safeToContinue = !explicitInsufficientFunds;
      if (!explicitInsufficientFunds && result.errorCode === 'crypto_insufficient_funds') {
        result.errorCode = 'crypto_row_failed';
        result.details.errorCode = result.errorCode;
      }
    }
    if (unexpectedError) {
      if (rowArgs.rechargeMode === 'crypto' && rowArgs.stopProfiles && result.stopProfile === true
        && result.profileStop?.attempted !== true) {
        // 适配器之外抛出的单行异常也必须回收 AdsPower profile，避免钱包窗口残留。
        result.profileStop = await adspower.stopProfile(rowArgs, {
          userId: row.ads_power_user_id || row.profile_id || '',
          serialNumber: row.ads_power_serial_number || '',
        });
      }
      if (!guardedCrypto) await this.writeUnexpectedRowOpomResult(row, result, options);
      addEvent(this.db, job.id, 'row.error', `row ${row.row_number}: ${result.message}`, {
        status: result.status,
        stage: result.stage,
        errorCode: result.errorCode,
        errorDetail: result.errorDetail,
      }, row.id);
    }
    try {
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
        SET status = ?, stage = ?, error_code = ?, message = ?, error_detail = ?,
          purchase_status = ?, purchase_amount = ?,
          balance_before = ?, balance_after = ?,
          ${CRYPTO_ACCOUNTING_FIELDS.map(([column]) => `${column} = ?`).join(', ')},
          ads_power_user_id = COALESCE(NULLIF(?, ''), ads_power_user_id),
          ads_power_serial_number = COALESCE(NULLIF(?, ''), ads_power_serial_number),
          card_no = COALESCE(NULLIF(?, ''), card_no),
          card_last4 = COALESCE(NULLIF(?, ''), card_last4),
          payment_method_action = COALESCE(NULLIF(?, ''), payment_method_action),
          card_provider = COALESCE(NULLIF(?, ''), card_provider),
          card_type = COALESCE(NULLIF(?, ''), card_type),
          expires_at = COALESCE(NULLIF(?, ''), expires_at),
          zdr_status = ?, zdr_changed = ?,
          data_training_status = ?, data_training_changed = ?,
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
        result.errorCode || '',
        result.message || '',
        result.errorDetail || '',
        result.details?.purchaseStatus || '',
        result.details?.purchaseAmount || '',
        String(result.details?.balanceBefore ?? ''),
        String(result.details?.balanceAfter ?? ''),
        ...CRYPTO_ACCOUNTING_FIELDS.map(([, key]) => String(result.details?.[key] ?? '')),
        result.details?.adsPowerUserId || row.ads_power_user_id || '',
        result.details?.adsPowerSerialNumber || row.ads_power_serial_number || '',
        result.details?.cardNo || '',
        result.details?.cardLast4 || '',
        result.details?.paymentMethodAction || '',
        row.card_provider || result.details?.cardProvider || '',
        result.details?.cardType || row.card_type || '',
        result.details?.cardExpiresAt || row.expires_at || '',
        result.details?.zdrStatus || '',
        result.details?.zdrChanged || '',
        result.details?.dataTrainingStatus || '',
        result.details?.dataTrainingChanged || '',
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
      if (result.details?.paymentMethodAction === 'existing_preserved') {
        this.db.prepare(`
          UPDATE job_rows
          SET ejh_order_no = '',
            card_no = '',
            card_provider = '',
            card_type = '',
            expires_at = ''
          WHERE id = ?
        `).run(row.id);
      }
      addEvent(this.db, job.id, 'row.finished', `row ${row.row_number}: ${result.status}`, {
        status: result.status,
        stage: result.stage,
        errorCode: result.errorCode || '',
        errorDetail: result.errorDetail || '',
        logDir: result.details?.automationLogDir || '',
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
        `).run(options.cryptoScheduled && explicitInsufficientFunds ? 'crypto_insufficient_funds' : result.message || result.status, nowIso(), job.id);
        addEvent(this.db, job.id, 'job.blocked', result.message || result.status, {}, row.id);
      }
    } finally {
      this.currentRows.delete(row.id);
      this.refreshCurrent();
    }
  }

  refreshCurrent() {
    const rows = [...this.currentRows.values()]
      .sort((a, b) => Number(a.rowNumber || 0) - Number(b.rowNumber || 0));
    this.current = rows[0] || null;
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
      const current = {
        ...(this.currentRows.get(row.id) || {}),
        jobId: job.id,
        rowId: row.id,
        rowNumber: row.row_number,
        taskRowNumber: Math.max(1, Number(row.row_number || 0) - 1),
        profileId: row.profile_id,
        stage: 'worker.running',
        elapsedMs,
        startedAtMs,
      };
      this.currentRows.set(row.id, current);
      this.refreshCurrent();
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
        cardNo: row.card_no || '',
        paymentMethodAction: row.payment_method_action || '',
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
        stage: 'worker.exception',
        message: result.message,
        errorCode: result.errorCode || result.status,
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
    const error = simplifyError(message || 'worker failed during row execution', {
      status: 'failed',
      stage: 'worker.error',
    });
    this.db.prepare(`
      UPDATE job_rows
      SET status = 'failed',
        stage = 'worker.error',
        error_code = ?,
        message = ?,
        error_detail = ?,
        finished_at = COALESCE(finished_at, ?),
        updated_at = ?
      WHERE job_id = ? AND status = 'running'
    `).run(error.errorCode, error.message, error.detail, now, now, jobId);
    for (const row of rows) {
      addEvent(this.db, jobId, 'row.error', `row ${row.row_number}: ${error.message}`, {
        errorCode: error.errorCode,
        errorDetail: error.detail,
      }, row.id);
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
        errorCode: row.error_code || '',
        errorDetail: row.error_detail || '',
        message: row.message,
        details: {
          errorCode: row.error_code || '',
          purchaseStatus: row.purchase_status,
          purchaseAmount: row.purchase_amount,
          balanceBefore: row.balance_before,
          balanceAfter: row.balance_after,
          ...Object.fromEntries(CRYPTO_ACCOUNTING_FIELDS.map(([column, key]) => [key, row[column] ?? ''])),
          cardLast4: row.card_last4,
          cardNo: row.card_no,
          paymentMethodAction: row.payment_method_action || '',
          zdrStatus: row.zdr_status || '',
          zdrChanged: row.zdr_changed || '',
          dataTrainingStatus: row.data_training_status || '',
          dataTrainingChanged: row.data_training_changed || '',
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
  }
}
