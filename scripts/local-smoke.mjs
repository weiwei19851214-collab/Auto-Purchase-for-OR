#!/usr/bin/env node
import {redact} from '../src/server/redact.mjs';

const BLOCKED_CSV = `status,ID,username,amount,card_number,exp_month,exp_year,cvv,postal_code,auto_topup_threshold,auto_topup_amount
,1415,smoke@example.com,,5257970000000001,06,28,456,97001,2,25
`;

const args = parseArgs(process.argv.slice(2));
const baseUrl = normalizeBase(args.base || process.env.SMOKE_BASE_URL || 'http://127.0.0.1:4100');
const checks = [];

function add(label, ok, status = '') {
  checks.push({label, ok: Boolean(ok), status: String(status || (ok ? 'ok' : 'failed'))});
}

try {
  const health = await requestJson('/api/health');
  add('health endpoint', health.status === 200 && health.body?.ok, `http_${health.status}`);

  const session = await requestJson('/api/session');
  const token = session.body?.token || '';
  add('local session endpoint', session.status === 200 && Boolean(token), `http_${session.status}`);

  const unauthorized = await requestJson('/api/preflight');
  add('session guard rejects unauthenticated API', unauthorized.status === 401, `http_${unauthorized.status}`);

  const preflight = await requestJson('/api/preflight', {token});
  add('preflight endpoint', preflight.status === 200 && preflight.body?.ok, `http_${preflight.status}`);

  const dryRun = await requestJson('/api/jobs/dry-run', {
    method: 'POST',
    token,
    body: {
      fileName: 'smoke-blocked.csv',
      csvText: BLOCKED_CSV,
      options: {adspowerStatusMode: 'disabled'},
    },
  });
  add('dry-run blocked row contract', dryRun.status === 200 && dryRun.body?.ready === 0 && dryRun.body?.blocked === 1, `http_${dryRun.status}`);
  add('dry-run response redaction', !containsSensitive(JSON.stringify(dryRun.body || {})), 'no_sensitive_values');

  const create = await requestJson('/api/jobs', {
    method: 'POST',
    token,
    body: {
      fileName: 'smoke-blocked.csv',
      csvText: BLOCKED_CSV,
      options: {adspowerStatusMode: 'disabled'},
    },
  });
  const jobId = create.body?.job?.id || '';
  add('blocked job completes without live token', create.status === 201 && create.body?.job?.status === 'completed' && create.body?.job?.readyRows === 0, `http_${create.status}`);
  add('job create response redaction', !containsSensitive(JSON.stringify(create.body || {})), 'no_sensitive_values');

  const details = jobId ? await requestJson(`/api/jobs/${encodeURIComponent(jobId)}`, {token}) : {status: 0, body: null};
  add('job details endpoint', details.status === 200 && details.body?.job?.id === jobId, `http_${details.status}`);

  const resultCsv = jobId ? await requestText(`/api/jobs/${encodeURIComponent(jobId)}/result.csv`, {token}) : {status: 0, text: ''};
  add('result CSV endpoint', resultCsv.status === 200 && /missing_fields/.test(resultCsv.text), `http_${resultCsv.status}`);
  add('result CSV redaction', !containsSensitive(resultCsv.text), 'no_sensitive_values');
} catch (error) {
  add('local smoke exception', false, redact(error.message || 'unknown error'));
}

const failed = checks.filter((check) => !check.ok);
const result = {ok: failed.length === 0, failed: failed.length, baseUrl, checks};
if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const check of checks) {
    console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.label}: ${check.status}`);
  }
  console.log(result.ok ? 'local smoke passed' : `local smoke failed: ${failed.length} check(s)`);
}
process.exitCode = result.ok ? 0 : 1;

function parseArgs(argv) {
  const parsed = {base: '', json: false};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--base') {
      parsed.base = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--base=')) {
      parsed.base = arg.split('=').slice(1).join('=');
    }
  }
  return parsed;
}

function normalizeBase(value) {
  const url = new URL(String(value || 'http://127.0.0.1:4100'));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('base URL must be http(s)');
  return String(url).replace(/\/$/, '');
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: headers(options.token),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return {status: response.status, body: await safeJson(response)};
}

async function requestText(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: headers(options.token),
  });
  return {status: response.status, text: await response.text()};
}

function headers(token) {
  const output = {};
  if (token) output['x-runner-session'] = token;
  output['content-type'] = 'application/json';
  return output;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function containsSensitive(value) {
  return /,456,|card_number|cvv|"cvc"|"cardCvc"/i.test(String(value || ''));
}
