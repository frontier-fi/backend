import { type ChildProcess, spawn } from 'node:child_process';
import { ADMIN_API_KEY, DATABASE_URL, HEALTH_URL, PORT, repoRoot } from './config';

let child: ChildProcess | undefined;
const logs: string[] = [];

export function serverLogs(): string {
    return logs.slice(-80).join('');
}

function capture(chunk: Buffer): void {
    logs.push(chunk.toString());
    if (logs.length > 200) logs.splice(0, logs.length - 200);
}

export async function startServer(): Promise<void> {
    try {
        const existing = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(500) });
        if (existing.ok || existing.status > 0) {
            throw new Error(`Port ${PORT} is already in use. Stop that process before bun run test:e2e.`);
        }
    } catch (error) {
        if (error instanceof Error && error.message.includes('already in use')) throw error;
    }

    child = spawn('bun', ['apps/main.ts'], {
        cwd: repoRoot,
        env: {
            ...process.env,
            PORT: String(PORT),
            NODE_ENV: 'local',
            DEPLOYMENT_ENV: 'canary',
            ADMIN_API_KEY,
            DATABASE_URL,
            WORKER: 'false',
            SCHEDULER: 'false',
            SOR_INSTANCE: 'true',
            SOR_SERVICE_URL: `http://127.0.0.1:${PORT}/graphql`,
            APOLLO_SCHEMA_REPORTING: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('exit', (code) => {
        logs.push(`\n[server exit ${code}]\n`);
    });

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        if (child.exitCode != null) {
            throw new Error(`API exited before /health returned 200\n${serverLogs()}`);
        }
        try {
            const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1_000) });
            if (response.status === 200) return;
        } catch {
            // The process is still binding the port.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`API did not become healthy on port ${PORT}\n${serverLogs()}`);
}

export async function stopServer(): Promise<void> {
    if (!child || child.exitCode != null) return;
    child.kill('SIGTERM');
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && child.exitCode == null) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (child.exitCode == null) child.kill('SIGKILL');
}
