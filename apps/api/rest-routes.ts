import { Express } from 'express';

export function loadRestRoutes(app: Express) {
    app.get('/', (_req, res) => {
        res.redirect(302, '/graphql');
    });
    app.use('/health', (_, res) => res.sendStatus(200));
}
