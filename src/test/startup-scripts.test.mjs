import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

test('single Windows bootstrap installs prerequisites, clones new-portal, and starts the local console', () => {
  const root = process.cwd();
  const powershell = readFileSync(join(root, 'bootstrap-windows.ps1'), 'utf8');

  assert.match(powershell, /Git\.Git/);
  assert.match(powershell, /OpenJS\.NodeJS\.LTS/);
  assert.match(powershell, /--branch', \$Branch, '--single-branch/);
  assert.match(powershell, /'new-portal'/);
  assert.match(powershell, /npm\.cmd start/);
  assert.match(powershell, /api\/health/);
  assert.doesNotMatch(powershell, /\/usr\/bin\/env|\bbash\b/);
});

test('single macOS bootstrap installs prerequisites, clones new-portal, and starts the local console', () => {
  const root = process.cwd();
  const script = readFileSync(join(root, 'bootstrap-macos.sh'), 'utf8');

  assert.match(script, /Homebrew\/install\/HEAD\/install\.sh/);
  assert.match(script, /brew install git/);
  assert.match(script, /brew install node/);
  assert.match(script, /--branch "\$BRANCH" --single-branch/);
  assert.match(script, /BRANCH="\$\{BRANCH:-new-portal\}"/);
  assert.match(script, /start-local\.sh/);
  assert.match(script, /api\/health/);
  assert.match(script, /open "\$console_url"/);
});
