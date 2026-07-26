import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const script = () => readFileSync(join(process.cwd(), 'src/automation/bind_openrouter_card_cdp.mjs'), 'utf8');

test('browser ZDR option is explicit, default-off, and supports ZDR-only mode', () => {
  const source = script();
  assert.match(source, /key === 'disable-zdr'/);
  assert.match(source, /key === 'zdr-only'/);
  assert.match(source, /disableZdr: normalizeBooleanInput\(disableZdrInput\)/);
  assert.match(source, /zdrOnly: normalizeBooleanInput\(zdrOnlyInput\)/);
  assert.match(source, /zdrOnly requires disableZdr/);
  assert.match(source, /initialZdrResult\(input\.disableZdr\)/);
  assert.match(source, /reason: requested \? 'pending' : 'not_requested'/);
  assert.match(source, /status: requested \? 'pending' : 'skipped'/);
  assert.match(source, /&& !input\.zdrOnly/);
});

test('browser ZDR task runs after account identity check and before account side effects', () => {
  const source = script();
  const waitAccount = source.indexOf("runLoggedStep('wait-account-state'");
  const accountMismatch = source.indexOf('OpenRouter account mismatch: expected', waitAccount);
  const zdrStep = source.indexOf("runLoggedStep('disable-openrouter-zdr'", accountMismatch);
  const paymentReadiness = source.indexOf('Payment entry not ready after waiting', zdrStep);
  const creditsStatus = source.indexOf('if (input.creditsStatusOnly)', zdrStep);
  const autoTopupOnly = source.indexOf('if (input.autoTopupOnly)', zdrStep);
  const purchaseOnly = source.indexOf('if (input.purchaseOnly)', zdrStep);
  assert.ok(waitAccount > 0);
  assert.ok(accountMismatch > waitAccount);
  assert.ok(zdrStep > accountMismatch);
  assert.ok(paymentReadiness > zdrStep);
  assert.ok(creditsStatus > zdrStep);
  assert.ok(autoTopupOnly > zdrStep);
  assert.ok(purchaseOnly > zdrStep);
  assert.match(source, /navigate-credits-page-after-zdr/);
  assert.match(source, /wait-account-state-after-zdr/);
});

test('browser ZDR-only mode exits after ZDR without reading balance or opening purchase surfaces', () => {
  const source = script();
  const start = source.indexOf('if (input.disableZdr)');
  const end = source.indexOf('if (!input.creditsStatusOnly', start);
  const body = source.slice(start, end);
  assert.match(body, /if \(input\.zdrOnly\)/);
  assert.match(body, /status: zdrResult\.changed \? 'zdr_configured' : 'zdr_unchanged'/);
  assert.match(body, /zdr: zdrResult/);
  assert.doesNotMatch(body, /getCurrentCreditBalance|openPurchaseCreditsModal|openPaymentMethodEntryPath|fillStripeCard|executeConfirmedPurchase/);
});

test('browser ZDR automation uses Guardrails visible navigation and scoped switch reads', () => {
  const source = script();
  assert.match(source, /OPENROUTER_GUARDRAILS_URL = 'https:\/\/openrouter\.ai\/workspaces\/default\/guardrails'/);
  assert.match(source, /OPENROUTER_GUARDRAILS_MODELS_URL = 'https:\/\/openrouter\.ai\/workspaces\/default\/guardrails\/default\/models'/);
  assert.match(source, /navigatePage\(page, OPENROUTER_GUARDRAILS_MODELS_URL\)/);
  assert.ok(source.includes('Workspace\\\\s+Guardrail'));
  assert.ok(source.includes('Model\\\\s*&\\\\s*Provider\\\\s+Access'));
  assert.ok(source.includes('Zero\\\\s+Data\\\\s+Retention'));
  assert.match(source, /const switchSelector = '\[role="switch"\],button\[aria-checked\],input\[type="checkbox"\]\[role="switch"\],input\[type="checkbox"\]\[aria-checked\]'/);
  assert.match(source, /zdr_section_not_isolated_from_data_training/);
  assert.ok(source.includes('Data\\\\s+Training'));
});

test('browser ZDR automation disables switches one at a time and fail-closes on no progress', () => {
  const source = script();
  assert.match(source, /disable-first-enabled/);
  assert.doesNotMatch(source, /disable-enabled/);
  assert.match(source, /async function waitForZdrSwitchProgress/);
  assert.match(source, /lastState\.enabled\.length < previousEnabledCount/);
  assert.match(source, /const guardLimit = before\.total \+ 3/);
  assert.match(source, /Zero Data Retention disable loop exceeded guard limit/);
  assert.match(source, /toggledClicks: toggled\.clicks/);
  assert.match(source, /status: 'already_disabled'/);
  assert.match(source, /status: 'disabled'/);
});

test('browser ZDR automation saves, handles confirmation, and reopens Guardrails for verification', () => {
  const source = script();
  assert.match(source, /async function clickGuardrailsSave/);
  assert.match(source, /method:'top_right_save'/);
  assert.match(source, /async function clickGuardrailsConfirmationIfPresent/);
  assert.ok(source.includes('Confirm\\\\s+Eligibility\\\\s+Changes'));
  assert.ok(source.includes('Confirm\\\\s*&\\\\s*Save'));
  assert.match(source, /const reopened = await openZdrGuardrailsPanel\(page, \{skipNavigate: false\}\)/);
  assert.match(source, /Zero Data Retention verification failed; still enabled/);
});
