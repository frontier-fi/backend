import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockPoolFindMany,
    mockGetLastSyncedBlock,
    mockUpsertLastSyncedBlock,
    mockGetChangedPoolsV3,
    mockSyncPools,
    mockSyncTokenPairs,
    rpcHead,
    subgraphHead,
} = vi.hoisted(() => ({
    mockPoolFindMany: vi.fn(),
    mockGetLastSyncedBlock: vi.fn(),
    mockUpsertLastSyncedBlock: vi.fn(),
    mockGetChangedPoolsV3: vi.fn(),
    mockSyncPools: vi.fn(),
    mockSyncTokenPairs: vi.fn(),
    rpcHead: 1_000_000,
    // Further behind than Base's acceptableSGLag, so syncPoolsV3 takes the RPC path.
    subgraphHead: 1_000_000 - 100,
}));

vi.mock('../../prisma/prisma-client', () => ({
    prisma: { prismaPool: { findMany: mockPoolFindMany } },
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

    it('retries pools it could not update on the next run while advancing the checkpoint', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mockGetLastSyncedBlock.mockResolvedValue(rpcHead - 15);

        // Run 1: both pools changed, the read for 0xpoolb fails.
        mockGetChangedPoolsV3.mockResolvedValueOnce(['0xpoola', '0xpoolb']);
        mockPoolFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: '0xpoola' }, { id: '0xpoolb' }]);
        mockSyncPools.mockResolvedValueOnce(['0xpoola']);

        expect(await PoolController().syncPoolsV3('BASE')).toEqual(['0xpoola']);
        expect(mockSyncTokenPairs).toHaveBeenLastCalledWith(['0xpoola'], expect.anything(), expect.any(String), 'BASE');
        expect(mockUpsertLastSyncedBlock).toHaveBeenLastCalledWith('BASE', 'POOLS_V3', rpcHead);

        // Run 2: nothing changed on chain, 0xpoolb is retried and succeeds.
        mockGetChangedPoolsV3.mockResolvedValueOnce([]);
        mockPoolFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: '0xpoolb' }]);

        expect(await PoolController().syncPoolsV3('BASE')).toEqual(['0xpoolb']);
        expect(mockPoolFindMany).toHaveBeenLastCalledWith(
            expect.objectContaining({ where: { chain: 'BASE', protocolVersion: 3, id: { in: ['0xpoolb'] } } }),
        );

        // Run 3: nothing changed and nothing left to retry.
        mockGetChangedPoolsV3.mockResolvedValueOnce([]);
        mockPoolFindMany.mockResolvedValueOnce([]);
        mockSyncPools.mockClear();

        expect(await PoolController().syncPoolsV3('BASE')).toEqual([]);
        expect(mockSyncPools).not.toHaveBeenCalled();
    });
});
