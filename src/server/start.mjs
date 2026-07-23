import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const envFile = process.env.ENV_FILE || resolve(rootDir, '.recharge.local.env');

// `npm start` is the documented local entrypoint.  Load the same optional
// machine-local settings as start-local.sh before importing modules that read
// process.env during initialization (port, SQLite path, OPOM integration).
if (existsSync(envFile)) process.loadEnvFile(envFile);

await import('./index.mjs');
