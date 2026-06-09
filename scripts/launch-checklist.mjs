#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {ROOT_DIR} from '../src/server/config.mjs';
import {redact} from '../src/server/redact.mjs';

const DEFAULT_OPOM_REPO = '/Users/weiwei/project/manager-openrouter';
const args = parseArgs(process.argv.slice(2));
const opomRepo = resolve(args.opomRepo || process.env.OPOM_REPO || DEFAULT_OPOM_REPO);

const readiness = runReadinessAudit(opomRepo, args.preflightMarker);
const failedItems = readiness.items.filter((item) => item.status === 'fail');
const pendingItems = readiness.items.filter((item) => item.status.startsWith('pending_'));

const checklist = {
  ok: readiness.ok,
  complete: readiness.complete,
  launchReadyWithAuthorization: readiness.ok && pendingItems.every((item) => [
    'pending_manual_ops',
    'pending_opom_production_deploy',
    'pending_external_api',
  ].includes(item.status)),
  failed: failedItems.length,
  pending: pendingItems.length,
  rechargeRepo: ROOT_DIR,
  opomRepo,
  requiredCommands: [
    'npm run verify:integration -- --base http://127.0.0.1:4174',
    'npm run preflight:production -- --with-opom-read --marker-file ./var/production-preflight-marker.json',
    'npm run audit:completion -- --preflight-marker ./var/production-preflight-marker.json',
  ],
  authorizationGates: [
    'git push',
    'OPOM production deployment',
    'editing OPOM production .env',
    'OPOM production db:push',
    'OPOM production write APIs',
    'real EJH card creation',
    'OpenRouter live purchase submission',
  ],
  firstOperationalSequence: [
    'Ops prepares AdsPower profiles and OPOM group=recharge',
    'Ready to recharge pulls OPOM queue',
    'Operator reviews pending rows and OPOM health',
    'Match AdsPower validates unique profile and identity',
    'Operator enters amount/rules and optional billing mapping CSV',
    'Dry-run resolves missing_fields and identity issues',
    'No-purchase validation runs before live purchase',
    'Authorized EJH card creation writes safe card CSV',
    'Authorized live execution runs one small row first',
    'OPOM card/result writeback, waived AdsPower status evidence, production completion evidence, and sanitized result CSV are verified',
  ],
  pendingItems,
  failedItems,
};

if (args.json) {
  console.log(JSON.stringify(checklist, null, 2));
} else {
  console.log(`Launch checklist: ${checklist.ok ? 'OK' : 'FAIL'}${checklist.complete ? ' complete' : ' not-complete'}`);
  console.log(`Repos: Recharge=${checklist.rechargeRepo} OPOM=${checklist.opomRepo}`);
  console.log(`Pending: ${checklist.pending}  Failed: ${checklist.failed}`);
  if (pendingItems.length) {
    console.log('\nPending items');
    for (const item of pendingItems) {
      console.log(`- ${item.id}: ${item.status} - ${item.title}`);
      if (item.next) console.log(`  next: ${item.next}`);
    }
  }
  if (failedItems.length) {
    console.log('\nFailed items');
    for (const item of failedItems) {
      console.log(`- ${item.id}: ${item.title}`);
    }
  }
  console.log('\nRequired commands');
  for (const command of checklist.requiredCommands) console.log(`- ${command}`);
  console.log('\nAuthorization gates');
  for (const gate of checklist.authorizationGates) console.log(`- ${gate}`);
  console.log('\nFirst operational sequence');
  checklist.firstOperationalSequence.forEach((step, index) => console.log(`${index + 1}. ${step}`));
}

process.exitCode = checklist.ok ? 0 : 1;

function runReadinessAudit(opomRepoPath, preflightMarker) {
  const auditArgs = [
    'scripts/readiness-audit.mjs',
    '--json',
    '--opom-repo',
    opomRepoPath,
  ];
  if (preflightMarker) auditArgs.push('--preflight-marker', preflightMarker);
  const result = spawnSync(process.execPath, auditArgs, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    throw new Error(redact(result.stderr || result.stdout || `readiness audit failed with exit ${result.status}`));
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`readiness audit returned invalid JSON: ${redact(error.message)}`);
  }
}

function parseArgs(argv) {
  const parsed = {json: false, opomRepo: '', preflightMarker: ''};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--opom-repo') {
      parsed.opomRepo = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--opom-repo=')) {
      parsed.opomRepo = arg.split('=').slice(1).join('=');
    } else if (arg === '--preflight-marker') {
      parsed.preflightMarker = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--preflight-marker=')) {
      parsed.preflightMarker = arg.split('=').slice(1).join('=');
    }
  }
  return parsed;
}
