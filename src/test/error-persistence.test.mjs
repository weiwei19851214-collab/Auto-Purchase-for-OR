import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {openDatabase} from '../server/db.mjs';
import {publicRow} from '../server/automation-adapter.mjs';

test('database migration preserves historical raw errors as detail and exposes a short message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-error-migration-'));
  const dbPath = join(dir, 'legacy.sqlite');
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE jobs (
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
      CREATE TABLE job_rows (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        row_id TEXT,
        type TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO jobs (
        id, file_name, csv_path, result_csv_path, status, created_at, updated_at
      ) VALUES ('job_1', 'input.csv', '/tmp/input.csv', '/tmp/result.csv', 'failed', 'now', 'now');
      INSERT INTO job_rows (
        id, job_id, status, stage, message
      ) VALUES (
        'row_1',
        'job_1',
        'payment_issue_card_declined',
        'purchase.submit',
        'payment_issue_card_declined: Error: Payment Issue Your card was declined for making repeated attempts too frequently or exceeding its amount limit.'
      );
    `);
    legacy.close();

    const db = openDatabase(dbPath);
    const row = db.prepare('SELECT * FROM job_rows WHERE id = ?').get('row_1');
    assert.equal(row.error_code, 'card_rate_or_amount_limit');
    assert.equal(row.message, '支付次数过多或超限');
    assert.match(row.error_detail, /repeated attempts/i);

    const exposed = publicRow({...row, missing_json: '[]'});
    assert.equal(exposed.errorCode, 'card_rate_or_amount_limit');
    assert.equal(exposed.message, '支付次数过多或超限');
    assert.match(exposed.errorDetail, /repeated attempts/i);
    db.close();
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('database migration upgrades the old Auto Top-Up entry error code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-error-upgrade-'));
  const dbPath = join(dir, 'current.sqlite');
  try {
    let db = openDatabase(dbPath);
    db.prepare(`
      INSERT INTO jobs (
        id, file_name, csv_path, result_csv_path, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('job_1', 'input.csv', '/tmp/input.csv', '/tmp/result.csv', 'failed', 'now', 'now');
    db.prepare(`
      INSERT INTO job_rows (
        id, job_id, row_number, raw_index, status, stage,
        error_code, message, error_detail, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'row_1',
      'job_1',
      2,
      0,
      'failed',
      'automation',
      'auto_topup_not_enabled',
      '自动充值未打开',
      'Auto top-up Enable button not found: {"clicked":false,"buttonTexts":[]}',
      'now',
    );
    db.close();

    db = openDatabase(dbPath);
    const row = db.prepare('SELECT error_code, message FROM job_rows WHERE id = ?').get('row_1');
    assert.equal(row.error_code, 'auto_topup_action_unavailable');
    assert.equal(row.message, '自动充值入口未加载');
    db.close();
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
