import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {fillAmount, resolveAmount} from '../automation/crypto_recharge_openrouter_cdp.mjs';
import {buildCryptoRechargeTask} from '../automation/lib/recharge-plan.mjs';

// 实际输入函数及页面回读表达式；假 CDP 复现 keyDown.text 和 char 都会插入文本的行为。
function fakeAmountPage(initialValue, {clearWorks = true, resetOnBlur = false, buttonReady = true, balance = '0.47'} = {}) {
  const events = [];
  let cursor = 0;
  const input = {
    value: initialValue, type: 'number', disabled: false, marked: false,
    parentElement: {innerText: 'Amount'},
    getBoundingClientRect: () => ({width: 300, height: 40}),
    getAttribute: () => 'Amount', closest: () => null,
    setAttribute() { this.marked = true; },
    removeAttribute() { this.marked = false; },
    scrollIntoView() {},
    focus() { document.activeElement = this; },
  };
  const button = {
    innerText: 'Purchase', disabled: !buttonReady,
    getBoundingClientRect: () => ({width: 300, height: 40}),
    getAttribute: () => null,
  };
  const document = {
    activeElement: null,
    body: {innerText: 'TOTAL AVAILABLE $' + balance},
    querySelectorAll: (selector) => selector === 'input' ? [input] : [button],
    querySelector: () => input.marked ? input : null,
  };
  const page = {async send(method, params) {
    if (method === 'Runtime.evaluate') {
      return {result: {value: runInNewContext(params.expression, {document})}};
    }
    assert.equal(method, 'Input.dispatchKeyEvent');
    events.push(params);
    if (['rawKeyDown', 'keyDown'].includes(params.type)) {
      if (params.key === 'End' && params.windowsVirtualKeyCode === 35) cursor = input.value.length;
      if (params.key === 'Backspace' && params.windowsVirtualKeyCode === 8 && clearWorks && cursor > 0) {
        input.value = input.value.slice(0, cursor - 1) + input.value.slice(cursor);
        cursor -= 1;
      }
      if (params.key === 'Tab' && params.windowsVirtualKeyCode === 9) {
        document.activeElement = button;
        if (resetOnBlur) input.value = '10';
      }
    }
    if (params.type !== 'keyUp' && params.text) {
      input.value = input.value.slice(0, cursor) + params.text + input.value.slice(cursor);
      cursor += params.text.length;
    }
    return {};
  }};
  return {page, input, events};
}

for (const oldValue of ['10', '10115500', '150']) {
  for (const amount of ['150', '20', '10.50']) {
    test('crypto replaces ' + oldValue + ' with exactly ' + amount + ' and blurs', async () => {
      const {page, input, events} = fakeAmountPage(oldValue);
      const result = await fillAmount(page, amount);
      assert.equal(input.value, amount);
      assert.equal(result.blurred, true);
      assert.equal(result.purchaseReady, true);
      assert.equal(events.filter((event) => event.text).map((event) => event.text).join(''), amount);
      assert.ok(events.filter((event) => event.text).every((event) => event.type === 'char'));
    });
  }
}

test('crypto refuses to type when the old amount was not cleared', async () => {
  const {page, events} = fakeAmountPage('10115500', {clearWorks: false});
  await assert.rejects(fillAmount(page, '150'), /empty value before typing/);
  assert.equal(events.some((event) => event.type === 'char'), false);
});

test('crypto rejects a page that resets the amount after Tab or disables Purchase', async () => {
  for (const options of [{resetOnBlur: true}, {buttonReady: false}]) {
    await assert.rejects(fillAmount(fakeAmountPage('10', options).page, '150'), /did not retain 150/);
  }
});

test('crypto page rule 145/150/20 selects and enters the correct fixed amount at both boundaries', async () => {
  const task = buildCryptoRechargeTask({balance_threshold: '145', amount_below_threshold: '150', amount_at_or_above_threshold: '20'}, {});
  for (const [balance, expected] of [['0.47', '150'], ['144.99', '150'], ['145', '20'], ['200', '20'], ['-2.62', '150']]) {
    const {page, input} = fakeAmountPage('10', {balance});
    const decision = await resolveAmount(page, task.purchase);
    assert.equal(decision.amount, expected);
    await fillAmount(page, decision.amount);
    assert.equal(input.value, expected);
  }
});
