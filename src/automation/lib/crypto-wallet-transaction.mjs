const NETWORK_ALIASES = new Map([
  ['arbitrum one', 'arbitrum one'],
  ['arbitrum', 'arbitrum one'],
  ['arb one', 'arbitrum one'],
  ['ethereum', 'ethereum'],
  ['ethereum mainnet', 'ethereum'],
  ['base', 'base'],
  ['base mainnet', 'base'],
  ['polygon', 'polygon'],
  ['polygon pos', 'polygon'],
]);

// Coinbase 文案里的介词 “to” 不能被当成资产；只有明确币种才参与资产指纹。
const KNOWN_ASSETS = '(?:USDC|USDT|ETH|DAI|MATIC|SOL|BTC)';

export function normalizeTransactionLabel(value) {
  return String(value || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizedLines(value) {
  return String(value || '').replace(/ /g, ' ').split(/\r?\n/)
    .map((line) => normalizeTransactionLabel(line)).filter(Boolean);
}

export function normalizeTransactionAmount(value) {
  const raw = String(value ?? '').trim();
  const negative = /^[-−]/.test(raw);
  const cleaned = raw.replace(/[+$,\s−-]/g, '');
  const number = Number(cleaned);
  if (negative || !Number.isFinite(number) || number <= 0) return null;
  return Math.round(number * 1e8) / 1e8;
}

function normalizeDisplayedSendAmount(value) {
  const raw = String(value ?? '').trim();
  return normalizeTransactionAmount(raw.replace(/^[-−]\s*/, ''));
}

export function normalizeTransactionNetwork(value) {
  const normalized = normalizeTransactionLabel(value).toLowerCase();
  return NETWORK_ALIASES.get(normalized) || normalized;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function extractTransactionNetworks(text) {
  const lines = String(text || '').replace(/ /g, ' ').split(/\r?\n/)
    .map((line) => normalizeTransactionLabel(line)).filter(Boolean);
  const networks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^Network\s*:?\s*(.*)$/i);
    if (!match) continue;
    const value = normalizeTransactionLabel(match[1]) || lines[index + 1] || '';
    if (value && !/^advanced$/i.test(value)) networks.push(value);
  }
  return unique(networks.map(normalizeTransactionNetwork));
}

export function extractTransactionAmountAssets(text) {
  const lines = normalizedLines(text);
  const matches = String(text || '').matchAll(/[-+]?\s*\d[\d,]*(?:\.\d+)?\s*([A-Z][A-Z0-9_]{1,15})\b/g);
  const inline = [...matches].map((match) => ({
    amount: normalizeDisplayedSendAmount(match[0].replace(match[1], '')),
    asset: String(match[1] || '').toUpperCase(),
  })).filter((entry) => entry.amount != null && entry.asset);
  const labeled = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(?:Amount|Value)\s*:?\s*([-+]?\s*\d[\d,]*(?:\.\d+)?)\s*([A-Z][A-Z0-9_]*)?$/i);
    if (!match) continue;
    const asset = match[2] || lines[index + 1] || '';
    if (/^[A-Z][A-Z0-9_]*$/i.test(asset)) {
      labeled.push({amount: normalizeTransactionAmount(match[1]), asset: asset.toUpperCase()});
    }
  }
  return [...inline, ...labeled];
}

function originMatches(origin, expectedOrigin) {
  return String(origin || '') === String(expectedOrigin || '');
}

function amountAssetMatches(entries, expectedAmount, expectedAsset) {
  const amount = normalizeTransactionAmount(expectedAmount);
  const asset = String(expectedAsset || '').trim().toUpperCase();
  if (amount == null || !asset) return false;
  return entries.some((entry) => entry.asset === asset && entry.amount === amount);
}

function entriesConflict(entries, expectedAmount, expectedAsset) {
  const amount = normalizeTransactionAmount(expectedAmount);
  const asset = String(expectedAsset || '').trim().toUpperCase();
  // Gas/fee rows may contain another asset; only a conflicting value for the
  // payment asset invalidates the fingerprint.
  return entries.some((entry) => entry.asset === asset && entry.amount !== amount);
}

function networkMatches(networks, expectedNetwork) {
  const expected = normalizeTransactionNetwork(expectedNetwork);
  if (!networks.length || networks.some((network) => !NETWORK_ALIASES.has(network))) return false;
  if (expected) return networks.length === 1 && networks[0] === expected;
  // No silent chain default: an observed page must expose exactly one recognizable network.
  return networks.length === 1;
}

function buttonState(buttons, label) {
  const matches = buttons.filter((button) => normalizeTransactionLabel(button.label) === label);
  return {
    count: matches.length,
    enabled: matches.length === 1
      && matches[0].disabled !== true
      && matches[0].ariaDisabled !== 'true',
  };
}

export function classifyOkxTransactionSnapshot(snapshot, expected = {}) {
  const expectedOrigin = 'chrome-extension://mcohilncbfahbmgdjkbpemcciiolgcge';
  const text = normalizeTransactionLabel(snapshot?.text);
  const buttons = Array.isArray(snapshot?.buttons) ? snapshot.buttons.filter((button) => button.visible !== false) : [];
  const originOk = originMatches(snapshot?.origin, expectedOrigin);
  const entries = extractTransactionAmountAssets(snapshot?.text || '');
  const networks = extractTransactionNetworks(snapshot?.text || '');
  const amount = normalizeTransactionAmount(expected.amount);
  const asset = String(expected.asset || '').trim().toUpperCase();
  const amountAssetOk = amountAssetMatches(entries, amount, asset);
  const conflictingAmountAsset = entriesConflict(entries, amount, asset);
  const expectedNetwork = normalizeTransactionNetwork(expected.network);
  const hasNetworkLabel = networks.length > 0;
  const networkMismatch = expectedNetwork && hasNetworkLabel && !networks.includes(expectedNetwork);
  const networkOk = networkMatches(networks, expected.network);
  const warningButton = buttonState(buttons, 'Continue (Unsafe)');
  const confirmButton = buttonState(buttons, 'Confirm');
  const base = {
    hasAmount: amountAssetOk,
    hasNetwork: networkOk,
    originOk,
    amountAssetOk,
    network: networks[0] || '',
    asset,
  };

  if (/Suspicious Receiving address/i.test(text) && originOk
    && !conflictingAmountAsset && !networkMismatch
    && warningButton.count === 1 && warningButton.enabled) {
    return {stage: 'risk_warning', ...base, buttonCount: warningButton.count};
  }
  if (/\b(?:1 of 2 confirmations|Confirm Send)\b/i.test(text) && originOk
    && amountAssetOk && !conflictingAmountAsset && networkOk
    && confirmButton.count === 1 && confirmButton.enabled) {
    return {stage: 'confirm_send', ...base, buttonCount: confirmButton.count};
  }
  return {
    stage: 'unknown',
    ...base,
    buttonCount: /Suspicious Receiving address/i.test(text) ? warningButton.count : confirmButton.count,
  };
}

export function checkoutPaymentFingerprint(text) {
  const normalized = String(text || '').replace(/ /g, ' ');
  // Coinbase 文案可能是 “Pay $10.50 to ...” 或 “Pay 10.50 USDC ...”。
  // 这里读取的是实际扣款金额，可能包含网络/服务费，不能回退成用户设置的充值目标金额。
  const pay = normalized.match(new RegExp('\\bPay\\s+\\$?\\s*([0-9,]+(?:\\.\\d+)?)\\s*(' + KNOWN_ASSETS + ')?\\b', 'i'));
  const total = normalized.match(new RegExp('\\bTotal(?: due| to pay)?\\s*:?\\s*\\$?\\s*([0-9,]+(?:\\.\\d+)?)\\s*(' + KNOWN_ASSETS + ')?\\b', 'i'));
  return {
    amount: pay?.[1] || total?.[1] || '',
    asset: String(pay?.[2] || total?.[2] || '').toUpperCase(),
    network: extractTransactionNetworks(normalized)[0] || '',
  };
}
