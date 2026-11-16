import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockPoolFindMany,
    mockGetVaultSubgraphClient,
    mockGetViemClient,
    mockSyncBptBalancesFromSubgraph,
    mockSyncBptBalancesFromRpc,
} = vi.hoisted(() => ({
    mockPoolFindMany: vi.fn(),
    mockGetVaultSubgraphClient: vi.fn(() => ({})),
    mockGetViemClient: vi.fn(() => ({})),
    mockSyncBptBalancesFromSubgraph: vi.fn(),
    mockSyncBptBalancesFromRpc: vi.fn(),
}));

vi.mock('../../../../prisma/prisma-client', () => ({
    prisma: {
        prismaPool: { findMany: mockPoolFindMany },
    },
}));

vi.mock('../../../sources/subgraphs', () => ({
    getVaultSubgraphClient: mockGetVaultSubgraphClient,
}));

vi.mock('../../../sources/viem-client', () => ({
    getViemClient: mockGetViemClient,
}));

vi.mock('./helpers/sync-bpt-balances-from-subgraph', () => ({
    syncBptBalancesFromSubgraph: mockSyncBptBalancesFromSubgraph,
}));

vi.mock('./helpers/sync-bpt-balances-from-rpc', () => ({
    syncBptBalancesFromRpc: mockSyncBptBalancesFromRpc,
}));

describe('syncBptBalancesV3', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it('logs fallback and recovery only when the BPT balance sync source changes per chain', async () => {
        const { syncBptBalancesV3 } = await import('./sync-bpt-balances-v3');
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        mockPoolFindMany.mockResolvedValue([{ id: '0xpoola' }]);
        mockSyncBptBalancesFromSubgraph
            .mockRejectedValueOnce(new Error('subgraph lagging behind by 75 blocks'))
            .mockRejectedValueOnce(new Error('subgraph lagging behind by 79 blocks'))
            .mockResolvedValueOnce(12)
            .mockResolvedValueOnce(5);
        mockSyncBptBalancesFromRpc.mockResolvedValue(5);

        await syncBptBalancesV3('BASE', 'https://subgraph.example/vault');
        await syncBptBalancesV3('BASE', 'https://subgraph.example/vault');
        await syncBptBalancesV3('BASE', 'https://subgraph.example/vault');
        await syncBptBalancesV3('BASE', 'https://subgraph.example/vault');

        expect(mockSyncBptBalancesFromRpc).toHaveBeenCalledTimes(2);
        expect(stderr.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
            {
                level: 'warn',
                message: 'BPT balance sync switched to RPC fallback',
                event: 'bpt-balance-sync-source',
                chain: 'BASE',
                source: 'rpc',
                syncCategory: 'BPT_BALANCES_V3',
                error: 'subgraph lagging behind by 75 blocks',
                stack: expect.any(String),
            },
        ]);
        expect(stdout.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
            {
                level: 'info',
                message: 'BPT balance sync using subgraph',
                event: 'bpt-balance-sync-source',
                chain: 'BASE',
                source: 'subgraph',
                syncCategory: 'BPT_BALANCES_V3',
            },
        ]);

        stderr.mockRestore();
        stdout.mockRestore();
    });

    it('returns 0 without logging or syncing when there are no V3 pools on the chain', async () => {
        const { syncBptBalancesV3 } = await import('./sync-bpt-balances-v3');
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        mockPoolFindMany.mockResolvedValue([]);

        expect(await syncBptBalancesV3('BASE', 'https://subgraph.example/vault')).toBe(0);
        expect(mockSyncBptBalancesFromSubgraph).not.toHaveBeenCalled();
        expect(mockSyncBptBalancesFromRpc).not.toHaveBeenCalled();
        expect(stderr).not.toHaveBeenCalled();
        expect(stdout).not.toHaveBeenCalled();

        stderr.mockRestore();
        stdout.mockRestore();
    });
});
