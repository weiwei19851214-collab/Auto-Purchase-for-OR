#!/usr/bin/env node
import {runnerArgs} from '../src/server/automation-adapter.mjs';
import {
  configuredTargetsFromRunner,
  inspectAdsPowerStatusTargets,
} from '../src/server/adspower-status-targets.mjs';

const args = parseArgs(process.argv.slice(2));
const runner = runnerArgs();
const result = await inspectAdsPowerStatusTargets({
  adspowerApiBase: runner.adspowerApiBase,
  adspowerApiKey: runner.adspowerApiKey,
  configured: configuredTargetsFromRunner(runner),
});

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`AdsPower group discovery: ${result.ok ? 'OK' : 'WARN'} ${result.status}`);
  console.log(`Base: ${result.base}`);
  if (result.groups.length) {
    console.log('\nGroups');
    for (const group of result.groups) {
      console.log(`- ${group.groupId}\t${group.groupName}`);
    }
  }
  console.log('\nConfigured targets');
  for (const role of ['success', 'failure', 'blocker']) {
    const item = result.targets[role];
    console.log(`- ${role}: ${item.status}${item.groupId ? ` ${item.groupId}` : ''}${item.groupName ? ` ${item.groupName}` : ''}`);
  }
  console.log('\nCandidate groups');
  for (const role of ['success', 'failure', 'blocker']) {
    const candidates = result.candidates[role] || [];
    console.log(`- ${role}: ${candidates.length ? candidates.map((item) => `${item.groupId} ${item.groupName}`).join('; ') : 'none'}`);
  }
  if (result.suggestedEnv.length) {
    console.log('\nSuggested env');
    for (const line of result.suggestedEnv) console.log(line);
  }
}

process.exitCode = result.ok ? 0 : 1;

function parseArgs(argv) {
  return {json: argv.includes('--json')};
}
