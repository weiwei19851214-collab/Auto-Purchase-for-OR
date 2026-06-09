const DEFAULT_ADSPOWER_BASE = 'http://127.0.0.1:50325';

export function adsPowerDefaults(env = process.env) {
  return {
    adspowerApiBase: env.ADSPOWER_API_BASE || DEFAULT_ADSPOWER_BASE,
    adspowerApiKey: env.ADSPOWER_API_KEY || '',
  };
}

export async function stopProfile(args, profileNo) {
  if (!profileNo) return {attempted: false};
  const base = args.adspowerApiBase || DEFAULT_ADSPOWER_BASE;
  const headers = {'Content-Type': 'application/json'};
  if (args.adspowerApiKey) headers.Authorization = `Bearer ${args.adspowerApiKey}`;
  const failures = [];
  try {
    const res = await fetch(`${base}/api/v2/browser-profile/stop`, {
      method: 'POST',
      headers,
      body: JSON.stringify({profile_no: String(profileNo)}),
    });
    if (res.ok) return {attempted: true, ok: true, endpoint: 'v2'};
    failures.push(`v2:${res.status}`);
  } catch (error) {
    failures.push(`v2:${error.message}`);
  }
  try {
    const url = new URL(`${base}/api/v1/browser/stop`);
    url.searchParams.set('serial_number', String(profileNo));
    const res = await fetch(url, {headers});
    if (res.ok) return {attempted: true, ok: true, endpoint: 'v1'};
    failures.push(`v1:${res.status}`);
  } catch (error) {
    failures.push(`v1:${error.message}`);
  }
  return {attempted: true, ok: false, failures};
}

function headers(args) {
  const output = {'Content-Type': 'application/json'};
  if (args.adspowerApiKey) output.Authorization = `Bearer ${args.adspowerApiKey}`;
  return output;
}

async function fetchUserList(args, params) {
  const base = args.adspowerApiBase || DEFAULT_ADSPOWER_BASE;
  const url = new URL(`${base}/api/v1/user/list`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  const maxAttempts = Number(args.adspowerListMaxAttempts || 4);
  const retryDelayMs = Number(args.adspowerListRetryDelayMs || 1200);
  let lastMessage = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetch(url, {headers: headers(args)});
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.code === 0) {
      return Array.isArray(body.data?.list) ? body.data.list : [];
    }
    lastMessage = body.msg || String(res.status);
    const retryable = /too many request|rate/i.test(lastMessage);
    if (!retryable || attempt >= maxAttempts) {
      throw new Error(`AdsPower user/list failed: ${lastMessage}`);
    }
    await sleep(retryDelayMs * attempt);
  }
  throw new Error(`AdsPower user/list failed: ${lastMessage || 'unknown error'}`);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

const PROFILE_IDENTITY_KEYS = new Set([
  'username',
  'user_name',
  'userName',
  'name',
  'remark',
  'domain_name',
  'domainName',
  'email',
  'login_email',
  'loginEmail',
  'account',
  'account_name',
  'accountName',
  'platform',
  'platform_name',
  'platformName',
  'platform_account',
  'platformAccount',
  'openrouter_account',
  'openRouterAccount',
]);

function collectIdentityValues(value, output = []) {
  if (value == null) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectIdentityValues(item, output);
    return output;
  }
  if (typeof value !== 'object') return output;
  for (const [key, item] of Object.entries(value)) {
    if (PROFILE_IDENTITY_KEYS.has(key) && typeof item !== 'object') {
      output.push(item);
    } else if (['platforms', 'platform_accounts', 'platformAccounts', 'accounts'].includes(key)) {
      collectIdentityValues(item, output);
    }
  }
  return output;
}

function profileIdentity(profile) {
  return collectIdentityValues(profile)
    .map((value) => String(value || '').toLowerCase())
    .filter(Boolean);
}

function profileMatchesEmail(profile, expectedEmail) {
  const expected = normalizeEmail(expectedEmail);
  if (!expected) return false;
  return profileIdentity(profile).some((value) => value.includes(expected));
}

function profileIdentifierMismatch(profile, expected) {
  const expectedUserId = String(expected.userId || '').trim();
  const expectedSerialNumber = String(expected.serialNumber || '').trim();
  const actualUserId = String(profile.user_id || '').trim();
  const actualSerialNumber = String(profile.serial_number || '').trim();
  if (expectedUserId && actualUserId && expectedUserId !== actualUserId) return 'user_id';
  if (expectedSerialNumber && actualSerialNumber && expectedSerialNumber !== actualSerialNumber) return 'serial_number';
  return '';
}

export async function findProfileForAccount(args, account, options = {}) {
  const expectedEmail = account.loginEmail || account.username || account.login_email || '';
  const userId = account.ads_power_user_id || account.adsPower?.userId || '';
  const serialNumber = account.ads_power_serial_number || account.ID || account.adsPower?.serialNumber || '';
  let matches = [];
  let matchSource = '';
  if (userId) {
    matches = await fetchUserList(args, {user_id: userId, page: 1, page_size: 100});
    matchSource = 'user_id';
  } else if (serialNumber) {
    matches = await fetchUserList(args, {serial_number: serialNumber, page: 1, page_size: 100});
    matchSource = 'serial_number';
  } else {
    const maxPages = Number(options.maxPages || 10);
    for (let page = 1; page <= maxPages; page += 1) {
      const pageRows = await fetchUserList(args, {page, page_size: 100});
      matches.push(...pageRows.filter((profile) => profileMatchesEmail(profile, expectedEmail)));
      if (pageRows.length < 100) break;
    }
    matchSource = 'email_scan';
  }

  if (matches.length === 0) {
    return {status: 'profile_not_found', matchSource, expectedEmail};
  }
  if (matches.length > 1) {
    return {
      status: 'profile_ambiguous',
      matchSource,
      expectedEmail,
      matches: matches.map(publicProfile),
    };
  }
  const profile = matches[0];
  const identifierMismatch = profileIdentifierMismatch(profile, {userId, serialNumber});
  if (identifierMismatch) {
    return {
      status: 'identifier_mismatch',
      matchSource,
      mismatchField: identifierMismatch,
      expectedEmail,
      expectedUserId: userId,
      expectedSerialNumber: serialNumber,
      profile: publicProfile(profile),
    };
  }
  if (expectedEmail && !profileMatchesEmail(profile, expectedEmail)) {
    return {
      status: 'identity_mismatch',
      matchSource,
      expectedEmail,
      profile: publicProfile(profile),
    };
  }
  return {
    status: 'matched',
    matchSource,
    expectedEmail,
    profile: publicProfile(profile),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchProfilesForEmailScan(args, options = {}) {
  const maxPages = Number(options.maxPages || 10);
  const pageSize = Number(options.pageSize || 100);
  const scanDelayMs = Number(options.scanDelayMs ?? 250);
  const profiles = [];
  for (let page = 1; page <= maxPages; page += 1) {
    if (page > 1 && scanDelayMs > 0) await sleep(scanDelayMs);
    const pageRows = await fetchUserList(args, {page, page_size: pageSize});
    profiles.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }
  return profiles;
}

function matchFromProfiles(profileRows, account) {
  const expectedEmail = account.loginEmail || account.username || account.login_email || '';
  const matches = profileRows.filter((profile) => profileMatchesEmail(profile, expectedEmail));
  if (matches.length === 0) {
    return {status: 'profile_not_found', matchSource: 'email_index', expectedEmail};
  }
  if (matches.length > 1) {
    return {
      status: 'profile_ambiguous',
      matchSource: 'email_index',
      expectedEmail,
      matches: matches.map(publicProfile),
    };
  }
  return {
    status: 'matched',
    matchSource: 'email_index',
    expectedEmail,
    profile: publicProfile(matches[0]),
  };
}

export async function matchProfilesForAccounts(args, accounts, options = {}) {
  const results = new Array(accounts.length);
  const scanIndexes = [];
  for (const [index, account] of accounts.entries()) {
    const userId = account.ads_power_user_id || account.adsPower?.userId || '';
    const serialNumber = account.ads_power_serial_number || account.ID || account.adsPower?.serialNumber || '';
    if (userId || serialNumber) {
      try {
        results[index] = await findProfileForAccount(args, account, options);
      } catch (error) {
        results[index] = {
          status: 'failed',
          message: error.message || 'AdsPower match failed',
        };
      }
    } else {
      scanIndexes.push(index);
    }
  }

  if (scanIndexes.length) {
    try {
      const profiles = await fetchProfilesForEmailScan(args, options);
      for (const index of scanIndexes) {
        results[index] = matchFromProfiles(profiles, accounts[index]);
      }
    } catch (error) {
      for (const index of scanIndexes) {
        results[index] = {
          status: 'failed',
          message: error.message || 'AdsPower email index failed',
        };
      }
    }
  }
  return results;
}

export function publicProfile(profile) {
  return {
    userId: profile.user_id || '',
    serialNumber: profile.serial_number || '',
    username: profile.username || '',
    name: profile.name || '',
    groupId: profile.group_id || '',
    groupName: profile.group_name || '',
    remark: profile.remark || '',
  };
}
