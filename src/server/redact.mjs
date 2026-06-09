export function redact(value) {
  return String(value || '')
    .replace(/\b\d{12,19}\b/g, (digits) => `${digits.slice(0, 2)}***${digits.slice(-4)}`)
    .replace(/("?(?:cvc|cvv|cardCvc|card-cvc|password|token|cookie|session)"?\s*[:=]\s*)"[^"]+"/gi, '$1"***"')
    .replace(/\b((?:cvc|cvv|cardCvc|card-cvc|password|token|cookie|session)\s*[:=]\s*)[^\s,;|]+/gi, '$1[secret]')
    .replace(/\b([A-Z0-9._%+-]{2})[A-Z0-9._%+-]*(@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi, '$1***$2');
}
