#!/usr/bin/env node
// A fresh service/database on an ephemeral port; no real OPOM, AdsPower or wallet.
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'crypto-scheduler-api-'));
const token = 'isolated-test-session';
const walletPassword = 'isolated-test-wallet-password';
let child;
let base;
const env = {...process.env, PORT:'0', OR_RUNNER_DATA_DIR:directory, OR_RUNNER_DB:join(directory,'runner.sqlite'),
  OR_RUNNER_SESSION_TOKEN:token, ADSPOWER_API_BASE:'http://127.0.0.1:1', ADSPOWER_API_KEY:'',
  OPOM_BASE_URL:'', OPOM_API_BASE:'', OPOM_RECHARGE_TOKEN:'', RECHARGE_API_TOKEN:'',
  OPOM_SECONDARY_BASE_URL:'', ADSPOWER_STATUS_MODE:'disabled'};
async function start() {
  child = spawn(process.execPath, ['src/server/index.mjs'], {cwd:root, env, stdio:['ignore','pipe','pipe']});
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('isolated server startup timeout')), 10000);
    child.once('error', (error) => {clearTimeout(timer); reject(error);});
    child.once('exit', (code) => {clearTimeout(timer); reject(new Error(`isolated server exited ${code}`));});
    child.stdout.on('data', (data) => {
      const url = String(data).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) {clearTimeout(timer); resolve(url);}
    });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {child.once('exit', resolve); child.kill('SIGTERM');});
}
async function request(path, body) {
  const response = await fetch(base+path, {method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-runner-session':token},body:body?JSON.stringify(body):undefined});
  const text = await response.text();
  assert.equal(text.includes(walletPassword), false);
  return {status:response.status, body:JSON.parse(text), headers:response.headers};
}
try {
  await start();
  assert.equal((await fetch(base+'/api/scheduler?rechargeMode=crypto')).status, 401);
  let response = await request('/api/scheduler?rechargeMode=crypto');
  assert.equal(response.status, 200);
  assert.equal(response.body.settings.amount, 150);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const connection = {opomBaseUrl:'http://127.0.0.1:1',opomRechargeToken:'mock-token',adspowerApiBase:'http://127.0.0.1:1',adspowerApiKey:'mock-key'};
  for (const settings of [{scheduleType:'daily',dailyTimes:['09:00','21:30']},{scheduleType:'hourly',hourlyMinutes:[15,45]},{scheduleType:'interval',intervalMinutes:30}]) {
    response = await request('/api/scheduler',{rechargeMode:'crypto',action:'save',settings,...connection,walletPassword});
    assert.equal(response.status, 200);
    assert.equal(response.body.enabled, false);
    assert.equal(response.body.walletPasswordConfigured, true);
    assert.equal(response.body.settings.scheduleType,settings.scheduleType);
  }
  assert.equal((await request('/api/scheduler',{rechargeMode:'crypto',action:'enable'})).status, 409);
  response = await request('/api/scheduler',{rechargeMode:'crypto',action:'enable',confirmAutomaticPurchase:true});
  assert.equal(response.status,200);
  assert.equal(response.body.enabled,true);
  assert.ok(Date.parse(response.body.nextRunAt)>Date.now());
  await stop();
  assert.equal(readFileSync(join(directory,'runner.sqlite')).includes(Buffer.from(walletPassword)),false);
  await start();
  response = await request('/api/scheduler?rechargeMode=crypto');
  assert.equal(response.body.enabled,false);
  assert.equal(response.body.walletPasswordConfigured,false);
  assert.equal(response.body.status,'paused_restart');
  assert.equal((await request('/api/scheduler',{rechargeMode:'crypto',action:'enable',confirmAutomaticPurchase:true})).status,409);
  assert.equal((await request('/api/jobs')).body.jobs.length,0);
  const exec = promisify(execFile);
  for (const script of ['scripts/local-smoke.mjs','scripts/ui-smoke.mjs']) {
    await exec(process.execPath,[script,'--base',base],{cwd:root,env,timeout:30000});
  }
  console.log('PASS isolated scheduler API, restart/password privacy, local smoke and UI contracts');
} finally {
  await stop();
  rmSync(directory,{recursive:true,force:true});
}
