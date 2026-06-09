import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT_DIR} from './config.mjs';
import {redact} from './redact.mjs';

const SCRIPT_PATH = join(ROOT_DIR, 'ejh_create_cards.py');

export function ejhDefaults(env = process.env) {
  return {
    appKey: env.EJH_APP_KEY || '',
    appSecret: env.EJH_APP_SECRET || '',
    python: env.PYTHON || 'python3',
  };
}

export async function createCardsWithEjh(input = {}, env = process.env) {
  if (!existsSync(SCRIPT_PATH)) throw new Error('EJH card script is missing');
  const defaults = ejhDefaults(env);
  const appKey = input.appKey || defaults.appKey;
  const appSecret = input.appSecret || defaults.appSecret;
  const required = {
    appKey,
    appSecret,
    count: input.count,
    amount: input.amount,
    activeDate: input.activeDate,
    cardholder: input.cardholder,
    output: input.output,
  };
  const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Missing EJH card creation inputs: ${missing.join(', ')}`);

  const args = [
    SCRIPT_PATH,
    '--non-interactive',
    '--app-key', appKey,
    '--app-secret', appSecret,
    '--count', String(input.count),
    '--amount', String(input.amount),
    '--active-date', String(input.activeDate),
    '--cardholder', String(input.cardholder),
    '--output', String(input.output),
  ];
  if (input.cardBatchId) args.push('--card-batch-id', String(input.cardBatchId));
  if (input.unsafeRawOutput) args.push('--unsafe-raw-output');

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(defaults.python, args, {stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      resolve({ok: false, error: redact(error.message)});
    });
    child.on('close', (code) => {
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1) || '';
      let parsed = null;
      try {
        parsed = JSON.parse(last);
      } catch {}
      resolve({
        ok: code === 0 && parsed?.ok !== false,
        code,
        result: parsed,
        stdout: redact(stdout),
        stderr: redact(stderr),
      });
    });
  });
}
