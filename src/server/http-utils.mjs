import {readFile} from 'node:fs/promises';
import {extname} from 'node:path';

const JSON_LIMIT_BYTES = 25 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw httpError(415, 'Content-Type must be application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT_BYTES) throw httpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, 'Request body must be valid JSON');
  }
}

export function sendJson(res, status, payload) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(payload, null, 2));
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {'Content-Type': contentType});
  res.end(text);
}

export async function sendFile(res, filePath) {
  const data = await readFile(filePath);
  res.writeHead(200, {'Content-Type': MIME[extname(filePath)] || 'application/octet-stream'});
  res.end(data);
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function route(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  return {url, parts, pathname: url.pathname};
}
