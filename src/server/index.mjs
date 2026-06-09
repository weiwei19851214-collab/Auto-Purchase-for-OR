import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {assertLocalRequest, requireSession, sessionPayload} from './auth.mjs';
import {DEFAULT_SERVER_PORT, PUBLIC_DIR} from './config.mjs';
import {openDatabase, getJob, recoverInterruptedWork} from './db.mjs';
import {httpError, readJsonBody, route, sendFile, sendJson, sendText} from './http-utils.mjs';
import {cancelJob, createJob, dryRunPayload, jobDetails, jobsList} from './jobs.mjs';
import {matchAdsPowerPayload} from './adspower-match.mjs';
import {configuredTargetsFromRunner, inspectAdsPowerStatusTargets} from './adspower-status-targets.mjs';
import {allocateCardsPayload} from './card-allocation.mjs';
import {environmentPreflight} from './preflight.mjs';
import {readyToRechargePayload, resolveOpomAccountsPayload} from './opom-orchestrator.mjs';
import {redact} from './redact.mjs';
import {cleanupJobUpload, runnerArgs} from './automation-adapter.mjs';
import {JobWorker} from './worker.mjs';

const db = openDatabase();
const recoveredJobIds = recoverInterruptedWork(db);
if (recoveredJobIds.length) console.warn(`[recovery] blocked ${recoveredJobIds.length} interrupted job(s) for manual verification`);
const worker = new JobWorker(db);
for (const jobId of recoveredJobIds) {
  try {
    await worker.writeCurrentResult(jobId);
    cleanupJobUpload(getJob(db, jobId));
  } catch (error) {
    console.warn(`[recovery] could not rewrite result for ${jobId}: ${redact(error.message)}`);
  }
}
worker.start();

const server = createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      error: redact(error.message || 'Internal server error'),
    });
  }
});

async function handle(req, res) {
  const {parts, pathname} = route(req);
  assertLocalRequest(req);

  if (pathname === '/api/health') {
    sendJson(res, 200, {ok: true, worker: worker.status()});
    return;
  }

  if (pathname === '/api/session') {
    sendJson(res, 200, {ok: true, ...sessionPayload()});
    return;
  }

  if (pathname === '/api/preflight') {
    requireSession(req);
    sendJson(res, 200, await environmentPreflight());
    return;
  }

  if (req.method === 'POST' && pathname === '/api/jobs/dry-run') {
    requireSession(req);
    const payload = await readJsonBody(req);
    sendJson(res, 200, await dryRunPayload(payload));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/opom/ready') {
    requireSession(req);
    const payload = await readJsonBody(req);
    sendJson(res, 200, await readyToRechargePayload(payload));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/opom/resolve') {
    requireSession(req);
    const payload = await readJsonBody(req);
    sendJson(res, 200, await resolveOpomAccountsPayload(payload));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/adspower/match') {
    requireSession(req);
    const payload = await readJsonBody(req);
    sendJson(res, 200, await matchAdsPowerPayload(payload));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/adspower/status-targets') {
    requireSession(req);
    const payload = await readJsonBody(req);
    const runner = runnerArgs(payload.options || payload || {});
    sendJson(res, 200, await inspectAdsPowerStatusTargets({
      adspowerApiBase: runner.adspowerApiBase,
      adspowerApiKey: runner.adspowerApiKey,
      configured: configuredTargetsFromRunner(runner),
    }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/cards/allocate') {
    requireSession(req);
    const payload = await readJsonBody(req);
    sendJson(res, 200, await allocateCardsPayload(payload));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/jobs') {
    requireSession(req);
    const payload = await readJsonBody(req);
    sendJson(res, 201, await createJob(db, payload));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/jobs') {
    requireSession(req);
    sendJson(res, 200, {ok: true, jobs: jobsList(db), worker: worker.status()});
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'jobs' && parts[2]) {
    requireSession(req);
    const jobId = parts[2];
    const job = getJob(db, jobId);
    if (!job) throw httpError(404, 'Job not found');

    if (req.method === 'GET' && parts.length === 3) {
      sendJson(res, 200, {ok: true, ...jobDetails(db, jobId), worker: worker.status()});
      return;
    }

    if (req.method === 'GET' && parts[3] === 'rows') {
      sendJson(res, 200, {ok: true, rows: jobDetails(db, jobId).rows});
      return;
    }

    if (req.method === 'GET' && parts[3] === 'result.csv') {
      if (!existsSync(job.result_csv_path)) throw httpError(404, 'Result CSV is not ready yet');
      await sendFile(res, job.result_csv_path);
      return;
    }

    if (req.method === 'POST' && parts[3] === 'cancel') {
      const canceled = await cancelJob(db, jobId);
      sendJson(res, 200, {ok: true, ...canceled});
      return;
    }
  }

  if (req.method === 'GET') {
    await serveStatic(res, pathname);
    return;
  }

  throw httpError(404, 'Not found');
}

async function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}/`) && filePath !== PUBLIC_DIR) throw httpError(403, 'Forbidden');
  if (!existsSync(filePath)) {
    sendText(res, 404, 'Not found');
    return;
  }
  await sendFile(res, filePath);
}

server.listen(DEFAULT_SERVER_PORT, '127.0.0.1', () => {
  console.log(`OpenRouter recharge runner listening on http://127.0.0.1:${DEFAULT_SERVER_PORT}`);
});
