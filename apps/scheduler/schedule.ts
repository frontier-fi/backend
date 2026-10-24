import config from '../../config';
import type { NetworkData, WorkerJob } from '../../config/types';
import { globalWorkerJobs } from '../../config/worker-jobs';

export interface ScheduledJob {
    name: string;
    chainId: string;
    interval: number;
    initialDelay: number;
}

// Gap between first runs, so a cold start does not fire every job at once.
export const STARTUP_STAGGER_MS = 5_000;

/**
 * Chain jobs run once per network, in config order. Global jobs run once for all networks.
 * They are keyed on the first network because the worker needs a chain id for the job id
 * and the Sentry monitor slug.
 */
export function buildSchedule(
    networks: Pick<NetworkData, 'chain' | 'workerJobs'>[],
    globalJobs: WorkerJob[],
    staggerMs = STARTUP_STAGGER_MS,
): ScheduledJob[] {
    if (networks.length === 0) {
        return [];
    }

    const globalChainId = String(networks[0].chain.id);
    const jobs = [
        ...networks.flatMap((network) =>
            network.workerJobs.map((job) => ({ ...job, chainId: String(network.chain.id) })),
        ),
        ...globalJobs.map((job) => ({ ...job, chainId: globalChainId })),
    ];

    return jobs.map((job, index) => ({
        name: job.name,
        chainId: job.chainId,
        interval: job.interval,
        initialDelay: Math.min(index * staggerMs, job.interval),
    }));
}

export function configuredSchedule(): ScheduledJob[] {
    return buildSchedule(Object.values(config), globalWorkerJobs);
}
