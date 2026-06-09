export function maskEmail(email) {
  const value = String(email || '');
  const [name, domain] = value.split('@');
  if (!name || !domain) return value ? `${value.slice(0, 2)}***` : '';
  return `${name.slice(0, 2)}***@${domain}`;
}

export function cardLast4(number) {
  return String(number || '').replace(/\D/g, '').slice(-4);
}

export function normalizeExpiry(month, year) {
  const mm = String(month || '').replace(/\D/g, '').padStart(2, '0').slice(-2);
  let yy = String(year || '').replace(/\D/g, '');
  if (yy.length === 4 && yy.startsWith('20')) yy = yy.slice(2);
  yy = yy.padStart(2, '0').slice(-2);
  return `${mm}${yy}`;
}

export function normalizeMoneyValue(value) {
  const cleaned = String(value || '').replace(/[$,\s]/g, '');
  if (!cleaned) return '';
  const number = Number(cleaned);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid money value: ${value}`);
  return Number.isInteger(number) ? String(number) : String(number);
}

export function redact(text) {
  return String(text || '')
    .replace(/\b\d{12,19}\b/g, '[card]')
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]+\b/g, '[ak]')
    .replace(/\b((?:cvc|cvv|cardCvc|card-cvc|password|token|cookie|session)\s*[:=]\s*)[^\s,;|]+/gi, '$1[secret]')
    .replace(/\b[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (email) => maskEmail(email))
    .replace(/("cvc"\s*:\s*")([^"]+)(")/gi, '$1***$3')
    .slice(0, 1200);
}
