import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openDatabase} from '../server/db.mjs';
import {
  createExceptionCard,
  exceptionCardsCsv,
  listExceptionCards,
  replacementDefaults,
  replacementRowFromAccount,
  resolveReplacementDirs,
  suggestedReplacementCardAmount,
} from '../server/replacement.mjs';

test('replacementDefaults follows PRD safe defaults', () => {
  const defaults = replacementDefaults(new Date('2026-06-25T02:00:00.000Z'));
  assert.equal(defaults.pollIntervalMinutes, 18);
  assert.equal(defaults.autoExecuteOnFound, false);
  assert.equal(defaults.autoCreateEjhCards, false);
  assert.equal(defaults.autoBindInAdsPowerAfterCardCreate, false);
  assert.match(defaults.artifactDir, /Desktop\/2026-06-25$/);
  assert.match(defaults.logRootDir, /Desktop\/2026-06-25\/logs$/);
});

test('resolveReplacementDirs defaults logs under artifact directory', () => {
  const dirs = resolveReplacementDirs({
    replacementArtifactDir: '/tmp/replacement-artifacts',
  }, new Date('2026-06-25T02:00:00.000Z'));
  assert.equal(dirs.artifactDir, '/tmp/replacement-artifacts/2026-06-25');
  assert.equal(dirs.logRootDir, '/tmp/replacement-artifacts/2026-06-25/logs');
});

test('resolveReplacementDirs does not duplicate an explicit date directory', () => {
  const dirs = resolveReplacementDirs({
    replacementArtifactDir: '/tmp/replacement-artifacts/2026-06-25',
    replacementLogRootDir: '/tmp/replacement-logs/2026-06-25',
  }, new Date('2026-06-25T02:00:00.000Z'));
  assert.equal(dirs.artifactDir, '/tmp/replacement-artifacts/2026-06-25');
  assert.equal(dirs.logRootDir, '/tmp/replacement-logs/2026-06-25');
});

test('suggestedReplacementCardAmount rounds five-day spend to 150 steps', () => {
  assert.equal(suggestedReplacementCardAmount(0), 150);
  assert.equal(suggestedReplacementCardAmount(64), 450);
  assert.equal(suggestedReplacementCardAmount(2000), 10000);
});

test('replacementRowFromAccount derives amount from last three days usage', () => {
  const row = replacementRowFromAccount({
    opomAccountId: 'acct_1',
    loginEmail: 'buyer@example.com',
    adsPower: {userId: 'k1dglko5', serialNumber: '1415'},
    health: {status: 'ok'},
    usageLast3Days: [
      {date: '2026-06-22', costUsd: 60},
      {date: '2026-06-23', costUsd: 70},
      {date: '2026-06-24', costUsd: 62},
    ],
  });
  assert.equal(row.eligible, true);
  assert.equal(row.avgDailySpend3d, 64);
  assert.equal(row.maxDailySpend3d, 70);
  assert.equal(row.suggestedCardAmount, 450);
  assert.equal(row.stage, 'card_amount_planned');
});

test('createExceptionCard writes single CSV and marks original account non-reusable', () => {
  const root = mkdtempSync(join(tmpdir(), 'replacement-test-'));
  const db = openDatabase(join(root, 'runner.sqlite'));
  try {
    const result = createExceptionCard(db, {
      replacementArtifactDir: root,
      opomAccountId: 'acct_1',
      loginEmail: 'buyer@example.com',
      adsPowerUserId: 'k1dglko5',
      adsPowerSerialNumber: '1415',
      ejhOrderNo: 'ejh_1',
      cardNo: '5257970000000001',
      expMonth: '06',
      expYear: '28',
      cvv: '123',
      reason: '=blocked by original account',
    });
    assert.equal(result.card.reusableForOriginalAccount, false);
    assert.equal(result.card.cardNo, '5257970000000001');
    assert.equal(existsSync(result.csvPath), true);

    const fileText = readFileSync(result.csvPath, 'utf8');
    assert.match(fileText, /reusable_for_original_account/);
    assert.match(fileText, /false/);
    assert.doesNotMatch(fileText, /cvv/i);
    assert.match(fileText, /'=blocked by original account/);

    const cards = listExceptionCards(db);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].reusableForOriginalAccount, false);

    const exportText = exceptionCardsCsv(db);
    assert.match(exportText, /5257970000000001/);
    assert.match(exportText, /false/);
    assert.doesNotMatch(exportText, /123/);
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});
