// 仅用于虚拟币账号密码确认；不读取代理密码，不扫描其他浏览器，不缓存或持久化密码。
export async function readCryptoAccountPassword(args, account, fetchImpl = fetch) {
  const userId = String(account.ads_power_user_id || account.profileId || '').trim();
  const serial = String(account.ads_power_serial_number || account.profileNo || '').trim();
  const email = String(account.loginEmail || account.login_email || account.expectedAccount || '').trim().toLowerCase();
  if ((!userId && !serial) || !email) throw new Error('crypto_password_identity_unverified');
  const url = new URL('/api/v1/user/list', args.adspowerApiBase || 'http://127.0.0.1:50325');
  url.searchParams.set(userId ? 'user_id' : 'serial_number', userId || serial);
  url.searchParams.set('page', '1');
  url.searchParams.set('page_size', '100');
  let body;
  try {
    const response = await fetchImpl(url, {
      headers: args.adspowerApiKey ? {Authorization: 'Bearer ' + args.adspowerApiKey} : {},
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error();
    body = await response.json();
  } catch {
    // 不透传上游错误体，防止接口把凭据回显到任务日志。
    throw new Error('crypto_password_lookup_failed');
  }
  if (body?.code !== 0 || !Array.isArray(body.data?.list)) throw new Error('crypto_password_lookup_failed');
  if (body.data.list.length !== 1) throw new Error('crypto_password_identity_unverified');
  const profile = body.data.list[0];
  return passwordFromProfile(profile, account);
}

function passwordFromProfile(profile, account) {
  const userId = String(account.ads_power_user_id || account.profileId || '').trim();
  const serial = String(account.ads_power_serial_number || account.profileNo || '').trim();
  const email = String(account.loginEmail || account.login_email || account.expectedAccount || '').trim().toLowerCase();
  if ((!userId && !serial) || !email) throw new Error('crypto_password_identity_unverified');
  // 必须匹配平台账号 username，而不是备注中的邮箱；同一浏览器可能存有无关邮箱信息。
  if ((userId ? String(profile.user_id) !== userId : String(profile.serial_number) !== serial)
      || String(profile.username || '').trim().toLowerCase() !== email) {
    throw new Error('crypto_password_identity_unverified');
  }
  if (typeof profile.password !== 'string' || !profile.password || /^[*•]+$/.test(profile.password)) {
    throw new Error('crypto_password_unavailable');
  }
  return profile.password;
}

export function cryptoPasswordPreview(profile, account, includePassword = false) {
  try {
    // 匹配已拿到的原始响应足够取密码；这里禁止发第二次 user/list 请求。
    const password = passwordFromProfile(profile, account);
    // 只有本地虚拟币列表明确请求时回传明文；定时任务只读取可用状态。
    return {passwordStatus: 'available', ...(includePassword ? {accountPassword: password} : {})};
  } catch (error) {
    return {passwordStatus: error.message === 'crypto_password_unavailable' ? 'missing'
      : error.message === 'crypto_password_identity_unverified' ? 'identity_mismatch' : 'lookup_failed'};
  }
}
