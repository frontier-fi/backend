import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockPoolFindMany,
    mockGetLastSyncedBlock,
    mockUpsertLastSyncedBlock,
    mockGetChangedPoolsV3,
    mockSyncPools,
    mockSyncTokenPairs,
    pendingResync,
    rpcHead,
    subgraphHead,
} = vi.hoisted(() => ({
    mockPoolFindMany: vi.fn(),
    mockGetLastSyncedBlock: vi.fn(),
    mockUpsertLastSyncedBlock: vi.fn(),
    mockGetChangedPoolsV3: vi.fn(),
    mockSyncPools: vi.fn(),
    mockSyncTokenPairs: vi.fn(),
    // Stands in for the pendingResync column, which outlives a worker restart.
    pendingResync: new Set<string>(),
    rpcHead: 1_000_000,
    // Further behind than Base's acceptableSGLag, so syncPoolsV3 takes the RPC path.
    subgraphHead: 1_000_000 - 100,
}));

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
    getViemClient: () => ({ getBlockNumber: async () => BigInt(rpcHead) }),
}));

vi.mock('../sources/subgraphs', () => ({
    getVaultSubgraphClient: () => ({ lastSyncedBlock: async () => subgraphHead }),
    getPoolsSubgraphClient: () => ({ lastSyncedBlock: async () => subgraphHead }),
    getV3JoinedSubgraphClient: vi.fn(),
}));

vi.mock('../sources/logs', () => ({ getChangedPoolsV3: mockGetChangedPoolsV3 }));
vi.mock('../actions/pool/v3/sync-pools', () => ({ syncPools: mockSyncPools }));
vi.mock('../actions/pool/v3/sync-tokenpairs', () => ({ syncTokenPairs: mockSyncTokenPairs }));

import { PoolController } from './pool-controller';

describe('PoolController.syncPoolsV3 on the RPC path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        pendingResync.clear();
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
    it('logs only when the pool sync source changes for a chain', async () => {
        // A fresh module, so the syncPoolsV3 runs above have not recorded a source yet.
        vi.resetModules();
        const { logPoolSyncSourceChange } = await import('./pool-controller');
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        logPoolSyncSourceChange('BASE', 'rpc', { lag: 75, acceptableSGLag: 30 });
        logPoolSyncSourceChange('BASE', 'rpc', { lag: 80, acceptableSGLag: 30 });
        logPoolSyncSourceChange('SEPOLIA', 'subgraph', { lag: 2, acceptableSGLag: 100 });
        logPoolSyncSourceChange('BASE', 'subgraph', { lag: 20, acceptableSGLag: 30 });

        expect(stdout.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
            {
                level: 'info',
                message: 'Pool sync source changed',
                event: 'pool-sync-source',
                chain: 'BASE',
                source: 'rpc',
                lag: 75,
                acceptableSGLag: 30,
            },
            {
                level: 'info',
                message: 'Pool sync source changed',
                event: 'pool-sync-source',
                chain: 'SEPOLIA',
                source: 'subgraph',
                lag: 2,
                acceptableSGLag: 100,
            },
            {
                level: 'info',
                message: 'Pool sync source changed',
                event: 'pool-sync-source',
                chain: 'BASE',
                source: 'subgraph',
                lag: 20,
                acceptableSGLag: 30,
            },
        ]);

        stdout.mockRestore();
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
