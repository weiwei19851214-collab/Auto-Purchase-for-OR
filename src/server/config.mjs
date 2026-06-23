import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DATA_DIR = join(ROOT_DIR, 'data');
export const UPLOAD_DIR = join(DATA_DIR, 'uploads');
export const RESULT_DIR = join(DATA_DIR, 'results');
export const LOG_DIR = join(DATA_DIR, 'logs');
export const DB_PATH = process.env.OR_RUNNER_DB || join(DATA_DIR, 'runner.sqlite');
export const PUBLIC_DIR = join(ROOT_DIR, 'public');
export const AUTOMATION_DIR = join(ROOT_DIR, 'src/automation');
export const AUTOMATION_LIB_DIR = join(AUTOMATION_DIR, 'lib');
export const BIND_SCRIPT = join(AUTOMATION_DIR, 'bind_openrouter_card_cdp.mjs');
export const BATCH_SCRIPT = join(AUTOMATION_DIR, 'batch_recharge_openrouter_cards_cdp.mjs');

export const DEFAULT_SERVER_PORT = Number(process.env.PORT || 4100);
export const DEFAULT_ROW_TIMEOUT_MS = Number(process.env.ROW_TIMEOUT_MS || 600000);
export const AUTOMATION_LOG_RETENTION_HOURS = Number(process.env.AUTOMATION_LOG_RETENTION_HOURS || 48);

export const LIVE_STATUSES = new Set([
  'queued',
  'running',
  'blocked',
]);
