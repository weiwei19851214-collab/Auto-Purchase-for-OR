const VERIFICATION_SUBJECT = /^([0-9]{6}) is your verification code[.!]?$/i;
const VERIFICATION_SENDER = 'notifications@openrouter.ai';

// This result contains an authentication code: consume in memory only, never log it.
export function selectFreshVerification(rows, {
  expectedAccount, mailboxAccount, baselineIds, challengeStartedAt,
  now = Date.now(), maxAgeMs = 5 * 60 * 1000,
} = {}) {
  const normalize = (value) => String(value ?? '').trim().toLowerCase();
  const expected = normalize(expectedAccount);
  if (!expected || !expected.includes('@') || normalize(mailboxAccount) !== expected) {
    return {status: 'gmail_identity_mismatch'};
  }
  if (!(Array.isArray(baselineIds) || baselineIds instanceof Set)
    || !Number.isFinite(challengeStartedAt) || !Number.isFinite(now)
    || challengeStartedAt > now || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return {status: 'gmail_freshness_evidence_missing'};
  }
  const baseline = new Set(baselineIds);
  const candidates = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || normalize(row.sender) !== VERIFICATION_SENDER) continue;
    const match = String(row.subject ?? '').trim().match(VERIFICATION_SUBJECT);
    if (!match) continue;
    const {messageId, receivedAt} = row;
    if (typeof messageId !== 'string' || !messageId.trim() || baseline.has(messageId)) continue;
    // Gmail hover timestamps omit seconds. A new ID absent from the pre-challenge
    // snapshot can qualify in that same minute, with up to 59 seconds uncertainty.
    const earliest = row.timestampPrecision === 'minute'
      ? Math.floor(challengeStartedAt / 60_000) * 60_000 : challengeStartedAt;
    if (!Number.isFinite(receivedAt) || receivedAt < earliest
      || receivedAt > now || now - receivedAt > maxAgeMs) continue;
    const candidate = {code: match[1], messageId, receivedAt};
    const existing = candidates.get(messageId);
    if (existing && (existing.code !== candidate.code || existing.receivedAt !== receivedAt)) {
      return {status: 'gmail_ambiguous_verification_email'};
    }
    candidates.set(messageId, candidate);
  }
  const fresh = [...candidates.values()].sort((a, b) => b.receivedAt - a.receivedAt);
  if (fresh.length > 1) return {status: 'gmail_ambiguous_verification_email'};
  if (!fresh.length) return {status: 'gmail_waiting_for_fresh_verification'};
  return {code: fresh[0].code, messageId: fresh[0].messageId};
}

// Self-contained for Runtime.evaluate. Reads inbox subjects only; never opens mail.
// Callers must not log this snapshot because subjects may contain authentication codes.
export function readGmailInboxSnapshot() {
  const visible = (element) => Boolean(element && element.getClientRects().length
    && getComputedStyle(element).visibility !== 'hidden');
  const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const accountElements = [...document.querySelectorAll('[aria-label], [title]')].filter((element) => {
    const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`;
    return visible(element) && /Google Account|Google 帐号|Google 账号|Google 帳戶/i.test(label);
  });
  const accountEmails = [...new Set(accountElements.flatMap((element) =>
    (`${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`
      .match(emailPattern) || []).map((email) => email.toLowerCase())))];
  const titleEmails = [...new Set((document.title.match(emailPattern) || []).map((email) => email.toLowerCase()))];
  // A conflict between account control and document title is unsafe in multi-login Gmail.
  const mailboxAccount = accountEmails.length === 1
    && (titleEmails.length === 0 || (titleEmails.length === 1 && titleEmails[0] === accountEmails[0]))
    ? accountEmails[0] : accountEmails.length === 0 && titleEmails.length === 1 ? titleEmails[0] : null;
  const parseTimestamp = (raw) => {
    const value = String(raw || '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
    // Require a year and a clock. Relative strings and date-only strings cannot establish freshness.
    if (!/\b20\d{2}\b/.test(value) || !/\d{1,2}:\d{2}/.test(value)) return null;
    const chinese = value.match(/^(20\d{2})年(\d{1,2})月(\d{1,2})日\s*(上午|下午)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (chinese) {
      let hour = Number(chinese[5]);
      if (chinese[4] && (hour < 1 || hour > 12)) return null;
      if (chinese[4]) hour = hour % 12 + (chinese[4] === '下午' ? 12 : 0);
      const date = new Date(Number(chinese[1]), Number(chinese[2]) - 1, Number(chinese[3]), hour, Number(chinese[6]), Number(chinese[7] || 0));
      return date.getFullYear() === Number(chinese[1]) && date.getMonth() === Number(chinese[2]) - 1
        && date.getDate() === Number(chinese[3]) && date.getHours() === hour
        && date.getMinutes() === Number(chinese[6]) ? date.getTime() : null;
    }
    // Gmail's English hover text is e.g. "Thu, Oct 15, 2026, 10:47 AM".
    if (!/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?,? )?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? 20\d{2},? \d{1,2}:\d{2}(?::\d{2})?(?: ?[AP]M)?$/i.test(value)) return null;
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) ? epoch : null;
  };
  const isInbox = /(?:^#inbox(?:\/|$))/.test(location.hash);
  const rows = isInbox ? [...document.querySelectorAll('tr.zA')].filter(visible).slice(0, 50).map((row) => {
    const subjectElement = row.querySelector('.bog');
    const senderElement = row.querySelector('.yW [email], .yX [email]');
    const lastMessage = row.matches('[data-legacy-last-message-id]') ? row
      : row.querySelector('[data-legacy-last-message-id]');
    const identityElement = row.matches('[data-legacy-thread-id], [data-thread-id]') ? row
      : row.querySelector('[data-legacy-thread-id], [data-thread-id]');
    const timestamps = [...row.querySelectorAll('.xW [title], .xW[title]')]
      .map((element) => parseTimestamp(element.getAttribute('title'))).filter(Number.isFinite);
    const uniqueTimestamps = [...new Set(timestamps)];
    return {
      messageId: lastMessage?.getAttribute('data-legacy-last-message-id') || identityElement?.getAttribute('data-legacy-thread-id') || identityElement?.getAttribute('data-thread-id') || null,
      subject: subjectElement?.textContent?.trim() || '',
      sender: senderElement?.getAttribute('email')?.trim().toLowerCase() || '',
      receivedAt: uniqueTimestamps.length === 1 ? uniqueTimestamps[0] : null,
      timestampPrecision: 'minute',
    };
  }) : [];
  return {mailboxAccount, isInbox, rows};
}

export const GMAIL_INBOX_SNAPSHOT_EXPRESSION = `(${readGmailInboxSnapshot.toString()})()`;
