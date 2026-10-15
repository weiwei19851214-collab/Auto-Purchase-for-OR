import assert from 'node:assert/strict';
import test from 'node:test';
import {continueRiskWarning} from '../automation/lib/crypto-risk-continue.mjs';

const risk = () => ({stage: 'risk_warning', originOk: true});
const confirmed = () => ({stage: 'confirm_send', originOk: true, hasAmount: true, hasNetwork: true});
function harness({inspect, trigger, capture} = {}) {
  let time = 0;
  const calls = [];
  const evidence = [];
  let state = risk();
  return {
    calls, evidence,
    options: {
      inspect: async () => inspect ? inspect({time, calls, state}) : state,
      trigger: async method => {
        calls.push({method, time});
        if (trigger) await trigger(method, next => { state = next; });
      },
      capture: async event => { evidence.push(event); if (capture) await capture(event, next => { state = next; }); },
      now: () => time,
      sleep: async ms => { time += ms; },
    },
  };
}

test('DOM success is verified, with no fallback click', async () => {
  const h = harness({trigger: (method, set) => set(confirmed())});
  const result = await continueRiskWarning(h.options);
  assert.equal(result.method, 'dom');
  assert.deepEqual(h.calls, [{method: 'dom', time: 0}]);
  assert.deepEqual(h.evidence.map(e => e.phase), ['before', 'after', 'success']);
});

test('each fallback waits twenty seconds and only dispatches once', async () => {
  const h = harness({trigger: (method, set) => { if (method === 'playwright') set(confirmed()); }});
  const result = await continueRiskWarning(h.options);
  assert.equal(result.method, 'playwright');
  assert.deepEqual(h.calls, [{method: 'dom', time: 0}, {method: 'cdp', time: 20000}, {method: 'playwright', time: 40000}]);
});

test('third timeout stops with fixed manual blocker', async () => {
  const h = harness();
  await assert.rejects(continueRiskWarning(h.options), error => {
    assert.equal(error.code, 'crypto_wallet_transaction_risk_warning_not_dismissed');
    assert.equal(error.status, 'manual_security_blocker');
    assert.equal(error.attempts.length, 3);
    return true;
  });
  assert.equal(h.evidence.filter(e => e.phase === 'timeout').length, 3);
});

test('unknown page is observed until deadline and never clicked again', async () => {
  const h = harness({trigger: (method, set) => set({stage: 'unknown', originOk: true})});
  await assert.rejects(continueRiskWarning(h.options), {code: 'crypto_wallet_transaction_page_changed'});
  assert.equal(h.calls.length, 1);
  assert.ok(h.evidence.some(e => e.phase === 'timeout'));
});

test('unknown transient page can become verified confirmation', async () => {
  const h = harness({inspect: ({time, calls}) => !calls.length ? risk() : time >= 1000 ? confirmed() : {stage: 'unknown'}});
  assert.equal((await continueRiskWarning(h.options)).method, 'dom');
  assert.equal(h.calls.length, 1);
});

test('late transition during timeout evidence prevents second dispatch', async () => {
  const h = harness({capture: (event, set) => { if (event.phase === 'timeout') set(confirmed()); }});
  assert.equal((await continueRiskWarning(h.options)).method, 'dom');
  assert.equal(h.calls.length, 1);
});

test('confirmation exactly at deadline succeeds without fallback', async () => {
  const h = harness({inspect: ({time}) => time >= 20000 ? confirmed() : risk()});
  assert.equal((await continueRiskWarning(h.options)).method, 'dom');
  assert.equal(h.calls.length, 1);
});

test('transition during before evidence prevents stale click', async () => {
  const h = harness({capture: (event, set) => { if (event.phase === 'before') set(confirmed()); }});
  await continueRiskWarning(h.options);
  assert.equal(h.calls.length, 0);
});

test('loss of origin during before evidence stops before dispatch', async () => {
  const h = harness({capture: (event, set) => {
    if (event.phase === 'before') set({stage: 'risk_warning', originOk: false});
  }});
  await assert.rejects(continueRiskWarning(h.options), {code: 'crypto_wallet_transaction_page_changed'});
  assert.equal(h.calls.length, 0);
});

test('dispatch may throw after effective click; inspect still determines success', async () => {
  const h = harness({trigger: (method, set) => { set(confirmed()); throw new Error('private diagnostic'); }});
  const result = await continueRiskWarning(h.options);
  assert.equal(result.method, 'dom');
  assert.equal(result.attempts[0].dispatchError, true);
  assert.equal(JSON.stringify(h.evidence).includes('private diagnostic'), false);
});

test('dispatch error without transition still waits before fallback', async () => {
  const h = harness({trigger: (method, set) => { if (method === 'dom') throw new Error('dispatch'); set(confirmed()); }});
  assert.equal((await continueRiskWarning(h.options)).method, 'cdp');
  assert.equal(h.calls[1].time, 20000);
});

for (const invalid of [
  {stage: 'risk_warning', originOk: false},
  {stage: 'confirm_send', originOk: true, hasAmount: false, hasNetwork: true},
  {stage: 'confirm_send', originOk: true, hasAmount: true, hasNetwork: false},
  {stage: 'unknown'},
]) {
  test(`unverified initial state blocks dispatch: ${JSON.stringify(invalid)}`, async () => {
    const h = harness({inspect: () => invalid});
    await assert.rejects(continueRiskWarning(h.options), {code: 'crypto_wallet_transaction_page_changed'});
    assert.equal(h.calls.length, 0);
  });
}

test('capture errors never hide verified outcome and are counted', async () => {
  const h = harness({trigger: (method, set) => set(confirmed()), capture: () => { throw new Error('disk'); }});
  const result = await continueRiskWarning(h.options);
  assert.equal(result.method, 'dom');
  assert.equal(result.evidenceFailures, 3);
});
