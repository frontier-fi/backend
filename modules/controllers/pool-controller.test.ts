import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockPoolFindMany,
    mockGetLastSyncedBlock,
    mockUpsertLastSyncedBlock,
    mockGetChangedPoolsV3,
    mockSyncPools,
    mockSyncTokenPairs,
    mockGetAllInitializedPools,
    mockAddPoolsV3,
    mockSyncBptBalancesFromSubgraph,
    mockSyncBptBalancesFromRpc,
    mockSyncErc4626Tokens,
    mockBlockedBuffers,
    mockSyncErc4626Reviews,
    mockSyncErc4626OnchainData,
    mockSyncTokenContentData,
    mockSyncCoingeckoIds,
    mockSyncRateProviderReviews,
    mockBootstrapTokenPrices,
    mockUpdateDerivedPrices,
    mockUpdateLiquidityValuesForPools,
    mockUpdateAprs,
    mockSyncTags,
    mockViemClient,
    mockSubgraphLastSyncedBlock,
    pendingResync,
    rpcHead,
    subgraphHead,
} = vi.hoisted(() => {
    const rpcHead = 1_000_000;
    const subgraphHead = rpcHead - 100;
    return {
        mockPoolFindMany: vi.fn(),
        mockGetLastSyncedBlock: vi.fn(),
        mockUpsertLastSyncedBlock: vi.fn(),
        mockGetChangedPoolsV3: vi.fn(),
        mockSyncPools: vi.fn(),
        mockSyncTokenPairs: vi.fn(),
        mockGetAllInitializedPools: vi.fn(),
        mockAddPoolsV3: vi.fn(),
        mockSyncBptBalancesFromSubgraph: vi.fn(),
        mockSyncBptBalancesFromRpc: vi.fn(),
        mockSyncErc4626Tokens: vi.fn(),
        mockBlockedBuffers: vi.fn(),
        mockSyncErc4626Reviews: vi.fn(),
        mockSyncErc4626OnchainData: vi.fn(),
        mockSyncTokenContentData: vi.fn(),
        mockSyncCoingeckoIds: vi.fn(),
        mockSyncRateProviderReviews: vi.fn(),
        mockBootstrapTokenPrices: vi.fn(),
        mockUpdateDerivedPrices: vi.fn(),
        mockUpdateLiquidityValuesForPools: vi.fn(),
        mockUpdateAprs: vi.fn(),
        mockSyncTags: vi.fn(),
        mockViemClient: { getBlockNumber: async () => BigInt(rpcHead) },
        mockSubgraphLastSyncedBlock: vi.fn(async () => subgraphHead),
        // Stands in for the pendingResync column, which outlives a worker restart.
        pendingResync: new Set<string>(),
        rpcHead,
        // Further behind than Base's acceptableSGLag, so syncPoolsV3 takes the RPC path.
        subgraphHead,
    };
});

vi.mock('../../prisma/prisma-client', () => ({
    prisma: {
        prismaPool: { findMany: mockPoolFindMany },
        prismaPoolDynamicData: {
            findMany: async () => [...pendingResync].map((poolId) => ({ poolId })),
            updateMany: async ({
                where,
                data,
            }: {
                where: { poolId: { in: string[] } };
                data: { pendingResync: boolean };
            }) => {
                for (const poolId of where.poolId.in) {
                    if (data.pendingResync) pendingResync.add(poolId);
                    else pendingResync.delete(poolId);
                }
            },
        },
        $transaction: (operations: Promise<unknown>[]) => Promise.all(operations),
    },
}));

vi.mock('../actions/last-synced-block', () => ({
    getLastSyncedBlock: mockGetLastSyncedBlock,
    upsertLastSyncedBlock: mockUpsertLastSyncedBlock,
}));

vi.mock('../sources/viem-client', () => ({
    getViemClient: () => mockViemClient,
}));

vi.mock('../sources/subgraphs', () => ({
    getVaultSubgraphClient: () => ({ lastSyncedBlock: mockSubgraphLastSyncedBlock }),
    getPoolsSubgraphClient: () => ({ lastSyncedBlock: mockSubgraphLastSyncedBlock }),
    getV3JoinedSubgraphClient: () => ({ getAllInitializedPools: mockGetAllInitializedPools }),
}));

vi.mock('../sources/logs', () => ({ getChangedPoolsV3: mockGetChangedPoolsV3 }));
vi.mock('../actions/pool/v3/sync-pools', () => ({ syncPools: mockSyncPools }));
vi.mock('../actions/pool/v3/sync-tokenpairs', () => ({ syncTokenPairs: mockSyncTokenPairs }));
vi.mock('../actions/pool/v3/add-pools', () => ({ addPools: mockAddPoolsV3 }));
vi.mock('../actions/pool/update-liquidity', () => ({
    updateLiquidity24hAgo: vi.fn(),
    updateLiquidityValuesForPools: mockUpdateLiquidityValuesForPools,
}));
vi.mock('../user/lib/bpt-balances/helpers/sync-bpt-balances-from-subgraph', () => ({
    syncBptBalancesFromSubgraph: mockSyncBptBalancesFromSubgraph,
}));
vi.mock('../user/lib/bpt-balances/helpers/sync-bpt-balances-from-rpc', () => ({
    syncBptBalancesFromRpc: mockSyncBptBalancesFromRpc,
}));
vi.mock('../actions/token/sync-erc4626-tokens', () => ({ syncErc4626Tokens: mockSyncErc4626Tokens }));
vi.mock('../actions/token/sync-erc4626-onchain-data', () => ({ syncErc4626OnchainData: mockSyncErc4626OnchainData }));
vi.mock('../content/lib/sync-erc4626-blocked-buffers', () => ({ syncBlockedBuffers: mockBlockedBuffers }));
vi.mock('../content/lib/sync-erc4626-reviews', () => ({ syncErc4626Reviews: mockSyncErc4626Reviews }));
vi.mock('../content/lib/sync-rate-provider-reviews', () => ({
    syncRateProviderReviews: mockSyncRateProviderReviews,
}));
vi.mock('../content/lib/sync-token-data', () => ({ syncTokenContentData: mockSyncTokenContentData }));
vi.mock('../token/lib/coingecko-data.service', () => ({
    coingeckoDataService: { syncCoingeckoIds: mockSyncCoingeckoIds },
}));
vi.mock('../content/lib/sync-tags', () => ({ syncTags: mockSyncTags }));
vi.mock('../pricing/pricing-service', () => ({
    PricingService: vi.fn(function () {
        return {
            bootstrapTokenPrices: mockBootstrapTokenPrices,
            updateDerivedPrices: mockUpdateDerivedPrices,
        };
    }),
}));
vi.mock('../aprs', () => ({
    AprService: vi.fn(function () {
        return { updateAprs: mockUpdateAprs };
    }),
}));

import { PoolController } from './pool-controller';

describe('PoolController.syncPoolsV3 on the RPC path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        pendingResync.clear();
        mockSubgraphLastSyncedBlock.mockResolvedValue(subgraphHead);
        mockSyncPools.mockImplementation(async (pools: { id: string }[]) => pools.map((pool) => pool.id));
    });

    it('resyncs every known pool at the RPC head when there is no POOLS_V3 checkpoint', async () => {
        mockGetLastSyncedBlock.mockResolvedValue(1);
        mockPoolFindMany
            .mockResolvedValueOnce([{ id: '0xPOOLA' }, { id: '0xpoolb' }]) // known pools
            .mockResolvedValueOnce([]) // stable pools mid amp ramp
            .mockResolvedValueOnce([{ id: '0xpoola' }, { id: '0xpoolb' }]); // pools to sync

        const ids = await PoolController().syncPoolsV3('BASE');

        expect(mockGetChangedPoolsV3).not.toHaveBeenCalled();
        expect(mockPoolFindMany).toHaveBeenLastCalledWith(
            expect.objectContaining({
                where: { chain: 'BASE', protocolVersion: 3, id: { in: ['0xpoola', '0xpoolb'] } },
            }),
        );
        expect(ids).toEqual(['0xpoola', '0xpoolb']);
        expect(mockUpsertLastSyncedBlock).toHaveBeenCalledWith('BASE', 'POOLS_V3', rpcHead);
    });

    it('scans RPC logs from the checkpoint when one exists', async () => {
        mockGetLastSyncedBlock.mockResolvedValue(rpcHead - 15);
        mockGetChangedPoolsV3.mockResolvedValue(['0xpoola']);
        mockPoolFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: '0xpoola' }]);

        await PoolController().syncPoolsV3('BASE');

        expect(mockGetChangedPoolsV3).toHaveBeenCalledWith(
            expect.any(String),
            expect.anything(),
            BigInt(rpcHead - 15),
            BigInt(rpcHead),
        );
        expect(mockUpsertLastSyncedBlock).toHaveBeenCalledWith('BASE', 'POOLS_V3', rpcHead);
    });

    it('chunks multi-batch RPC log scans into exact inclusive windows without off-by-one widths or gaps', async () => {
        // Monad: rpcMaxBlockRange = 500, acceptableSGLag = 150
        mockSubgraphLastSyncedBlock.mockResolvedValue(rpcHead - 200);
        mockGetLastSyncedBlock.mockResolvedValue(rpcHead - 1000);
        mockGetChangedPoolsV3
            .mockResolvedValueOnce(['0xpoola'])
            .mockResolvedValueOnce(['0xpoolb'])
            .mockResolvedValueOnce(['0xpoola']);
        mockPoolFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: '0xpoola' }, { id: '0xpoolb' }]);

        const ids = await PoolController().syncPoolsV3('MONAD');

        expect(mockGetChangedPoolsV3.mock.calls.map(([, , from, to]) => [from, to])).toEqual([
            [BigInt(rpcHead - 1000), BigInt(rpcHead - 501)],
            [BigInt(rpcHead - 500), BigInt(rpcHead - 1)],
            [BigInt(rpcHead), BigInt(rpcHead)],
        ]);
        expect(ids).toEqual(['0xpoola', '0xpoolb']);
    });

    it('skips getChangedPoolsV3 when checkpoint is already at latestBlock', async () => {
        mockGetLastSyncedBlock.mockResolvedValue(rpcHead);
        mockPoolFindMany.mockResolvedValueOnce([]);

        const ids = await PoolController().syncPoolsV3('BASE');

        expect(mockGetChangedPoolsV3).not.toHaveBeenCalled();
        expect(ids).toEqual([]);
    });

    it('retries pools it could not update on a later run, across a restart, while advancing the checkpoint', async () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        mockGetLastSyncedBlock.mockResolvedValue(rpcHead - 15);

        // Run 1: both pools changed, the read for 0xpoolb fails.
        mockGetChangedPoolsV3.mockResolvedValueOnce(['0xpoola', '0xpoolb']);
        mockPoolFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: '0xpoola' }, { id: '0xpoolb' }]);
        mockSyncPools.mockResolvedValueOnce(['0xpoola']);

        expect(await PoolController().syncPoolsV3('BASE')).toEqual(['0xpoola']);
        expect(mockSyncPools).toHaveBeenLastCalledWith(
            expect.anything(),
            'BASE',
            expect.any(String),
            expect.anything(),
            rpcHead,
        );
        expect(mockSyncTokenPairs).toHaveBeenLastCalledWith(['0xpoola'], expect.anything(), expect.any(String), 'BASE');
        expect(mockUpsertLastSyncedBlock).toHaveBeenLastCalledWith('BASE', 'POOLS_V3', rpcHead);
        expect([...pendingResync]).toEqual(['0xpoolb']);

        // The worker restarts: module state is gone, the database is not.
        vi.resetModules();
        const { PoolController: RestartedPoolController } = await import('./pool-controller');

        // Run 2: nothing changed on chain, 0xpoolb is retried and succeeds.
        mockGetChangedPoolsV3.mockResolvedValueOnce([]);
        mockPoolFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: '0xpoolb' }]);

        expect(await RestartedPoolController().syncPoolsV3('BASE')).toEqual(['0xpoolb']);
        expect(mockSyncPools).toHaveBeenLastCalledWith(
            expect.anything(),
            'BASE',
            expect.any(String),
            expect.anything(),
            rpcHead,
        );
        expect([...pendingResync]).toEqual([]);
        expect(mockPoolFindMany).toHaveBeenLastCalledWith(
            expect.objectContaining({ where: { chain: 'BASE', protocolVersion: 3, id: { in: ['0xpoolb'] } } }),
        );

        // Run 3: nothing changed and nothing left to retry.
        mockGetChangedPoolsV3.mockResolvedValueOnce([]);
        mockPoolFindMany.mockResolvedValueOnce([]);
        mockSyncPools.mockClear();

        expect(await PoolController().syncPoolsV3('BASE')).toEqual([]);
        expect(mockSyncPools).not.toHaveBeenCalled();
        stderr.mockRestore();
        stdout.mockRestore();
    });
});

describe('logPoolSyncSourceChange', () => {
    it('logs at debug level only when the pool sync source changes for a chain', async () => {
        // A fresh module, so the syncPoolsV3 runs above have not recorded a source yet.
        const previousLogLevel = process.env.LOG_LEVEL;
        const previousDebug = process.env.DEBUG;
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        try {
            process.env.LOG_LEVEL = 'info';
            delete process.env.DEBUG;
            vi.resetModules();
            const { env } = await import('../../apps/env');
            const { logPoolSyncSourceChange } = await import('./pool-controller');

            // Suppressed by default in production when LOG_LEVEL is info.
            logPoolSyncSourceChange('MAINNET', 'rpc', { lag: 75, acceptableSGLag: 30 });
            expect(stdout).not.toHaveBeenCalled();

            env.LOG_LEVEL = 'debug';
            process.env.LOG_LEVEL = 'debug';
            logPoolSyncSourceChange('BASE', 'rpc', { lag: 75, acceptableSGLag: 30 });
            logPoolSyncSourceChange('BASE', 'rpc', { lag: 80, acceptableSGLag: 30 });
            logPoolSyncSourceChange('SEPOLIA', 'subgraph', { lag: 2, acceptableSGLag: 100 });
            logPoolSyncSourceChange('BASE', 'subgraph', { lag: 20, acceptableSGLag: 30 });

            expect(stdout.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
                {
                    level: 'debug',
                    message: 'Pool sync source changed',
                    event: 'pool-sync-source',
                    chain: 'BASE',
                    source: 'rpc',
                    lag: 75,
                    acceptableSGLag: 30,
                },
                {
                    level: 'debug',
                    message: 'Pool sync source changed',
                    event: 'pool-sync-source',
                    chain: 'SEPOLIA',
                    source: 'subgraph',
                    lag: 2,
                    acceptableSGLag: 100,
                },
                {
                    level: 'debug',
                    message: 'Pool sync source changed',
                    event: 'pool-sync-source',
                    chain: 'BASE',
                    source: 'subgraph',
                    lag: 20,
                    acceptableSGLag: 30,
                },
            ]);
        } finally {
            if (previousLogLevel === undefined) {
                delete process.env.LOG_LEVEL;
            } else {
                process.env.LOG_LEVEL = previousLogLevel;
            }
            if (previousDebug === undefined) {
                delete process.env.DEBUG;
            } else {
                process.env.DEBUG = previousDebug;
            }
            stdout.mockRestore();
        }
    });
});

describe('logPoolPendingResyncChange', () => {
    it('logs warn JSON on changes and 3m reminders while stuck, caps listed IDs, and logs info JSON once on recovery', async () => {
        vi.resetModules();
        const { logPoolPendingResyncChange, PENDING_RESYNC_REMINDER_MS } = await import('./pool-controller');
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        // Healthy initial state stays silent.
        logPoolPendingResyncChange('BASE', [], 0);
        // Set enters pendingResync -> logs immediately.
        logPoolPendingResyncChange('BASE', ['0xpoolb', '0xpoola'], 1_000);
        // Unchanged set before reminder interval -> stays silent.
        logPoolPendingResyncChange('BASE', ['0xpoola', '0xpoolb'], 31_000);
        // Unchanged set at reminder interval -> re-emits warn reminder.
        logPoolPendingResyncChange('BASE', ['0xpoola', '0xpoolb'], 1_000 + PENDING_RESYNC_REMINDER_MS);
        // Set changes shortly after -> logs immediately regardless of reminder interval.
        logPoolPendingResyncChange('BASE', ['0xpoolb', '0xpoolc'], 2_000 + PENDING_RESYNC_REMINDER_MS);
        // Larger set caps listed IDs and reports omittedPools.
        logPoolPendingResyncChange(
            'BASE',
            ['0xp1', '0xp2', '0xp3', '0xp4', '0xp5', '0xp6', '0xp7'],
            3_000 + PENDING_RESYNC_REMINDER_MS,
        );
        // Recovery logs once; subsequent empty runs stay silent even well past reminder interval.
        logPoolPendingResyncChange('BASE', [], 4_000 + PENDING_RESYNC_REMINDER_MS);
        logPoolPendingResyncChange('BASE', [], 4_000 + PENDING_RESYNC_REMINDER_MS * 3);

        expect(stderr.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
            {
                level: 'warn',
                message: 'Pools pending resync on next run',
                event: 'pool-sync-retry',
                chain: 'BASE',
                failedPools: 2,
                poolIds: ['0xpoola', '0xpoolb'],
            },
            {
                level: 'warn',
                message: 'Pools pending resync on next run',
                event: 'pool-sync-retry',
                chain: 'BASE',
                failedPools: 2,
                poolIds: ['0xpoola', '0xpoolb'],
            },
            {
                level: 'warn',
                message: 'Pools pending resync on next run',
                event: 'pool-sync-retry',
                chain: 'BASE',
                failedPools: 2,
                poolIds: ['0xpoolb', '0xpoolc'],
            },
            {
                level: 'warn',
                message: 'Pools pending resync on next run',
                event: 'pool-sync-retry',
                chain: 'BASE',
                failedPools: 7,
                poolIds: ['0xp1', '0xp2', '0xp3', '0xp4', '0xp5'],
                omittedPools: 2,
            },
        ]);
        expect(stdout.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
            {
                level: 'info',
                message: 'Recovered all pools pending resync',
                event: 'pool-sync-retry',
                chain: 'BASE',
                failedPools: 0,
            },
        ]);

        stderr.mockRestore();
        stdout.mockRestore();
    });
});

describe('logSubgraphSyncStatus', () => {
    it('logs per-chain RPC head and subgraph block/lag at most once per 2m interval and clamps negative lag to 0', async () => {
        vi.resetModules();
        const { logSubgraphSyncStatus, SUBGRAPH_SYNC_LOG_INTERVAL_MS } = await import('./pool-controller');
        expect(SUBGRAPH_SYNC_LOG_INTERVAL_MS).toBe(120_000);
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        // First call per chain logs immediately.
        logSubgraphSyncStatus('BASE', { rpcBlock: 59_480_020, vaultBlock: 59_480_000, poolsBlock: 59_479_995 }, 1_000);
        // Second call within the throttle window is skipped.
        logSubgraphSyncStatus(
            'BASE',
            { rpcBlock: 59_480_035, vaultBlock: 59_480_010, poolsBlock: 59_480_010 },
            1_000 + SUBGRAPH_SYNC_LOG_INTERVAL_MS - 1,
        );
        // Independent chain logs immediately even inside BASE's window; subgraph ahead of RPC clamps lag to 0.
        logSubgraphSyncStatus(
            'SEPOLIA',
            { rpcBlock: 12_170_000, vaultBlock: 12_170_001, poolsBlock: 12_169_999 },
            5_000,
        );
        // Next call at the interval boundary logs again.
        logSubgraphSyncStatus(
            'BASE',
            { rpcBlock: 59_480_050, vaultBlock: 59_480_030, poolsBlock: 59_480_040 },
            1_000 + SUBGRAPH_SYNC_LOG_INTERVAL_MS,
        );

        expect(stdout.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
            {
                level: 'info',
                message: 'Subgraph sync status',
                event: 'subgraph-sync-status',
                chain: 'BASE',
                rpcBlock: 59_480_020,
                vaultBlock: 59_480_000,
                poolsBlock: 59_479_995,
                vaultLag: 20,
                poolsLag: 25,
                lag: 25,
            },
            {
                level: 'info',
                message: 'Subgraph sync status',
                event: 'subgraph-sync-status',
                chain: 'SEPOLIA',
                rpcBlock: 12_170_000,
                vaultBlock: 12_170_001,
                poolsBlock: 12_169_999,
                vaultLag: 0,
                poolsLag: 1,
                lag: 1,
            },
            {
                level: 'info',
                message: 'Subgraph sync status',
                event: 'subgraph-sync-status',
                chain: 'BASE',
                rpcBlock: 59_480_050,
                vaultBlock: 59_480_030,
                poolsBlock: 59_480_040,
                vaultLag: 20,
                poolsLag: 10,
                lag: 20,
            },
        ]);

        stdout.mockRestore();
    });
});
describe('PoolController.addPoolsV3 bootstrap sequence', () => {
    const poolId = '0x1bfd9e31b5e9cc758484bb6b0789a270dfe04d9f';
    const wrapperAddress = '0xe298b938631f750dd409fb18227c4a23dcdaab9b';
    const underlyingAddress = '0x4200000000000000000000000000000000000006';

    beforeEach(() => {
        vi.clearAllMocks();
        mockPoolFindMany.mockResolvedValue([]);
        mockGetLastSyncedBlock.mockResolvedValue(100);
        mockSyncBptBalancesFromSubgraph.mockResolvedValue(rpcHead);
        mockSyncBptBalancesFromRpc.mockResolvedValue(0);
        mockSyncErc4626Tokens.mockResolvedValue([]);
        mockBlockedBuffers.mockResolvedValue(undefined);
        mockSyncErc4626Reviews.mockResolvedValue(undefined);
        mockSyncErc4626OnchainData.mockResolvedValue(undefined);
        mockSyncTokenContentData.mockResolvedValue(undefined);
        mockSyncCoingeckoIds.mockResolvedValue([]);
        mockSyncRateProviderReviews.mockResolvedValue(undefined);
        mockBootstrapTokenPrices.mockResolvedValue([]);
        mockUpdateDerivedPrices.mockResolvedValue([]);
        mockUpdateLiquidityValuesForPools.mockResolvedValue([]);
        mockUpdateAprs.mockResolvedValue([poolId]);
        mockSyncTags.mockResolvedValue(undefined);
    });

    it('bootstraps ERC4626 reviews, onchain data, token metadata, CoinGecko IDs, prices, liquidity, BPT price, APRs, and tags on new boosted pool init', async () => {
        const callOrder: string[] = [];
        mockBlockedBuffers.mockImplementation(async () => {
            callOrder.push('syncBlockedBuffers');
        });
        mockSyncErc4626Reviews.mockImplementation(async () => {
            callOrder.push('syncErc4626Reviews');
        });
        mockSyncErc4626OnchainData.mockImplementation(async () => {
            callOrder.push('syncErc4626OnchainData');
        });
        mockSyncTokenContentData.mockImplementation(async () => {
            callOrder.push('syncTokenContentData');
        });
        mockSyncCoingeckoIds.mockImplementation(async () => {
            callOrder.push('syncCoingeckoIds');
            return [];
        });
        mockSyncRateProviderReviews.mockImplementation(async () => {
            callOrder.push('syncRateProviderReviews');
        });
        mockBootstrapTokenPrices.mockImplementation(async () => {
            callOrder.push('bootstrapTokenPrices');
            return [wrapperAddress];
        });
        mockUpdateLiquidityValuesForPools.mockImplementation(async () => {
            callOrder.push('updateLiquidityValuesForPools');
            return [];
        });
        mockUpdateDerivedPrices.mockImplementation(async () => {
            callOrder.push('updateDerivedPrices');
            return [poolId];
        });
        mockUpdateAprs.mockImplementation(async () => {
            callOrder.push('updateAprs');
            return [poolId];
        });
        mockSyncTags.mockImplementation(async () => {
            callOrder.push('syncTags');
        });

        mockGetAllInitializedPools.mockResolvedValue([
            {
                id: poolId,
                tokens: [
                    {
                        address: wrapperAddress,
                        token: { isErc4626: true, underlyingToken: { address: underlyingAddress } },
                    },
                ],
            },
        ]);
        mockAddPoolsV3.mockResolvedValue([
            {
                tokens: [
                    {
                        address: wrapperAddress,
                        decimals: 18,
                        name: 'waBasWETH',
                        symbol: 'waBasWETH',
                        underlyingTokenAddress: underlyingAddress,
                    },
                    { address: underlyingAddress, decimals: 18, name: 'WETH', symbol: 'WETH' },
                    { address: poolId, decimals: 18, name: 'ETH LST 4Pool', symbol: '0xFF-waBasWETH' },
                ],
            },
        ]);

        const added = await PoolController().addPoolsV3('BASE');

        expect(added).toEqual([poolId]);
        expect(mockSyncErc4626Tokens).toHaveBeenCalledWith(mockViemClient, 'BASE', [
            expect.objectContaining({ address: wrapperAddress }),
        ]);
        expect(mockSyncTokenContentData).toHaveBeenCalledWith(['BASE'], [wrapperAddress, underlyingAddress, poolId]);
        expect(mockSyncCoingeckoIds).toHaveBeenCalledWith(expect.any(Number), {
            chains: ['BASE'],
            filterAddresses: [wrapperAddress, underlyingAddress, poolId],
        });
        expect(mockBootstrapTokenPrices).toHaveBeenCalledWith('BASE', [wrapperAddress, underlyingAddress, poolId]);
        expect(mockUpdateLiquidityValuesForPools).toHaveBeenCalledWith('BASE', [poolId]);
        expect(mockUpdateDerivedPrices).toHaveBeenCalledWith('BASE', [poolId]);
        expect(mockUpdateAprs).toHaveBeenCalledWith('BASE', [poolId]);
        expect(callOrder).toEqual([
            'syncBlockedBuffers',
            'syncErc4626Reviews',
            'syncErc4626OnchainData',
            'syncTokenContentData',
            'syncCoingeckoIds',
            'syncRateProviderReviews',
            'bootstrapTokenPrices',
            'updateLiquidityValuesForPools',
            'updateDerivedPrices',
            'updateAprs',
            'syncTags',
        ]);
        expect(mockUpsertLastSyncedBlock).toHaveBeenCalledWith('BASE', 'ADD_POOLS_V3', rpcHead);
    });

    it('skips ERC4626-specific syncs for plain pools while still syncing content, CoinGecko IDs, prices, APRs, and tags', async () => {
        const tokenA = '0x1111111111111111111111111111111111111111';
        mockGetAllInitializedPools.mockResolvedValue([
            {
                id: poolId,
                tokens: [{ address: tokenA, token: { isErc4626: false } }],
            },
        ]);
        mockAddPoolsV3.mockResolvedValue([
            {
                tokens: [
                    { address: tokenA, decimals: 18, name: 'Token A', symbol: 'TKA' },
                    { address: poolId, decimals: 18, name: 'Plain Pool', symbol: 'PLAIN' },
                ],
            },
        ]);

        await PoolController().addPoolsV3('BASE');

        expect(mockSyncErc4626Tokens).not.toHaveBeenCalled();
        expect(mockBlockedBuffers).not.toHaveBeenCalled();
        expect(mockSyncErc4626Reviews).not.toHaveBeenCalled();
        expect(mockSyncErc4626OnchainData).not.toHaveBeenCalled();
        expect(mockSyncTokenContentData).toHaveBeenCalledWith(['BASE'], [tokenA, poolId]);
        expect(mockSyncCoingeckoIds).toHaveBeenCalledWith(expect.any(Number), {
            chains: ['BASE'],
            filterAddresses: [tokenA, poolId],
        });
        expect(mockSyncRateProviderReviews).toHaveBeenCalledTimes(1);
        expect(mockBootstrapTokenPrices).toHaveBeenCalledWith('BASE', [tokenA, poolId]);
        expect(mockUpdateLiquidityValuesForPools).not.toHaveBeenCalled();
        expect(mockUpdateDerivedPrices).not.toHaveBeenCalled();
        expect(mockUpdateAprs).toHaveBeenCalledWith('BASE', [poolId]);
        expect(mockSyncTags).toHaveBeenCalledTimes(1);
        expect(mockUpsertLastSyncedBlock).toHaveBeenCalledWith('BASE', 'ADD_POOLS_V3', rpcHead);
    });

    it('skips second BPT pricing pass when only the BPT token itself was updated during bootstrap', async () => {
        const tokenA = '0x1111111111111111111111111111111111111111';
        mockBootstrapTokenPrices.mockResolvedValueOnce([poolId]);
        mockGetAllInitializedPools.mockResolvedValue([
            {
                id: poolId,
                tokens: [{ address: tokenA, token: { isErc4626: false } }],
            },
        ]);
        mockAddPoolsV3.mockResolvedValue([
            {
                tokens: [
                    { address: tokenA, decimals: 18, name: 'Token A', symbol: 'TKA' },
                    { address: poolId, decimals: 18, name: 'Plain Pool', symbol: 'PLAIN' },
                ],
            },
        ]);

        await PoolController().addPoolsV3('BASE');

        expect(mockUpdateLiquidityValuesForPools).toHaveBeenCalledWith('BASE', [poolId]);
        expect(mockUpdateDerivedPrices).not.toHaveBeenCalled();
    });

    it('includes RPC-discovered ERC4626 underlyings in token content, CoinGecko ID, and price bootstrap', async () => {
        const discoveredUnderlying = '0x2222222222222222222222222222222222222222';
        mockSyncErc4626Tokens.mockResolvedValueOnce([
            { address: wrapperAddress, underlyingTokenAddress: discoveredUnderlying },
        ]);
        mockGetAllInitializedPools.mockResolvedValue([
            {
                id: poolId,
                tokens: [{ address: wrapperAddress, token: {} }],
            },
        ]);
        mockAddPoolsV3.mockResolvedValue([
            {
                tokens: [
                    { address: wrapperAddress, decimals: 18, name: 'Wrapper', symbol: 'WRP' },
                    { address: poolId, decimals: 18, name: 'Boosted', symbol: 'BST' },
                ],
            },
        ]);

        await PoolController().addPoolsV3('BASE');

        const expectedAddresses = [wrapperAddress, poolId, discoveredUnderlying];
        expect(mockSyncTokenContentData).toHaveBeenCalledWith(['BASE'], expectedAddresses);
        expect(mockSyncCoingeckoIds).toHaveBeenCalledWith(expect.any(Number), {
            chains: ['BASE'],
            filterAddresses: expectedAddresses,
        });
        expect(mockBootstrapTokenPrices).toHaveBeenCalledWith('BASE', expectedAddresses);
    });

    it('logs failures from individual enrichment steps without aborting remaining bootstrap steps or ADD_POOLS_V3 checkpoint', async () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        mockSyncErc4626Reviews.mockRejectedValueOnce(new Error('GitHub 503'));
        mockSyncTags.mockRejectedValueOnce(new Error('Tags 500'));
        mockGetAllInitializedPools.mockResolvedValue([
            {
                id: poolId,
                tokens: [
                    {
                        address: wrapperAddress,
                        token: { isErc4626: true, underlyingToken: { address: underlyingAddress } },
                    },
                ],
            },
        ]);
        mockAddPoolsV3.mockResolvedValue([
            {
                tokens: [
                    {
                        address: wrapperAddress,
                        decimals: 18,
                        name: 'waBasWETH',
                        symbol: 'waBasWETH',
                        underlyingTokenAddress: underlyingAddress,
                    },
                    { address: poolId, decimals: 18, name: 'ETH LST 4Pool', symbol: '0xFF-waBasWETH' },
                ],
            },
        ]);

        await expect(PoolController().addPoolsV3('BASE')).resolves.toEqual([poolId]);

        expect(mockSyncErc4626OnchainData).toHaveBeenCalledTimes(1);
        expect(mockSyncTokenContentData).toHaveBeenCalledTimes(1);
        expect(mockUpdateAprs).toHaveBeenCalledWith('BASE', [poolId]);
        expect(mockUpsertLastSyncedBlock).toHaveBeenCalledWith('BASE', 'ADD_POOLS_V3', rpcHead);

        const loggedErrors = stderr.mock.calls.map(([line]) => JSON.parse(String(line)));
        expect(loggedErrors).toEqual([
            expect.objectContaining({
                level: 'error',
                message: 'Pool init enrichment step failed',
                chain: 'BASE',
                step: 'sync-erc4626-data',
                poolIds: [poolId],
                error: 'GitHub 503',
            }),
            expect.objectContaining({
                level: 'error',
                message: 'Pool init enrichment step failed',
                chain: 'BASE',
                step: 'sync-tags',
                poolIds: [poolId],
                error: 'Tags 500',
            }),
        ]);

        stderr.mockRestore();
    });

    it('falls back to RPC for initial BPT balances on subgraph error, and keeps running bootstrap if both fail', async () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        mockSyncBptBalancesFromSubgraph.mockRejectedValueOnce(new Error('Subgraph 502'));
        mockGetAllInitializedPools.mockResolvedValue([
            {
                id: poolId,
                blockNumber: String(rpcHead - 10),
                tokens: [
                    {
                        address: wrapperAddress,
                        token: { isErc4626: true, underlyingToken: { address: underlyingAddress } },
                    },
                ],
            },
        ]);
        mockAddPoolsV3.mockResolvedValue([
            {
                tokens: [
                    {
                        address: wrapperAddress,
                        decimals: 18,
                        name: 'waBasWETH',
                        symbol: 'waBasWETH',
                        underlyingTokenAddress: underlyingAddress,
                    },
                    { address: poolId, decimals: 18, name: 'ETH LST 4Pool', symbol: '0xFF-waBasWETH' },
                ],
            },
        ]);

        await expect(PoolController().addPoolsV3('BASE')).resolves.toEqual([poolId]);

        expect(mockSyncBptBalancesFromRpc).toHaveBeenCalledWith(
            [poolId],
            mockViemClient,
            'BASE',
            undefined,
            rpcHead - 11,
        );
        expect(mockSyncErc4626Reviews).toHaveBeenCalledTimes(1);
        expect(mockSyncTokenContentData).toHaveBeenCalledTimes(1);
        expect(mockUpdateAprs).toHaveBeenCalledWith('BASE', [poolId]);
        expect(mockSyncTags).toHaveBeenCalledTimes(1);
        expect(mockUpsertLastSyncedBlock).toHaveBeenCalledWith('BASE', 'ADD_POOLS_V3', rpcHead);
        expect(stderr.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
            expect.objectContaining({
                level: 'warn',
                message: 'Pool init BPT balance subgraph sync failed; falling back to RPC',
                chain: 'BASE',
                poolIds: [poolId],
                fromBlock: rpcHead - 11,
                toBlock: rpcHead,
                error: 'Subgraph 502',
            }),
        ]);

        // Even when both subgraph and RPC fallback fail, runInitStep isolates the error so downstream bootstrap still runs.
        vi.clearAllMocks();
        stderr.mockClear();
        mockPoolFindMany.mockResolvedValue([]);
        mockGetLastSyncedBlock.mockResolvedValue(100);
        mockSyncBptBalancesFromSubgraph.mockRejectedValueOnce(new Error('Subgraph 502'));
        mockSyncBptBalancesFromRpc.mockRejectedValueOnce(new Error('RPC timeout'));
        mockGetAllInitializedPools.mockResolvedValue([
            {
                id: poolId,
                blockNumber: String(rpcHead - 10),
                tokens: [
                    {
                        address: wrapperAddress,
                        token: { isErc4626: true, underlyingToken: { address: underlyingAddress } },
                    },
                ],
            },
        ]);
        mockAddPoolsV3.mockResolvedValue([
            {
                tokens: [
                    {
                        address: wrapperAddress,
                        decimals: 18,
                        name: 'waBasWETH',
                        symbol: 'waBasWETH',
                        underlyingTokenAddress: underlyingAddress,
                    },
                    { address: poolId, decimals: 18, name: 'ETH LST 4Pool', symbol: '0xFF-waBasWETH' },
                ],
            },
        ]);

        await expect(PoolController().addPoolsV3('BASE')).resolves.toEqual([poolId]);

        expect(mockSyncErc4626Reviews).toHaveBeenCalledTimes(1);
        expect(mockSyncTokenContentData).toHaveBeenCalledTimes(1);
        expect(mockUpdateAprs).toHaveBeenCalledWith('BASE', [poolId]);
        expect(mockSyncTags).toHaveBeenCalledTimes(1);
        expect(mockUpsertLastSyncedBlock).toHaveBeenCalledWith('BASE', 'ADD_POOLS_V3', rpcHead);

        const entries = stderr.mock.calls.map(([line]) => JSON.parse(String(line)));
        expect(entries).toEqual([
            expect.objectContaining({
                level: 'warn',
                message: 'Pool init BPT balance subgraph sync failed; falling back to RPC',
                error: 'Subgraph 502',
            }),
            expect.objectContaining({
                level: 'error',
                message: 'Pool init enrichment step failed',
                chain: 'BASE',
                step: 'sync-bpt-balances',
                poolIds: [poolId],
                error: 'RPC timeout',
            }),
        ]);

        stderr.mockRestore();
    });

    it('catches up BPT balances via RPC when subgraph backfill lags more than 5 blocks behind head', async () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const tokenA = '0x1111111111111111111111111111111111111111';
        const mockPool = [
            {
                id: poolId,
                blockNumber: String(rpcHead - 120),
                tokens: [{ address: tokenA, token: { isErc4626: false } }],
            },
        ];
        const mockInsert = [
            {
                tokens: [
                    { address: tokenA, decimals: 18, name: 'Token A', symbol: 'TKA' },
                    { address: poolId, decimals: 18, name: 'Plain Pool', symbol: 'PLAIN' },
                ],
            },
        ];

        // Within 5 blocks of head: no extra RPC catch-up scan
        mockGetAllInitializedPools.mockResolvedValue(mockPool);
        mockAddPoolsV3.mockResolvedValue(mockInsert);
        mockSyncBptBalancesFromSubgraph.mockResolvedValueOnce(rpcHead - 5);

        await PoolController().addPoolsV3('BASE');
        expect(mockSyncBptBalancesFromRpc).not.toHaveBeenCalled();
        expect(stderr).not.toHaveBeenCalled();

        // Beyond 5 blocks behind head: scans [E, head] via RPC without mutating checkpoint
        vi.clearAllMocks();
        mockPoolFindMany.mockResolvedValue([]);
        mockGetLastSyncedBlock.mockResolvedValue(100);
        mockGetAllInitializedPools.mockResolvedValue(mockPool);
        mockAddPoolsV3.mockResolvedValue(mockInsert);
        mockSyncBptBalancesFromSubgraph.mockResolvedValueOnce(rpcHead - 80);
        mockSyncBptBalancesFromRpc.mockResolvedValueOnce(80);

        await expect(PoolController().addPoolsV3('BASE')).resolves.toEqual([poolId]);

        expect(mockSyncBptBalancesFromRpc).toHaveBeenCalledTimes(1);
        expect(mockSyncBptBalancesFromRpc).toHaveBeenCalledWith(
            [poolId],
            mockViemClient,
            'BASE',
            undefined,
            rpcHead - 80,
        );
        expect(stderr.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
            expect.objectContaining({
                level: 'warn',
                message: 'Pool init BPT balance subgraph lagged behind head; catching up via RPC',
                chain: 'BASE',
                poolIds: [poolId],
                fromBlock: rpcHead - 80,
                toBlock: rpcHead,
                lag: 80,
            }),
        ]);

        // If RPC catch-up throws, runInitStep isolates it without re-running fallback from pool creation
        vi.clearAllMocks();
        stderr.mockClear();
        mockPoolFindMany.mockResolvedValue([]);
        mockGetLastSyncedBlock.mockResolvedValue(100);
        mockGetAllInitializedPools.mockResolvedValue(mockPool);
        mockAddPoolsV3.mockResolvedValue(mockInsert);
        mockSyncBptBalancesFromSubgraph.mockResolvedValueOnce(rpcHead - 80);
        mockSyncBptBalancesFromRpc.mockRejectedValueOnce(new Error('RPC rate limited'));

        await expect(PoolController().addPoolsV3('BASE')).resolves.toEqual([poolId]);

        expect(mockSyncBptBalancesFromRpc).toHaveBeenCalledTimes(1);
        expect(mockSyncBptBalancesFromRpc).toHaveBeenCalledWith(
            [poolId],
            mockViemClient,
            'BASE',
            undefined,
            rpcHead - 80,
        );
        expect(mockUpdateAprs).toHaveBeenCalledWith('BASE', [poolId]);
        expect(mockSyncTags).toHaveBeenCalledTimes(1);
        expect(mockUpsertLastSyncedBlock).toHaveBeenCalledWith('BASE', 'ADD_POOLS_V3', rpcHead);

        // If lag exceeds 5 * rpcMaxBlockRange (50,000 on Base), skip unbounded RPC scan and keep bootstrapping
        vi.clearAllMocks();
        stderr.mockClear();
        mockPoolFindMany.mockResolvedValue([]);
        mockGetLastSyncedBlock.mockResolvedValue(100);
        mockGetAllInitializedPools.mockResolvedValue(mockPool);
        mockAddPoolsV3.mockResolvedValue(mockInsert);
        mockSyncBptBalancesFromSubgraph.mockResolvedValueOnce(rpcHead - 60_000);

        await expect(PoolController().addPoolsV3('BASE')).resolves.toEqual([poolId]);

        expect(mockSyncBptBalancesFromRpc).not.toHaveBeenCalled();
        expect(mockUpdateAprs).toHaveBeenCalledWith('BASE', [poolId]);
        expect(mockSyncTags).toHaveBeenCalledTimes(1);
        expect(mockUpsertLastSyncedBlock).toHaveBeenCalledWith('BASE', 'ADD_POOLS_V3', rpcHead);
        expect(stderr.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
            expect.objectContaining({
                level: 'error',
                message: 'Pool init enrichment step failed',
                chain: 'BASE',
                step: 'sync-bpt-balances',
                poolIds: [poolId],
                error: expect.stringContaining('exceeds RPC catch-up limit'),
            }),
        ]);

        stderr.mockRestore();
    });

    it('uses Monad maxRpcBackfillRange (50,000) for addPoolsV3 BPT catch-up even with smaller rpcMaxBlockRange', async () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const tokenA = '0x1111111111111111111111111111111111111111';
        const mockPool = [
            {
                id: poolId,
                blockNumber: String(rpcHead - 10_000),
                tokens: [{ address: tokenA, token: { isErc4626: false } }],
            },
        ];
        const mockInsert = [
            {
                tokens: [
                    { address: tokenA, decimals: 18, name: 'Token A', symbol: 'TKA' },
                    { address: poolId, decimals: 18, name: 'Plain Pool', symbol: 'PLAIN' },
                ],
            },
        ];

        // 10,000-block lag exceeds 5 * 500 (2,500) but is well within Monad's decoupled maxRpcBackfillRange (50,000).
        mockGetAllInitializedPools.mockResolvedValue(mockPool);
        mockAddPoolsV3.mockResolvedValue(mockInsert);
        mockSyncBptBalancesFromSubgraph.mockResolvedValueOnce(rpcHead - 10_000);
        mockSyncBptBalancesFromRpc.mockResolvedValueOnce(10_000);

        await expect(PoolController().addPoolsV3('MONAD')).resolves.toEqual([poolId]);

        expect(mockSyncBptBalancesFromRpc).toHaveBeenCalledTimes(1);
        expect(mockSyncBptBalancesFromRpc).toHaveBeenCalledWith(
            [poolId],
            mockViemClient,
            'MONAD',
            undefined,
            rpcHead - 10_000,
        );

        // Lag exceeding Monad's 50,000-block maxRpcBackfillRange still aborts unbounded RPC backfill.
        vi.clearAllMocks();
        stderr.mockClear();
        mockPoolFindMany.mockResolvedValue([]);
        mockGetLastSyncedBlock.mockResolvedValue(100);
        mockGetAllInitializedPools.mockResolvedValue(mockPool);
        mockAddPoolsV3.mockResolvedValue(mockInsert);
        mockSyncBptBalancesFromSubgraph.mockResolvedValueOnce(rpcHead - 60_000);

        await expect(PoolController().addPoolsV3('MONAD')).resolves.toEqual([poolId]);

        expect(mockSyncBptBalancesFromRpc).not.toHaveBeenCalled();
        expect(stderr.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
            expect.objectContaining({
                level: 'error',
                message: 'Pool init enrichment step failed',
                chain: 'MONAD',
                step: 'sync-bpt-balances',
                error: expect.stringContaining('exceeds RPC catch-up limit (50000)'),
            }),
        ]);

        stderr.mockRestore();
    });
});
