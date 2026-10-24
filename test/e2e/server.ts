import { type ChildProcess, spawn } from 'node:child_process';
import {
    ADMIN_API_KEY,
    DATABASE_URL,
    HEALTH_URL,
    PORT,
    repoRoot,
    SOR_HEALTH_URL,
    SOR_PORT,
    SOR_URL,
    WORKER_HEALTH_URL,
    WORKER_PORT,
} from './config';

interface AppProcess {
    name: 'server' | 'worker' | 'sor';
    port: number;
    healthUrl: string;
    env: Record<string, string>;
    child?: ChildProcess;
    logs: string[];
}

// Production topology: the API proxies swap quotes to a separate SOR instance.
const api: AppProcess = {
    name: 'server',
    port: PORT,
    healthUrl: HEALTH_URL,
    env: { WORKER: 'false', SCHEDULER: 'false', SOR_INSTANCE: 'false', SOR_SERVICE_URL: SOR_URL },
    logs: [],
};

const sor: AppProcess = {
    name: 'sor',
    port: SOR_PORT,
    healthUrl: SOR_HEALTH_URL,
    env: { WORKER: 'false', SCHEDULER: 'false', SOR_INSTANCE: 'true' },
    logs: [],
};

// The tests post jobs to the worker themselves, the way the scheduler does.
const worker: AppProcess = {
    name: 'worker',
    port: WORKER_PORT,
    healthUrl: WORKER_HEALTH_URL,
    env: { WORKER: 'true', SCHEDULER: 'false' },
    logs: [],
};

function tail(app: AppProcess): string {
    return app.logs.slice(-80).join('');
}

export function serverLogs(): string {
    return tail(api);
}

export function workerLogs(): string {
    return tail(worker);
}

async function start(app: AppProcess): Promise<void> {
    try {
        const existing = await fetch(app.healthUrl, { signal: AbortSignal.timeout(500) });
        if (existing.ok || existing.status > 0) {
            throw new Error(`Port ${app.port} is already in use. Stop that process before bun run test:e2e.`);
        }
    } catch (error) {
        if (error instanceof Error && error.message.includes('already in use')) throw error;
    }

    const child = spawn('bun', ['apps/main.ts'], {
        cwd: repoRoot,
        env: {
            ...process.env,
            PORT: String(app.port),
            NODE_ENV: 'staging',
            DEPLOYMENT_ENV: 'staging',
            ADMIN_API_KEY,
            DATABASE_URL,
            APOLLO_SCHEMA_REPORTING: 'false',
            ...app.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    app.child = child;

    const capture = (chunk: Buffer) => {
        app.logs.push(chunk.toString());
        if (app.logs.length > 200) app.logs.splice(0, app.logs.length - 200);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('exit', (code) => {
        app.logs.push(`\n[${app.name} exit ${code}]\n`);
    });

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        if (child.exitCode != null) {
            throw new Error(`The ${app.name} exited before /health returned 200\n${tail(app)}`);
        }
        try {
            const response = await fetch(app.healthUrl, { signal: AbortSignal.timeout(1_000) });
            if (response.status === 200) return;
        } catch {
            // The process is still binding the port.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`The ${app.name} did not become healthy on port ${app.port}\n${tail(app)}`);
}

async function stop(app: AppProcess): Promise<void> {
    const child = app.child;
    if (!child || child.exitCode != null) return;
    child.kill('SIGTERM');
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && child.exitCode == null) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (child.exitCode == null) child.kill('SIGKILL');
}

export function sorLogs(): string {
    return tail(sor);
}

export const startServer = () => start(api);
export const stopServer = () => stop(api);
export const startWorker = () => start(worker);
export const stopWorker = () => stop(worker);
export const startSor = () => start(sor);
export const stopSor = () => stop(sor);
