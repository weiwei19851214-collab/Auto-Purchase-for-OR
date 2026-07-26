import {mkdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {DATA_DIR, DB_PATH} from './config.mjs';
import {nowIso} from './ids.mjs';
import {simplifyError} from '../automation/lib/error-message-contract.mjs';

export function openDatabase(path = DB_PATH) {
  mkdirSync(DATA_DIR, {recursive: true});
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      csv_path TEXT NOT NULL,
      result_csv_path TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      dry_run_status TEXT NOT NULL DEFAULT 'not_run',
      total_rows INTEGER NOT NULL DEFAULT 0,
      ready_rows INTEGER NOT NULL DEFAULT 0,
      completed_rows INTEGER NOT NULL DEFAULT 0,
      failed_rows INTEGER NOT NULL DEFAULT 0,
      blocked_rows INTEGER NOT NULL DEFAULT 0,
      skipped_rows INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS job_rows (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      row_number INTEGER NOT NULL,
      raw_index INTEGER NOT NULL,
      profile_id TEXT NOT NULL DEFAULT '',
      opom_account_id TEXT NOT NULL DEFAULT '',
      username_masked TEXT NOT NULL DEFAULT '',
      login_email_masked TEXT NOT NULL DEFAULT '',
      ads_power_user_id TEXT NOT NULL DEFAULT '',
      ads_power_serial_number TEXT NOT NULL DEFAULT '',
      ads_match_status TEXT NOT NULL DEFAULT '',
      ejh_order_no TEXT NOT NULL DEFAULT '',
      card_no TEXT NOT NULL DEFAULT '',
      card_last4 TEXT NOT NULL DEFAULT '',
      payment_method_action TEXT NOT NULL DEFAULT '',
      card_provider TEXT NOT NULL DEFAULT '',
      card_type TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL DEFAULT '',
      purchase_plan TEXT NOT NULL DEFAULT '',
      amount TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      error_detail TEXT NOT NULL DEFAULT '',
      missing_json TEXT NOT NULL DEFAULT '[]',
      purchase_status TEXT NOT NULL DEFAULT '',
      purchase_amount TEXT NOT NULL DEFAULT '',
      balance_before TEXT NOT NULL DEFAULT '',
      balance_after TEXT NOT NULL DEFAULT '',
      zdr_status TEXT NOT NULL DEFAULT '',
      zdr_changed TEXT NOT NULL DEFAULT '',
      auto_topup_status TEXT NOT NULL DEFAULT '',
      auto_topup_threshold TEXT NOT NULL DEFAULT '',
      auto_topup_amount TEXT NOT NULL DEFAULT '',
      opom_card_writeback_status TEXT NOT NULL DEFAULT '',
      opom_result_writeback_status TEXT NOT NULL DEFAULT '',
      adspower_tag_status TEXT NOT NULL DEFAULT '',
      adspower_status_mode TEXT NOT NULL DEFAULT '',
      adspower_status_target TEXT NOT NULL DEFAULT '',
      adspower_status_reason TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      row_id TEXT,
      type TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduler_state (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      settings_json TEXT NOT NULL DEFAULT '{}',
      last_slot TEXT NOT NULL DEFAULT '',
      last_run_at TEXT NOT NULL DEFAULT '',
      next_run_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'disabled',
      message TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
  const columns = db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name);
  if (!columns.includes('options_json')) {
    db.exec("ALTER TABLE jobs ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}';");
  }
  const rowColumns = db.prepare('PRAGMA table_info(job_rows)').all().map((column) => column.name);
  const addRowColumn = (name) => {
    if (!rowColumns.includes(name)) db.exec(`ALTER TABLE job_rows ADD COLUMN ${name} TEXT NOT NULL DEFAULT '';`);
  };
  for (const name of [
    'opom_account_id',
    'login_email_masked',
    'ads_power_user_id',
    'ads_power_serial_number',
    'ads_match_status',
    'ejh_order_no',
    'card_no',
    'payment_method_action',
    'card_provider',
    'card_type',
    'expires_at',
    'zdr_status',
    'zdr_changed',
    'opom_card_writeback_status',
    'opom_result_writeback_status',
    'adspower_tag_status',
    'adspower_status_mode',
    'adspower_status_target',
    'adspower_status_reason',
    'error_code',
    'error_detail',
  ]) addRowColumn(name);
  backfillSimplifiedRowErrors(db);
}

function backfillSimplifiedRowErrors(db) {
  const rows = db.prepare(`
    SELECT id, status, stage, message, error_code, error_detail
    FROM job_rows
    WHERE status IN (
      'failed', 'missing_fields', 'login_required', 'identity_mismatch',
      'payment_issue_card_declined', 'manual_security_blocker', 'purchase_unverified'
    )
      AND (
        error_code = ''
        OR error_detail = ''
        OR error_code IN ('auto_topup_not_enabled', 'auto_topup_manage_missing')
      )
  `).all();
  if (!rows.length) return;
  const update = db.prepare(`
    UPDATE job_rows
    SET error_code = ?, message = ?, error_detail = ?
    WHERE id = ?
  `);
  for (const row of rows) {
    const error = simplifyError(row.error_detail || row.message, {
      status: row.status,
      stage: row.stage,
    });
    update.run(error.errorCode, error.message, error.detail, row.id);
  }
}

export function addEvent(db, jobId, type, message = '', data = {}, rowId = '') {
  db.prepare(`
    INSERT INTO events (job_id, row_id, type, message, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(jobId, rowId, type, message, JSON.stringify(data), nowIso());
}

export function getJob(db, jobId) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
}

export function listJobs(db) {
  return db.prepare(`
    SELECT * FROM jobs
    ORDER BY created_at DESC
    LIMIT 100
  `).all();
}

export function listRows(db, jobId) {
  return db.prepare(`
    SELECT * FROM job_rows
    WHERE job_id = ?
    ORDER BY row_number ASC
  `).all(jobId);
}

export function listEvents(db, jobId) {
  return db.prepare(`
    SELECT * FROM events
    WHERE job_id = ?
    ORDER BY id ASC
  `).all(jobId);
}

export function updateJobCounts(db, jobId) {
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status IN ('ready','queued') THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status IN ('failed','purchase_unverified','payment_issue_card_declined','identity_mismatch','login_required') THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('missing_fields','manual_security_blocker') THEN 1 ELSE 0 END) AS blocked,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
    FROM job_rows
    WHERE job_id = ?
  `).get(jobId);
  db.prepare(`
    UPDATE jobs
    SET total_rows = ?, ready_rows = ?, completed_rows = ?, failed_rows = ?, blocked_rows = ?, skipped_rows = ?, updated_at = ?
    WHERE id = ?
  `).run(
    counts.total || 0,
    counts.ready || 0,
    counts.completed || 0,
    counts.failed || 0,
    counts.blocked || 0,
    counts.skipped || 0,
    nowIso(),
    jobId,
  );
}

export function recoverInterruptedWork(db) {
  const now = nowIso();
  const detail = 'server restarted during row execution; verify balance before rerun';
  const error = simplifyError(detail, {status: 'purchase_unverified', stage: 'worker.interrupted'});
  const runningRows = db.prepare(`
    SELECT id, job_id FROM job_rows
    WHERE status = 'running'
  `).all();
  const affectedJobIds = new Set(runningRows.map((row) => row.job_id));
  if (runningRows.length) {
    db.prepare(`
      UPDATE job_rows
      SET status = 'purchase_unverified',
        stage = 'worker.interrupted',
        error_code = ?,
        message = ?,
        error_detail = ?,
        finished_at = COALESCE(finished_at, ?),
        updated_at = ?
      WHERE status = 'running'
    `).run(error.errorCode, error.message, error.detail, now, now);
    for (const row of runningRows) {
      addEvent(db, row.job_id, 'row.interrupted', error.message, {
        errorCode: error.errorCode,
        errorDetail: error.detail,
      }, row.id);
    }
  }

  const runningJobs = db.prepare(`
    SELECT id FROM jobs
    WHERE status = 'running'
  `).all();
  for (const job of runningJobs) {
    affectedJobIds.add(job.id);
    db.prepare(`
      UPDATE jobs
      SET status = 'blocked',
        error = ?,
        finished_at = COALESCE(finished_at, ?),
        updated_at = ?
      WHERE id = ?
    `).run('server restarted during job execution', now, now, job.id);
    addEvent(db, job.id, 'job.recovered_blocked', 'server restarted during job execution');
  }

  for (const jobId of affectedJobIds) {
    updateJobCounts(db, jobId);
  }
  return [...affectedJobIds];
}
