import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

test('Windows startup wrappers invoke the local Node server without Bash', () => {
  const root = process.cwd();
  const powershell = readFileSync(join(root, 'start-local.ps1'), 'utf8');
  const command = readFileSync(join(root, 'start-local.cmd'), 'utf8');

  assert.match(powershell, /npm\.cmd start/);
  assert.match(powershell, /Get-NetTCPConnection/);
  assert.doesNotMatch(powershell, /\/usr\/bin\/env|\bbash\b/);
  assert.match(command, /powershell\.exe .*start-local\.ps1/i);
});
