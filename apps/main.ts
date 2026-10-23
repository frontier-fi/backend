import './sentry';
import { startApiServer } from './api/server';
import { startWorkerServer } from './worker/server';
import { startSchedulerServer } from './scheduler/server';

const isWorker = process.env.WORKER === 'true';
const isScheduler = process.env.SCHEDULER === 'true';

// Both flags may be set. DigitalOcean workers cannot receive traffic from other
// components, so the scheduler posts jobs to the worker HTTP server on localhost.
if (isWorker) {
    startWorkerServer();
}
if (isScheduler) {
    startSchedulerServer();
}
if (!isWorker && !isScheduler) {
    startApiServer();
}
