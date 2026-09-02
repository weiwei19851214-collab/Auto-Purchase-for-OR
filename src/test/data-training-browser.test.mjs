import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';

const source = () => readFileSync(join(process.cwd(), 'src/automation/bind_openrouter_card_cdp.mjs'), 'utf8');
const uiSource = () => ({
  html: readFileSync(join(process.cwd(), 'public/index.html'), 'utf8'),
  app: readFileSync(join(process.cwd(), 'public/app.js'), 'utf8'),
});

test('portal exposes mutually exclusive Data Training-only modes', () => {
  const {html, app} = uiSource();
  assert.match(html, /id="dataTrainingOnly"/);
  assert.match(html, /id="disableDataTrainingOnly"/);
  assert.match(html, /仅开启 Data Training，不执行其他操作/);
  assert.match(html, /仅关闭 Data Training，不执行其他操作/);
  assert.match(html, /id="confirmDataTraining"/);
  assert.match(app, /enableDataTraining: el\.dataTrainingOnly\.checked/);
  assert.match(app, /disableDataTraining: el\.disableDataTrainingOnly\.checked/);
  assert.match(app, /scopePurchase: !configurationOnly/);
  assert.match(app, /opomWriteback: !configurationOnly/);
  assert.match(app, /\['zdrOnly', 'enableZdrOnly', 'dataTrainingOnly', 'disableDataTrainingOnly', 'refundOnly'\]/);
  assert.doesNotMatch(html, /id="disableZdr"/);
});

test('browser Data Training mode is explicit and does not require card inputs', () => {
  const script = source();
  assert.match(script, /key === 'enable-data-training'/);
  assert.match(script, /key === 'disable-data-training'/);
  assert.match(script, /key === 'data-training-only'/);
  assert.match(script, /enableDataTraining: normalizeBooleanInput\(enableDataTrainingInput\)/);
  assert.match(script, /disableDataTraining: normalizeBooleanInput\(disableDataTrainingInput\)/);
  assert.match(script, /dataTrainingOnly: normalizeBooleanInput\(dataTrainingOnlyInput\)/);
  assert.match(script, /dataTrainingOnly requires enableDataTraining or disableDataTraining/);
  assert.match(script, /Data Training changes must run in dataTrainingOnly mode/);
  assert.match(script, /&& !input\.dataTrainingOnly/);
});

test('browser Data Training flow runs after identity check and exits before payment work', () => {
  const script = source();
  const accountMismatch = script.indexOf('OpenRouter account mismatch: expected');
  const dataTrainingStep = script.indexOf("const dataTrainingStepName = input.disableDataTraining ? 'disable-openrouter-data-training' : 'enable-openrouter-data-training'", accountMismatch);
  const dataTrainingReturn = script.indexOf('status: dataTrainingResult.changed', dataTrainingStep);
  const paymentReadiness = script.indexOf('Payment entry not ready after waiting', dataTrainingReturn);
  assert.ok(accountMismatch > 0);
  assert.ok(dataTrainingStep > accountMismatch);
  assert.ok(dataTrainingReturn > dataTrainingStep);
  assert.ok(paymentReadiness > dataTrainingReturn);

  const onlyBody = script.slice(script.indexOf('if (input.dataTrainingOnly)', dataTrainingStep), paymentReadiness);
  assert.doesNotMatch(onlyBody, /getCurrentCreditBalance|openPurchaseCreditsModal|openPaymentMethodEntryPath|fillStripeCard|executeConfirmedPurchase/);
});

test('browser Data Training disable flow only changes Privacy and exits', () => {
  const script = source();
  const privacyStart = script.indexOf('async function configurePrivacyDataTraining');
  const privacyEnd = script.indexOf('async function configureGuardrailDataTraining', privacyStart);
  const privacyBody = script.slice(privacyStart, privacyEnd);
  const configureStart = script.indexOf('async function configureOpenRouterDataTraining');
  const configureEnd = script.indexOf('async function ensureCreditsPage', configureStart);
  const configureBody = script.slice(configureStart, configureEnd);
  const disableReturn = configureBody.indexOf('if (!targetEnabled)');
  const guardrailCall = configureBody.indexOf('configureGuardrailDataTraining(page)');
  assert.ok(disableReturn > 0);
  assert.ok(guardrailCall > disableReturn);
  assert.match(configureBody.slice(disableReturn, guardrailCall), /status:privacy\.changed \? 'disabled' : 'already_disabled'/);
  assert.match(privacyBody, /waitForDataTrainingSwitch\(page, false, 2000\)/);
  assert.match(privacyBody, /if \(!targetEnabled\)[\s\S]*return \{configured:true, changed:true, status:targetStatus, save, verified, toggled\};/);

  const mainStep = script.indexOf("'disable-openrouter-data-training'");
  const mainReturn = script.indexOf("'data_training_disabled'", mainStep);
  const paymentReadiness = script.indexOf('Payment entry not ready after waiting', mainReturn);
  assert.ok(mainStep > 0);
  assert.ok(mainReturn > mainStep);
  assert.ok(paymentReadiness > mainReturn);
});

test('Privacy account counts are not mistaken for HTTP 5xx errors', () => {
  const script = source();
  assert.ok(script.includes('hasServerError: /\\\\b(?:Error|HTTP)\\\\s*5\\\\d{2}\\\\b'));
  assert.ok(!script.includes('hasServerError: /\\\\b5\\\\d{2}\\\\b'));
  assert.match(script, /state\.href\?\.startsWith\(OPENROUTER_CREDITS_URL\) && state\.hasServerErrorRaw/);
});

test('browser Data Training uses the measured Privacy and Guardrail controls', () => {
  const script = source();
  assert.match(script, /OPENROUTER_PRIVACY_URL = 'https:\/\/openrouter\.ai\/settings\/privacy'/);
  assert.match(script, /OPENROUTER_GUARDRAILS_MODELS_URL = 'https:\/\/openrouter\.ai\/workspaces\/default\/guardrails\/default\/models'/);
  assert.ok(script.includes("const targetText = 'Allow paid endpoints that train on request data'"));
  assert.match(script, /configurePrivacyDataTraining/);
  assert.match(script, /configureGuardrailDataTraining/);
  assert.match(script, /clickGuardrailsSave\(page\)/);
  assert.match(script, /clickGuardrailsConfirmationIfPresent\(page\)/);
  assert.match(script, /const privacy = await configurePrivacyDataTraining\(page, targetEnabled\)/);
  assert.match(script, /const guardrail = await configureGuardrailDataTraining\(page\)/);
});
