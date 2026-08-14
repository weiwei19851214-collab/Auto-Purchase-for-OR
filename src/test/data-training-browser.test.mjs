import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';

const source = () => readFileSync(join(process.cwd(), 'src/automation/bind_openrouter_card_cdp.mjs'), 'utf8');
const uiSource = () => ({
  html: readFileSync(join(process.cwd(), 'public/index.html'), 'utf8'),
  app: readFileSync(join(process.cwd(), 'public/app.js'), 'utf8'),
});

test('portal exposes a mutually exclusive Data Training-only mode', () => {
  const {html, app} = uiSource();
  assert.match(html, /id="dataTrainingOnly"/);
  assert.match(html, /仅开启 Data Training，不执行其他操作/);
  assert.match(html, /id="confirmDataTraining"/);
  assert.match(app, /enableDataTraining: el\.dataTrainingOnly\.checked/);
  assert.match(app, /scopePurchase: !configurationOnly/);
  assert.match(app, /opomWriteback: !configurationOnly/);
  assert.match(app, /if \(mode\) el\.dataTrainingOnly\.checked = false/);
  assert.match(app, /el\.zdrOnly\.checked = false/);
  assert.match(app, /el\.enableZdrOnly\.checked = false/);
});

test('browser Data Training mode is explicit and does not require card inputs', () => {
  const script = source();
  assert.match(script, /key === 'enable-data-training'/);
  assert.match(script, /key === 'data-training-only'/);
  assert.match(script, /enableDataTraining: normalizeBooleanInput\(enableDataTrainingInput\)/);
  assert.match(script, /dataTrainingOnly: normalizeBooleanInput\(dataTrainingOnlyInput\)/);
  assert.match(script, /dataTrainingOnly requires enableDataTraining/);
  assert.match(script, /enableDataTraining must run in dataTrainingOnly mode/);
  assert.match(script, /&& !input\.dataTrainingOnly/);
});

test('browser Data Training flow runs after identity check and exits before payment work', () => {
  const script = source();
  const accountMismatch = script.indexOf('OpenRouter account mismatch: expected');
  const dataTrainingStep = script.indexOf("runLoggedStep('enable-openrouter-data-training'", accountMismatch);
  const dataTrainingReturn = script.indexOf("status: dataTrainingResult.changed ? 'data_training_enabled'", dataTrainingStep);
  const paymentReadiness = script.indexOf('Payment entry not ready after waiting', dataTrainingReturn);
  assert.ok(accountMismatch > 0);
  assert.ok(dataTrainingStep > accountMismatch);
  assert.ok(dataTrainingReturn > dataTrainingStep);
  assert.ok(paymentReadiness > dataTrainingReturn);

  const onlyBody = script.slice(script.indexOf('if (input.dataTrainingOnly)', dataTrainingStep), paymentReadiness);
  assert.doesNotMatch(onlyBody, /getCurrentCreditBalance|openPurchaseCreditsModal|openPaymentMethodEntryPath|fillStripeCard|executeConfirmedPurchase/);
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
  assert.match(script, /const privacy = await configurePrivacyDataTraining\(page\)/);
  assert.match(script, /const guardrail = await configureGuardrailDataTraining\(page\)/);
});
