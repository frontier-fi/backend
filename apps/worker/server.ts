import * as Sentry from '@sentry/node';
import express from 'express';
import type { Server } from 'node:http';
import { env } from '../env';
import type { Stoppable } from '../shutdown';
import { configureWorkerRoutes } from './job-handlers';

// Below SHUTDOWN_DEADLINE_MS, so the server and the database connection still close in time.
const JOB_DRAIN_TIMEOUT_MS = 90_000;

export async function startWorkerServer(): Promise<Stoppable> {
    const app = express();

    app.use(express.json());

    const routes = configureWorkerRoutes(app);

    Sentry.setupExpressErrorHandler(app);

    // Replaces the default handler so Sentry does not get the error a second time from its log.
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        if (!res.headersSent) {
            res.sendStatus(500);
        }
    });

    const server = await new Promise<Server>((resolve) => {
        const listening = app.listen(env.PORT, '0.0.0.0', () => resolve(listening));
    });
    console.log(`Worker listening on port ${env.PORT}`);

    return {
        async stop() {
            const unfinished = await routes.drain(JOB_DRAIN_TIMEOUT_MS);
            if (unfinished.length > 0) {
                console.warn(`Stopping the worker while these jobs still run: ${unfinished.join(', ')}`);
            }
            const closed = new Promise((resolve) => server.close(resolve));
            server.closeAllConnections();
            await closed;
        },
    };
}
