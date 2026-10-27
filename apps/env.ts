import { existsSync } from 'fs';
import { resolve } from 'path';
import { EnvType, load } from 'ts-dotenv';

type Env = EnvType<typeof schema>;

export const schema = {
    PORT: Number,
    NODE_ENV: String,
    DEPLOYMENT_ENV: String,
    ADMIN_API_KEY: String,
    DATABASE_URL: String,
    DRPC_API_KEY: { type: String, optional: true },
    COINGECKO_API_KEY: { type: String, optional: true },
    MERKL_API_KEY: { type: String, optional: true },
    WORKER_QUEUE_URL: { type: String, optional: true },
    SENTRY_DSN: { type: String, optional: true },
    SENTRY_TRACES_SAMPLE_RATE: { type: String, optional: true },
    SOR_POOLS_CACHE_TTL_SECONDS: { type: String, default: '10' },
    SOR_SERVICE_URL: { type: String, optional: true },
    SOR_INSTANCE: { type: Boolean, default: false },
};

function projectRoot(): string {
    let dir = __dirname;
    for (let i = 0; i < 5; i++) {
        if (existsSync(resolve(dir, 'package.json'))) {
            return dir;
        }
        const parent = resolve(dir, '..');
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return process.cwd();
}

// A missing file counts as empty, which is the case in containers.
export const env: Env = load(schema, {
    path: resolve(projectRoot(), '.env'),
    // Process environment wins. Containers and the e2e harness set PORT and
    // DATABASE_URL themselves; the file only fills keys that are still unset.
    overrideProcessEnv: false,
});
