import { createHash, timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

/** Stellate adds this header to every request it forwards. See `headers` in stellate.ts. */
export const ORIGIN_SECRET_HEADER = 'x-stellate-origin-secret';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Rejects requests that did not come through Stellate, so the edge cache and rate limits cannot be
 * bypassed through the origin hostname. Without a secret every request passes, which keeps local
 * development and tests working. Routes registered before this one, such as /health, are not checked.
 */
export function requireOriginSecret(secret: string | undefined) {
    if (!secret) {
        return (_req: Request, _res: Response, next: NextFunction) => next();
    }

    const expected = digest(secret);
    return (req: Request, res: Response, next: NextFunction) => {
        const provided = req.headers[ORIGIN_SECRET_HEADER];
        if (typeof provided === 'string' && timingSafeEqual(digest(provided), expected)) {
            return next();
        }
        res.status(403).json({ errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }] });
    };
}
