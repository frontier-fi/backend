import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configuredSchedule } from '../scheduler/schedule';
import { configureWorkerRoutes, JobHandler, jobHandlers, WorkerRoutes } from './job-handlers';

const SEPOLIA_ID = '11155111';

async function serve(
    handlers: Record<string, JobHandler>,
): Promise<{ server: Server; url: string; routes: WorkerRoutes }> {
    const app = express();
    app.use(express.json());
    const routes = configureWorkerRoutes(app, handlers);
    const server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
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
    let server: Server;
    let url: string;

    beforeAll(async () => {
        ({ server, url } = await serve(handlers));
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    beforeEach(() => {
        for (const name of Object.keys(handlers)) delete handlers[name];
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
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

    it('skips a job that is still running', async () => {
        const job = blockingJob(handlers, 'sync-pools-v3');

        const first = post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        await job.started;
        const second = await post(url, { name: 'sync-pools-v3', chain: SEPOLIA_ID });
        job.finish();

        expect(second.body).toMatchObject({ status: 'skipped' });
        expect((await first).body).toMatchObject({ status: 'done' });
    });

    it.each([
        ['an unknown job', { name: 'not-a-job', chain: SEPOLIA_ID }],
        ['an unconfigured chain', { name: 'sync-pools-v3', chain: '1' }],
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
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });

    it('lets running jobs finish and refuses new ones meanwhile', async () => {
        const job = blockingJob(handlers, 'sync-hook-data');
        const running = post(url, { name: 'sync-hook-data', chain: SEPOLIA_ID });
        await job.started;

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
        await job.started;

        expect(await routes.drain(50)).toEqual([`sync-hook-data-${SEPOLIA_ID}`]);

        job.finish();
        await running;
    });
});
