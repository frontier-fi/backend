import { Express } from 'express';

export function loadRestRoutes(app: Express) {
    app.use('/health', (_, res) => res.sendStatus(200));
}
