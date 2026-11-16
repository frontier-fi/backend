import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configuredSchedule } from '../scheduler/schedule';
import {
    acquirePostgresAdvisoryLock,
    configureWorkerRoutes,
    JobHandler,
    jobHandlers,
    WorkerRouteOptions,
    WorkerRoutes,
} from './job-handlers';
import { env } from '../env';

const SEPOLIA_ID = '11155111';

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

    beforeAll(async () => {
        ({ server, url } = await serve(handlers));
    });

    afterAll(async () => {
        if (server?.listening) {
            await new Promise((resolve) => server!.close(resolve));
        }
    });

    beforeEach(() => {
        for (const name of Object.keys(handlers)) delete handlers[name];
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

        expect(console.log).toHaveBeenCalledTimes(1);
        expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
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

            const line = vi.mocked(console.error).mock.calls[0][0] as string;
            expect(line).not.toContain('secret-drpc-key');
            const parsed = JSON.parse(line);
            expect(parsed).toMatchObject({
                level: 'error',
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

        const line = vi.mocked(console.error).mock.calls[0][0] as string;
        expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(1_500);
        const parsed = JSON.parse(line);
        expect(parsed).toMatchObject({
            level: 'error',
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

        const line = vi.mocked(console.error).mock.calls[0][0] as string;
        expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(1_500);
        expect(line).toBe((line as string & { toWellFormed(): string }).toWellFormed());
        const parsed = JSON.parse(line);
        expect(parsed).toMatchObject({
            level: 'error',
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

describe('worker drain', () => {
    const handlers: Record<string, JobHandler> = {};
    let server: Server;
    let url: string;
    let routes: WorkerRoutes;

    beforeEach(async () => {
        for (const name of Object.keys(handlers)) delete handlers[name];
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        ({ server, url, routes } = await serve(handlers));
    });

    afterEach(async () => {
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
