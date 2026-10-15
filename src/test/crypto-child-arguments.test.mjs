import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as childRunner from '../automation/lib/child-runner.mjs';
import * as common from '../automation/lib/common.mjs';
import {runClosedLoopChildAsync} from '../server/automation-adapter.mjs';

for (const mode of ['crypto', 'bank']) {
  test(`${mode} subprocess arguments preserve runner-specific flags and JSON authorization`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recharge-child-test-'));
    try {
      const script = join(dir, 'inspect.mjs');
      writeFileSync(script, `import {readFileSync} from 'node:fs';
        const task = JSON.parse(readFileSync(0, 'utf8'));
        console.log(JSON.stringify({ok:true, argv:process.argv.slice(2), task}));`);
      const task = {purchase: {confirmed: true, amount: '10'}, confirmWalletPayment: true};
      const args = {rechargeMode: mode, scopeAutoTopup: true, scopePurchase: true, confirmPurchase: true,
        scopePaymentMethod: true, removeExisting: true, rowTimeoutMs: 5000};
      const expectedArgs = mode === 'crypto' ? ['--stdin']
        : ['--stdin', '--configure-auto-topup', '--confirm-purchase', '--remove-existing'];
      for (const result of [childRunner.runClosedLoopChild(script, task, args),
        await runClosedLoopChildAsync(script, task, args, childRunner, common)]) {
        assert.equal(result.ok, true);
        assert.deepEqual(result.result.argv, expectedArgs);
        assert.deepEqual(result.result.task, task);
      }
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
}
