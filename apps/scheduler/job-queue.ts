import config from '../../config';
import { chainIdToChain } from '../../config/chain-id-to-chain';
import { env } from '../env';

class WorkerQueue {
    constructor(private readonly queueUrl?: string) {}

    public async sendWithInterval(json: string, intervalMs: number): Promise<void> {
        try {
            if (this.queueUrl === undefined) {
                return;
            }

            await this.send(json);
            console.log(`Sent job ${json}`);
        } catch (error) {
            console.error(error);
        } finally {
            setTimeout(() => {
                this.sendWithInterval(json, intervalMs);
            }, intervalMs);
        }
    }

    private async send(json: string): Promise<void> {
        if (this.queueUrl === undefined) {
            throw new Error('WORKER_QUEUE_URL is undefined');
        }

        const response = await fetch(this.queueUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: json,
        });

        if (!response.ok) {
            throw new Error(`Failed to send job: ${response.status} ${response.statusText}`);
        }
    }
}

const workerQueue = new WorkerQueue(env.WORKER_QUEUE_URL);

export async function scheduleJobs(chainId: string): Promise<void> {
    for (const job of config[chainIdToChain[chainId]].workerJobs) {
        console.log(`Initializing job ${job.name}-${chainId}-init`);
        await workerQueue.sendWithInterval(JSON.stringify({ name: job.name, chain: chainId }), job.interval);
    }
}
