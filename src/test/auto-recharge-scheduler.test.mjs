import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../server/db.mjs';
import {AutoRechargeScheduler} from '../server/auto-recharge-scheduler.mjs';

function withFetch(fakeFetch, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

function schedulerPayload(overrides = {}) {
  return {
    enabled: true,
    confirmAutomaticPurchase: true,
    group: 'VIP',
    limit: 100,
    defaults: {
      balanceThreshold: '145',
      amountBelowThreshold: '150',
      amountAtOrAboveThreshold: '10',
      autoTopupThreshold: '100',
      autoTopupAmount: '150',
    },
    options: {
      opomBaseUrl: 'http://opom.local',
      opomRechargeToken: 'test-token',
      adspowerApiBase: 'http://adspower.local',
      adspowerApiKey: 'ads-token',
      opomWriteback: true,
      scopeBillingAddress: false,
      scopePaymentMethod: false,
      scopePurchase: true,
      scopeAutoTopup: false,
      confirmPurchase: true,
      preparePurchaseOnly: false,
      concurrency: 1,
    },
    ...overrides,
  };
}

test('auto recharge scheduler is disabled by default and requires explicit confirmation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-scheduler-default-'));
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const scheduler = new AutoRechargeScheduler(db);
    assert.equal(scheduler.getState().enabled, false);
    assert.throws(
      () => scheduler.update(schedulerPayload({confirmAutomaticPurchase: false})),
      /明确确认/,
    );
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('auto recharge scheduler creates a queued live job on the 15 minute slot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-runner-scheduler-run-'));
  const calls = [];
  try {
    const db = openDatabase(join(dir, 'test.sqlite'));
    const scheduler = new AutoRechargeScheduler(db);
    scheduler.update(schedulerPayload());

    await withFetch(async (url) => {
      calls.push(String(url));
      if (String(url).startsWith('http://opom.local/api/v1/recharge/accounts')) {
        return Response.json({
          data: [{
            opomAccountId: 'acct_1',
            loginEmail: 'user@example.com',
            status: 'CARD_SWITCH',
            adsPower: {userId: 'profile_ok', serialNumber: '1415'},
            health: {status: 'ok', eligible: true},
            activeCard: {
              orderNo: 'ejh_order_1',
              cardNo: '5257970000000001',
              status: 'ACTIVE',
            },
          }],
          nextCursor: null,
        });
      }
      if (String(url).startsWith('http://adspower.local/api/v1/user/list')) {
        return Response.json({
          code: 0,
          data: {
            list: [{
              user_id: 'profile_ok',
              serial_number: '1415',
              username: 'user@example.com',
            }],
          },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      await scheduler.tick(new Date('2026-07-23T10:15:05+08:00'));
    });

    const jobs = db.prepare('SELECT * FROM jobs').all();
    const rows = db.prepare('SELECT * FROM job_rows').all();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'queued');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'queued');
    assert.equal(rows[0].opom_account_id, 'acct_1');
    assert.equal(rows[0].card_no, '5257970000000001');
    assert.ok(calls.some((url) => url.includes('/api/v1/recharge/accounts')));
    assert.ok(calls.some((url) => url.includes('/api/v1/user/list')));
    const state = scheduler.getState();
    assert.equal(state.enabled, true);
    assert.equal(state.status, 'queued');
    assert.match(state.message, /自动充值已创建任务/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
