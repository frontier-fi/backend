import { PrismaClient } from '@prisma/client';
import { env } from '../apps/env';

function defaultConnectionLimit(): number {
    if (process.env.WORKER === 'true') {
        return 6;
    }
    if (process.env.SCHEDULER === 'true' || process.env.SOR_INSTANCE === 'true') {
        return 2;
    }
    return 5;
}

export function withDefaultConnectionParams(
    databaseUrl: string,
    connectionLimit?: number,
    defaultPoolTimeout = 20,
): string {
    try {
        const parsed = new URL(databaseUrl);
        if (connectionLimit !== undefined) {
            parsed.searchParams.set('connection_limit', String(connectionLimit));
        } else if (!parsed.searchParams.has('connection_limit')) {
            parsed.searchParams.set('connection_limit', String(defaultConnectionLimit()));
        }
        if (!parsed.searchParams.has('pool_timeout')) {
            parsed.searchParams.set('pool_timeout', String(defaultPoolTimeout));
        }
        return parsed.toString();
    } catch {
        return databaseUrl;
    }
}

export let prisma = new PrismaClient({
    datasources: {
        db: {
            url: withDefaultConnectionParams(env.DATABASE_URL),
        },
    },
});

// Debugging query times
// export let prisma = new PrismaClient({
//     log: ['query'],
//     datasources: {
//         db: {
//             url: env.DATABASE_URL,
//         },
//     },
// });

// let callCount = 0;
// prisma.$use(async (params, next) => {
//     console.log(JSON.stringify(params, null, 2), callCount++);
//     // if (callCount > 8) {
//     //     throw new Error(`Maximum number of Prisma calls exceeded (${callCount}) - ${JSON.stringify(params, null, 2)}`);
//     // }
//     return next(params);
// });

// prisma.$use(async (params, next) => {
//     const before = Date.now()
//     const result = await next(params)
//     const after = Date.now()
//     console.log(`Query ${params.model}.${params.action} took ${after - before}ms`)
//     return result
// })

export function setPrisma(prismaClient: PrismaClient) {
    prisma = prismaClient;
}
