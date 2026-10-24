import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobQueue, scheduleJobs, WorkerQueue } from './job-queue';

function fakeQueue(answer: (name: string) => Promise<void> = async () => undefined) {
    const sent: string[] = [];
    const queue: JobQueue = {
        send: vi.fn(async (json: string) => {
            const { name } = JSON.parse(json);
            sent.push(name);
            return answer(name);
        }),
    };
    return { queue, sent };
}

describe('scheduleJobs', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('returns before any job is sent', () => {
        const { queue } = fakeQueue();

        scheduleJobs([{ name: 'first', chainId: '1', interval: 60_000, initialDelay: 0 }], queue);

        expect(queue.send).not.toHaveBeenCalled();
    });

    it('starts the next job while a slow first job is still running', async () => {
        const { queue, sent } = fakeQueue((name) =>
            name === 'slow' ? new Promise(() => undefined) : Promise.resolve(),
        );

        scheduleJobs(
            [
                { name: 'slow', chainId: '1', interval: 60_000, initialDelay: 0 },
                { name: 'fast', chainId: '1', interval: 60_000, initialDelay: 5_000 },
            ],
            queue,
        );

        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual(['slow']);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(sent).toEqual(['slow', 'fast']);
    });

    it('sends a job again one interval after it finishes', async () => {
        const { queue } = fakeQueue();

        scheduleJobs([{ name: 'job', chainId: '1', interval: 10_000, initialDelay: 0 }], queue);

        await vi.advanceTimersByTimeAsync(0);
        expect(queue.send).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(queue.send).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(queue.send).toHaveBeenCalledTimes(2);
        expect(queue.send).toHaveBeenLastCalledWith(JSON.stringify({ name: 'job', chain: '1' }));
    });

    it('keeps the schedule after the worker rejects or cannot be reached', async () => {
        const send = vi
            .fn<(json: string) => Promise<void>>()
            .mockRejectedValueOnce(new Error('Failed to send job: 400 Bad Request'))
            .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
            .mockResolvedValue(undefined);

        scheduleJobs([{ name: 'job', chainId: '1', interval: 1_000, initialDelay: 0 }], { send });

        await vi.advanceTimersByTimeAsync(2_000);
        expect(send).toHaveBeenCalledTimes(3);
        expect(console.error).toHaveBeenCalledTimes(2);
    });

    it('sends nothing after stop, neither jobs waiting for their first run nor the next run of a running one', async () => {
        let finishRunning: () => void = () => undefined;
        const { queue, sent } = fakeQueue((name) =>
            name === 'running'
                ? new Promise<void>((resolve) => {
                      finishRunning = resolve;
                  })
                : Promise.resolve(),
        );

        const scheduler = scheduleJobs(
            [
                { name: 'running', chainId: '1', interval: 1_000, initialDelay: 0 },
                { name: 'waiting', chainId: '1', interval: 1_000, initialDelay: 5_000 },
            ],
            queue,
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual(['running']);

        scheduler.stop();
        finishRunning();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(sent).toEqual(['running']);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('WorkerQueue', () => {
    let server: Server | undefined;

    async function listen(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<string> {
        const listening = createServer((req, res) => {
            let body = '';
            req.setEncoding('utf8');
            req.on('data', (chunk: string) => (body += chunk));
            req.on('end', () => handler(req, body, res));
        });
        server = listening;
        await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
        return `http://127.0.0.1:${(listening.address() as AddressInfo).port}/`;
    }

    async function close(): Promise<void> {
        const closing = server;
        server = undefined;
        if (closing) {
            closing.closeAllConnections();
            await new Promise((resolve) => closing.close(resolve));
        }
    }

    afterEach(close);

    it('posts the job as JSON and resolves when the worker answers', async () => {
        let received: Record<string, string | undefined> = {};
        const url = await listen((req, body, res) => {
            received = { method: req.method, contentType: req.headers['content-type'], body };
            setTimeout(() => res.end('{"status":"done"}'), 100);
        });

        await new WorkerQueue(url).send('{"name":"job","chain":"1"}');

        expect(received).toEqual({
            method: 'POST',
            contentType: 'application/json',
            body: '{"name":"job","chain":"1"}',
        });
    });

    it('rejects when the worker refuses the job', async () => {
        const url = await listen((_req, _body, res) => {
            res.statusCode = 400;
            res.end('Bad Request');
        });

        await expect(new WorkerQueue(url).send('{}')).rejects.toThrow('Failed to send job: 400 Bad Request');
    });

    it('rejects when nothing listens', async () => {
        const url = await listen(() => undefined);
        await close();

        await expect(new WorkerQueue(url).send('{}')).rejects.toThrow(/ECONNREFUSED/);
    });
});
