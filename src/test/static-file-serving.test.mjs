import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

test('static file boundary check is path-separator independent', () => {
  const source = readFileSync(join(process.cwd(), 'src/server/index.mjs'), 'utf8');

  assert.match(source, /relative\(PUBLIC_DIR, filePath\)/);
  assert.match(source, /relativePath\.startsWith\(`\.\.\$\{sep\}`\)/);
  assert.match(source, /isAbsolute\(relativePath\)/);
  assert.doesNotMatch(source, /filePath\.startsWith\(`\$\{PUBLIC_DIR\}\/`\)/);
});
