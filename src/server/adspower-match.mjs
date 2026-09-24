import * as adspower from '../automation/lib/adspower.mjs';
import {runnerArgs} from './automation-adapter.mjs';
import {redact} from './redact.mjs';
import {cryptoPasswordPreview} from '../automation/lib/crypto-account-password.mjs';

export async function matchAdsPowerPayload(payload = {}) {
  const args = runnerArgs(payload.options || {});
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  let results;
  try {
    const matches = await adspower.matchProfilesForAccounts(args, rows, {
      ...(payload.matchOptions || {}),
      // 只在身份匹配成功后投影密码，不暴露原始 profile；复用现有查询的限流重试。
      projectMatchedProfile: args.rechargeMode === 'crypto'
        ? (profile, account) => cryptoPasswordPreview(profile, {
          ...account,
          ads_power_user_id: adspower.publicProfile(profile).userId,
          ads_power_serial_number: adspower.publicProfile(profile).serialNumber,
        }, payload.includeAccountPassword === true)
        : undefined,
    });
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
