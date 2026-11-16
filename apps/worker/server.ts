import express from 'express';
import type { Server } from 'node:http';
import { logger } from '../../modules/common/logger';
import { env } from '../env';
import type { Stoppable } from '../shutdown';
import { configureWorkerRoutes } from './job-handlers';

// Below SHUTDOWN_DEADLINE_MS, so the server and the database connection still close in time.
const JOB_DRAIN_TIMEOUT_MS = 90_000;

export async function startWorkerServer(): Promise<Stoppable> {
    const app = express();

    app.use(express.json());

    const routes = configureWorkerRoutes(app);

    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        logger.error('Unhandled worker HTTP error', { err });
        if (!res.headersSent) {
            res.sendStatus(500);
        }
    });

    const host = process.env.WORKER_HOST || '127.0.0.1';
    const server = await new Promise<Server>((resolve) => {
        const listening = app.listen(env.PORT, host, () => resolve(listening));
    });
    logger.info('Worker server listening', { host, port: env.PORT });

    return {
        async stop() {
            const unfinished = await routes.drain(JOB_DRAIN_TIMEOUT_MS);
            if (unfinished.length > 0) {
                logger.warn('Stopping worker with jobs still running', { jobs: unfinished });
            }
            const closed = new Promise((resolve) => server.close(resolve));
            server.closeAllConnections();
            await closed;
        },
    };
}
