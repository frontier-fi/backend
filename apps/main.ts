import { prisma } from '../prisma/prisma-client';
import { startApiServer } from './api/server';
import { startWorkerServer } from './worker/server';
import { startSchedulerServer } from './scheduler/server';
import { createShutdown, Stoppable } from './shutdown';

const isWorker = process.env.WORKER === 'true';
const isScheduler = process.env.SCHEDULER === 'true';

// Stopped in this order: the scheduler sends no more jobs, the worker lets running jobs finish,
// then the servers close.
const parts: Stoppable[] = [];

const shutdown = createShutdown(parts, {
    cleanup: async () => {
        await prisma.$disconnect();
    },
    exit: (code) => process.exit(code),
});
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

async function main() {
    // Both flags may be set. DigitalOcean workers cannot receive traffic from other
    // components, so the scheduler posts jobs to the worker HTTP server on localhost.
    const worker = isWorker ? await startWorkerServer() : undefined;
    const scheduler = isScheduler ? startSchedulerServer() : undefined;
    if (scheduler) {
        parts.push(scheduler);
    }
    if (worker) {
        parts.push(worker);
    }
    if (!isWorker && !isScheduler) {
        parts.push(await startApiServer());
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
