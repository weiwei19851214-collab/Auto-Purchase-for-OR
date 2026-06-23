#!/usr/bin/env node

/**
 * Sequential closed-loop runner for OpenRouter recharge rows.
 *
 * Operator-facing behavior stays one action per row:
 * replace old card -> save new card -> validation purchase -> Auto top-up -> result CSV.
 *
 * The implementation is deliberately split into small modules so the batch
 * layer only plans rows, invokes the single-profile engine, and records a
 * structured final state.
 */

import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {adsPowerDefaults, stopProfile} from './lib/adspower.mjs';
import {runClosedLoopChild} from './lib/child-runner.mjs';
import {defaultOutputCsv, ensureColumns, padRows, parseCsv, rowObject, stringifyCsv} from './lib/csv.mjs';
import {cardLast4, normalizeMoneyValue, redact} from './lib/common.mjs';
import {
  baseRowResult,
  buildClosedLoopTask,
  dryRunResult,
  adsPowerProfileIdentifier,
  isEligible,
  requiredColumns,
  resultColumns,
  successDetails,
  validateRow,
  writeOutcome,
} from './lib/recharge-plan.mjs';
import {classifyError, completedRecord, STATUSES} from './lib/status-contract.mjs';

const BIND_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'bind_openrouter_card_cdp.mjs');

function usage() {
  return `Usage:
  batch_recharge_openrouter_cards_cdp.mjs --dry-run --csv /path/to/attached-account.csv
  batch_recharge_openrouter_cards_cdp.mjs --csv /path/to/attached-account.csv
  batch_recharge_openrouter_cards_cdp.mjs --csv /path/to/attached-account.csv --output-csv /path/to/result.csv --limit 10

Options:
  --csv PATH                 required user-supplied CSV path
  --output-csv PATH          result CSV path; default account.result-<YYYYMMDD-HHMMSS>.csv
  --limit N                  process at most N eligible rows
  --dry-run                  validate and print planned rows only; no browser launch
  --remove-existing          replace existing saved cards before binding; default true
  --no-remove-existing       keep existing saved cards
  --auto-topup-threshold N   fallback Auto top-up threshold when row column is empty
  --auto-topup-amount N      fallback Auto top-up amount when row column is empty
  --stop-profiles            stop each profile after non-security completion/failure; default true
  --keep-profiles-open       do not stop profiles automatically
  --row-timeout-ms N         max runtime per child row; default 600000
  --verbose                  include child stdout/stderr tails in redacted summary

This runner is one closed-loop business action. It does not expose a separate
"bind only" step. Dry-run is the only non-browser preflight mode.`;
}

function parseArgs(argv) {
  const defaults = adsPowerDefaults();
  const args = {
    csv: '',
    outputCsv: '',
    limit: Infinity,
    dryRun: false,
    removeExisting: true,
    autoTopupThreshold: '',
    autoTopupAmount: '',
    stopProfiles: true,
    rowTimeoutMs: 600000,
    verbose: false,
    ...defaults,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--remove-existing') {
      args.removeExisting = true;
      continue;
    }
    if (arg === '--no-remove-existing') {
      args.removeExisting = false;
      continue;
    }
    if (arg === '--stop-profiles') {
      args.stopProfiles = true;
      continue;
    }
    if (arg === '--keep-profiles-open') {
      args.stopProfiles = false;
      continue;
    }
    if (arg === '--verbose') {
      args.verbose = true;
      continue;
    }

    const takesValue = new Set([
      '--csv',
      '--output-csv',
      '--limit',
      '--adspower-api-base',
      '--adspower-api-key',
      '--auto-topup-threshold',
      '--auto-topup-amount',
      '--row-timeout-ms',
    ]);
    if (!takesValue.has(arg)) throw new Error(`Unexpected argument: ${arg}`);
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (arg === '--csv') args.csv = resolve(value);
    if (arg === '--output-csv') args.outputCsv = resolve(value);
    if (arg === '--limit') args.limit = Number(value);
    if (arg === '--adspower-api-base') args.adspowerApiBase = value;
    if (arg === '--adspower-api-key') args.adspowerApiKey = value;
    if (arg === '--auto-topup-threshold') args.autoTopupThreshold = normalizeMoneyValue(value);
    if (arg === '--auto-topup-amount') args.autoTopupAmount = normalizeMoneyValue(value);
    if (arg === '--row-timeout-ms') args.rowTimeoutMs = Number(value);
    i += 1;
  }

  if (!Number.isFinite(args.limit) && args.limit !== Infinity) throw new Error('--limit must be a number');
  if (args.limit <= 0) throw new Error('--limit must be positive');
  if (!Number.isInteger(args.rowTimeoutMs) || args.rowTimeoutMs <= 0) throw new Error('--row-timeout-ms must be a positive integer');
  if (!args.csv) throw new Error('--csv PATH is required; use the CSV attachment path supplied for this run');
  return args;
}

function readPlan(args) {
  const text = readFileSync(args.csv, 'utf8');
  const parsedRows = parseCsv(text);
  if (parsedRows.length < 1) throw new Error(`CSV is empty: ${args.csv}`);

  const header = [...parsedRows[0]];
  const dataRows = parsedRows.slice(1).map((row) => [...row]);
  const missingHeader = requiredColumns().filter((key) => !header.includes(key));
  if (missingHeader.length) throw new Error(`CSV missing required columns: ${missingHeader.join(', ')}`);
  ensureColumns(header, resultColumns());

  const plan = [];
  for (let index = 0; index < dataRows.length && plan.length < args.limit; index += 1) {
    const row = rowObject(header, dataRows[index]);
    if (!isEligible(row)) continue;
    plan.push({index, rowNumber: index + 2, row});
  }

  return {header, dataRows, plan};
}

function makeSummary(args, plan, dataRows, outputCsv) {
  return {
    ok: true,
    csv: args.csv,
    outputCsv: args.dryRun ? '' : outputCsv,
    dryRun: args.dryRun,
    planned: plan.length,
    attempted: 0,
    completed: 0,
    skipped: dataRows.length - plan.length,
    blocked: 0,
    failed: 0,
    halted: false,
    results: [],
  };
}

async function closeOtherProfiles(args, currentProfileIdentifier, plannedProfileIdentifiers, processedProfileIdentifiers) {
  if (!args.stopProfiles) return;
  for (const profileIdentifier of plannedProfileIdentifiers) {
    if (profileIdentifier.value !== String(currentProfileIdentifier.value || '')) {
      await stopProfile(args, profileIdentifier);
    }
  }
  for (const profileIdentifier of processedProfileIdentifiers.values()) {
    if (String(profileIdentifier.value) !== String(currentProfileIdentifier.value || '')) {
      await stopProfile(args, profileIdentifier);
    }
  }
}

function isCompleted(details) {
  return details.purchaseStatus === 'verified' && /^(updated|unchanged)$/.test(details.autoTopupStatus);
}

async function processLiveRow({args, header, dataRows, item, summary, plannedProfileNos, processedProfileNos}) {
  const {index, rowNumber, row} = item;
  const profileIdentifier = adsPowerProfileIdentifier(row);
  await closeOtherProfiles(args, profileIdentifier, plannedProfileNos, processedProfileNos);

  const csvRow = dataRows[index];
  const missing = validateRow(row, args);
  const baseResult = baseRowResult(rowNumber, row);
  if (missing.length) {
    summary.blocked += 1;
    summary.results.push({...baseResult, status: STATUSES.MISSING_FIELDS, missing});
    writeOutcome(header, csvRow, STATUSES.MISSING_FIELDS, missing.join(','), {cardLast4: cardLast4(row.card_number)});
    return;
  }

  summary.attempted += 1;
  const task = buildClosedLoopTask(row, args);
  const outcome = runClosedLoopChild(BIND_SCRIPT, task, args);
  let profileStop = {attempted: false};

  if (outcome.ok) {
    const details = successDetails(row, outcome.result, args);
    const completed = isCompleted(details);
    if (completed) summary.completed += 1;
    else summary.failed += 1;
    if (args.stopProfiles) profileStop = await stopProfile(args, profileIdentifier);
    if (profileIdentifier.value) processedProfileNos.set(profileIdentifier.value, profileIdentifier);

    const status = completed ? STATUSES.COMPLETED : STATUSES.PURCHASE_UNVERIFIED;
    const statusContract = completed ? completedRecord(details) : {
      ...classifyError('purchase_unverified: purchase or auto top-up was not fully verified'),
      evidence: details,
    };
    summary.results.push({
      ...baseResult,
      status,
      stage: statusContract.stage,
      purchaseStatus: details.purchaseStatus,
      purchaseAmount: details.purchaseAmount,
      balanceBefore: details.balanceBefore,
      balanceAfter: details.balanceAfter,
      autoTopupStatus: details.autoTopupStatus,
      profileStop,
    });
    writeOutcome(header, csvRow, status, completed ? 'completed' : 'purchase or auto top-up was not fully verified', details);
    return;
  }

  const statusContract = classifyError(outcome.error);
  if (statusContract.status === STATUSES.FAILED) summary.failed += 1;
  else summary.blocked += 1;
  if (args.stopProfiles && statusContract.stopProfile) profileStop = await stopProfile(args, profileIdentifier);
  if (statusContract.stopProfile && profileIdentifier.value) processedProfileNos.set(profileIdentifier.value, profileIdentifier);

  const redactedError = redact(outcome.error);
  summary.results.push({
    ...baseResult,
    status: statusContract.status,
    stage: statusContract.stage,
    error: redactedError,
    profileStop,
    ...(outcome.child ? {child: outcome.child} : {}),
  });
  writeOutcome(header, csvRow, statusContract.status, redactedError, {cardLast4: cardLast4(row.card_number)});
  if (!statusContract.safeToContinueBatch) {
    summary.halted = true;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const {header, dataRows, plan} = readPlan(args);
  const outputCsv = args.outputCsv || defaultOutputCsv(args.csv);
  const summary = makeSummary(args, plan, dataRows, outputCsv);

  if (args.dryRun) {
    summary.results = plan.map(({rowNumber, row}) => dryRunResult(rowNumber, row, args));
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const plannedProfileNos = [...new Map(plan
    .map(({row}) => adsPowerProfileIdentifier(row))
    .filter((identifier) => identifier.value)
    .map((identifier) => [identifier.value, identifier])).values()];
  const processedProfileNos = new Map();
  for (const item of plan) {
    await processLiveRow({args, header, dataRows, item, summary, plannedProfileNos, processedProfileNos});
    if (summary.halted) break;
  }

  padRows(dataRows, header.length);
  writeFileSync(outputCsv, stringifyCsv([header, ...dataRows]), 'utf8');
  summary.ok = !summary.halted && summary.failed === 0;
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: redact(error.message),
  }, null, 2));
  process.exitCode = 1;
});
