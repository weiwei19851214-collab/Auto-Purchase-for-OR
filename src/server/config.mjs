import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DATA_DIR = process.env.OR_RUNNER_DATA_DIR ? resolve(process.env.OR_RUNNER_DATA_DIR) : join(ROOT_DIR, 'data');
export const UPLOAD_DIR = join(DATA_DIR, 'uploads');
export const RESULT_DIR = join(DATA_DIR, 'results');
export const LOG_DIR = join(DATA_DIR, 'logs');
export const DB_PATH = process.env.OR_RUNNER_DB || join(DATA_DIR, 'runner.sqlite');
export const PUBLIC_DIR = join(ROOT_DIR, 'public');
export const AUTOMATION_DIR = join(ROOT_DIR, 'src/automation');
export const AUTOMATION_LIB_DIR = join(AUTOMATION_DIR, 'lib');
export const BIND_SCRIPT = join(AUTOMATION_DIR, 'bind_openrouter_card_cdp.mjs');
export const CRYPTO_RECHARGE_SCRIPT = join(AUTOMATION_DIR, 'crypto_recharge_openrouter_cdp.mjs');
export const BATCH_SCRIPT = join(AUTOMATION_DIR, 'batch_recharge_openrouter_cards_cdp.mjs');

export const DEFAULT_SERVER_PORT = Number(process.env.PORT || 4100);
// 虚拟币单行从 Worker 开始计时最多 240 秒；子进程提前结束，给 AdsPower 回收和结果落库预留时间。
export const MAX_ROW_TIMEOUT_MS = 175000;
export const DEFAULT_ROW_TIMEOUT_MS = Math.min(Number(process.env.ROW_TIMEOUT_MS || MAX_ROW_TIMEOUT_MS), MAX_ROW_TIMEOUT_MS);
export const CRYPTO_TASK_TIMEOUT_MS = 240000;
export const CRYPTO_CHILD_TIMEOUT_MS = 230000;
export const AUTOMATION_LOG_RETENTION_HOURS = Number(process.env.AUTOMATION_LOG_RETENTION_HOURS || 48);

export const LIVE_STATUSES = new Set([
  'queued',
  'running',
  'blocked',
]);
