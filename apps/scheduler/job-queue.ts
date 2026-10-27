import { request } from 'node:http';
import type { ScheduledJob } from './schedule';

export interface JobQueue {
    send(json: string): Promise<void>;
}

const WORKER_REQUEST_TIMEOUT_MS = 15 * 60_000;

/**
 * Posts jobs to the worker, which answers when the job ends. This uses node:http because fetch
 * gives up when the response headers take longer than five minutes.
 */
export class WorkerQueue implements JobQueue {
    constructor(
        private readonly queueUrl: string,
        private readonly requestTimeoutMs: number = WORKER_REQUEST_TIMEOUT_MS,
    ) {}

    public send(json: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const req = request(
                this.queueUrl,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
                },
                (res) => {
                    // Read the body so the connection goes back to the pool.
                    res.resume();
                    res.on('error', reject);
                    res.on('end', () => {
                        const status = res.statusCode ?? 0;
                        if (status >= 200 && status < 300) {
                            resolve();
                        } else {
                            reject(new Error(`Failed to send job: ${status} ${res.statusMessage ?? ''}`.trim()));
                        }
                    });
                },
            );
            req.setTimeout(this.requestTimeoutMs, () => {
                req.destroy(new Error(`Worker request timed out after ${this.requestTimeoutMs}ms`));
            });
            req.on('error', reject);
            req.end(json);
        });
    }
}

export interface Scheduler {
    /** Sends no more jobs. Jobs the worker is already running carry on. */
    stop(): void;
}

/**
 * Starts every job on its own timer. The worker answers when a job finishes, so awaiting
 * jobs in turn would hold every later job behind the slowest first run.
 */
export function scheduleJobs(schedule: ScheduledJob[], queue: JobQueue): Scheduler {
    let stopped = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const after = (delay: number, fn: () => void) => {
        const timer = setTimeout(() => {
            timers.delete(timer);
            fn();
        }, delay);
        timers.add(timer);
    };

    const run = async (json: string, interval: number) => {
        try {
            await queue.send(json);
            console.log(`Sent job ${json}`);
        } catch (error) {
            console.error(error);
        }
        if (!stopped) {
            after(interval, () => run(json, interval));
        }
    };

    for (const job of schedule) {
        const json = JSON.stringify({ name: job.name, chain: job.chainId });
        console.log(`Initializing job ${job.name}-${job.chainId}-init, first run in ${job.initialDelay / 1000}s`);
        after(job.initialDelay, () => run(json, job.interval));
    }

    return {
        stop() {
            stopped = true;
            for (const timer of timers) {
                clearTimeout(timer);
            }
            timers.clear();
        },
    };
}
