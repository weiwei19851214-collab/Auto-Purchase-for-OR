import {randomBytes, timingSafeEqual} from 'node:crypto';
import {httpError} from './http-utils.mjs';

const SESSION_TOKEN = process.env.OR_RUNNER_SESSION_TOKEN || randomBytes(24).toString('base64url');
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function sessionPayload() {
  return {
    token: SESSION_TOKEN,
    integrations: {
      opomWritebackConfigured: !!(
        (process.env.OPOM_BASE_URL || process.env.OPOM_API_BASE)
        && process.env.OPOM_RECHARGE_TOKEN
      ),
    },
  };
}

export function assertLocalRequest(req) {
  const host = normalizeHost(req.headers.host || '');
  if (host && !ALLOWED_HOSTS.has(host)) {
    throw httpError(403, 'Only localhost access is allowed');
  }
  const origin = req.headers.origin;
  if (origin) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw httpError(403, 'Cross-origin requests are not allowed');
    }
    if (!ALLOWED_HOSTS.has(normalizeHost(parsed.host))) {
      throw httpError(403, 'Cross-origin requests are not allowed');
    }
  }
}

export function requireSession(req) {
  const provided = String(req.headers['x-runner-session'] || '');
  const expected = SESSION_TOKEN;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (
    providedBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw httpError(401, 'Missing or invalid local session token');
  }
}

function normalizeHost(value) {
  const host = String(value || '').toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 ? host.slice(1, end) : host;
  }
  return host.split(':')[0];
}
