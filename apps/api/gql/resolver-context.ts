import { Request } from 'express';

function getHeader(req: Request, key: string): string | undefined {
    const value = req.headers[key.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
}

export interface ResolverContext {
    adminApiKey: string | null;
    req: Request;
}

export async function resolverContext(req: Request): Promise<ResolverContext> {
    return {
        adminApiKey: getHeader(req, 'AdminApiKey') ?? null,
        req,
    };
}
