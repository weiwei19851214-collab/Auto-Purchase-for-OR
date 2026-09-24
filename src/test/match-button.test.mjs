import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('matching remains disabled across renders and recovers after success or failure', async () => {
  const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
  const extract = (signature) => {
    const start = source.indexOf(signature);
    assert.ok(start >= 0);
    return source.slice(start, source.indexOf(String.fromCharCode(10) + '  }', start) + 4);
  };
  const el = {readyCount: {}, selectedCount: {}, blockedCount: {}, startButton: {}, matchButton: {textContent: '匹配 AdsPower'}, skipMatch: {checked: false}};
  const context = {el, state: {matchingAdsPower: false, rows: [{}]}, rowReady: () => true, selectedRows: () => [{}]};
  runInNewContext(extract('  function renderCounts(') + extract('  function canStart(') + extract('  async function withBusy('), context);
  let release;
  const pending = new Promise((resolve) => {release = resolve;});
  const running = context.withBusy(el.matchButton, '匹配中…', async () => {
    context.renderCounts();
    await pending;
  });
  assert.equal(el.matchButton.disabled, true);
  assert.equal(el.matchButton.textContent, '匹配中…');
  assert.equal(el.startButton.disabled, true);
  let duplicates = 0;
  await context.withBusy(el.matchButton, '匹配中…', async () => {duplicates += 1;});
  assert.equal(duplicates, 0);
  release();
  await running;
  assert.equal(el.matchButton.disabled, false);
  assert.equal(el.matchButton.textContent, '匹配 AdsPower');
  await assert.rejects(context.withBusy(el.matchButton, '匹配中…', async () => {throw new Error('fixture');}), /fixture/);
  assert.equal(context.state.matchingAdsPower, false);
  assert.equal(el.matchButton.disabled, false);
});
