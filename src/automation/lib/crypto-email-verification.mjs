import {GMAIL_INBOX_SNAPSHOT_EXPRESSION, selectFreshVerification} from './gmail-verification.mjs';

const VERIFIED_GMAIL_SNAPSHOT_EXPRESSION = `(() => {
  if (location.origin !== 'https://mail.google.com') return {trustedOrigin: false};
  return {...${GMAIL_INBOX_SNAPSHOT_EXPRESSION}, trustedOrigin: true};
})()`;

function isReloadContextLoss(error) {
  return /\bExecution context was destroyed\b|\bCannot find context with specified id\b/i.test(String(error?.message || ''));
}

async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', {expression, returnByValue: true});
  if (result.exceptionDetails) throw new Error('manual_security_blocker: crypto_email_dom_unavailable');
  return result.result.value;
}

// No email subjects, codes, or credentials may be returned to diagnostics.
export async function inspectEmailChallenge(page, expectedAccount) {
  return evaluate(page, `(() => {
    if(location.origin !== 'https://openrouter.ai' || location.pathname !== '/settings/credits') return null;
    const dialogs=[...document.querySelectorAll('[role="dialog"]')].filter(e=>e.getClientRects().length);
    const dialog=dialogs.find(e=>/Verification required/i.test(e.innerText) && /code sent to your email/i.test(e.innerText));
    if(!dialog) return null;
    const emails=(dialog.innerText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi)||[]).map(e=>e.toLowerCase());
    return {identityMatches:emails.length===1 && emails[0]===${JSON.stringify(String(expectedAccount).toLowerCase())},
      rejected:/invalid code|incorrect code|expired|too many attempts/i.test(dialog.innerText),
      fieldReady:!!dialog.querySelector('input[autocomplete="one-time-code"][maxlength="6"]')};
  })()`);
}

export async function captureGmailBaseline(input, {getTargets, cdp, createTarget, timeoutMs = 20000}) {
  const expected = String(input.expectedAccount || '').trim().toLowerCase();
  if (!expected.includes('@')) throw new Error('manual_security_blocker: crypto_email_identity_mismatch');
  const readBaseline = async (target, required) => {
    const client = await cdp(target.webSocketDebuggerUrl);
    const deadline = Date.now() + timeoutMs;
    try {
      const url = new URL(target.url);
      if (url.origin === 'https://mail.google.com' && url.hash !== '#inbox') {
        url.hash = 'inbox';
        await client.send('Page.navigate', {url: url.href});
      }
      do {
        let snapshot;
        try { snapshot = await evaluate(client, VERIFIED_GMAIL_SNAPSHOT_EXPRESSION); }
        catch (error) {
          if (!isReloadContextLoss(error)) throw error;
        }
        if (snapshot?.mailboxAccount && snapshot.mailboxAccount.toLowerCase() !== expected) {
          if (required) throw new Error('manual_security_blocker: crypto_email_identity_mismatch');
          return null;
        }
        if (snapshot?.trustedOrigin === true && snapshot.mailboxAccount?.toLowerCase() === expected
          && snapshot.isInbox && snapshot.rows?.length
          && snapshot.rows.every(row => typeof row.messageId === 'string' && row.messageId.trim())) {
          return {targetId: target.id, baselineIds: snapshot.rows.map(row => row.messageId), challengeStartedAt: Date.now()};
        }
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(250, deadline - Date.now()))));
      } while (Date.now() < deadline);
      if (required) throw new Error('manual_security_blocker: crypto_email_gmail_not_ready');
      return null;
    } finally { client.close(); }
  };
  const targets = getTargets(input.debugPort).filter(t => t.type === 'page' && /^https:\/\/mail\.google\.com\/mail\//.test(t.url));
  for (const target of targets) {
    const baseline = await readBaseline(target, false);
    if (baseline) return baseline;
  }
  if (!createTarget) throw new Error('manual_security_blocker: crypto_email_gmail_unavailable');
  // Use this profile's existing Google session, addressed to the expected account.
  // Never capture a replacement baseline after Purchase has sent the challenge.
  const target = await createTarget(input.debugPort,
    'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(expected) + '#inbox');
  if (!target?.webSocketDebuggerUrl) throw new Error('manual_security_blocker: crypto_email_gmail_unavailable');
  return readBaseline(target, true);
}

export async function submitEmailCode(page, expectedAccount, code) {
  if(!/^\d{6}$/.test(code)) throw new Error('manual_security_blocker: crypto_email_code_invalid');
  const challenge=await inspectEmailChallenge(page,expectedAccount);
  if(!challenge?.identityMatches || !challenge.fieldReady || challenge.rejected) throw new Error('manual_security_blocker: crypto_email_challenge_changed');
  const focused=await evaluate(page,`(()=>{const dialogs=[...document.querySelectorAll('[role="dialog"]')].filter(e=>e.getClientRects().length && /code sent to your email/i.test(e.innerText));if(dialogs.length!==1)return false;const f=dialogs[0].querySelector('input[autocomplete="one-time-code"][maxlength="6"]');if(!f||f.disabled)return false;f.focus();return document.activeElement===f})()`);
  if(!focused) throw new Error('manual_security_blocker: crypto_email_focus_failed');
  const assertChallenge = async () => {
    const state = await inspectEmailChallenge(page, expectedAccount);
    if (!state?.identityMatches || !state.fieldReady || state.rejected) {
      throw new Error('manual_security_blocker: crypto_email_challenge_changed');
    }
  };
  await assertChallenge();
  const key=async(type,key,code,windowsVirtualKeyCode)=>page.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode});
  await key('keyDown','End','End',35);await key('keyUp','End','End',35);
  for(let i=0;i<6;i++){await key('keyDown','Backspace','Backspace',8);await key('keyUp','Backspace','Backspace',8)}
  const empty=await evaluate(page,`document.activeElement?.autocomplete==='one-time-code' && document.activeElement.value===''`);
  if(!empty) throw new Error('manual_security_blocker: crypto_email_clear_failed');
  for(const ch of code){
    await assertChallenge();
    await key('keyDown',ch,'Digit'+ch,48+Number(ch));
    await page.send('Input.dispatchKeyEvent',{type:'char',text:ch});
    await key('keyUp',ch,'Digit'+ch,48+Number(ch));
  }
  await key('keyDown','Tab','Tab',9);await key('keyUp','Tab','Tab',9);
  const retained=await evaluate(page,`(()=>{const f=document.querySelector('[role="dialog"] input[autocomplete="one-time-code"]');return !!f && f.value===${JSON.stringify(code)} && document.activeElement!==f})()`);
  if(!retained) throw new Error('manual_security_blocker: crypto_email_fill_failed');
  await assertChallenge();
  const clicked=await evaluate(page,`(()=>{const d=[...document.querySelectorAll('[role="dialog"]')].find(e=>e.getClientRects().length && /code sent to your email/i.test(e.innerText));const buttons=[...(d?.querySelectorAll('button')||[])].filter(e=>e.getClientRects().length && e.innerText.trim()==='Continue' && !e.disabled);if(buttons.length!==1)return false;buttons[0].click();return true})()`);
  if(!clicked) throw new Error('manual_security_blocker: crypto_email_continue_unavailable');
  return {submitted:true};
}

export async function completeEmailVerification(input,page,context,{getTargets,cdp,timeoutMs=20000}){
  if(!context || context.submitted || context.inProgress) throw new Error('manual_security_blocker: crypto_email_baseline_missing_or_used');
  context.inProgress=true;
  const challenge=await inspectEmailChallenge(page,input.expectedAccount);
  if(!challenge?.identityMatches) throw new Error('manual_security_blocker: crypto_email_identity_mismatch');
  const target=getTargets(input.debugPort).find(t=>t.id===context.targetId && /^https:\/\/mail\.google\.com\/mail\//.test(t.url));
  if(!target) throw new Error('manual_security_blocker: crypto_email_gmail_unavailable');
  const gmail=await cdp(target.webSocketDebuggerUrl);
  const deadline=Date.now()+timeoutMs;
  let lastRefresh=Date.now();
  try{
    while(Date.now()<deadline){
      let snapshot;
      try {
        snapshot=await evaluate(gmail,VERIFIED_GMAIL_SNAPSHOT_EXPRESSION);
      } catch (error) {
        // Reload can retire the old JS context. Retry only this known CDP case;
        // ordinary evaluation errors and disconnected browsers remain failures.
        if (!isReloadContextLoss(error)) throw error;
        await new Promise(r=>setTimeout(r,Math.max(0,Math.min(1000,deadline-Date.now()))));
        continue;
      }
      if(snapshot?.trustedOrigin !== true) throw new Error('manual_security_blocker: crypto_email_gmail_origin_changed');
      // Gmail temporarily has no account label while loading after Page.reload.
      // No rows are considered until identity returns; the existing deadline bounds this wait.
      if(!snapshot.mailboxAccount?.trim()) {
        await new Promise(r=>setTimeout(r,Math.max(0,Math.min(1000,deadline-Date.now()))));
        continue;
      }
      if(!snapshot.isInbox) throw new Error('manual_security_blocker: crypto_email_inbox_changed');
      const selected=selectFreshVerification(snapshot.rows,{...context,mailboxAccount:snapshot.mailboxAccount,expectedAccount:input.expectedAccount});
      if(selected.code){
        context.submitted=true; // Never submit twice, including after an ambiguous timeout.
        try{await submitEmailCode(page,input.expectedAccount,selected.code)}finally{selected.code=''}
        return {submitted:true,source:'gmail_subject',freshMessageVerified:true};
      }
      if(selected.status!=='gmail_waiting_for_fresh_verification') throw new Error('manual_security_blocker: crypto_email_'+selected.status);
      if(Date.now()-lastRefresh>10000){await gmail.send('Page.reload',{ignoreCache:false});lastRefresh=Date.now()}
      await new Promise(r=>setTimeout(r,Math.max(0,Math.min(1000,deadline-Date.now()))));
    }
    throw new Error('manual_security_blocker: crypto_email_fresh_message_timeout');
  }finally{gmail.close()}
}
