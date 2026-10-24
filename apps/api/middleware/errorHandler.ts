import { NextFunction, Request, Response } from 'express';

function httpStatus(error: unknown): number {
    const { status, statusCode } = (error ?? {}) as { status?: unknown; statusCode?: unknown };
    const code = status ?? statusCode;
    return typeof code === 'number' && code >= 400 && code < 600 ? code : 500;
}

/**
 * Last handler on the API app. Express's default handler answers with HTML and includes the
 * stack trace whenever NODE_ENV is not production.
 */
export function jsonErrorHandler(error: unknown, _req: Request, res: Response, next: NextFunction) {
    if (res.headersSent) {
        return next(error);
    }

    const status = httpStatus(error);
    if (status >= 500) {
        console.error(error);
    }

    const clientError = status < 500 && error instanceof Error;
    res.status(status).json({
        errors: [
            {
                message: clientError ? error.message : status < 500 ? 'Bad request' : 'Internal server error',
                extensions: { code: status < 500 ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR' },
            },
        ],
    });
}
