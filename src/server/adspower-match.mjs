import * as adspower from '../automation/lib/adspower.mjs';
import {runnerArgs} from './automation-adapter.mjs';
import {redact} from './redact.mjs';

export async function matchAdsPowerPayload(payload = {}) {
  const args = runnerArgs(payload.options || {});
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  let results;
  try {
    const matches = await adspower.matchProfilesForAccounts(args, rows, payload.matchOptions || {});
    results = matches.map((result, index) => ({index, ...result}));
  } catch (error) {
    results = rows.map((_, index) => ({
      index,
      status: 'failed',
      message: redact(error.message || 'AdsPower match failed'),
    }));
  }
  return {
    ok: true,
    total: rows.length,
    matched: results.filter((row) => row.status === 'matched').length,
    failed: results.filter((row) => row.status !== 'matched').length,
    results,
  };
}
