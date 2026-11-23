import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configuredSchedule } from '../scheduler/schedule';
import {
    acquirePostgresAdvisoryLock,
    configureWorkerRoutes,
    DEFAULT_DONE_LOG_INTERVAL_MS,
    JobHandler,
    jobHandlers,
    SLOW_JOB_LOG_THRESHOLD_S,
    WorkerRouteOptions,
    WorkerRoutes,
} from './job-handlers';
import { env } from '../env';

const SEPOLIA_ID = '11155111';
const BASE_ID = '8453';

const noopLock = async () => async () => undefined;

async function serve(
    handlers: Record<string, JobHandler>,
    options: WorkerRouteOptions = {},
): Promise<{ server: Server; url: string; routes: WorkerRoutes }> {
    const app = express();
    app.use(express.json());
    const routes = configureWorkerRoutes(app, handlers, {
        acquireLock: noopLock,
        ...options,
    });
    const server = await new Promise<Server>((resolve, reject) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        listening.once('error', reject);
    });
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, routes };
}

async function post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    const isJson = response.headers.get('content-type')?.includes('application/json');
    return { status: response.status, body: isJson ? JSON.parse(text) : text };
}

/** A handler that runs until finish() is called. */
function blockingJob(handlers: Record<string, JobHandler>, name: string) {
    let finish: () => void = () => undefined;
    const started = new Promise<void>((markStarted) => {
        handlers[name] = () =>
            new Promise<void>((resolve) => {
                finish = resolve;
                markStarted();
            });
    });
    return { started, finish: () => finish() };
}

describe('jobHandlers', () => {
    const scheduledNames = configuredSchedule().map((entry) => entry.name);

    it('has a handler for every scheduled job', () => {
        expect(scheduledNames.filter((name) => !Object.hasOwn(jobHandlers, name))).toEqual([]);
    });

    it('schedules every handler', () => {
        expect(Object.keys(jobHandlers).filter((name) => !scheduledNames.includes(name))).toEqual([]);
    });
});

describe('worker route', () => {
    const handlers: Record<string, JobHandler> = {};
    let server: Server | undefined;
    let url: string;
    let stdoutSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        for (const name of Object.keys(handlers)) delete handlers[name];
        stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        ({ server, url } = await serve(handlers));
    });

    afterEach(async () => {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        if (server?.listening) {
            server.closeAllConnections();
            await new Promise((resolve) => server!.close(resolve));
        }
    });

    it('answers the health check', async () => {
        expect((await fetch(`${url}health`)).status).toBe(200);
    });

    it('runs a known job with the chain from the message', async () => {
        const handler = vi.fn(async () => undefined);
        handlers['sync-pools-v3'] = handler;

        const result = await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });

        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ job: `sync-pools-v3-${SEPOLIA_ID}`, status: 'done' });
        expect(handler).toHaveBeenCalledWith('SEPOLIA');
    });

    it('reports a failed job without failing the request', async () => {
        handlers['sync-pools-v3'] = async () => {
            throw new Error('rpc down');
        };

        const result = await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });

        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ status: 'failed', error: 'rpc down' });
    });

    it('logs one JSON line per job with its name and chain', async () => {
        handlers['sync-pools-v3'] = async () => undefined;

        await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });

        expect(stdoutSpy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(stdoutSpy.mock.calls[0][0]))).toMatchObject({
            level: 'info',
            message: 'Worker job finished',
            job: `sync-pools-v3-${SEPOLIA_ID}`,
            name: 'sync-pools-v3',
            chain: 'SEPOLIA',
            status: 'done',
            durationSeconds: expect.any(Number),
        });
    });

    it('logs a failed job to stderr with its stack and without the RPC key', async () => {
        const previousKey = env.DRPC_API_KEY;
        env.DRPC_API_KEY = 'secret-drpc-key';
        handlers['sync-pools-v3'] = async () => {
            const err = new Error('HTTP request failed. URL: https://lb.drpc.live/base/secret-drpc-key');
            err.stack = [
                'Error: HTTP request failed. URL: https://lb.drpc.live/base/secret-drpc-key',
                '    at fetchJson (https://lb.drpc.live/base/secret-drpc-key:10:5)',
            ].join('\n');
            throw err;
        };

        try {
            const result = await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });

            const line = String(stderrSpy.mock.calls[0][0]).trimEnd();
            expect(line).not.toContain('secret-drpc-key');
            const parsed = JSON.parse(line);
            expect(parsed).toMatchObject({
                level: 'error',
                message: 'Worker job failed',
                name: 'sync-pools-v3',
                chain: 'SEPOLIA',
                status: 'failed',
                error: 'HTTP request failed. URL: https://lb.drpc.live/base/***',
            });
            expect(parsed.stack).toMatch(/^\s*at /);
            expect(parsed.stack).toContain('https://lb.drpc.live/base/***');
            expect(parsed.stack).not.toContain('HTTP request failed');
            expect(result.body).not.toHaveProperty('stack');
        } finally {
            env.DRPC_API_KEY = previousKey;
        }
    });

    it('keeps oversized failure logs valid JSON under DigitalOcean 2 KB syslog limit', async () => {
        handlers['sync-pools-v3'] = async () => {
            const err = new Error('x'.repeat(4_000));
            err.stack = `Error: ${'x'.repeat(4_000)}\n${'    at frame (/app/index.js:1:1)\n'.repeat(40)}`;
            throw err;
        };

        await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });

        const line = String(stderrSpy.mock.calls[0][0]).trimEnd();
        expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(1_600);
        const parsed = JSON.parse(line);
        expect(parsed).toMatchObject({
            level: 'error',
            message: 'Worker job failed',
            job: `sync-pools-v3-${SEPOLIA_ID}`,
            name: 'sync-pools-v3',
            chain: 'SEPOLIA',
            status: 'failed',
        });
        expect(parsed.error.endsWith('…')).toBe(true);
        expect(parsed.stack.endsWith('…')).toBe(true);
        expect(parsed.stack).toContain('at frame (/app/index.js:1:1)');
        expect(parsed.stack).not.toContain('xxxx');
    });

    it('caps multi-byte and JSON-escaped failure logs by UTF-8 byte length', async () => {
        handlers['sync-pools-v3'] = async () => {
            const payload = '─"\\\n\u001b😀'.repeat(300);
            const err = new Error(payload);
            err.stack = `Error: ${payload}\n${`    at ${payload} (/app/index.js:1:1)\n`.repeat(10)}`;
            throw err;
        };

        await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });

        const line = String(stderrSpy.mock.calls[0][0]).trimEnd();
        expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(1_600);
        expect(Buffer.from(line, 'utf8').toString('utf8')).toBe(line);
        const parsed = JSON.parse(line);
        expect(parsed).toMatchObject({
            level: 'error',
            message: 'Worker job failed',
            job: `sync-pools-v3-${SEPOLIA_ID}`,
            name: 'sync-pools-v3',
            chain: 'SEPOLIA',
            status: 'failed',
        });
        expect(parsed.error.endsWith('…')).toBe(true);
        expect(parsed.stack === undefined || parsed.stack.endsWith('…')).toBe(true);
    });

    it('skips a job that is still running', async () => {
        const job = blockingJob(handlers, 'sync-pools-v3');

        const first = post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        await Promise.race([job.started, first]);
        const second = await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        job.finish();

        expect(second.body).toMatchObject({ status: 'skipped' });
        expect((await first).body).toMatchObject({ status: 'done' });
    });

    it.each([
        ['an unknown job', { name: 'not-a-job', chain: SEPOLIA_ID }],
        ['an unconfigured chain', { name: 'sync-pools-v3', chain: '999999999' }],
        ['an inherited property as the job', { name: 'constructor', chain: SEPOLIA_ID }],
        ['an inherited property as the chain', { name: 'sync-pools-v3', chain: 'toString' }],
        ['a message without fields', {}],
    ])('rejects %s', async (_case, body) => {
        handlers['sync-pools-v3'] = vi.fn(async () => undefined);

        const result = await post(url, body);

        expect(result.status).toBe(400);
        expect(handlers['sync-pools-v3']).not.toHaveBeenCalled();
    });
});

describe('worker job log throttling', () => {
    const handlers: Record<string, JobHandler> = {};
    let clock = 0;
    let lockHeldByPeer = false;
    let server: Server;
    let url: string;
    let stdoutSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        for (const name of Object.keys(handlers)) delete handlers[name];
        clock = 1_000;
        lockHeldByPeer = false;
        stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        ({ server, url } = await serve(handlers, {
            acquireLock: async () => (lockHeldByPeer ? null : async () => undefined),
            doneLogIntervalMs: DEFAULT_DONE_LOG_INTERVAL_MS,
            slowJobLogThresholdSeconds: SLOW_JOB_LOG_THRESHOLD_S,
            now: () => clock,
        }));
    });

    afterEach(async () => {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        if (server?.listening) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('logs the first done run, suppresses fast done runs within doneLogIntervalMs while returning outcome, and logs again once elapsed', async () => {
        handlers['sync-pools-v3'] = async () => {
            clock += 250;
        };

        // 1. First done run after startup logs immediately (clock ends at 1_250).
        const first = await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        expect(first.status).toBe(200);
        expect(first.body).toEqual({
            job: `sync-pools-v3-${SEPOLIA_ID}`,
            status: 'done',
            durationSeconds: 0.25,
        });
        expect(stdoutSpy).toHaveBeenCalledTimes(1);

        // 2. Fast runs inside the 10-minute window are suppressed on stdout, without sliding the window forward.
        clock = 1_250 + 30_000 - 250;
        const second = await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        expect(second.status).toBe(200);
        expect(second.body).toEqual({
            job: `sync-pools-v3-${SEPOLIA_ID}`,
            status: 'done',
            durationSeconds: 0.25,
        });
        expect(stdoutSpy).toHaveBeenCalledTimes(1);

        clock = 1_250 + DEFAULT_DONE_LOG_INTERVAL_MS - 1 - 250;
        const justBeforeBoundary = await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        expect(justBeforeBoundary.body).toMatchObject({ status: 'done', durationSeconds: 0.25 });
        expect(stdoutSpy).toHaveBeenCalledTimes(1);

        // 3. Run completing at doneLogIntervalMs after the first logged done emits the heartbeat again.
        clock = 1_250 + DEFAULT_DONE_LOG_INTERVAL_MS - 250;
        const afterInterval = await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        expect(afterInterval.body).toMatchObject({ status: 'done', durationSeconds: 0.25 });
        expect(stdoutSpy).toHaveBeenCalledTimes(2);
        expect(JSON.parse(String(stdoutSpy.mock.calls[1][0]))).toMatchObject({
            level: 'info',
            message: 'Worker job finished',
            job: `sync-pools-v3-${SEPOLIA_ID}`,
            name: 'sync-pools-v3',
            chain: 'SEPOLIA',
            status: 'done',
            durationSeconds: 0.25,
        });
    });

    it('logs slow done runs (>= slowJobLogThresholdSeconds) immediately even within the throttle window', async () => {
        let simulatedDurationMs = 100;
        handlers['sync-pools-v3'] = async () => {
            clock += simulatedDurationMs;
        };

        await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        expect(stdoutSpy).toHaveBeenCalledTimes(1);

        // Fast follow-up 20s later is suppressed.
        clock += 20_000;
        await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        expect(stdoutSpy).toHaveBeenCalledTimes(1);

        // Slow run (>= 10s) 20s later bypasses throttling and logs immediately with durationSeconds.
        clock += 20_000;
        simulatedDurationMs = SLOW_JOB_LOG_THRESHOLD_S * 1_000;
        const slow = await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        expect(slow.body).toEqual({
            job: `sync-pools-v3-${SEPOLIA_ID}`,
            status: 'done',
            durationSeconds: SLOW_JOB_LOG_THRESHOLD_S,
        });
        expect(stdoutSpy).toHaveBeenCalledTimes(2);
        expect(JSON.parse(String(stdoutSpy.mock.calls[1][0]))).toMatchObject({
            level: 'info',
            message: 'Worker job finished',
            name: 'sync-pools-v3',
            chain: 'SEPOLIA',
            status: 'done',
            durationSeconds: SLOW_JOB_LOG_THRESHOLD_S,
        });
    });

    it('always logs failed and skipped runs immediately inside the throttle window and preserves first-done logging', async () => {
        // Initial skipped and failed runs before any done do not mark first-done as logged.
        lockHeldByPeer = true;
        handlers['sync-pools-v3'] = async () => undefined;
        await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        expect(stdoutSpy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(stdoutSpy.mock.calls[0][0]))).toMatchObject({
            level: 'info',
            message: 'Worker job skipped',
            status: 'skipped',
            reason: 'locked by another worker',
        });

        lockHeldByPeer = false;
        let shouldFail = true;
        handlers['sync-pools-v3'] = async () => {
            if (shouldFail) throw new Error('transient rpc error');
        };
        await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        expect(stderrSpy).toHaveBeenCalledTimes(1);

        // First actual done run still logs immediately.
        shouldFail = false;
        await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        expect(stdoutSpy).toHaveBeenCalledTimes(2);
        expect(JSON.parse(String(stdoutSpy.mock.calls[1][0]))).toMatchObject({
            level: 'info',
            message: 'Worker job finished',
            status: 'done',
        });

        // Within the throttle window: fast done is suppressed, but failed and skipped still log immediately.
        clock += 5_000;
        await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        expect(stdoutSpy).toHaveBeenCalledTimes(2);

        clock += 5_000;
        shouldFail = true;
        await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        expect(stderrSpy).toHaveBeenCalledTimes(2);
        expect(JSON.parse(String(stderrSpy.mock.calls[1][0]))).toMatchObject({
            level: 'error',
            message: 'Worker job failed',
            name: 'sync-pools-v3',
            chain: 'SEPOLIA',
            status: 'failed',
            error: 'transient rpc error',
        });

        clock += 5_000;
        lockHeldByPeer = true;
        await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        expect(stdoutSpy).toHaveBeenCalledTimes(3);
        expect(JSON.parse(String(stdoutSpy.mock.calls[2][0]))).toMatchObject({
            level: 'info',
            message: 'Worker job skipped',
            name: 'sync-pools-v3',
            chain: 'SEPOLIA',
            status: 'skipped',
        });
    });

    it('tracks throttle timers independently per job name and chain', async () => {
        handlers['sync-pools-v3'] = async () => undefined;
        handlers['add-pools-v3'] = async () => undefined;

        await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        clock += 1_000;
        // Repeat of same job + chain is suppressed.
        await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        // Same job on a different chain logs immediately.
        await post(url, { name: 'sync-pools-v3', chain: BASE_ID });
        // Different job on the original chain logs immediately.
        await post(url, { name: 'add-pools-v3', chain: SEPOLIA_ID });

        expect(stdoutSpy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])))).toEqual([
            expect.objectContaining({ name: 'sync-pools-v3', chain: 'SEPOLIA', status: 'done' }),
            expect.objectContaining({ name: 'sync-pools-v3', chain: 'BASE', status: 'done' }),
            expect.objectContaining({ name: 'add-pools-v3', chain: 'SEPOLIA', status: 'done' }),
        ]);
    });
});

describe('worker drain', () => {
    const handlers: Record<string, JobHandler> = {};
    let server: Server;
    let url: string;
    let routes: WorkerRoutes;

    let stdoutSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        for (const name of Object.keys(handlers)) delete handlers[name];
        stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        ({ server, url, routes } = await serve(handlers));
    });

    afterEach(async () => {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        if (server?.listening) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('lets running jobs finish and refuses new ones meanwhile', async () => {
        const job = blockingJob(handlers, 'sync-hook-data');
        const running = post(url, { name: 'sync-hook-data', chain: SEPOLIA_ID });
        await Promise.race([job.started, running]);

        const drained = routes.drain(5_000);
        const refused = await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        job.finish();

        expect(refused.status).toBe(503);
        expect(await drained).toEqual([]);
        expect((await running).body).toMatchObject({ status: 'done' });
    });

    it('stops waiting at the deadline and names the jobs still running', async () => {
        const job = blockingJob(handlers, 'sync-hook-data');
        const running = post(url, { name: 'sync-hook-data', chain: SEPOLIA_ID });
        await Promise.race([job.started, running]);

        expect(await routes.drain(50)).toEqual([`sync-hook-data-${SEPOLIA_ID}`]);

        job.finish();
        await running;
    });

    it('fails a job that exceeds jobTimeoutMs and releases its lock', async () => {
        await new Promise((resolve) => server.close(resolve));
        const releaseSpy = vi.fn(async () => undefined);
        ({ server, url, routes } = await serve(handlers, {
            jobTimeoutMs: 40,
            acquireLock: async () => releaseSpy,
        }));

        const job = blockingJob(handlers, 'sync-hook-data');
        const result = await post(url, { name: 'sync-hook-data', chain: SEPOLIA_ID });
        job.finish();

        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({
            job: `sync-hook-data-${SEPOLIA_ID}`,
            status: 'failed',
            error: expect.stringContaining('timed out after 40ms'),
        });
        expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    it('skips a job when Postgres advisory lock is held by another worker', async () => {
        await new Promise((resolve) => server.close(resolve));
        ({ server, url, routes } = await serve(handlers, {
            acquireLock: async () => null,
        }));

        const handler = vi.fn(async () => undefined);
        handlers['sync-pools-v3'] = handler;

        const result = await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });

        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({
            job: `sync-pools-v3-${SEPOLIA_ID}`,
            status: 'skipped',
        });
        expect(handler).not.toHaveBeenCalled();
    });

    it('acquires and releases Postgres advisory lock via Prisma client', async () => {
        const mockClient = {
            $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
            $executeRaw: vi.fn().mockResolvedValue(1),
        };

        const release = await acquirePostgresAdvisoryLock('sync-pools-v3-11155111', mockClient as any);
        expect(release).toBeTypeOf('function');
        expect(mockClient.$queryRaw).toHaveBeenCalledTimes(1);

        await release!();
        expect(mockClient.$executeRaw).toHaveBeenCalledTimes(1);

        mockClient.$queryRaw.mockResolvedValueOnce([{ locked: false }]);
        const skipped = await acquirePostgresAdvisoryLock('sync-pools-v3-11155111', mockClient as any);
        expect(skipped).toBeNull();
    });
});
