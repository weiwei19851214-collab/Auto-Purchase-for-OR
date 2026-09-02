import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {assertLocalRequest, requireSession, sessionPayload} from './auth.mjs';
import {DEFAULT_SERVER_PORT, PUBLIC_DIR, ROOT_DIR} from './config.mjs';
import {openDatabase, getJob, recoverInterruptedWork} from './db.mjs';
import {httpError, readJsonBody, route, sendFile, sendJson, sendText} from './http-utils.mjs';
import {cancelJob, createJob, dryRunPayload, jobDetails, jobsList, repairOpomWriteback, resumeJob, resumePreview} from './jobs.mjs';
import {matchAdsPowerPayload} from './adspower-match.mjs';
import {configuredTargetsFromRunner, inspectAdsPowerStatusTargets} from './adspower-status-targets.mjs';
import {allocateCardsPayload} from './card-allocation.mjs';
import {environmentPreflight} from './preflight.mjs';
import {readyToRechargePayload, resolveOpomAccountsPayload} from './opom-orchestrator.mjs';
import {redact} from './redact.mjs';
import {runnerArgs} from './automation-adapter.mjs';
import {JobWorker} from './worker.mjs';
import {AutoRechargeScheduler} from './auto-recharge-scheduler.mjs';

const db = openDatabase();
const recoveredJobIds = recoverInterruptedWork(db);
if (recoveredJobIds.length) console.warn(`[recovery] blocked ${recoveredJobIds.length} interrupted job(s) for manual verification`);
const worker = new JobWorker(db);
const autoRechargeScheduler = new AutoRechargeScheduler(db);
for (const jobId of recoveredJobIds) {
  try {
    await worker.writeCurrentResult(jobId);
  } catch (error) {
    console.warn(`[recovery] could not rewrite result for ${jobId}: ${redact(error.message)}`);
  }
}
worker.start();
autoRechargeScheduler.start();

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
    sendJson(res, 200, {ok: true, worker: worker.status(), scheduler: autoRechargeScheduler.getState()});
    return;
  }

  if (pathname === '/api/session') {
    sendJson(res, 200, {ok: true, ...sessionPayload()});
    return;
  }

  if (pathname === '/api/repo-info') {
    sendJson(res, 200, {ok: true, repo: await repoInfo()});
    return;
  }

  if (pathname === '/api/preflight') {
    requireSession(req);
    const payload = req.method === 'POST' ? await readJsonBody(req) : {};
    sendJson(res, 200, await environmentPreflight(payload.options || payload || {}));
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

  if (pathname === '/api/scheduler') {
    requireSession(req);
    if (req.method === 'GET') {
      sendJson(res, 200, autoRechargeScheduler.getState());
      return;
    }
    if (req.method === 'POST') {
      const payload = await readJsonBody(req);
      sendJson(res, 200, autoRechargeScheduler.update(payload));
      return;
    }
  }

  if (req.method === 'GET' && pathname === '/api/jobs') {
    requireSession(req);
    sendJson(res, 200, {ok: true, jobs: jobsList(db), worker: worker.status(), scheduler: autoRechargeScheduler.getState()});
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

    if (req.method === 'POST' && parts[3] === 'resume-preview') {
      const payload = await readJsonBody(req);
      sendJson(res, 200, await resumePreview(db, jobId, payload));
      return;
    }

    if (req.method === 'POST' && parts[3] === 'resume') {
      if (worker.status().running) throw httpError(409, 'Worker is currently running; wait before resuming a job');
      const payload = await readJsonBody(req);
      sendJson(res, 200, await resumeJob(db, jobId, payload));
      return;
    }

    if (req.method === 'POST' && parts[3] === 'rows' && parts[4] && parts[5] === 'opom-writeback-repair') {
      if (worker.status().running) throw httpError(409, 'Worker is currently running; wait before repairing OPOM writeback');
      sendJson(res, 200, await repairOpomWriteback(db, jobId, {rowNumber: Number(parts[4])}));
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

function gitOutput(args) {
  return new Promise((resolveOutput, reject) => {
    execFile('git', args, {
      cwd: ROOT_DIR,
      timeout: 2000,
      maxBuffer: 1024 * 64,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolveOutput(String(stdout || '').trim());
    });
  });
}

async function repoInfo() {
  try {
    const [branch, updatedAt, shortSha] = await Promise.all([
      gitOutput(['rev-parse', '--abbrev-ref', 'HEAD']),
      gitOutput(['log', '-1', '--format=%cI']),
      gitOutput(['rev-parse', '--short', 'HEAD']),
    ]);
    return {
      branch,
      updatedAt,
      shortSha,
    };
  } catch (error) {
    // Git 信息只用于页面展示；读取失败不能影响充值执行器主体功能。
    return {
      branch: 'unknown',
      updatedAt: '',
      shortSha: '',
      error: redact(error.message || 'git info unavailable'),
    };
  }
}

async function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(PUBLIC_DIR, `.${requested}`);
  // 不能用字符串拼接 '/' 判断目录边界：Windows resolve 会返回 '\\'，会把合法首页误判为越界。
  const relativePath = relative(PUBLIC_DIR, filePath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw httpError(403, 'Forbidden');
  }
  if (!existsSync(filePath)) {
    sendText(res, 404, 'Not found');
    return;
  }
  await sendFile(res, filePath, {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
}

server.listen(DEFAULT_SERVER_PORT, '127.0.0.1', () => {
  console.log(`OpenRouter recharge runner listening on http://127.0.0.1:${DEFAULT_SERVER_PORT}`);
});
