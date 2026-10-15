import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {captureGmailBaseline, submitEmailCode, completeEmailVerification} from '../automation/lib/crypto-email-verification.mjs';

const account = 'reader@example.test';
function mockPage({origin = 'https://openrouter.ai', pathname = '/settings/credits', email = account, continueCount = 1, rejected = false} = {}) {
  const calls = [];
  let clicks = 0;
  const document = {activeElement: null};
  const field = {value: '', autocomplete: 'one-time-code', disabled: false, focus() {document.activeElement = field;}};
  const buttons = Array.from({length: continueCount}, () => ({
    innerText: 'Continue', disabled: false, getClientRects: () => [{}], click() {clicks++;},
  }));
  const dialog = {
    innerText: `Verification required\nEnter code sent to your email ${email}${rejected ? '\ninvalid code' : ''}`,
    getClientRects: () => [{}], querySelector: () => field, querySelectorAll: () => buttons,
  };
  document.querySelectorAll = () => [dialog];
  document.querySelector = () => field;
  const location = {origin, pathname};
  return {
    calls, field, document, location, dialog, buttons, get clicks() {return clicks;},
    async send(method, params) {
      calls.push({method, params});
      if (method === 'Runtime.evaluate') return {result: {value: runInNewContext(params.expression, {document, location})}};
      assert.equal(method, 'Input.dispatchKeyEvent');
      if (params.type === 'keyDown' && params.key === 'Backspace') field.value = field.value.slice(0, -1);
      if (params.type === 'char') field.value += params.text;
      if (params.type === 'keyDown' && params.key === 'Tab') document.activeElement = buttons[0] || null;
      return {};
    },
  };
}

test('challenge inspection refuses other origins and other account identities', async () => {
  for (const changes of [{origin: 'https://evil.example.test'}, {pathname: '/other'}, {email: 'other@example.test'}]) {
    const page = mockPage(changes);
    await assert.rejects(submitEmailCode(page, account, '123456'), /crypto_email_challenge_changed/);
    assert.equal(page.calls.some(call => call.method === 'Input.dispatchKeyEvent'), false);
    assert.equal(page.clicks, 0);
  }
});
test('invalid or rejected codes produce safe errors before typing', async () => {
  const page = mockPage();
  await assert.rejects(submitEmailCode(page, account, 'invalid-secret-value'), /crypto_email_code_invalid/);
  assert.equal(page.calls.length, 0);
  const rejected = mockPage({rejected: true});
  await assert.rejects(submitEmailCode(rejected, account, '123456'), /crypto_email_challenge_changed/);
  assert.equal(rejected.calls.some(call => call.method === 'Input.dispatchKeyEvent'), false);
});
test('submission clears existing text, types each digit through real key events, blurs then clicks once', async () => {
  const page = mockPage();
  page.field.value = '999999';
  const result = await submitEmailCode(page, account, '012345');
  assert.deepEqual(result, {submitted: true});
  assert.equal(page.field.value, '012345');
  assert.equal(page.clicks, 1);
  const keys = page.calls.filter(call => call.method === 'Input.dispatchKeyEvent').map(call => call.params);
  assert.deepEqual(keys.slice(0, 2).map(key => [key.type, key.key]), [['keyDown', 'End'], ['keyUp', 'End']]);
  assert.equal(keys.filter(key => key.type === 'keyDown' && key.key === 'Backspace').length, 6);
  for (let index = 0; index < 6; index++) {
    const digit = '012345'[index];
    assert.deepEqual(keys.slice(14 + index * 3, 17 + index * 3).map(key => [key.type, key.key ?? key.text]), [['keyDown', digit], ['char', digit], ['keyUp', digit]]);
  }
  assert.deepEqual(keys.slice(-2).map(key => [key.type, key.key]), [['keyDown', 'Tab'], ['keyUp', 'Tab']]);
  assert.notEqual(page.document.activeElement, page.field);
});
test('ambiguous or absent Continue never clicks', async () => {
  for (const continueCount of [0, 2]) {
    const page = mockPage({continueCount});
    await assert.rejects(submitEmailCode(page, account, '123456', {continueTimeoutMs: 10}), /crypto_email_continue_unavailable/);
    assert.equal(page.clicks, 0);
  }
});
test('completion locks successful context against a second submission and closes Gmail connection', async () => {
  const page = mockPage();
  let closes = 0;
  const context = {targetId: 'gmail', baselineIds: ['old'], challengeStartedAt: Date.now() - 1000};
  const dependencies = {
    getTargets: () => [{id: 'gmail', url: 'https://mail.google.com/mail/u/0/#inbox', webSocketDebuggerUrl: 'ws://127.0.0.1/test'}],
    cdp: async () => ({
      close() {closes++;},
      async send() {return {result: {value: {trustedOrigin: true, isInbox: true, mailboxAccount: account, rows: [{messageId: 'new', sender: 'notifications@openrouter.ai', subject: '123456 is your verification code', receivedAt: Date.now()}]}}};},
    }),
  };
  const result = await completeEmailVerification({expectedAccount: account, debugPort: 1}, page, context, dependencies);
  assert.deepEqual(result, {submitted: true, source: 'gmail_subject', freshMessageVerified: true});
  assert.equal(context.submitted, true);
  assert.equal(page.clicks, 1);
  assert.equal(closes, 1);
  await assert.rejects(completeEmailVerification({expectedAccount: account}, page, context, dependencies), /baseline_missing_or_used/);
  assert.equal(page.clicks, 1);
});
test('completion refuses wrong mailbox without typing or leaking email contents', async () => {
  const page = mockPage();
  let closed = false;
  await assert.rejects(completeEmailVerification({expectedAccount: account}, page,
    {targetId: 'gmail', baselineIds: [], challengeStartedAt: Date.now() - 1000}, {
      getTargets: () => [{id: 'gmail', url: 'https://mail.google.com/mail/u/0/#inbox'}],
      cdp: async () => ({close() {closed = true;}, async send() {return {result: {value: {trustedOrigin: true, isInbox: true, mailboxAccount: 'other@example.test', rows: []}}};}}),
    }), /gmail_identity_mismatch/);
  assert.equal(closed, true);
  assert.equal(page.calls.some(call => call.method === 'Input.dispatchKeyEvent'), false);
  assert.equal(page.clicks, 0);
});
test('context is locked before awaiting page inspection so concurrent calls cannot submit twice', async () => {
  const page = mockPage();
  const send = page.send.bind(page);
  let release;
  const paused = new Promise(resolve => {release = resolve;});
  let first = true;
  page.send = async (...args) => {
    if (first) {first = false; await paused;}
    return send(...args);
  };
  const context = {targetId: 'gmail', baselineIds: [], challengeStartedAt: Date.now() - 1000};
  let connections = 0;
  const dependencies = {
    getTargets: () => [{id: 'gmail', url: 'https://mail.google.com/mail/u/0/#inbox'}],
    cdp: async () => {
      connections++;
      return {close() {}, async send() {return {result: {value: {trustedOrigin: true, isInbox: true, mailboxAccount: account, rows: [{messageId: 'new', sender: 'notifications@openrouter.ai', subject: '123456 is your verification code', receivedAt: Date.now()}]}}};}};
    },
  };
  const pending = completeEmailVerification({expectedAccount: account}, page, context, dependencies);
  assert.equal(context.inProgress, true);
  await assert.rejects(completeEmailVerification({expectedAccount: account}, page, context, dependencies), /baseline_missing_or_used/);
  assert.equal(connections, 0);
  release();
  await pending;
  assert.equal(connections, 1);
  assert.equal(page.clicks, 1);
});
test('leaving inbox prevents submission even when snapshot contains a fresh matching email', async () => {
  const page = mockPage();
  let closed = false;
  await assert.rejects(completeEmailVerification({expectedAccount: account}, page,
    {targetId: 'gmail', baselineIds: [], challengeStartedAt: Date.now() - 1000}, {
      getTargets: () => [{id: 'gmail', url: 'https://mail.google.com/mail/u/0/#inbox'}],
      cdp: async () => ({close() {closed = true;}, async send() {return {result: {value: {trustedOrigin: true, isInbox: false, mailboxAccount: account, rows: [{messageId: 'new', sender: 'notifications@openrouter.ai', subject: '123456 is your verification code', receivedAt: Date.now()}]}}};}}),
    }), /crypto_email_inbox_changed/);
  assert.equal(closed, true);
  assert.equal(page.calls.some(call => call.method === 'Input.dispatchKeyEvent'), false);
  assert.equal(page.clicks, 0);
});
test('identity or origin changes during typing stop remaining digits and prevent Continue', async () => {
  for (const change of [page => {page.location.origin = 'https://evil.example.test';}, page => {page.dialog.innerText = 'Verification required code sent to your email other@example.test';}]) {
    const page = mockPage();
    const send = page.send.bind(page);
    page.send = async (method, params) => {
      const result = await send(method, params);
      if (method === 'Input.dispatchKeyEvent' && params.type === 'char') change(page);
      return result;
    };
    await assert.rejects(submitEmailCode(page, account, '123456'), /crypto_email_challenge_changed/);
    assert.equal(page.calls.filter(call => call.params.type === 'char').length, 1);
    assert.equal(page.clicks, 0);
  }
});
test('challenge changes after blur prevent Continue submission', async () => {
  const page = mockPage();
  const send = page.send.bind(page);
  page.send = async (method, params) => {
    const result = await send(method, params);
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp' && params.key === 'Tab') page.location.pathname = '/other';
    return result;
  };
  await assert.rejects(submitEmailCode(page, account, '123456'), /crypto_email_challenge_changed/);
  assert.equal(page.clicks, 0);
});

function pollingFixture(sequence, timeoutMs = 4000) {
  const page = mockPage();
  let reads = 0;
  let closed = false;
  const context = {targetId: 'gmail', baselineIds: [], challengeStartedAt: Date.now() - 1000};
  const freshSnapshot = {trustedOrigin: true, isInbox: true, mailboxAccount: account, rows: [{messageId: 'new', sender: 'notifications@openrouter.ai', subject: '123456 is your verification code', receivedAt: Date.now()}]};
  const dependencies = {
    timeoutMs,
    getTargets: () => [{id: 'gmail', url: 'https://mail.google.com/mail/u/0/#inbox'}],
    cdp: async () => ({close() {closed = true;}, async send(method, params) {
      assert.equal(method, 'Runtime.evaluate');
      assert.equal(page.clicks, 0);
      const next = sequence[Math.min(reads++, sequence.length - 1)];
      if (next instanceof Error) throw next;
      const value = typeof next === 'function' ? next(params.expression) : next;
      return {result: {value: value === 'fresh' ? freshSnapshot : value}};
    }}),
  };
  return {page, context, get reads() {return reads;}, get closed() {return closed;},
    run: () => completeEmailVerification({expectedAccount: account}, page, context, dependencies)};
}
test('transient missing Gmail identity waits until the same account is loaded before typing', async () => {
  const fixture = pollingFixture([{trustedOrigin: true, isInbox: false, mailboxAccount: null, rows: []}, 'fresh']);
  await fixture.run();
  assert.equal(fixture.reads, 2);
  assert.equal(fixture.page.clicks, 1);
  assert.equal(fixture.closed, true);
});
test('known reload execution-context destruction retries before accepting fresh email', async () => {
  for (const message of ['Execution context was destroyed.', 'Cannot find context with specified id']) {
    const fixture = pollingFixture([new Error(message), 'fresh']);
    await fixture.run();
    assert.equal(fixture.reads, 2);
    assert.equal(fixture.page.clicks, 1);
    assert.equal(fixture.closed, true);
  }
});
test('missing identity and persistent reload errors stop at the polling deadline without typing', async () => {
  for (const value of [{trustedOrigin: true, isInbox: true, mailboxAccount: null, rows: []}, new Error('Execution context was destroyed.')]) {
    const fixture = pollingFixture([value], 20);
    await assert.rejects(fixture.run(), /crypto_email_fresh_message_timeout/);
    assert.equal(fixture.page.calls.some(call => call.method === 'Input.dispatchKeyEvent'), false);
    assert.equal(fixture.closed, true);
  }
});
test('arbitrary CDP errors are not retried', async () => {
  const fixture = pollingFixture([new Error('CDP connection closed'), 'fresh']);
  await assert.rejects(fixture.run(), /CDP connection closed/);
  assert.equal(fixture.reads, 1);
  assert.equal(fixture.page.clicks, 0);
  assert.equal(fixture.closed, true);
});
test('a conflicting nonempty Gmail account after loading fails immediately', async () => {
  const fixture = pollingFixture([{trustedOrigin: true, isInbox: true, mailboxAccount: 'other@example.test', rows: []}, 'fresh']);
  await assert.rejects(fixture.run(), /gmail_identity_mismatch/);
  assert.equal(fixture.reads, 1);
  assert.equal(fixture.page.calls.some(call => call.method === 'Input.dispatchKeyEvent'), false);
});
test('snapshot verifies live Gmail origin and rejects navigation before reading rows', async () => {
  const fixture = pollingFixture([expression => runInNewContext(expression, {location: {origin: 'https://evil.example.test'}})]);
  await assert.rejects(fixture.run(), /crypto_email_gmail_origin_changed/);
  assert.equal(fixture.reads, 1);
  assert.equal(fixture.page.calls.some(call => call.method === 'Input.dispatchKeyEvent'), false);
  assert.equal(fixture.closed, true);
});

test('email verification failure pauses the batch instead of retrying another payment', async () => {
  const {classifyError} = await import('../automation/lib/status-contract.mjs');
  for (const reason of ['fresh_message_timeout', 'verification_rejected', 'baseline_missing_or_used']) {
    const result = classifyError('manual_security_blocker: crypto_email_' + reason);
    assert.equal(result.status, 'manual_security_blocker');
    assert.equal(result.stage, 'crypto.email_verification');
    assert.equal(result.safeToContinueBatch, false);
    assert.equal(result.stopProfile, false);
  }
});

function mockPollingClock(t) {
  let now = 1800000000000;
  const startedAt = now;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay = 0) => {
    now += delay;
    queueMicrotask(callback);
    return 0;
  });
  return {get elapsed() {return now - startedAt;}};
}
function baselineFixture({targets = [], sequence = [], createdSequence = sequence} = {}) {
  const created = {id: 'created-gmail', type: 'page', url: 'https://mail.google.com/mail/u/?authuser=reader%40example.test#inbox', webSocketDebuggerUrl: 'ws://created'};
  const reads = new Map();
  const closes = [];
  const creates = [];
  const dependencies = {
    getTargets: () => targets,
    async createTarget(...args) {creates.push(args); return created;},
    async cdp(url) {
      return {
        close() {closes.push(url);},
        async send(method) {
          if (method === 'Page.navigate') return {};
          assert.equal(method, 'Runtime.evaluate');
          const values = url === created.webSocketDebuggerUrl ? createdSequence : sequence;
          const index = reads.get(url) || 0;
          reads.set(url, index + 1);
          const value = values[Math.min(index, values.length - 1)];
          if (value instanceof Error) throw value;
          return {result: {value}};
        },
      };
    },
  };
  return {dependencies, creates, closes, reads,
    run: (overrides = {}) => captureGmailBaseline({expectedAccount: account, debugPort: 62027}, {...dependencies, ...overrides})};
}
const baselineSnapshot = {trustedOrigin: true, mailboxAccount: account, isInbox: true, rows: [{messageId: 'before-purchase'}]};
const existingGmailTarget = {id: 'existing-gmail', type: 'page', url: 'https://mail.google.com/mail/u/0/#inbox', webSocketDebuggerUrl: 'ws://existing'};

test('baseline opens an account-directed Gmail inbox when no Gmail tab exists', async () => {
  const fixture = baselineFixture({createdSequence: [baselineSnapshot]});
  const result = await fixture.run();
  assert.deepEqual(fixture.creates, [[62027, 'https://mail.google.com/mail/u/?authuser=reader%40example.test#inbox']]);
  assert.equal(result.targetId, 'created-gmail');
  assert.deepEqual(result.baselineIds, ['before-purchase']);
  assert.equal(typeof result.challengeStartedAt, 'number');
  assert.deepEqual(fixture.closes, ['ws://created']);
});
test('baseline reuses a matching existing inbox without creating another tab', async () => {
  const fixture = baselineFixture({targets: [existingGmailTarget], sequence: [baselineSnapshot]});
  const result = await fixture.run();
  assert.equal(result.targetId, existingGmailTarget.id);
  assert.equal(fixture.creates.length, 0);
  assert.deepEqual(fixture.closes, ['ws://existing']);
});
test('baseline opens the requested account when existing Gmail belongs to another account', async () => {
  const fixture = baselineFixture({targets: [existingGmailTarget],
    sequence: [{...baselineSnapshot, mailboxAccount: 'other@example.test'}], createdSequence: [baselineSnapshot]});
  const result = await fixture.run();
  assert.equal(result.targetId, 'created-gmail');
  assert.equal(fixture.creates.length, 1);
  assert.deepEqual(fixture.closes, ['ws://existing', 'ws://created']);
});
test('baseline tolerates loading and context replacement but records only the verified inbox', async t => {
  mockPollingClock(t);
  const fixture = baselineFixture({createdSequence: [
    {trustedOrigin: true, mailboxAccount: null, isInbox: false, rows: []},
    new Error('Execution context was destroyed.'),
    {...baselineSnapshot, rows: []},
    baselineSnapshot,
  ]});
  const result = await fixture.run();
  assert.deepEqual(result.baselineIds, ['before-purchase']);
  assert.equal(fixture.reads.get('ws://created'), 4);
  assert.deepEqual(fixture.closes, ['ws://created']);
});
test('baseline fails safely when the inbox never finishes loading within twenty seconds', async t => {
  const clock = mockPollingClock(t);
  const fixture = baselineFixture({createdSequence: [{trustedOrigin: true, mailboxAccount: null, isInbox: false, rows: []}]});
  await assert.rejects(fixture.run(), /crypto_email_gmail_not_ready/);
  assert.equal(clock.elapsed, 20000);
  assert.deepEqual(fixture.closes, ['ws://created']);
});
test('baseline never accepts a conflicting identity or untrusted origin in the newly opened inbox', async t => {
  mockPollingClock(t);
  for (const snapshot of [{...baselineSnapshot, mailboxAccount: 'other@example.test'}, {...baselineSnapshot, trustedOrigin: false}]) {
    const fixture = baselineFixture({createdSequence: [snapshot]});
    await assert.rejects(fixture.run(), snapshot.trustedOrigin ? /crypto_email_identity_mismatch/ : /crypto_email_gmail_not_ready/);
    assert.deepEqual(fixture.closes, ['ws://created']);
  }
});
test('fresh verification default wait ends at forty seconds without submitting a code', async t => {
  const clock = mockPollingClock(t);
  const page = mockPage();
  let closed = false;
  await assert.rejects(completeEmailVerification({expectedAccount: account}, page,
    {targetId: 'gmail', baselineIds: ['old'], challengeStartedAt: Date.now()}, {
      getTargets: () => [{id: 'gmail', url: 'https://mail.google.com/mail/u/0/#inbox'}],
      cdp: async () => ({close() {closed = true;}, async send() {
        return {result: {value: {trustedOrigin: true, isInbox: true, mailboxAccount: null, rows: []}}};
      }}),
    }), /crypto_email_fresh_message_timeout/);
  assert.equal(clock.elapsed, 40000);
  assert.equal(page.clicks, 0);
  assert.equal(page.calls.some(call => call.method === 'Input.dispatchKeyEvent'), false);
  assert.equal(closed, true);
});

test('baseline never accepts inbox rows lacking message identifiers', async t => {
  mockPollingClock(t);
  const fixture = baselineFixture({createdSequence: [{...baselineSnapshot, rows: [{messageId: ''}]}]});
  await assert.rejects(fixture.run(), /crypto_email_gmail_not_ready/);
  assert.deepEqual(fixture.closes, ['ws://created']);
});


test('Continue waits for asynchronous enablement after blur and clicks once', async t => {
  mockPollingClock(t);
  const page = mockPage();
  let polls = 0;
  const send = page.send.bind(page);
  page.buttons[0].disabled = true;
  page.buttons[0].innerText = '  Continue  ';
  page.send = async (method, params) => {
    if (params.expression?.includes("return 'waiting_disabled'")) {
      if (++polls === 3) page.buttons[0].disabled = false;
    }
    return send(method, params);
  };
  await submitEmailCode(page, account, '123456');
  assert.equal(polls, 3);
  assert.equal(page.clicks, 1);
  assert.equal(page.calls.filter(c => c.params.type === 'char').length, 6);
});

test('Continue stays disabled until bounded deadline without repeated code submission', async t => {
  const clock = mockPollingClock(t);
  const page = mockPage();
  page.buttons[0].disabled = true;
  await assert.rejects(submitEmailCode(page, account, '123456'), /crypto_email_continue_unavailable/);
  assert.equal(clock.elapsed, 5000);
  assert.equal(page.clicks, 0);
  assert.equal(page.calls.filter(c => c.params.type === 'char').length, 6);
});

test('identity change while waiting for Continue prevents the click', async t => {
  mockPollingClock(t);
  const page = mockPage();
  const send = page.send.bind(page);
  page.send = async (method, params) => {
    if (params.expression?.includes("return 'waiting_disabled'")) page.dialog.innerText = 'Verification required code sent to your email other@example.test';
    return send(method, params);
  };
  await assert.rejects(submitEmailCode(page, account, '123456'), /crypto_email_challenge_changed/);
  assert.equal(page.clicks, 0);
});


test('dialog disappearance during Continue readiness does not click again or claim verification success', async t => {
  mockPollingClock(t);
  const page = mockPage();
  const send = page.send.bind(page);
  page.send = async (method, params) => {
    if (params.expression?.includes("return 'waiting_disabled'")) page.document.querySelectorAll = () => [];
    return send(method, params);
  };
  const result = await submitEmailCode(page, account, '123456');
  assert.deepEqual(result, {submitted: true});
  assert.equal(page.clicks, 0);
  assert.equal('verified' in result, false);
});
