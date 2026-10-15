import assert from 'node:assert/strict';
import test from 'node:test';
import {buildCryptoCallbackPayload} from '../server/crypto-callback.mjs';
import {writeCryptoCompletedRow} from '../server/opom-client.mjs';

const row = {opom_account_id: 'account-1', login_email: 'fixture@example.com'};
const details = {purchaseStatus: 'verified', purchaseAmount: '150', cryptoCreditAmount: '150.00000000',
  cryptoPaymentAmount: '155.123456789123456789', cryptoPaymentAsset: 'USDC', cryptoNetworkFeeUsd: '0.01',
  cryptoNetworkFeeDisplay: '<$0.01', cryptoNetworkFeeSource: 'okx_wallet', balanceBefore: '-2', balanceAfter: '148'};
const context = {idempotencyKey: 'stable', providerEventId: 'event-1', occurredAt: '2026-10-15T11:00:00Z'};
const args = {opomWriteback: true, opomBaseUrl: 'http://opom.test', opomRechargeToken: 'fixture', runId: 'run', opomWritebackRetries: 1};
const stored = {data: {status: 'STORED', callbackId: 'cb', providerEventId: 'event-1'}};

test('crypto callback keeps all three USD amounts separate with exact decimal precision and no fee', () => {
  const result = buildCryptoCallbackPayload(row, details, context);
  assert.equal(result.amount, '150.00000000');
  assert.equal(result.PaidAmount, '155.123456789123456789');
  assert.equal(result.networkFee, '0.01');
  assert.equal(result.amountCurrency, 'USD');
  assert.equal(result.networkFeeCurrency, 'USD');
  assert.match(result.remark, /<\$0.01/);
  assert.equal(result.fee, undefined);
  assert.equal(result.feeCurrency, undefined);
});

for (const change of [{cryptoPaymentAmount: ''}, {cryptoPaymentAmount: 155}, {cryptoPaymentAmount: '1e2'},
  {cryptoPaymentAmount: '-1'}, {cryptoPaymentAsset: 'ETH'}, {cryptoNetworkFeeUsd: ''}, {purchaseStatus: 'submitted'}]) {
  test(`callback rejects incomplete evidence ${JSON.stringify(change)}`, () => {
    assert.throws(() => buildCryptoCallbackPayload(row, {...details, ...change}, context));
  });
}

test('USD gas amount is usable; ETH gas is never relabeled USD or defaulted to zero', () => {
  const noUsd = {...details, cryptoNetworkFeeUsd: '', cryptoNetworkFeeAmount: '0', cryptoNetworkFeeAsset: 'USD'};
  assert.equal(buildCryptoCallbackPayload(row, noUsd, context).networkFee, '0');
  assert.throws(() => buildCryptoCallbackPayload(row, {...noUsd, cryptoNetworkFeeAsset: 'ETH'}, context));
});

test('callback retries reuse persisted payload then synchronize legacy balance and AdsPower', async t => {
  const callbackPayload = buildCryptoCallbackPayload(row, details, context);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({url: String(url), body: JSON.parse(init.body)});
    return Response.json(String(url).endsWith('/callback') ? stored : {ok: true}, {status: String(url).endsWith('/callback') ? 201 : 200});
  });
  await writeCryptoCompletedRow(args, row, details, {callbackPayload});
  await writeCryptoCompletedRow(args, row, {...details, cryptoPaymentAmount: '999'}, {callbackPayload});
  assert.deepEqual(calls[0].body, calls[2].body);
  assert.equal(calls[1].body.balanceBeforeUsd, -2);
  assert.equal(calls[1].body.occurredAt, context.occurredAt);
  assert.deepEqual(calls[1].body, calls[3].body);
});

for (const [status, response] of [[200, {}], [200, {data: {...stored.data, providerEventId: 'other'}}],
  [200, {data: {...stored.data, callbackId: ''}}], [202, stored], [409, {error: 'IDEMPOTENCY_PAYLOAD_MISMATCH'}]]) {
  test(`reject callback response ${status} ${JSON.stringify(response)}`, async t => {
    let writes = 0;
    t.mock.method(globalThis, 'fetch', async () => { writes++; return Response.json(response, {status}); });
    await assert.rejects(writeCryptoCompletedRow(args, row, details, {callbackPayload: buildCryptoCallbackPayload(row, details, context)}));
    assert.equal(writes, 1);
  });
}

test('missing frozen payload fails before any write', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not call'); });
  await assert.rejects(writeCryptoCompletedRow(args, row, details), /persisted callbackPayload/);
});

for (const status of [500, 503, 400, 401, 404, 409, 422]) {
  test(`HTTP ${status} preserves classification and only transient failures retry`, async t => {
    let writes = 0;
    t.mock.method(globalThis, 'fetch', async () => { writes++; return Response.json({error: 'fixture'}, {status}); });
    await assert.rejects(writeCryptoCompletedRow({...args, opomWritebackRetries: 2, opomRetryDelayMs: 1}, row, details,
      {callbackPayload: buildCryptoCallbackPayload(row, details, context)}), error => error.httpStatus === status);
    assert.equal(writes, status >= 500 ? 2 : 1);
  });
}
