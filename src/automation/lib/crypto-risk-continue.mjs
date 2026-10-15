// 只在风险页仍可确认时升级点击方式；页面状态不明时绝不追加点击。
export async function continueRiskWarning({
  inspect, trigger, capture = async () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, waitMs = 20000, pollMs = 250,
}) {
  const attempts = [];
  let evidenceFailures = 0;
  const record = async details => {
    try { await capture(details); } catch { evidenceFailures += 1; }
  };
  const verified = state => state?.stage === 'confirm_send'
    && state.originOk === true && state.hasAmount === true && state.hasNetwork === true;
  const risk = state => state?.stage === 'risk_warning' && state.originOk === true;
  const fail = code => {
    const error = new Error(`manual_security_blocker: ${code}`);
    Object.assign(error, {code, status: 'manual_security_blocker', attempts, evidenceFailures});
    throw error;
  };
  const success = async (method, state, attempt) => {
    if (attempt) attempt.outcome = 'success';
    await record({method, phase: 'success', state});
    return {method, attempts, evidenceFailures};
  };

  for (const method of ['dom', 'cdp', 'playwright']) {
    let state = await inspect();
    if (verified(state)) return success(method, state);
    if (!risk(state)) {
      await record({method, phase: 'state_changed', state});
      fail('crypto_wallet_transaction_page_changed');
    }
    await record({method, phase: 'before', state});
    // 留证可能耗时：点击前再次读取，避免在旧风险页快照上二次提交。
    state = await inspect();
    if (verified(state)) return success(method, state);
    if (!risk(state)) {
      await record({method, phase: 'state_changed', state});
      fail('crypto_wallet_transaction_page_changed');
    }
    const attempt = {method, dispatchError: false, outcome: 'timeout'};
    attempts.push(attempt);
    try { await trigger(method); } catch {
      attempt.dispatchError = true;
      await record({method, phase: 'dispatch_error', state, errorCode: 'crypto_wallet_risk_continue_dispatch_failed'});
    }
    const deadline = now() + waitMs;
    state = await inspect();
    await record({method, phase: 'after', state});
    while (true) {
      if (verified(state)) return success(method, state, attempt);
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollMs, remaining));
      state = await inspect();
    }
    await record({method, phase: 'timeout', state});
    // 超时留证期间页面仍可能推进；升级前必须用新的状态核验。
    state = await inspect();
    if (verified(state)) return success(method, state, attempt);
    if (!risk(state)) {
      attempt.outcome = 'state_changed';
      await record({method, phase: 'state_changed', state});
      fail('crypto_wallet_transaction_page_changed');
    }
  }
  fail('crypto_wallet_transaction_risk_warning_not_dismissed');
}
