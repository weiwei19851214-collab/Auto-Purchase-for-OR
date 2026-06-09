import {spawnSync} from 'node:child_process';
import {redact} from './common.mjs';

export function parseChildJson(stdout, stderr) {
  for (const text of [stdout, stderr]) {
    const trimmed = String(text || '').trim();
    if (!trimmed) continue;
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {}
    }
  }
  return null;
}

export function runClosedLoopChild(bindScript, task, args) {
  const childArgs = [bindScript, '--stdin', '--confirm-purchase', '--configure-auto-topup'];
  if (args.removeExisting) childArgs.push('--remove-existing');
  const child = spawnSync(process.execPath, childArgs, {
    input: JSON.stringify(task),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: args.rowTimeoutMs,
    killSignal: 'SIGTERM',
  });
  const parsed = parseChildJson(child.stdout, child.stderr);
  if (child.status === 0 && parsed?.ok) return {ok: true, result: parsed};
  if (child.error?.code === 'ETIMEDOUT') {
    return {
      ok: false,
      error: `bind script timed out after ${args.rowTimeoutMs}ms`,
      child: args.verbose ? {stdout: redact(child.stdout), stderr: redact(child.stderr)} : undefined,
    };
  }
  const message = parsed?.error || child.stderr || child.stdout || `bind script exited ${child.status}`;
  return {
    ok: false,
    error: message,
    child: args.verbose ? {stdout: redact(child.stdout), stderr: redact(child.stderr)} : undefined,
  };
}
