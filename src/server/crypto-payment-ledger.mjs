import {CRYPTO_AMOUNT_FIELDS} from '../automation/lib/crypto-amount-fields.mjs';
// Conservative durable account guard: interrupted browser work never permits another payment.
export function initializeCryptoPaymentLedger(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS crypto_payment_ledger (
    account_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, row_id TEXT NOT NULL,
    cycle_id TEXT NOT NULL DEFAULT '', phase TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS crypto_callback_outbox (
    event_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
}
export function frozenCryptoCallback(db, eventKey, buildPayload) {
  initializeCryptoPaymentLedger(db);
  const existing = db.prepare('SELECT payload_json FROM crypto_callback_outbox WHERE event_key=?').get(eventKey);
  if (existing) return JSON.parse(existing.payload_json);
  const payload = buildPayload();
  db.prepare('INSERT INTO crypto_callback_outbox(event_key,payload_json,created_at) VALUES(?,?,?)')
    .run(eventKey,JSON.stringify(payload),new Date().toISOString());
  return payload;
}
export function getCryptoPayment(db, accountId) {
  initializeCryptoPaymentLedger(db);
  return db.prepare('SELECT * FROM crypto_payment_ledger WHERE account_id = ?').get(String(accountId || '')) || null;
}
export function isCryptoAccountBlocked(db, accountId) {
  const entry = getCryptoPayment(db, accountId);
  return !!entry && !['completed', 'not_paid'].includes(entry.phase);
}
export function assertCryptoPaymentAllowed(db, accountId) {
  if (isCryptoAccountBlocked(db, accountId)) throw new Error('purchase_unverified: previous crypto payment requires reconciliation');
}
export function beginCryptoPayment(db, accountId, jobId, rowId, cycleId = '') {
  assertCryptoPaymentAllowed(db, accountId);
  const previous = getCryptoPayment(db, accountId);
  if (previous?.phase === 'completed' && (previous.row_id === rowId || (cycleId && previous.cycle_id === cycleId))) {
    throw new Error('purchase_unverified: crypto payment already completed in this cycle');
  }
  db.prepare(`INSERT INTO crypto_payment_ledger(account_id,job_id,row_id,cycle_id,phase,updated_at)
    VALUES(?,?,?,?,'executing',?) ON CONFLICT(account_id) DO UPDATE SET job_id=excluded.job_id,
    row_id=excluded.row_id,cycle_id=excluded.cycle_id,phase='executing',details_json='{}',updated_at=excluded.updated_at`)
    .run(String(accountId), jobId, rowId, cycleId, new Date().toISOString());
}
export function updateCryptoPayment(db, accountId, phase, details = {}) {
  // Explicit allowlist: never persist child input or wallet credentials.
  const safe = {};
  for (const key of ['purchaseAmount','balanceBefore','balanceAfter','adsPowerUserId','adsPowerSerialNumber','purchaseStatus','cryptoOccurredAt', ...Object.keys(CRYPTO_AMOUNT_FIELDS)]) {
    if (details[key] !== undefined) safe[key] = details[key];
  }
  db.prepare('UPDATE crypto_payment_ledger SET phase=?,details_json=?,updated_at=? WHERE account_id=?')
    .run(phase, JSON.stringify(safe), new Date().toISOString(), String(accountId));
}
