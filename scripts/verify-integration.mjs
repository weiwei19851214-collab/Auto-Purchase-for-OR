#!/usr/bin/env node
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT_DIR} from '../src/server/config.mjs';

const DEFAULT_OPOM_REPO = '/Users/weiwei/project/manager-openrouter';

const args = parseArgs(process.argv.slice(2));
const rechargeRepo = ROOT_DIR;
const opomRepo = resolve(args.opomRepo || process.env.OPOM_REPO || DEFAULT_OPOM_REPO);
const smokeBase = args.base || process.env.SMOKE_BASE_URL || 'http://127.0.0.1:4100';
const checks = [];

function runCheck(label, cwd, command, commandArgs = [], options = {}) {
  const startedAt = Date.now();
  console.log(`\n==> ${label}`);
  console.log(`cwd: ${cwd}`);
  console.log(`cmd: ${[command, ...commandArgs].join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    env: {...process.env, ...(options.env || {})},
  });
  const durationMs = Date.now() - startedAt;
  const ok = result.status === 0;
  checks.push({label, ok, durationMs});
  if (!ok && !options.continueOnFailure) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

try {
  if (!existsSync(opomRepo)) throw new Error(`OPOM repo not found: ${opomRepo}`);

  runCheck('Recharge local API smoke', rechargeRepo, 'npm', ['run', 'smoke:local', '--', '--base', smokeBase]);
  runCheck('Recharge operator UI smoke', rechargeRepo, 'npm', ['run', 'smoke:ui', '--', '--base', smokeBase]);
  runCheck('Recharge browser UI interaction smoke', rechargeRepo, 'npm', ['run', 'smoke:ui:interaction', '--', '--base', smokeBase]);
  runCheck('Recharge OPOM browser flow smoke', rechargeRepo, 'npm', ['run', 'smoke:ui:opom-flow', '--', '--base', smokeBase]);
  runCheck('Recharge identity mismatch browser smoke', rechargeRepo, 'npm', ['run', 'smoke:ui:identity-mismatch', '--', '--base', smokeBase]);
  runCheck('Recharge Feishu handoff CSV smoke', rechargeRepo, 'npm', ['run', 'smoke:feishu']);
  runCheck('Recharge goal readiness audit', rechargeRepo, 'npm', ['run', 'audit:readiness', '--', '--opom-repo', opomRepo]);
  runCheck('Recharge launch checklist', rechargeRepo, 'npm', ['run', 'checklist:launch', '--', '--opom-repo', opomRepo]);
  runCheck('Recharge sensitive static audit', rechargeRepo, 'npm', ['run', 'audit:sensitive']);
  runCheck('Recharge syntax check', rechargeRepo, 'npm', ['run', 'check']);
  runCheck('Recharge tests', rechargeRepo, 'npm', ['test']);

  runOpomTempDbPush(opomRepo);
  runOpomBuildWithNextEnvRestore(opomRepo);
  runCheck('OPOM typecheck', opomRepo, 'npm', ['run', 'typecheck']);
  runCheck('OPOM lint', opomRepo, 'npm', ['run', 'lint']);
  runCheck('OPOM Recharge route/import/migration tests', opomRepo, 'npm', [
    'test',
    '--',
    'test/recharge-api-routes.test.ts',
    'test/admin-routes.test.ts',
    'test/setup-db-migration.test.ts',
  ]);

  runCheck('Recharge diff whitespace check', rechargeRepo, 'git', ['diff', '--check']);
  runCheck('OPOM diff whitespace check', opomRepo, 'git', ['diff', '--check']);
} catch (error) {
  console.error(`\nIntegration verification failed: ${error.message}`);
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  const totalMs = checks.reduce((sum, check) => sum + check.durationMs, 0);
  console.log('\nIntegration verification passed');
  for (const check of checks) {
    console.log(`OK ${check.label}: ${Math.round(check.durationMs / 1000)}s`);
  }
  console.log(`Total command time: ${Math.round(totalMs / 1000)}s`);
}

function runOpomTempDbPush(cwd) {
  const tempDir = mkdtempSync(join(tmpdir(), 'opom-recharge-dbpush-'));
  const dbPath = join(tempDir, 'verify.sqlite');
  try {
    runCheck('OPOM db:push on temporary SQLite', cwd, 'npm', ['run', 'db:push'], {
      env: {DATABASE_URL: `file:${dbPath}`},
    });
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
}

function runOpomBuildWithNextEnvRestore(cwd) {
  const nextEnvPath = join(cwd, 'next-env.d.ts');
  const before = existsSync(nextEnvPath) ? readFileSync(nextEnvPath, 'utf8') : null;
  try {
    runCheck('OPOM production build', cwd, 'npm', ['run', 'build']);
  } finally {
    if (before !== null && existsSync(nextEnvPath)) {
      const after = readFileSync(nextEnvPath, 'utf8');
      if (after !== before) {
        writeFileSync(nextEnvPath, before, 'utf8');
        console.log('restored OPOM next-env.d.ts after Next build generated type path');
      }
    }
  }
}

function parseArgs(argv) {
  const parsed = {base: '', opomRepo: ''};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') {
      parsed.base = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--base=')) {
      parsed.base = arg.split('=').slice(1).join('=');
    } else if (arg === '--opom-repo') {
      parsed.opomRepo = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--opom-repo=')) {
      parsed.opomRepo = arg.split('=').slice(1).join('=');
    }
  }
  return parsed;
}
