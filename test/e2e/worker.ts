import { SEPOLIA_CHAIN_ID, WORKER_URL } from './config';
import { workerLogs } from './server';

export interface JobResult {
    job: string;
    status: 'done' | 'failed' | 'skipped';
    error?: string;
}

export async function postJob(body: unknown): Promise<Response> {
    return fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(480_000),
    });
}

/** Runs a scheduled job for Sepolia through the worker and throws unless it finished. */
export async function runJob(name: string): Promise<JobResult> {
    const response = await postJob({ name, chain: SEPOLIA_CHAIN_ID });
    const raw = await response.text();
    if (response.status !== 200) {
        throw new Error(`The worker answered ${response.status} for ${name}\n${raw}\n${workerLogs()}`);
    }

    const result = JSON.parse(raw) as JobResult;
    if (result.status !== 'done') {
        throw new Error(`Job ${result.job} ${result.status}: ${result.error ?? ''}\n${workerLogs()}`);
    }
    return result;
}
