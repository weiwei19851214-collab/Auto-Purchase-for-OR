#!/usr/bin/env node
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {ROOT_DIR} from '../src/server/config.mjs';
import {redact} from '../src/server/redact.mjs';

const SCAN_ROOTS = [
  'README.md',
  'docs',
  'public',
  'scripts',
  'src',
  'openrouter-recharge-input-template.csv',
  'ejh_create_cards.py',
];

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'data',
  '.next',
  'dist',
  'build',
  'coverage',
]);

const ALLOW_FIXTURE_RE = /^(src\/test\/|scripts\/.*smoke\.mjs$)/;

const RULES = [
  {
    id: 'full_pan',
    description: '12-19 digit card-like value',
    pattern: /\b\d{12,19}\b/g,
    allowFixtures: true,
  },
  {
    id: 'inline_cvv',
    description: 'inline CVV/CVC numeric value',
    pattern: /\b(?:cvv|cvc|cardCvc|card-cvc|cvvPassword)\b\s*[:=,]\s*['"]?\d{3,4}\b/gi,
    allowFixtures: true,
  },
  {
    id: 'openrouter_key',
    description: 'OpenRouter API key',
    pattern: /\bsk-or-v1-[A-Za-z0-9_-]{10,}\b/g,
    allowFixtures: false,
  },
  {
    id: 'bearer_token_literal',
    description: 'literal bearer token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g,
    allowFixtures: false,
  },
  {
    id: 'raw_ejh_diagnostic_in_template',
    description: 'raw EJH diagnostic field in user-facing handoff/template',
    pattern: /\b(?:encryptedParam|requestPayload|rawResponse)\b/g,
    allowFixtures: true,
  },
];

const findings = [];
for (const file of collectFiles()) {
  const rel = relative(ROOT_DIR, file).replaceAll('\\', '/');
  if (!isTextFile(rel)) continue;
  const text = readFileSync(file, 'utf8');
  const allowFixture = ALLOW_FIXTURE_RE.test(rel);
  for (const rule of RULES) {
    if (rule.id === 'raw_ejh_diagnostic_in_template' && !isUserFacingTemplate(rel)) continue;
    if (allowFixture && rule.allowFixtures) continue;
    const matches = [...text.matchAll(rule.pattern)];
    for (const match of matches) {
      findings.push({
        rule: rule.id,
        description: rule.description,
        file: rel,
        line: lineNumberAt(text, match.index || 0),
        match: redact(match[0]),
      });
    }
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ok: findings.length === 0, findings}, null, 2));
} else {
  if (!findings.length) {
    console.log('sensitive static audit passed');
  } else {
    console.log(`sensitive static audit failed: ${findings.length} finding(s)`);
    for (const finding of findings) {
      console.log(`- ${finding.rule} ${finding.file}:${finding.line} ${finding.match}`);
    }
  }
}

process.exitCode = findings.length === 0 ? 0 : 1;

function collectFiles() {
  const output = [];
  for (const root of SCAN_ROOTS) {
    const path = join(ROOT_DIR, root);
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path, output);
      } else if (stat.isFile()) {
        output.push(path);
      }
    } catch {
      continue;
    }
  }
  return output;
}

function walk(dir, output) {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, output);
    } else if (stat.isFile()) {
      output.push(path);
    }
  }
}

function isTextFile(path) {
  return /\.(?:md|csv|html|css|js|mjs|ts|tsx|py|json)$/i.test(path);
}

function isUserFacingTemplate(path) {
  return path.endsWith('.csv') || path.startsWith('public/');
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}
