import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {classifyOkxWalletStages, findOkxWalletTargets, importOkxWallet} from '../automation/crypto_recharge_openrouter_cdp.mjs';
import {classifyError} from '../automation/lib/status-contract.mjs';
import {clearWalletSeeds, holdWalletSeeds, validateWalletSeedRows, walletSeedForRow} from '../server/crypto-wallet-secrets.mjs';
import {executeRowWithAdapters} from '../server/automation-adapter.mjs';
import {openDatabase} from '../server/db.mjs';
import {createJob} from '../server/jobs.mjs';
import {createLiveConfirmation} from '../server/safety.mjs';

const phrase = Array(12).fill('notawalletword').join(' '); // 无效钱包测试词，不能用于恢复。

function walletPage(startStage = 'welcome', afterConfirm = 'ready', options = {}) {
  let stage = startStage;
  let active = null;
  let fields = ['words', 'prefilled_words'].includes(startStage)
    ? Array.from({length: 12}, (_, index) => ({type: 'text', disabled: false,
      value: options.prefilled && index === 0 ? 'already' : '',
      getBoundingClientRect: () => ({width: 100, height: 25}), focus() { active = this; }}))
    : startStage === 'locked' ? [{type: 'password', disabled: false, value: '',
      getBoundingClientRect: () => ({width: 100, height: 25})}] : [];
  if (startStage === 'prefilled_words') stage = 'words';
  const clicks = [];
  const button = (label, next) => ({innerText: label,
    get disabled() { return label === 'Confirm' && (options.confirmDisabled || fields.some((field) => !field.value)); },
    matches: () => true,
    scrollIntoView() {},
    getBoundingClientRect: () => ({width: 120, height: 30}), click() {
      clicks.push(label);
      stage = next;
      if (next === 'words') fields = Array.from({length: 12}, () => ({type: 'text', disabled: false, value: '',
        getBoundingClientRect: () => ({width: 100, height: 25}), focus() { active = this; }}));
      if (next === 'password_setup') fields = [{type: 'password', disabled: false, value: '',
        getBoundingClientRect: () => ({width: 100, height: 25})}];
    },
  });
  const document = {
    get body() { return {innerText: ({welcome: 'Import wallet', method: 'Import wallet Seed phrase or private key Use 12, 18, or 24-word seed phrases, or private keys Social login Hardware wallet',
      words: 'Seed phrase or private key', ready: 'Assets Send Receive', locked: 'Unlock Enter password',
      password_setup: 'Create password'})[stage] || 'Unknown'}; },
    get activeElement() { return active; },
    querySelectorAll(selector) {
      if (selector === 'input,textarea') return fields;
      if (selector === 'button,[role="button"]') return stage === 'welcome' ? [button('Import wallet', 'method')]
        : stage === 'words' ? [button('Confirm', afterConfirm)]
          : stage === 'ready' ? [button('Send', 'ready'), button('Receive', 'ready')] : [];
      if (selector === 'button,[role="button"],a,li,div') {
        return stage === 'welcome' ? [button('Import wallet', 'method')]
          : stage === 'method' ? [button('Seed phrase or private key Use 12, 18, or 24-word seed phrases, or private keys', 'words')]
            : stage === 'words' ? [button('Confirm', afterConfirm)]
              : stage === 'ready' ? [button('Send', 'ready'), button('Receive', 'ready')] : [];
      }
      return [];
    },
  };
  const location = {
    origin: 'chrome-extension://mcohilncbfahbmgdjkbpemcciiolgcge',
    get hash() { return ({welcome: '#/initialize', method: '#/initialize-import', words: '#/import-with-seed-phrase-and-private-key'})[stage] || '#/wallet'; },
  };
  return {clicks, get stage() { return stage; }, async send(method, params) {
    if (method === 'Runtime.evaluate') return {result: {value: runInNewContext(params.expression, {
      document, location,
    })}};
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mouseReleased') {
        if (stage === 'welcome') { clicks.push('Import wallet'); stage = 'method'; }
        else if (stage === 'method') {
          clicks.push('Seed phrase or private key Use 12, 18, or 24-word seed phrases, or private keys');
          stage = 'words';
          fields = Array.from({length: 12}, () => ({type: 'text', disabled: false, value: '',
            getBoundingClientRect: () => ({width: 100, height: 25}), focus() { active = this; }}));
        } else if (stage === 'words') {
          clicks.push('Confirm');
          stage = afterConfirm;
          if (stage === 'password_setup') fields = [{type: 'password', disabled: false, value: '',
            getBoundingClientRect: () => ({width: 100, height: 25})}];
        }
      }
      return {};
    }
    assert.equal(method, 'Input.dispatchKeyEvent');
    if (params.type === 'char' && active) active.value += params.text;
    if (params.type === 'rawKeyDown' && params.key === 'Tab') active = null;
    return {};
  }};
}

test('welcome imports exactly once through the four described screens, without payment clicks', async () => {
  const page = walletPage();
  assert.deepEqual(await importOkxWallet(page, phrase), {status: 'ready'});
  assert.deepEqual(page.clicks, ['Import wallet', 'Seed phrase or private key Use 12, 18, or 24-word seed phrases, or private keys', 'Confirm']);
  assert.equal(page.stage, 'ready');
});

test('an already open empty 12-word page is filled without restarting the import navigation', async () => {
  const page = walletPage('words');
  assert.deepEqual(await importOkxWallet(page, phrase), {status: 'ready'});
  assert.deepEqual(page.clicks, ['Confirm']);
  assert.equal(page.stage, 'ready');
  assert.equal(JSON.stringify(page.clicks).includes(phrase), false);
});

test('an already open method page proceeds without clicking Import wallet again', async () => {
  const page = walletPage('method');
  assert.deepEqual(await importOkxWallet(page, phrase), {status: 'ready'});
  assert.deepEqual(page.clicks, ['Seed phrase or private key Use 12, 18, or 24-word seed phrases, or private keys', 'Confirm']);
});

test('missing phrase, prefilled words, and disabled import Confirm do not overwrite or submit', async () => {
  const missing = walletPage('words');
  await assert.rejects(importOkxWallet(missing, ''), /crypto_wallet_import_phrase_missing/);
  assert.deepEqual(missing.clicks, []);
  const prefilled = walletPage('words', 'ready', {prefilled: true});
  await assert.rejects(importOkxWallet(prefilled, phrase), /crypto_wallet_import_fields_not_empty/);
  assert.deepEqual(prefilled.clicks, []);
  const disabled = walletPage('words', 'ready', {confirmDisabled: true});
  await assert.rejects(importOkxWallet(disabled, phrase), /crypto_wallet_import_confirm_unavailable/);
  assert.deepEqual(disabled.clicks, []);
});

test('import Confirm alone does not prove login; password setup still blocks the wallet', async () => {
  const page = walletPage('words', 'password_setup');
  await assert.rejects(importOkxWallet(page, phrase), /crypto_wallet_import_authentication_required/);
  assert.deepEqual(page.clicks, ['Confirm']);
  assert.equal(page.stage, 'password_setup');
});

test('ready wallet can proceed; locked and unknown screens never re-import', async () => {
  const existing = walletPage('ready');
  assert.deepEqual(await importOkxWallet(existing, phrase), {status: 'ready'});
  assert.deepEqual(existing.clicks, []);
  const locked = walletPage('locked');
  await assert.rejects(importOkxWallet(locked, phrase), /crypto_wallet_import_authentication_required/);
  assert.deepEqual(locked.clicks, []);
  const setup = walletPage('welcome', 'password_setup');
  await assert.rejects(importOkxWallet(setup, phrase), /crypto_wallet_import_authentication_required/);
  assert.deepEqual(setup.clicks, ['Import wallet', 'Seed phrase or private key Use 12, 18, or 24-word seed phrases, or private keys', 'Confirm']);
  const unknown = walletPage('unknown');
  await assert.rejects(importOkxWallet(unknown, phrase), /crypto_wallet_import_unknown_page/);
  assert.deepEqual(unknown.clicks, []);
  const status = classifyError('manual_security_blocker: crypto_wallet_import_page_changed');
  assert.equal(status.status, 'manual_security_blocker');
  assert.equal(status.stopProfile, false);
  assert.equal(status.safeToContinueBatch, false);
});

test('wallet discovery waits for any OKX extension target and never opens a full tab', async () => {
  const extensionRoot = 'chrome-extension://mcohilncbfahbmgdjkbpemcciiolgcge/';
  const page = {id: 'wallet', type: 'page', url: extensionRoot + 'sidepanel.html', webSocketDebuggerUrl: 'ws://wallet'};
  const floating = {id: 'wallet-other', type: 'other', url: extensionRoot + 'popup.html', webSocketDebuggerUrl: 'ws://wallet-other'};
  const input = {debugPort: 'fixture'};
  const targets = await findOkxWalletTargets(input, () => [page, floating]);
  assert.deepEqual(targets, [page, floating]);
  let polls = 0;
  const delayed = await findOkxWalletTargets(input, () => ++polls < 2 ? [] : [floating], async () => {});
  assert.deepEqual(delayed, [floating]);
  const source = readFileSync(new URL('../automation/crypto_recharge_openrouter_cdp.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export function findOkxWalletTargets(');
  const end = source.indexOf('async function prepareOkxWallet(', start);
  assert.doesNotMatch(source.slice(start, end), /Target\.createTarget|side_panel|default_popup/);
});

test('loading SES helper target is ignored when notification initialize page is ready', () => {
  assert.deepEqual(classifyOkxWalletStages([{stage: 'welcome'}, {stage: 'unknown'}]), {status: 'welcome', index: 0});
  assert.deepEqual(classifyOkxWalletStages([{stage: 'unknown'}, {stage: 'ready'}]), {status: 'ready', index: 1});
  assert.deepEqual(classifyOkxWalletStages([{stage: 'unknown'}, {stage: 'method'}]), {status: 'method', index: 1});
  assert.deepEqual(classifyOkxWalletStages([{stage: 'unknown'}, {stage: 'words'}]), {status: 'words', index: 1});
  assert.deepEqual(classifyOkxWalletStages([{stage: 'unknown'}, {stage: 'unknown'}]), {status: 'pending', index: -1});
  assert.deepEqual(classifyOkxWalletStages([{stage: 'welcome'}, {stage: 'ready'}]), {status: 'ambiguous', index: -1});
  assert.deepEqual(classifyOkxWalletStages([{stage: 'words'}, {stage: 'method'}]), {status: 'ambiguous', index: -1});
  assert.deepEqual(classifyOkxWalletStages([{stage: 'words'}, {stage: 'locked'}]), {status: 'authentication_required', index: -1});
});

test('seed phrases remain in job memory and are never part of the child result', async () => {
  assert.deepEqual(validateWalletSeedRows([phrase], [{}]), [phrase]);
  assert.throws(() => validateWalletSeedRows([phrase, 'other '.repeat(12).trim()], [{}, {}]), /同一个 OKX 钱包/);
  assert.throws(() => validateWalletSeedRows([phrase], [{}, {}]), /行数不一致/);
  holdWalletSeeds('job_fixture', [phrase]);
  assert.equal(walletSeedForRow('job_fixture', 0), phrase);
  clearWalletSeeds('job_fixture');
  assert.equal(walletSeedForRow('job_fixture', 0), '');

  const csv = ['status,login_email,ads_power_user_id,ads_match_status,balance_threshold,amount_below_threshold,amount_at_or_above_threshold',
    ',user@example.com,profile1,matched,145,150,20'].join(String.fromCharCode(10));
  let task;
  const result = await executeRowWithAdapters(csv, 0, {
    rechargeMode: 'crypto', scopeBillingAddress: false, scopePaymentMethod: false,
    scopePurchase: true, scopeAutoTopup: false, confirmPurchase: false, runtimeSeedPhrase: phrase,
  }, {common: {cardLast4: () => ''}, runClosedLoopChildAsync: async (_script, input) => {
    task = input;
    return {ok: true, result: {cryptoPurchase: {walletConfirmationRequired: true}}};
  }});
  assert.equal(task.walletSeedPhrase, phrase);
  assert.equal(JSON.stringify(result).includes(phrase), false);
  const source = readFileSync(new URL('../server/jobs.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('validateWalletSeedRows') < source.indexOf('makeJobFiles(jobId'));
});

test('job creation keeps the recovery phrase out of SQLite and both CSV files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'crypto-wallet-test-'));
  const db = openDatabase(join(directory, 'runner.sqlite'));
  let files;
  try {
    const csvText = ['status,login_email,ads_power_user_id,ads_match_status,balance_threshold,amount_below_threshold,amount_at_or_above_threshold',
      ',user@example.com,profile1,matched,145,150,20'].join(String.fromCharCode(10));
    const options = {rechargeMode: 'crypto', scopeBillingAddress: false, scopePaymentMethod: false,
      scopePurchase: true, scopeAutoTopup: false, confirmPurchase: false};
    const liveConfirmationToken = createLiveConfirmation({csvText, options, ready: 1}).token;
    const created = await createJob(db, {csvText, options, seedPhrases: [phrase], liveConfirmationToken});
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(created.job.id);
    files = [job.csv_path, job.result_csv_path];
    assert.equal(walletSeedForRow(job.id, 0), phrase);
    for (const content of [readFileSync(job.csv_path), readFileSync(job.result_csv_path),
      readFileSync(join(directory, 'runner.sqlite')), Buffer.from(JSON.stringify(created))]) {
      assert.equal(content.includes(Buffer.from(phrase)), false);
    }
    clearWalletSeeds(job.id);
  } finally {
    db.close();
    for (const file of files || []) {
      try { unlinkSync(file); } catch {}
    }
    rmSync(directory, {recursive: true, force: true});
  }
});
