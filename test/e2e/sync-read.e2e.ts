import { PrismaClient } from '@prisma/client';
import { getAddress } from 'viem';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
    BAD_CHECKSUM,
    KNOWN_POOLS,
    LOWER_ADDRESS,
    MISSING_POOL,
    POOL_TYPES,
    SEPOLIA_CHAIN_ID,
    VALID_CHECKSUM,
} from './config';
import { createPrisma, dropDatabase, migrate, recreateDatabase } from './database';
import { data, expectRejectedAddress, graphql } from './graphql';
import { serverLogs, sorLogs, startServer, startSor, startWorker, stopServer, stopSor, stopWorker } from './server';
import { postJob, runJob } from './worker';

let prisma: PrismaClient | undefined;
let syncedIds: string[] = [];
let quotePoolId = KNOWN_POOLS[2].id;
let quoteTokenIn = '';
let quoteTokenOut = '';

const POOL_FIELDS = `
    __typename
    id
    address
    chain
    protocolVersion
    type
    name
    symbol
    hook { address type }
    poolTokens { address symbol decimals index }
`;

beforeAll(async () => {
    await recreateDatabase();
    await migrate();
    prisma = createPrisma();
    await startSor();
    await startServer();
    await startWorker();
}, 180_000);

afterAll(async () => {
    await stopWorker();
    await stopServer();
    await stopSor();
    await prisma?.$disconnect();
    await dropDatabase();
});

function db(): PrismaClient {
    if (!prisma) throw new Error('database client is not open');
    return prisma;
}

it('serves health and the schema', async () => {
    const health = await fetch('http://127.0.0.1:4010/health');
    expect(health.status).toBe(200);

    const schema = data(
        await graphql<{ __schema: { queryType: { name: string }; mutationType: { name: string } } }>(
            '{ __schema { queryType { name } mutationType { name } } }',
        ),
    );
    expect(schema.__schema.queryType.name).toBe('Query');
    expect(schema.__schema.mutationType.name).toBe('Mutation');
});

it('rejects admin mutations without the key', async () => {
    const missing = await graphql('mutation { poolSyncAllPoolsFromSubgraph(chain: SEPOLIA) }');
    expect(missing.body.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    expect(missing.body.errors?.[0]?.message).toMatch(/admin api key/i);

    const wrong = await graphql('mutation { poolSyncAllPoolsFromSubgraph(chain: SEPOLIA) }', {
        headers: { AdminApiKey: 'not-the-key' },
    });
    expect(wrong.body.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');

    expect(await db().prismaPool.count()).toBe(0);
});

it('reads an empty database', async () => {
    const empty = data(
        await graphql<{
            poolGetPools: unknown[];
            poolGetPoolsCount: number;
            filtered: unknown[];
            poolGetFeaturedPools: unknown[];
            poolGetSnapshots: unknown[];
            poolEvents: unknown[];
            poolEventsOnChain: unknown[];
            aggregatorPools: unknown[];
            poolGetAggregatorPools: unknown[];
            tokenGetTokens: unknown[];
            tokenGetCurrentPrices: unknown[];
            tokenGetHistoricalPrices: unknown[];
            tokenGetTokenDynamicData: null;
            tokenGetTokensDynamicData: unknown[];
            tokenGetRelativePriceChartData: unknown[];
            protocolMetricsChain: { chainId: string; poolCount: string; totalLiquidity: string };
            protocolMetricsAggregated: { poolCount: string; chains: { chainId: string }[] };
            sorGetSwapPaths: { protocolVersion: number; returnAmount: string; swaps: unknown[] };
        }>(`{
            poolGetPools { id }
            poolGetPoolsCount
            filtered: poolGetPools(where: { chainIn: [SEPOLIA], protocolVersionIn: [3], poolTypeIn: [WEIGHTED] }) { id }
            poolGetFeaturedPools(chains: [SEPOLIA]) { poolId primary description pool { id } }
            poolGetSnapshots(id: "${MISSING_POOL}", chain: SEPOLIA, range: ALL_TIME) { id timestamp totalLiquidity }
            poolEvents { id }
            poolEventsOnChain: poolEvents(first: 5, where: { chainIn: [SEPOLIA] }) { id type poolId }
            aggregatorPools(where: { chainIn: [SEPOLIA], protocolVersionIn: [3] }) { id chain protocolVersion type address }
            poolGetAggregatorPools(where: { chainIn: [SEPOLIA] }) { id }
            tokenGetTokens(chains: [SEPOLIA]) { address symbol decimals chainId }
            tokenGetCurrentPrices(chains: [SEPOLIA]) { address price chain }
            tokenGetHistoricalPrices(addresses: ["${MISSING_POOL}"], chain: SEPOLIA, range: SEVEN_DAY) { address prices { price timestamp } }
            tokenGetTokenDynamicData(address: "${MISSING_POOL}", chain: SEPOLIA) { tokenAddress price }
            tokenGetTokensDynamicData(addresses: ["${MISSING_POOL}"], chain: SEPOLIA) { tokenAddress price }
            tokenGetRelativePriceChartData(tokenIn: "${MISSING_POOL}", tokenOut: "${VALID_CHECKSUM.toLowerCase()}", range: SEVEN_DAY, chain: SEPOLIA) { id timestamp price }
            protocolMetricsChain(chain: SEPOLIA) { chainId poolCount totalLiquidity numLiquidityProviders }
            protocolMetricsAggregated(chains: [SEPOLIA]) { poolCount totalLiquidity chains { chainId poolCount } }
            sorGetSwapPaths(chain: SEPOLIA, tokenIn: "${MISSING_POOL}", tokenOut: "0x0000000000000000000000000000000000000002", swapType: EXACT_IN, swapAmount: "1", useProtocolVersion: 3, considerPoolsWithHooks: false) {
                protocolVersion returnAmount swaps { poolId } priceImpact { error }
            }
        }`),
    );

    expect(empty.poolGetPools).toEqual([]);
    expect(empty.poolGetPoolsCount).toBe(0);
    expect(empty.filtered).toEqual([]);
    expect(empty.poolGetFeaturedPools).toEqual([]);
    expect(empty.poolGetSnapshots).toEqual([]);
    expect(empty.poolEvents).toEqual([]);
    expect(empty.poolEventsOnChain).toEqual([]);
    expect(empty.aggregatorPools).toEqual([]);
    expect(empty.poolGetAggregatorPools).toEqual([]);
    expect(empty.tokenGetTokens).toEqual([]);
    expect(empty.tokenGetCurrentPrices).toEqual([]);
    expect(empty.tokenGetHistoricalPrices).toEqual([]);
    expect(empty.tokenGetTokenDynamicData).toBeNull();
    expect(empty.tokenGetTokensDynamicData).toEqual([]);
    expect(empty.tokenGetRelativePriceChartData).toEqual([]);
    expect(empty.protocolMetricsChain.chainId).toBe('11155111');
    expect(Number(empty.protocolMetricsChain.poolCount)).toBe(0);
    expect(Number(empty.protocolMetricsAggregated.poolCount)).toBe(0);
    expect(empty.protocolMetricsAggregated.chains).toHaveLength(1);
    expect(empty.sorGetSwapPaths.protocolVersion).toBe(3);
    expect(empty.sorGetSwapPaths.returnAmount).toBe('0');
    expect(empty.sorGetSwapPaths.swaps).toEqual([]);
});

it('rejects a bad checksum with BAD_USER_INPUT and accepts a valid one', async () => {
    const variable = await graphql('query ($id: String!) { poolGetPool(id: $id, chain: SEPOLIA) { id } }', {
        variables: { id: BAD_CHECKSUM },
    });
    expectRejectedAddress(variable);

    const inline = await graphql(`query { poolGetPool(id: "${BAD_CHECKSUM}", chain: SEPOLIA) { id } }`);
    expectRejectedAddress(inline);

    const valid = await graphql('query ($id: String!) { poolGetPool(id: $id, chain: SEPOLIA) { id } }', {
        variables: { id: VALID_CHECKSUM },
    });
    expect(valid.status).toBe(200);
    expect(valid.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');

    // The API no longer reads AccountAddress, so a bad value must not fail the request.
    const ignoredHeader = data(
        await graphql<{ poolGetPoolsCount: number }>('{ poolGetPoolsCount }', {
            headers: { AccountAddress: BAD_CHECKSUM },
        }),
    );
    expect(ignoredHeader.poolGetPoolsCount).toBe(0);

    const syntax = await graphql('{ poolGetPoolsCount ');
    expect(syntax.status).toBe(400);
    expect(syntax.body.errors?.[0]?.extensions?.code).toBe('GRAPHQL_PARSE_FAILED');

    expect(await db().prismaPool.count()).toBe(0);
});

it('syncs every Sepolia pool from the subgraph', async () => {
    const synced = data(
        await graphql<{ poolSyncAllPoolsFromSubgraph: string[] }>(
            'mutation { poolSyncAllPoolsFromSubgraph(chain: SEPOLIA) }',
            { admin: true },
        ),
    );

    syncedIds = synced.poolSyncAllPoolsFromSubgraph;
    expect(syncedIds.length).toBeGreaterThan(0);
    expect(new Set(syncedIds).size).toBe(syncedIds.length);
    for (const id of syncedIds) expect(id).toMatch(LOWER_ADDRESS);

    const count = await db().prismaPool.count({ where: { chain: 'SEPOLIA' } });
    expect(count).toBe(syncedIds.length);

    const cursor = await db().prismaLastBlockSynced.findUnique({
        where: { category_chain: { category: 'ADD_POOLS_V3', chain: 'SEPOLIA' } },
    });
    expect(cursor?.blockNumber).toBeGreaterThan(0);
});

it('stores lowercase v3 pools, tokens, and reviews for chains this API knows', async () => {
    const pools = await db().prismaPool.findMany({
        where: { chain: 'SEPOLIA' },
        select: {
            id: true,
            address: true,
            type: true,
            protocolVersion: true,
            hook: true,
            swapFeeManager: true,
            factory: true,
            pauseManager: true,
            poolCreator: true,
        },
    });

    expect(pools).toHaveLength(syncedIds.length);
    for (const pool of pools) {
        expect(pool.id).toBe(pool.address);
        expect(pool.id).toMatch(LOWER_ADDRESS);
        expect(pool.protocolVersion).toBe(3);
        expect(POOL_TYPES).toContain(pool.type);
        expect(pool.swapFeeManager).toMatch(LOWER_ADDRESS);
        if (pool.factory) expect(pool.factory).toMatch(LOWER_ADDRESS);
        if (pool.pauseManager) expect(pool.pauseManager).toMatch(LOWER_ADDRESS);
        if (pool.poolCreator) expect(pool.poolCreator).toMatch(LOWER_ADDRESS);
        if (pool.hook && typeof pool.hook === 'object' && !Array.isArray(pool.hook)) {
            const hook = pool.hook as { address?: string; type?: string };
            expect(hook.type).toBe('UNKNOWN');
            expect(hook.address).toMatch(LOWER_ADDRESS);
        }
    }
    expect(await db().prismaPool.count({ where: { chain: { not: 'SEPOLIA' } } })).toBe(0);

    const tokens = await db().prismaToken.findMany({
        where: { chain: 'SEPOLIA' },
        select: { address: true },
    });
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) expect(token.address).toMatch(LOWER_ADDRESS);

    const reviews = await db().prismaPriceRateProviderData.findMany({ select: { chain: true } });
    const chains = new Set(reviews.map((review) => review.chain));
    expect(reviews.length).toBeGreaterThan(0);
    expect([...chains].every((chain) => chain === 'SEPOLIA' || chain === 'MAINNET')).toBe(true);
    expect(chains.has('SEPOLIA')).toBe(true);
});

it('reads the known pools and the public list', async () => {
    for (const known of KNOWN_POOLS) {
        const result = data(
            await graphql<{
                poolGetPool: {
                    __typename: string;
                    id: string;
                    address: string;
                    chain: string;
                    protocolVersion: number;
                    type: string;
                    poolTokens: { address: string }[];
                    hook: { address: string; type: string } | null;
                };
            }>(`query ($id: String!) { poolGetPool(id: $id, chain: SEPOLIA) { ${POOL_FIELDS} } }`, {
                variables: { id: known.id },
            }),
        );
        const pool = result.poolGetPool;
        expect(pool.id).toBe(known.id);
        expect(pool.address).toBe(known.id);
        expect(pool.chain).toBe('SEPOLIA');
        expect(pool.protocolVersion).toBe(3);
        expect(pool.type).toBe(known.type);
        expect(pool.__typename).toBe(known.typename);
        expect(pool.poolTokens.length).toBeGreaterThanOrEqual(2);
        for (const token of pool.poolTokens) expect(token.address).toMatch(LOWER_ADDRESS);
        if (pool.hook) {
            expect(pool.hook.type).toBe('UNKNOWN');
            expect(pool.hook.address).toMatch(LOWER_ADDRESS);
        }
        expect(syncedIds).toContain(known.id);
    }

    const weighted = data(
        await graphql<{
            poolGetPool: { id: string; poolTokens: { address: string }[] };
        }>(`query { poolGetPool(id: "${quotePoolId}", chain: SEPOLIA) { id poolTokens { address } } }`),
    );
    const tokens = weighted.poolGetPool.poolTokens
        .map((token) => token.address)
        .filter((address) => address !== quotePoolId);
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    quoteTokenIn = tokens[0];
    quoteTokenOut = tokens[1];

    const checksum = getAddress(quotePoolId);
    const byChecksum = data(
        await graphql<{ poolGetPool: { id: string } }>(
            `query { poolGetPool(id: "${checksum}", chain: SEPOLIA) { id } }`,
        ),
    );
    expect(byChecksum.poolGetPool.id).toBe(quotePoolId);

    const list = data(
        await graphql<{
            poolGetPools: { id: string; address: string; chain: string; protocolVersion: number; type: string }[];
            poolGetPoolsCount: number;
        }>(`
            {
                poolGetPools(
                    where: { chainIn: [SEPOLIA], protocolVersionIn: [3] }
                    orderBy: totalLiquidity
                    orderDirection: desc
                ) {
                    id
                    address
                    chain
                    protocolVersion
                    type
                }
                poolGetPoolsCount(where: { chainIn: [SEPOLIA], protocolVersionIn: [3] })
            }
        `),
    );
    expect(list.poolGetPools.length).toBeGreaterThan(0);
    expect(list.poolGetPoolsCount).toBe(list.poolGetPools.length);
    for (const pool of list.poolGetPools) {
        expect(syncedIds).toContain(pool.id);
        expect(pool.address).toBe(pool.id);
        expect(pool.chain).toBe('SEPOLIA');
        expect(pool.protocolVersion).toBe(3);
        expect(POOL_TYPES).toContain(pool.type);
    }

    const listedId = list.poolGetPools[0].id;
    const page = data(
        await graphql<{ poolGetPools: { id: string }[] }>(
            'query { poolGetPools(first: 1, where: { chainIn: [SEPOLIA], protocolVersionIn: [3] }, orderBy: totalShares, orderDirection: desc) { id } }',
        ),
    );
    expect(page.poolGetPools).toHaveLength(1);
    if (list.poolGetPoolsCount > 1) {
        const next = data(
            await graphql<{ poolGetPools: { id: string }[] }>(
                'query { poolGetPools(first: 1, skip: 1, where: { chainIn: [SEPOLIA], protocolVersionIn: [3] }, orderBy: totalShares, orderDirection: desc) { id } }',
            ),
        );
        expect(next.poolGetPools[0].id).not.toBe(page.poolGetPools[0].id);
    }

    const searched = data(
        await graphql<{ poolGetPools: { id: string }[]; poolGetPoolsCount: number }>(
            `
                query ($id: String!) {
                    poolGetPools(textSearch: $id, where: { chainIn: [SEPOLIA] }) {
                        id
                    }
                    poolGetPoolsCount(textSearch: $id, where: { chainIn: [SEPOLIA] })
                }
            `,
            { variables: { id: getAddress(listedId) } },
        ),
    );
    expect(searched.poolGetPools.map((pool) => pool.id)).toContain(listedId);
    expect(searched.poolGetPoolsCount).toBe(searched.poolGetPools.length);

    const weightedOnly = data(
        await graphql<{ poolGetPools: { type: string }[] }>(
            'query { poolGetPools(where: { chainIn: [SEPOLIA], poolTypeIn: [WEIGHTED], poolTypeNotIn: [STABLE] }) { type } }',
        ),
    );
    expect(weightedOnly.poolGetPools.length).toBeGreaterThan(0);
    expect(weightedOnly.poolGetPools.every((pool) => pool.type === 'WEIGHTED')).toBe(true);

    const excluded = data(
        await graphql<{ poolGetPools: { id: string }[] }>(
            'query ($id: String!) { poolGetPools(where: { chainIn: [SEPOLIA], idIn: [$id], idNotIn: [$id] }) { id } }',
            { variables: { id: listedId } },
        ),
    );
    expect(excluded.poolGetPools).toEqual([]);

    const included = data(
        await graphql<{ poolGetPools: { id: string }[] }>(
            'query ($id: String!) { poolGetPools(where: { chainIn: [SEPOLIA], idIn: [$id] }) { id } }',
            { variables: { id: getAddress(listedId) } },
        ),
    );
    expect(included.poolGetPools.map((pool) => pool.id)).toEqual([listedId]);

    const tokenFilter = data(
        await graphql<{ poolGetPools: { id: string }[] }>(
            'query ($token: String!) { poolGetPools(where: { chainIn: [SEPOLIA], tokensIn: [$token] }) { id } }',
            { variables: { token: getAddress(quoteTokenIn) } },
        ),
    );
    expect(tokenFilter.poolGetPools.map((pool) => pool.id)).toContain(quotePoolId);

    const otherFilters = data(
        await graphql<{
            unhooked: unknown[];
            tagged: unknown[];
            priced: unknown[];
            otherChain: { id: string }[];
            aggregators: { id: string; chain: string; protocolVersion: number; type: string; address: string }[];
            legacyAggregators: { id: string }[];
        }>(
            `
                query ($id: String!) {
                    unhooked: poolGetPools(where: { chainIn: [SEPOLIA], hasHook: false }) {
                        id
                    }
                    tagged: poolGetPools(where: { chainIn: [SEPOLIA], tagIn: ["incentivized"], reviewedOnly: false }) {
                        id
                    }
                    priced: poolGetPools(where: { chainIn: [SEPOLIA], minTvl: 0 }) {
                        id
                    }
                    otherChain: poolGetPools(where: { chainIn: [SEPOLIA], chainNotIn: [MAINNET] }) {
                        id
                    }
                    aggregators: aggregatorPools(
                        where: {
                            chainIn: [SEPOLIA]
                            protocolVersionIn: [3]
                            poolTypeIn: [WEIGHTED, STABLE, ECLP]
                            idIn: [$id]
                            minTvl: 0
                        }
                    ) {
                        id
                        chain
                        protocolVersion
                        type
                        address
                    }
                    legacyAggregators: poolGetAggregatorPools(where: { chainIn: [SEPOLIA], protocolVersionIn: [3] }) {
                        id
                    }
                }
            `,
            { variables: { id: quotePoolId } },
        ),
    );
    expect(otherFilters.unhooked.length).toBeGreaterThan(0);
    expect(Array.isArray(otherFilters.tagged)).toBe(true);
    expect(Array.isArray(otherFilters.priced)).toBe(true);
    expect(otherFilters.otherChain.map((pool) => pool.id)).toEqual(expect.arrayContaining([quotePoolId]));
    for (const pool of otherFilters.aggregators) {
        expect(pool.chain).toBe('SEPOLIA');
        expect(pool.protocolVersion).toBe(3);
        expect(pool.address).toMatch(LOWER_ADDRESS);
        expect(POOL_TYPES).toContain(pool.type);
    }
    expect(otherFilters.legacyAggregators.length).toBeGreaterThan(0);

    const tokensOnChain = data(
        await graphql<{ tokenGetTokens: { address: string; decimals: number; chainId: number; symbol: string }[] }>(
            'query ($token: String!) { tokenGetTokens(chains: [SEPOLIA], where: { tokensIn: [$token] }) { address symbol decimals chainId name } }',
            { variables: { token: quoteTokenIn } },
        ),
    );
    const quotedToken = tokensOnChain.tokenGetTokens.find((token) => token.address === quoteTokenIn);
    expect(quotedToken?.chainId).toBe(11155111);
    expect(quotedToken?.decimals).toBeGreaterThan(0);

    const allTokens = data(
        await graphql<{ tokenGetTokens: { address: string }[] }>('{ tokenGetTokens(chains: [SEPOLIA]) { address } }'),
    );
    expect(allTokens.tokenGetTokens.length).toBeGreaterThan(1);

    const surrounding = data(
        await graphql<{
            poolGetFeaturedPools: unknown[];
            poolGetSnapshots: unknown[];
            poolEvents: unknown[];
            protocolMetricsChain: { chainId: string; poolCount: string };
            protocolMetricsAggregated: { poolCount: string; chains: { poolCount: string }[] };
        }>(
            `
                query ($id: String!) {
                    poolGetFeaturedPools(chains: [SEPOLIA]) {
                        poolId
                        primary
                        description
                        pool {
                            id
                            protocolVersion
                        }
                    }
                    poolGetSnapshots(id: $id, chain: SEPOLIA, range: THIRTY_DAYS) {
                        id
                        poolId
                        timestamp
                        totalLiquidity
                        amounts
                    }
                    poolEvents(first: 5, skip: 0, where: { chainIn: [SEPOLIA], poolId: $id, type: SWAP }) {
                        id
                        chain
                        type
                        poolId
                    }
                    protocolMetricsChain(chain: SEPOLIA) {
                        chainId
                        poolCount
                        totalLiquidity
                        swapFee24h
                        swapVolume24h
                        surplus24h
                        yieldCapture24h
                        numLiquidityProviders
                    }
                    protocolMetricsAggregated(chains: [SEPOLIA]) {
                        poolCount
                        totalLiquidity
                        chains {
                            chainId
                            poolCount
                        }
                    }
                }
            `,
            { variables: { id: quotePoolId } },
        ),
    );
    expect(surrounding.poolGetFeaturedPools).toEqual([]);
    expect(surrounding.poolGetSnapshots).toEqual([]);
    expect(surrounding.poolEvents).toEqual([]);
    expect(surrounding.protocolMetricsChain.chainId).toBe('11155111');
    // The empty read above cached this chain for 30 minutes. The cache mutation refreshes it.
    expect(Number(surrounding.protocolMetricsChain.poolCount)).toBe(0);
    expect(Number(surrounding.protocolMetricsAggregated.poolCount)).toBe(0);
});

it('returns not found for an unknown pool', async () => {
    const missing = await graphql('query ($id: String!) { poolGetPool(id: $id, chain: SEPOLIA) { id } }', {
        variables: { id: MISSING_POOL },
    });
    expect(missing.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
    expect(missing.body.errors?.[0]?.message).toMatch(/does not exist/i);
});

it('reports a chain that has no config and does not write its pools', async () => {
    const before = await db().prismaPool.count();
    const sync = await graphql('mutation { poolSyncAllPoolsFromSubgraph(chain: BASE) }', { admin: true });
    expect(sync.body.errors?.[0]?.message).toMatch(/chain not configured/i);
    expect(await db().prismaPool.count()).toBe(before);

    const reloaded = data(
        await graphql<{
            poolReloadPools: { type: string; chain: string; success: boolean; error: string | null }[];
        }>('mutation { poolReloadPools(chains: [BASE]) { type chain success error } }', { admin: true }),
    );
    expect(reloaded.poolReloadPools).toEqual([expect.objectContaining({ type: 'v3', chain: 'BASE', success: false })]);
    expect(reloaded.poolReloadPools[0].error).toMatch(/chain not configured/i);

    const onchain = data(
        await graphql<{
            poolLoadOnChainDataForAllPools: { chain: string; success: boolean; error: string | null }[];
        }>('mutation { poolLoadOnChainDataForAllPools(chains: [BASE]) { type chain success error } }', { admin: true }),
    );
    expect(onchain.poolLoadOnChainDataForAllPools[0].chain).toBe('BASE');
    expect(onchain.poolLoadOnChainDataForAllPools[0].success).toBe(false);
    expect(onchain.poolLoadOnChainDataForAllPools[0].error).toMatch(/chain not configured/i);
    expect(await db().prismaPool.count({ where: { chain: 'BASE' } })).toBe(0);
    expect(await db().prismaPool.count()).toBe(before);
});

it('initializes wallet balances and reads them back', async () => {
    const init = data(
        await graphql<{ userInitWalletBalancesForAllPools: string }>(
            'mutation { userInitWalletBalancesForAllPools(chain: SEPOLIA) }',
            { admin: true },
        ),
    );
    expect(init.userInitWalletBalancesForAllPools).toBe('success');

    const again = data(
        await graphql<{ userSyncChangedWalletBalancesForAllPools: string }>(
            'mutation { userSyncChangedWalletBalancesForAllPools(chain: SEPOLIA) }',
            { admin: true },
        ),
    );
    expect(again.userSyncChangedWalletBalancesForAllPools).toBe('success');

    const cursor = await db().prismaLastBlockSynced.findUnique({
        where: { category_chain: { category: 'BPT_BALANCES_V3', chain: 'SEPOLIA' } },
    });
    expect(cursor?.blockNumber).toBeGreaterThan(0);

    const balance = await db().prismaUserWalletBalance.findFirst({
        where: { chain: 'SEPOLIA', balanceNum: { gt: 0 }, poolId: { not: null } },
        select: { userAddress: true, poolId: true },
    });
    expect(balance?.poolId).toBeTruthy();
    expect(balance?.userAddress).toMatch(LOWER_ADDRESS);

    const pool = data(
        await graphql<{
            poolGetPool: {
                id: string;
                userBalance: { walletBalance: string; totalBalance: string; totalBalanceUsd: number } | null;
            };
            poolGetPools: { id: string }[];
        }>(
            `
                query ($id: String!, $user: String!) {
                    poolGetPool(id: $id, chain: SEPOLIA, userAddress: $user) {
                        id
                        userBalance {
                            walletBalance
                            totalBalance
                            walletBalanceUsd
                            totalBalanceUsd
                        }
                    }
                    poolGetPools(where: { chainIn: [SEPOLIA], userAddress: $user }) {
                        id
                    }
                }
            `,
            { variables: { id: getAddress(balance!.poolId!), user: getAddress(balance!.userAddress) } },
        ),
    );
    expect(pool.poolGetPool.userBalance).not.toBeNull();
    expect(Number(pool.poolGetPool.userBalance?.walletBalance)).toBeGreaterThan(0);
    expect(pool.poolGetPools.map((item) => item.id)).toContain(balance!.poolId);
});

it('syncs token content through the worker, reloads types, and deletes one type', async () => {
    await runJob('sync-token-content-data');

    const reloaded = data(
        await graphql<{ tokenReloadAllTokenTypes: string }>('mutation { tokenReloadAllTokenTypes(chain: SEPOLIA) }', {
            admin: true,
        }),
    );
    expect(reloaded.tokenReloadAllTokenTypes).toBe('success');

    let tokenType = await db().prismaTokenType.findFirst({ where: { chain: 'SEPOLIA' } });
    if (!tokenType) {
        const address = '0x00000000000000000000000000000000000000e2';
        await db().prismaToken.create({
            data: { address, chain: 'SEPOLIA', name: 'E2E', symbol: 'E2E', decimals: 18 },
        });
        tokenType = await db().prismaTokenType.create({
            data: { id: `${address}-white-listed`, tokenAddress: address, type: 'WHITE_LISTED', chain: 'SEPOLIA' },
        });
    }

    const before = await db().prismaTokenType.count({ where: { chain: 'SEPOLIA' } });
    const deleted = data(
        await graphql<{ tokenDeleteTokenType: string }>(
            'mutation ($tokenAddress: String!, $type: GqlTokenType!) { tokenDeleteTokenType(tokenAddress: $tokenAddress, type: $type, chain: SEPOLIA) }',
            { admin: true, variables: { tokenAddress: getAddress(tokenType.tokenAddress), type: tokenType.type } },
        ),
    );
    expect(deleted.tokenDeleteTokenType).toBe('success');
    expect(await db().prismaTokenType.count({ where: { chain: 'SEPOLIA' } })).toBe(before - 1);

    const second = await graphql(
        'mutation ($tokenAddress: String!, $type: GqlTokenType!) { tokenDeleteTokenType(tokenAddress: $tokenAddress, type: $type, chain: SEPOLIA) }',
        { admin: true, variables: { tokenAddress: tokenType.tokenAddress, type: tokenType.type } },
    );
    expect(second.body.errors?.length).toBeGreaterThan(0);
});

it('reloads erc4626 data for Sepolia and returns a result for an unconfigured chain', async () => {
    const base = data(
        await graphql<{
            tokenReloadErc4626Tokens: { chain: string; success: boolean; error: string | null }[];
        }>('mutation { tokenReloadErc4626Tokens(chains: [BASE]) { chain success error } }', { admin: true }),
    );
    expect(base.tokenReloadErc4626Tokens[0].chain).toBe('BASE');
    expect(typeof base.tokenReloadErc4626Tokens[0].success).toBe('boolean');

    const sepolia = data(
        await graphql<{
            tokenReloadErc4626Tokens: { chain: string; success: boolean; error: string | null }[];
        }>('mutation { tokenReloadErc4626Tokens(chains: [SEPOLIA]) { chain success error } }', { admin: true }),
    );
    expect(sepolia.tokenReloadErc4626Tokens).toEqual([{ chain: 'SEPOLIA', success: true, error: null }]);
});

it('reloads swaps and then returns those events', async () => {
    const reloaded = data(
        await graphql<{ poolReloadSwaps: string }>(
            'mutation ($poolId: String!) { poolReloadSwaps(chain: SEPOLIA, poolId: $poolId) }',
            { admin: true, variables: { poolId: quotePoolId } },
        ),
    );
    expect(reloaded.poolReloadSwaps).toBe('success');

    const cursor = await db().prismaLastBlockSynced.findUnique({
        where: { category_chain: { category: 'SWAPS_V3', chain: 'SEPOLIA' } },
    });
    expect(cursor?.blockNumber).toBeGreaterThan(0);
    expect(await db().prismaPoolEvent.count({ where: { chain: 'SEPOLIA', type: 'SWAP' } })).toBeGreaterThan(0);

    const events = data(
        await graphql<{
            poolEvents: {
                __typename: string;
                id: string;
                chain: string;
                type: string;
                poolId: string;
                tx: string;
                userAddress: string;
                tokenIn?: { address: string; amount: string };
                tokenOut?: { address: string; amount: string };
                tokens?: { address: string; amount: string }[];
            }[];
        }>(
            `
                query ($poolId: String!) {
                    poolEvents(first: 20, where: { chainIn: [SEPOLIA], poolId: $poolId }) {
                        __typename
                        id
                        chain
                        type
                        poolId
                        tx
                        userAddress
                        ... on GqlPoolSwapEventV3 {
                            tokenIn {
                                address
                                amount
                            }
                            tokenOut {
                                address
                                amount
                            }
                        }
                        ... on GqlPoolAddRemoveEventV3 {
                            tokens {
                                address
                                amount
                            }
                        }
                    }
                }
            `,
            { variables: { poolId: getAddress(quotePoolId) } },
        ),
    );

    const anyEvents = data(
        await graphql<{ poolEvents: { type: string; poolId: string; userAddress: string }[] }>(`
            {
                poolEvents(first: 10, where: { chainIn: [SEPOLIA], type: SWAP }) {
                    id
                    type
                    poolId
                    userAddress
                    tx
                }
            }
        `),
    );
    expect(anyEvents.poolEvents.length).toBeGreaterThan(0);
    for (const event of anyEvents.poolEvents) {
        expect(event.type).toBe('SWAP');
        expect(event.poolId).toMatch(LOWER_ADDRESS);
        expect(event.userAddress).toMatch(LOWER_ADDRESS);
        expect(syncedIds).toContain(event.poolId);
    }

    if (events.poolEvents.length > 0) {
        for (const event of events.poolEvents) {
            expect(event.poolId).toBe(quotePoolId);
            expect(event.chain).toBe('SEPOLIA');
            expect(event.tx).toMatch(/^0x[a-f0-9]{64}$/);
            if (event.__typename === 'GqlPoolSwapEventV3') {
                expect(event.tokenIn?.address).toMatch(LOWER_ADDRESS);
                expect(event.tokenOut?.address).toMatch(LOWER_ADDRESS);
            }
        }
    }
});

it('updates prices through the worker, then reloads liquidity, snapshots, and aprs', async () => {
    await runJob('update-token-prices');

    const current = data(
        await graphql<{
            tokenGetCurrentPrices: { address: string; chain: string; price: number }[];
            tokenGetHistoricalPrices: { address: string; chain: string; prices: { price: number }[] }[];
            tokenGetRelativePriceChartData: { price: string }[];
            tokenGetTokenDynamicData: { tokenAddress: string; price: number } | null;
            tokenGetTokensDynamicData: { tokenAddress: string; price: number }[];
        }>(
            `
                query ($tokenIn: String!, $tokenOut: String!) {
                    tokenGetCurrentPrices(chains: [SEPOLIA]) {
                        address
                        chain
                        price
                        updatedAt
                        updatedBy
                    }
                    tokenGetHistoricalPrices(addresses: [$tokenIn, $tokenOut], chain: SEPOLIA, range: ALL) {
                        address
                        chain
                        prices {
                            timestamp
                            price
                        }
                    }
                    tokenGetRelativePriceChartData(tokenIn: $tokenIn, tokenOut: $tokenOut, range: ALL, chain: SEPOLIA) {
                        id
                        timestamp
                        price
                    }
                    tokenGetTokenDynamicData(address: $tokenIn, chain: SEPOLIA) {
                        tokenAddress
                        price
                        updatedAt
                    }
                    tokenGetTokensDynamicData(addresses: [$tokenIn, $tokenOut], chain: SEPOLIA) {
                        tokenAddress
                        price
                    }
                }
            `,
            { variables: { tokenIn: quoteTokenIn, tokenOut: quoteTokenOut } },
        ),
    );
    expect(Array.isArray(current.tokenGetCurrentPrices)).toBe(true);
    for (const price of current.tokenGetCurrentPrices) {
        expect(price.address).toMatch(LOWER_ADDRESS);
        expect(price.chain).toBe('SEPOLIA');
        expect(Number.isFinite(price.price)).toBe(true);
    }
    expect(Array.isArray(current.tokenGetHistoricalPrices)).toBe(true);
    expect(Array.isArray(current.tokenGetRelativePriceChartData)).toBe(true);
    expect(Array.isArray(current.tokenGetTokensDynamicData)).toBe(true);
    if (current.tokenGetTokenDynamicData) {
        expect(current.tokenGetTokenDynamicData.tokenAddress).toBe(quoteTokenIn);
        expect(Number.isFinite(current.tokenGetTokenDynamicData.price)).toBe(true);
    }

    const liquidity = data(
        await graphql<{ poolUpdateLiquidityValuesForAllPools: string }>(
            'mutation { poolUpdateLiquidityValuesForAllPools(chain: SEPOLIA) }',
            { admin: true },
        ),
    );
    expect(liquidity.poolUpdateLiquidityValuesForAllPools).toBe('success');

    const snapshots = data(
        await graphql<{ poolLoadSnapshotsForPools: string }>(
            'mutation ($poolId: String!) { poolLoadSnapshotsForPools(poolId: $poolId, chain: SEPOLIA) }',
            { admin: true, variables: { poolId: quotePoolId } },
        ),
    );
    expect(snapshots.poolLoadSnapshotsForPools).toBe('success');

    const snapshotRows = data(
        await graphql<{ poolGetSnapshots: { poolId: string; timestamp: number; amounts: string[] }[] }>(
            `
                query ($id: String!) {
                    poolGetSnapshots(id: $id, chain: SEPOLIA, range: ALL_TIME) {
                        id
                        poolId
                        chain
                        timestamp
                        totalLiquidity
                        sharePrice
                        volume24h
                        fees24h
                        surplus24h
                        totalShares
                        swapsCount
                        amounts
                    }
                }
            `,
            { variables: { id: getAddress(quotePoolId) } },
        ),
    );
    expect(Array.isArray(snapshotRows.poolGetSnapshots)).toBe(true);
    for (const snapshot of snapshotRows.poolGetSnapshots) {
        expect(snapshot.poolId).toBe(quotePoolId);
        expect(snapshot.timestamp).toBeGreaterThan(0);
        expect(Array.isArray(snapshot.amounts)).toBe(true);
    }

    const aprs = data(
        await graphql<{ poolReloadAllPoolAprs: string }>('mutation { poolReloadAllPoolAprs(chain: SEPOLIA) }', {
            admin: true,
        }),
    );
    expect(aprs.poolReloadAllPoolAprs).toBe('success');
});

it('runs the remaining global jobs through the worker', async () => {
    for (const name of [
        'sync-rate-provider-reviews',
        'sync-erc4626-data',
        'sync-categories',
        'fetch-token-yields',
        'sync-token-tvl',
        'global-purge-old-tokenprices',
    ]) {
        await runJob(name);
    }

    expect(await db().prismaPriceRateProviderData.count({ where: { chain: 'SEPOLIA' } })).toBeGreaterThan(0);
    const erc4626Reviews = await db().prismaErc4626ReviewData.findMany({ select: { chain: true } });
    expect(erc4626Reviews.length).toBeGreaterThan(0);
    expect(erc4626Reviews.every((review) => review.chain === 'SEPOLIA' || review.chain === 'MAINNET')).toBe(true);

    expect((await postJob({ name: 'not-a-job', chain: SEPOLIA_CHAIN_ID })).status).toBe(400);
});

it('caches protocol metrics', async () => {
    const cached = data(
        await graphql<{ protocolCacheMetrics: string }>('mutation { protocolCacheMetrics(chain: SEPOLIA) }', {
            admin: true,
        }),
    );
    expect(cached.protocolCacheMetrics).toBe('success');

    const metrics = data(
        await graphql<{
            protocolMetricsChain: { chainId: string; poolCount: string; totalLiquidity: string };
            protocolMetricsAggregated: { poolCount: string; chains: { chainId: string; poolCount: string }[] };
        }>(`
            {
                protocolMetricsChain(chain: SEPOLIA) {
                    chainId
                    poolCount
                    totalLiquidity
                    swapVolume24h
                    swapFee24h
                    numLiquidityProviders
                }
                protocolMetricsAggregated(chains: [SEPOLIA]) {
                    poolCount
                    totalLiquidity
                    swapVolume24h
                    chains {
                        chainId
                        poolCount
                        totalLiquidity
                    }
                }
            }
        `),
    );
    expect(metrics.protocolMetricsChain.chainId).toBe('11155111');
    expect(Number(metrics.protocolMetricsChain.poolCount)).toBeGreaterThan(0);
    expect(Number(metrics.protocolMetricsAggregated.poolCount)).toBe(Number(metrics.protocolMetricsChain.poolCount));
    expect(metrics.protocolMetricsAggregated.chains[0].chainId).toBe('11155111');
});

it('reloads on-chain pool state', async () => {
    const result = data(
        await graphql<{
            poolLoadOnChainDataForAllPools: { type: string; chain: string; success: boolean; error: string | null }[];
        }>('mutation { poolLoadOnChainDataForAllPools(chains: [SEPOLIA]) { type chain success error } }', {
            admin: true,
        }),
    );
    expect(result.poolLoadOnChainDataForAllPools).toEqual([
        { type: 'v3', chain: 'SEPOLIA', success: true, error: null },
    ]);

    const cursor = await db().prismaLastBlockSynced.findUnique({
        where: { category_chain: { category: 'POOLS_V3', chain: 'SEPOLIA' } },
    });
    expect(cursor?.blockNumber).toBeGreaterThan(0);
    expect(await db().prismaPool.count({ where: { chain: 'SEPOLIA' } })).toBe(syncedIds.length);
});

it('reloads and syncs again without duplicating pools', async () => {
    const before = await db().prismaPool.count({ where: { chain: 'SEPOLIA' } });

    const reloaded = data(
        await graphql<{
            poolReloadPools: { type: string; chain: string; success: boolean; error: string | null }[];
        }>('mutation { poolReloadPools(chains: [SEPOLIA]) { type chain success error } }', { admin: true }),
    );
    expect(reloaded.poolReloadPools).toEqual([{ type: 'v3', chain: 'SEPOLIA', success: true, error: null }]);

    const synced = data(
        await graphql<{ poolSyncAllPoolsFromSubgraph: string[] }>(
            'mutation { poolSyncAllPoolsFromSubgraph(chain: SEPOLIA) }',
            { admin: true },
        ),
    );
    expect(new Set(synced.poolSyncAllPoolsFromSubgraph)).toEqual(new Set(syncedIds));
    expect(await db().prismaPool.count({ where: { chain: 'SEPOLIA' } })).toBe(before);

    const listed = data(
        await graphql<{ poolGetPoolsCount: number }>(
            '{ poolGetPoolsCount(where: { chainIn: [SEPOLIA], protocolVersionIn: [3] }) }',
        ),
    );
    expect(listed.poolGetPoolsCount).toBeGreaterThan(0);
});

it('quotes an exact-in and an exact-out swap', async () => {
    const quote = `query ($tokenIn: String!, $tokenOut: String!, $poolId: String!, $swapType: GqlSorSwapType!, $hooks: Boolean!, $amount: AmountHumanReadable!) {
        sorGetSwapPaths(
            chain: SEPOLIA
            tokenIn: $tokenIn
            tokenOut: $tokenOut
            swapType: $swapType
            swapAmount: $amount
            useProtocolVersion: 3
            considerPoolsWithHooks: $hooks
            poolIds: [$poolId]
            queryBatchSwap: false
        ) {
            protocolVersion
            tokenIn
            tokenOut
            swapType
            returnAmount
            returnAmountRaw
            swapAmount
            swaps { poolId }
            paths { protocolVersion pools tokens { address decimals } }
            routes { tokenIn tokenOut }
            priceImpact { priceImpact error }
        }
    }`;

    const exactIn = data(
        await graphql<{
            sorGetSwapPaths: {
                protocolVersion: number;
                tokenIn: string;
                tokenOut: string;
                returnAmount: string;
                swaps: { poolId: string }[];
                paths: { pools: string[] }[];
            };
        }>(quote, {
            variables: {
                tokenIn: quoteTokenIn,
                tokenOut: quoteTokenOut,
                poolId: quotePoolId,
                swapType: 'EXACT_IN',
                hooks: false,
                amount: '0.01',
            },
        }),
    );
    expect(exactIn.sorGetSwapPaths.protocolVersion).toBe(3);
    expect(exactIn.sorGetSwapPaths.tokenIn.toLowerCase()).toBe(quoteTokenIn);
    expect(exactIn.sorGetSwapPaths.tokenOut.toLowerCase()).toBe(quoteTokenOut);
    expect(Number(exactIn.sorGetSwapPaths.returnAmount)).toBeGreaterThan(0);
    expect(exactIn.sorGetSwapPaths.swaps.length).toBeGreaterThan(0);
    expect(exactIn.sorGetSwapPaths.paths.some((path) => path.pools.includes(quotePoolId))).toBe(true);

    const exactOut = data(
        await graphql<{ sorGetSwapPaths: { protocolVersion: number; returnAmount: string; swapType: string } }>(quote, {
            variables: {
                tokenIn: quoteTokenIn,
                tokenOut: quoteTokenOut,
                poolId: quotePoolId,
                swapType: 'EXACT_OUT',
                hooks: false,
                amount: '0.000000001',
            },
        }),
    );
    expect(exactOut.sorGetSwapPaths.protocolVersion).toBe(3);
    expect(Number(exactOut.sorGetSwapPaths.returnAmount)).toBeGreaterThan(0);

    const withHooks = data(
        await graphql<{ sorGetSwapPaths: { returnAmount: string; protocolVersion: number } }>(quote, {
            variables: {
                tokenIn: quoteTokenIn,
                tokenOut: quoteTokenOut,
                poolId: quotePoolId,
                swapType: 'EXACT_IN',
                hooks: true,
                amount: '0.01',
            },
        }),
    );
    expect(withHooks.sorGetSwapPaths.protocolVersion).toBe(3);
    expect(Number.isFinite(Number(withHooks.sorGetSwapPaths.returnAmount))).toBe(true);
    expect(serverLogs().includes('[server exit')).toBe(false);
    expect(sorLogs().includes('[sor exit')).toBe(false);
});
