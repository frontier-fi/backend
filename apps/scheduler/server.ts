import { logger } from '../../modules/common/logger';
import { env } from '../env';
import { Scheduler, scheduleJobs, WorkerQueue } from './job-queue';
import { configuredSchedule } from './schedule';

export function startSchedulerServer(): Scheduler | undefined {
    if (!env.WORKER_QUEUE_URL) {
        logger.error('WORKER_QUEUE_URL is unset; no jobs scheduled');
        return undefined;
    }

    return scheduleJobs(configuredSchedule(), new WorkerQueue(env.WORKER_QUEUE_URL));
}
