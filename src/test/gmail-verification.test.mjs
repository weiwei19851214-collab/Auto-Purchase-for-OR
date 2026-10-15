import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {selectFreshVerification, GMAIL_INBOX_SNAPSHOT_EXPRESSION} from '../automation/lib/gmail-verification.mjs';

const now = Date.UTC(2026, 9, 15, 8, 10);
const options = {
  expectedAccount: 'reader@example.test', mailboxAccount: 'reader@example.test',
  baselineIds: ['old-thread'], challengeStartedAt: now - 60_000, now,
};
const fresh = {
  messageId: 'new-thread', sender: 'notifications@openrouter.ai',
  subject: '123456 is your verification code', receivedAt: now - 30_000,
};
test('accepts a fresh subject-only OTP in the expected mailbox', () => {
  assert.deepEqual(selectFreshVerification([fresh], options), {code: '123456', messageId: 'new-thread'});
});
test('normalizes mailbox and sender case without accepting other identities', () => {
  assert.equal(selectFreshVerification([fresh], {...options, mailboxAccount: 'other@example.test'}).status, 'gmail_identity_mismatch');
  assert.equal(selectFreshVerification([fresh], {...options, mailboxAccount: null}).status, 'gmail_identity_mismatch');
  assert.equal(selectFreshVerification([{...fresh, sender: fresh.sender.toUpperCase()}], {...options, mailboxAccount: ' READER@EXAMPLE.TEST '}).code, '123456');
});
test('requires a captured baseline and valid challenge window', () => {
  for (const changes of [{baselineIds: undefined}, {challengeStartedAt: undefined}, {challengeStartedAt: now + 1}, {maxAgeMs: 0}, {now: NaN}]) {
    assert.equal(selectFreshVerification([fresh], {...options, ...changes}).status, 'gmail_freshness_evidence_missing');
  }
});
test('rejects baseline, pre-challenge, stale, future and unprovable messages', () => {
  const invalid = [
    {messageId: 'old-thread'}, {messageId: ''}, {receivedAt: null}, {receivedAt: NaN},
    {receivedAt: String(now)}, {receivedAt: now - 60_001}, {receivedAt: now + 1},
    {sender: 'attacker@example.test'}, {sender: 'notifications@openrouter.ai.evil.test'},
    {subject: 'Re: 123456 is your verification code'}, {subject: '1234567 is your verification code'},
    {subject: '123456 is your verification code click here'},
  ];
  for (const changes of invalid) {
    assert.deepEqual(selectFreshVerification([{...fresh, ...changes}], options), {status: 'gmail_waiting_for_fresh_verification'});
  }
  assert.equal(selectFreshVerification([{...fresh, receivedAt: now - 300_001}], {...options, challengeStartedAt: now - 600_000}).status, 'gmail_waiting_for_fresh_verification');
});
test('rejects multiple fresh candidates even when the visible order differs', () => {
  const another = {...fresh, messageId: 'second', receivedAt: now - 1_000, subject: '654321 is your verification code'};
  for (const rows of [[fresh, another], [another, fresh]]) {
    assert.deepEqual(selectFreshVerification(rows, options), {status: 'gmail_ambiguous_verification_email'});
  }
});
test('deduplicates repeated DOM evidence and rejects conflicting thread evidence', () => {
  assert.equal(selectFreshVerification([fresh, {...fresh}], options).code, '123456');
  assert.equal(selectFreshVerification([fresh, {...fresh, subject: '654321 is your verification code'}], options).status, 'gmail_ambiguous_verification_email');
});
test('ignores old rows before selecting fresh evidence and preserves leading zeroes', () => {
  assert.deepEqual(selectFreshVerification([{...fresh, messageId: 'old-thread'}, {...fresh, subject: '012345 is your verification code'}], options), {code: '012345', messageId: 'new-thread'});
});
test('minute precision permits new same-minute mail but still excludes baseline and prior minutes', () => {
  const minuteOptions = {...options, challengeStartedAt: now - 20_000};
  const minuteRow = {...fresh, receivedAt: now - 60_000, timestampPrecision: 'minute'};
  assert.equal(selectFreshVerification([minuteRow], minuteOptions).code, '123456');
  assert.equal(selectFreshVerification([{...minuteRow, messageId: 'old-thread'}], minuteOptions).status, 'gmail_waiting_for_fresh_verification');
  assert.equal(selectFreshVerification([{...minuteRow, receivedAt: now - 120_000}], minuteOptions).status, 'gmail_waiting_for_fresh_verification');
});

function snapshotFixture({timestamp = 'Wed, Oct 14, 2026, 10:47\u202fPM', title = 'Inbox - reader@example.test - Gmail', hash = '#inbox'} = {}) {
  const element = (attributes = {}, textContent = '') => ({
    getAttribute: (name) => attributes[name] ?? null, getClientRects: () => [{}], textContent,
  });
  const account = element({'aria-label': 'Google Account: Reader\n(reader@example.test), Important account alert'});
  const identity = element({'data-legacy-thread-id': 'thread-id', 'data-thread-id': '#thread-f:1', 'data-legacy-last-message-id': 'last-message-id'});
  const row = {
    ...element(), matches: () => false,
    querySelector: (selector) => selector === '.bog' ? element({}, fresh.subject)
      : selector === '.yW [email], .yX [email]' ? element({email: fresh.sender}) : identity,
    querySelectorAll: () => [element({title: timestamp})],
  };
  return runInNewContext(GMAIL_INBOX_SNAPSHOT_EXPRESSION, {
    document: {title, querySelectorAll: (selector) => selector === 'tr.zA' ? [row] : [account]},
    location: {hash}, getComputedStyle: () => ({visibility: 'visible'}),
  });
}
test('snapshot reads subject and last-message ID without opening email', () => {
  const snapshot = snapshotFixture();
  assert.equal(snapshot.mailboxAccount, options.expectedAccount);
  assert.equal(snapshot.rows[0].messageId, 'last-message-id');
  assert.equal(snapshot.rows[0].subject, fresh.subject);
  assert.equal(snapshot.rows[0].receivedAt, new Date(2026, 9, 14, 22, 47).getTime());
});
test('snapshot rejects imprecise dates, conflicting identities and non-inbox views', () => {
  for (const timestamp of ['10:47 PM', 'Oct 14', 'Yesterday', '10/14/26', 'Oct 14, 2026']) {
    assert.equal(snapshotFixture({timestamp}).rows[0].receivedAt, null);
  }
  assert.equal(snapshotFixture({title: 'Inbox - other@example.test - Gmail'}).mailboxAccount, null);
  assert.equal(snapshotFixture({hash: '#search/in:anywhere'}).rows.length, 0);
});
