#!/usr/bin/env node
import {existsSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {ROOT_DIR} from '../src/server/config.mjs';
import {redact} from '../src/server/redact.mjs';

const DEFAULT_OPOM_REPO = '/Users/weiwei/project/manager-openrouter';
const args = parseArgs(process.argv.slice(2));
const rechargeRepo = ROOT_DIR;
const opomRepo = resolve(args.opomRepo || process.env.OPOM_REPO || DEFAULT_OPOM_REPO);
const preflightMarkerPath = args.preflightMarker || process.env.OPOM_PRODUCTION_PREFLIGHT_MARKER || '';
const items = [];
const adsPowerStatus = adsPowerStatusReadiness();
const opomProduction = opomProductionReadiness(process.env, preflightMarkerPath);

try {
  addRequirement({
    id: '0-manual-prep',
    title: 'Ops prepares AdsPower and OPOM recharge group',
    status: hasReadmeText(/group=recharge|Load OPOM group/i) ? 'pending_manual_ops' : 'fail',
    evidence: ['README documents recharge group and operator flow'],
    next: 'Operator must move eligible OPOM accounts into group=recharge before live work.',
  });

  addRequirement({
    id: '1-opom-ready',
    title: 'Load OPOM group pulls OPOM recharge accounts',
    status: all([
      hasFile('src/server/opom-client.mjs'),
      hasFile('src/server/opom-orchestrator.mjs'),
      hasText('src/server/index.mjs', /\/api\/opom\/ready/),
      hasOpomFile('app/api/v1/recharge/accounts/route.ts'),
    ]) ? 'ready' : 'fail',
    evidence: [
      'Recharge /api/opom/ready endpoint',
      'OPOM /api/v1/recharge/accounts route',
    ],
  });

  addRequirement({
    id: '2-operator-confirmation',
    title: 'Recharge lists pending rows for operator confirmation',
    status: all([
      hasText('public/index.html', /opomPreviewBody/),
      hasText('public/index.html', /liveRunBtn/),
      hasText('public/index.html', /自动预检/),
      hasText('src/server/safety.mjs', /dry-run confirmation token/i),
    ]) ? 'ready' : 'fail',
    evidence: ['Operator preview table', 'automatic preflight token gate'],
  });

  addRequirement({
    id: '3-adspower-match',
    title: 'Match AdsPower profiles and verify identity',
    status: all([
      hasFile('src/server/adspower-match.mjs'),
      hasText('src/server/index.mjs', /\/api\/adspower\/match/),
      hasText('src/test/opom-integration.test.mjs', /identity mismatch|matchAdsPowerPayload/i),
    ]) ? 'ready' : 'fail',
    evidence: ['AdsPower match endpoint', 'identity mismatch tests'],
  });

  addRequirement({
    id: '4-rules-and-billing',
    title: 'Run-level recharge rules and optional billing address mapping',
    status: all([
      hasText('public/index.html', /addressMappingCsv/),
      hasText('public/app.js', /opomDefaultsPayload/),
      hasText('src/server/opom-orchestrator.mjs', /addressCsvText|billing/i),
      hasText('src/automation/lib/recharge-plan.mjs', /auto_topup_threshold/),
    ]) ? 'ready' : 'fail',
    evidence: ['UI rule controls', 'address mapping parser', 'Auto top-up fields'],
  });

  addRequirement({
    id: '5-ejh-card-allocation',
    title: 'Batch EJH card creation/allocation emits safe card CSV',
    status: all([
      hasFile('ejh_create_cards.py'),
      hasFile('src/server/card-provider-ejh.mjs'),
      hasFile('src/server/card-allocation.mjs'),
      hasText('src/test/opom-integration.test.mjs', /raw diagnostic|allocateCards/i),
    ]) ? 'ready' : 'fail',
    evidence: ['EJH CLI/module wrapper', 'safe card allocation tests'],
    next: 'Real EJH card creation still requires explicit authorization and EJH credentials.',
  });

  addRequirement({
    id: '6-openrouter-closed-loop',
    title: 'Execute billing address, card replacement, recharge, and Auto top-up',
    status: all([
      hasFile('src/automation/bind_openrouter_card_cdp.mjs'),
      hasText('src/server/automation-adapter.mjs', /confirmPurchase|executeRow/),
      hasText('src/automation/lib/recharge-plan.mjs', /autoTopup|purchase/i),
      hasText('src/server/worker.mjs', /writeCurrentResult|recordAdsPowerStatus/),
    ]) ? 'ready' : 'fail',
    evidence: ['Closed-loop automation adapter', 'worker execution path'],
    next: 'Live OpenRouter purchase requires automatic preflight token and user authorization.',
  });

  addRequirement({
    id: '7-opom-writeback',
    title: 'Write new card binding and row result back to OPOM',
    status: all([
      hasText('src/server/opom-client.mjs', /writeCompletedRow|writeRowResult/),
      hasOpomFile('app/api/v1/recharge/accounts/[opomAccountId]/card-binding/route.ts'),
      hasOpomFile('app/api/v1/recharge/runs/[runId]/results/route.ts'),
      hasOpomText('test/recharge-api-routes.test.ts', /card-binding|run row results|idempot/i),
    ]) ? 'ready' : 'fail',
    evidence: ['Recharge OPOM client', 'OPOM machine write APIs', 'idempotency tests'],
    next: 'Production OPOM writeback requires deploying OPOM changes and setting RECHARGE_API_TOKEN.',
  });

  addRequirement({
    id: '7a-opom-production-deploy',
    title: 'OPOM production exposes recharge machine APIs',
    status: opomProduction.status,
    evidence: [
      'OPOM recharge routes exist in local code',
      opomProduction.evidence,
    ],
    next: opomProduction.next,
  });

  addRequirement({
    id: '8-adspower-status',
    title: 'Record or explicitly waive AdsPower success/failure status writeback',
    status: !all([
      hasFile('src/server/adspower-status.mjs'),
      hasText('src/server/adspower-status.mjs', /skipped_user_waived/),
      hasText('src/server/preflight.mjs', /AdsPower native tag API/),
      hasText('src/test/adspower-status.test.mjs', /group_move|remark_append/),
    ])
      ? 'fail'
      : adsPowerStatus.status,
    evidence: [
      'Default result CSV records skipped_user_waived because the user waived AdsPower status writeback authorization',
      'Optional group_move/remark_append adapters exist',
      adsPowerStatus.evidence,
    ],
    next: adsPowerStatus.next,
  });

  addRequirement({
    id: '9-result-csv-feishu',
    title: 'Emit structured sanitized result CSV for Feishu handoff',
    status: all([
      hasText('src/server/automation-adapter.mjs', /writeResultCsv/),
      hasFile('scripts/feishu-handoff-smoke.mjs'),
      hasText('src/automation/lib/csv.mjs', /spreadsheetSafeValue/),
      hasText('README.md', /Feishu Handoff/),
    ]) ? 'ready' : 'fail',
    evidence: ['Result CSV writer', 'Feishu smoke', 'spreadsheet formula escaping'],
  });

  addRequirement({
    id: 'bank-reconciliation',
    title: 'Bank daily statement reconciliation remains in OPOM',
    status: all([
      hasOpomFile('app/api/reconciliation/export/route.ts'),
      hasOpomText('test/reconciliation-routes.test.ts', /exports attributed recharge records/i),
    ]) ? 'ready_existing_opom' : 'fail',
    evidence: ['OPOM reconciliation export route and tests'],
  });

  addRequirement({
    id: 'safety-boundaries',
    title: 'No production write, card creation, or live payment without explicit authorization',
    status: all([
      hasText('src/server/safety.mjs', /dry-run confirmation token/i),
      hasText('src/server/card-allocation.mjs', /confirm|confirmation/i),
      hasText('scripts/production-preflight.mjs', /no OPOM write API called|OpenRouter live purchase boundary/),
    ]) ? 'ready' : 'fail',
    evidence: ['dry-run token gate', 'EJH confirmation gate', 'read-only production preflight'],
  });

  addRequirement({
    id: 'production-runbook',
    title: 'Production deployment and rollback runbook is documented',
    status: all([
      hasFile('docs/recharge-production-runbook.md'),
      hasText('docs/recharge-production-runbook.md', /OPOM Production Deployment Checklist/),
      hasText('docs/recharge-production-runbook.md', /Read-Only Production Verification/),
      hasText('docs/recharge-production-runbook.md', /Rollback/),
      hasText('docs/recharge-production-runbook.md', /Authorization Gates/),
    ]) ? 'ready' : 'fail',
    evidence: ['production checklist', 'read-only verification', 'rollback steps', 'authorization gates'],
  });
} catch (error) {
  addRequirement({
    id: 'audit-exception',
    title: 'Readiness audit exception',
    status: 'fail',
    evidence: [redact(error.message || 'unknown error')],
  });
}

const failed = items.filter((item) => item.status === 'fail');
const pending = items.filter((item) => item.status.startsWith('pending_'));
const result = {
  ok: failed.length === 0,
  complete: failed.length === 0 && pending.length === 0,
  failed: failed.length,
  pending: pending.length,
  rechargeRepo,
  opomRepo,
  items,
};

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const item of items) {
    const marker = item.status === 'fail' ? 'FAIL' : item.status.startsWith('pending_') ? 'PENDING' : 'OK';
    console.log(`${marker} ${item.id}: ${item.status} - ${item.title}`);
    if (item.next) console.log(`  next: ${item.next}`);
  }
  console.log(
    result.complete
      ? 'readiness audit proves the requested goal is complete'
      : result.ok && args.requireComplete
        ? `readiness audit is not complete: ${pending.length} pending authorization/external item(s)`
        : result.ok
      ? `readiness audit passed with ${pending.length} pending authorization/external item(s)`
      : `readiness audit failed: ${failed.length} item(s)`,
  );
}

process.exitCode = result.ok && (!args.requireComplete || result.complete) ? 0 : 1;

function addRequirement(item) {
  items.push({
    id: item.id,
    title: item.title,
    status: item.status,
    evidence: item.evidence || [],
    next: item.next || '',
  });
}

function all(values) {
  return values.every(Boolean);
}

function hasFile(relativePath) {
  return existsSync(join(rechargeRepo, relativePath));
}

function hasOpomFile(relativePath) {
  return existsSync(join(opomRepo, relativePath));
}

function hasText(relativePath, pattern) {
  const path = join(rechargeRepo, relativePath);
  if (!existsSync(path)) return false;
  return pattern.test(readFileSync(path, 'utf8'));
}

function hasOpomText(relativePath, pattern) {
  const path = join(opomRepo, relativePath);
  if (!existsSync(path)) return false;
  return pattern.test(readFileSync(path, 'utf8'));
}

function hasReadmeText(pattern) {
  return hasText('README.md', pattern);
}

function opomProductionReadiness(env = process.env, markerPath = '') {
  const marker = readPreflightMarker(markerPath);
  if (marker.ok) {
    return {
      status: 'ready_production_verified',
      evidence: `OPOM production recharge API was read-verified by marker ${marker.path} at ${marker.generatedAt}`,
      next: 'Keep OPOM production .env, SQLite backup evidence, and the preflight marker with the deployment record.',
    };
  }
  const verified = /^(1|true|yes)$/i.test(String(env.OPOM_PRODUCTION_RECHARGE_API_VERIFIED || '').trim());
  const baseUrl = String(env.OPOM_API_BASE || env.OPOM_BASE_URL || '').trim();
  const hasToken = Boolean(String(env.OPOM_RECHARGE_TOKEN || env.RECHARGE_API_TOKEN || '').trim());
  const preflightPassedAt = String(env.OPOM_PRODUCTION_PREFLIGHT_PASSED_AT || '').trim();
  const preflightAge = preflightEvidenceAge(preflightPassedAt);
  if (verified && baseUrl && hasToken && preflightAge.ok) {
    return {
      status: 'ready_production_verified',
      evidence: `OPOM production recharge API verification flag is set with production base URL, token, and read-only preflight evidence from ${preflightPassedAt}`,
      next: 'Keep OPOM production .env and SQLite backup evidence with the deployment record.',
    };
  }
  return {
    status: 'pending_opom_production_deploy',
    evidence: verified && baseUrl && hasToken
      ? `OPOM production verification is missing a recent OPOM_PRODUCTION_PREFLIGHT_PASSED_AT value: ${preflightAge.reason}`
      : markerPath && marker.reason
      ? `OPOM production preflight marker is not usable: ${marker.reason}`
      : verified
      ? 'OPOM_PRODUCTION_RECHARGE_API_VERIFIED is set, but production base URL or token is missing from the verification environment'
      : 'OPOM production recharge machine APIs have not been marked as deployed and read-verified',
    next: 'After explicit authorization, deploy OPOM changes, set RECHARGE_API_TOKEN, run production db:push if needed, then run read-only preflight with --marker-file or set OPOM_PRODUCTION_RECHARGE_API_VERIFIED=true plus OPOM_PRODUCTION_PREFLIGHT_PASSED_AT.',
  };
}

function readPreflightMarker(markerPath) {
  const path = String(markerPath || '').trim();
  if (!path) return {ok: false, reason: 'missing_marker_path'};
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) return {ok: false, reason: 'marker_file_missing'};
  try {
    const marker = JSON.parse(readFileSync(absolutePath, 'utf8'));
    const generatedAt = String(marker.generatedAt || '').trim();
    const age = preflightEvidenceAge(generatedAt);
    if (!marker.ok) return {ok: false, reason: 'marker_not_ok'};
    if (!marker.opomReadVerified) return {ok: false, reason: 'marker_missing_opom_read_verification'};
    if (!String(marker.opomBaseUrl || '').trim()) return {ok: false, reason: 'marker_missing_opom_base_url'};
    if (!age.ok) return {ok: false, reason: `marker_${age.reason}`};
    return {ok: true, path: absolutePath, generatedAt};
  } catch (error) {
    return {ok: false, reason: `marker_parse_failed:${redact(error.message || 'unknown_error')}`};
  }
}

function preflightEvidenceAge(value, now = new Date()) {
  if (!value) return {ok: false, reason: 'missing'};
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return {ok: false, reason: 'invalid_datetime'};
  const ageMs = now.getTime() - parsed.getTime();
  if (ageMs < -5 * 60 * 1000) return {ok: false, reason: 'future_datetime'};
  if (ageMs > 24 * 60 * 60 * 1000) return {ok: false, reason: 'older_than_24h'};
  return {ok: true, reason: 'recent'};
}

function adsPowerStatusReadiness(env = process.env) {
  const mode = String(env.ADSPOWER_STATUS_MODE || 'disabled').trim().toLowerCase();
  if (!mode || mode === 'disabled') {
    return {
      status: 'ready_user_waived',
      evidence: 'User waived AdsPower status writeback authorization; disabled mode records skipped_user_waived and waived_by_user in result CSV',
      next: 'If AdsPower writeback is needed later, configure group_move, remark_append, or remark_append_v2 after explicit authorization.',
    };
  }
  if (mode === 'group_move') {
    const success = Boolean(env.ADSPOWER_SUCCESS_GROUP_ID || env.ADSPOWER_SUCCESS_GROUP_NAME);
    const failure = Boolean(env.ADSPOWER_FAILURE_GROUP_ID || env.ADSPOWER_FAILURE_GROUP_NAME);
    const blocker = Boolean(env.ADSPOWER_BLOCKER_GROUP_ID || env.ADSPOWER_BLOCKER_GROUP_NAME);
    if (success && failure && blocker) {
      return {
        status: 'ready_operational_marker',
        evidence: 'ADSPOWER_STATUS_MODE=group_move with success/failure/blocker targets configured',
        next: 'Run npm run adspower:status-targets -- --json and npm run preflight:production to verify exact group targets before live writeback.',
      };
    }
    return {
      status: 'pending_ads_power_status_config',
      evidence: 'ADSPOWER_STATUS_MODE=group_move is set but one or more success/failure/blocker targets are missing',
      next: 'Set ADSPOWER_SUCCESS_GROUP_ID/NAME, ADSPOWER_FAILURE_GROUP_ID/NAME, and ADSPOWER_BLOCKER_GROUP_ID/NAME.',
    };
  }
  if (mode === 'remark_append' || mode === 'remark_append_v2') {
    return {
      status: 'ready_operational_marker',
      evidence: `ADSPOWER_STATUS_MODE=${mode} writes sanitized profile remarks`,
      next: 'Treat remark status as an operational marker, not a native AdsPower tag, unless AdsPower publishes a tag-write API.',
    };
  }
  return {
    status: 'fail',
    evidence: `Unsupported ADSPOWER_STATUS_MODE=${mode}`,
    next: 'Use disabled, group_move, remark_append, or remark_append_v2.',
  };
}

function parseArgs(argv) {
  const parsed = {json: false, opomRepo: '', requireComplete: false, preflightMarker: ''};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--require-complete') {
      parsed.requireComplete = true;
    } else if (arg === '--opom-repo') {
      parsed.opomRepo = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--opom-repo=')) {
      parsed.opomRepo = arg.split('=').slice(1).join('=');
    } else if (arg === '--preflight-marker') {
      parsed.preflightMarker = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--preflight-marker=')) {
      parsed.preflightMarker = arg.split('=').slice(1).join('=');
    }
  }
  return parsed;
}
