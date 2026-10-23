import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const repoRoot = process.cwd();

if (!existsSync(resolve(repoRoot, 'prisma/schema'))) {
    throw new Error(`Run bun run test:e2e from the backend repo. cwd is ${repoRoot}`);
}

export const PORT = 4010;
export const ADMIN_API_KEY = 'e2e-admin-key';
export const DATABASE_NAME = 'frontier_e2e';
export const DATABASE_URL = `postgresql://backend:let-me-in@127.0.0.1:5431/${DATABASE_NAME}?schema=public`;
export const GRAPHQL_URL = `http://127.0.0.1:${PORT}/graphql`;
export const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;

export const POOL_TYPES = ['WEIGHTED', 'STABLE', 'ECLP'] as const;

/** Live Sepolia pools the subgraph is expected to keep serving. */
export const KNOWN_POOLS = [
    { id: '0xbfa2c112f1987854c6922505d06a9d9e897e2bf9', type: 'ECLP', typename: 'GqlPoolEclp' },
    { id: '0x6c0705aa00bbc8476ec0b6d94fa5aa492e75b697', type: 'STABLE', typename: 'GqlPoolStable' },
    { id: '0xd181617f85b6ff1728211c53c0a2b8108bd4a69d', type: 'WEIGHTED', typename: 'GqlPoolWeighted' },
] as const;

/** Mixed-case WETH with a corrupted checksum. isAddress rejects it. */
export const BAD_CHECKSUM = '0xfff9976782d46CC05630D1f6eBAb18b2324d6B14';

/** EIP-55 WETH. Used as a header, not as a pool id. */
export const VALID_CHECKSUM = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';

export const MISSING_POOL = '0x0000000000000000000000000000000000000001';

export const LOWER_ADDRESS = /^0x[a-f0-9]{40}$/;
