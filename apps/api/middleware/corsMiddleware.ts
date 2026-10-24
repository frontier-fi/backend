import { NextFunction, Request, Response } from 'express';

const ALLOWED_HEADERS = 'X-Requested-With,Authorization,Content-Type,x-graphql-client-name,x-graphql-client-version';

export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);

    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Max-Age', '600');
        res.sendStatus(204);
        return;
    }

    next();
}
