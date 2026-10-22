import config from '../../config';
import { scheduleJobs } from './job-queue';

const chainIds = Object.values(config).map((network) => String(network.chain.id));

export async function startSchedulerServer() {
    try {
        for (const chainId of chainIds) {
            scheduleJobs(chainId);
        }
    } catch (e) {
        console.error(`Fatal error happened during cron scheduling.`, e);
    }
}
