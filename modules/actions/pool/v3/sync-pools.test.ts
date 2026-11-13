import { describe, expect, it, vi } from 'vitest';

const { mockFetchPoolSyncData, mockTransaction } = vi.hoisted(() => ({
    mockFetchPoolSyncData: vi.fn(),
    mockTransaction: vi.fn(),
}));

vi.mock('../../../sources/contracts/v3/fetch-pool-sync-data', () => ({
    fetchPoolSyncData: mockFetchPoolSyncData,
}));

vi.mock('../../../../prisma/prisma-client', () => ({
    prisma: {
        prismaTokenCurrentPrice: { findMany: async () => [] },
        prismaPool: { update: vi.fn() },
        prismaPoolDynamicData: { update: vi.fn() },
        prismaPoolToken: { update: vi.fn() },
        $transaction: mockTransaction,
    },
}));

import { syncPools } from './sync-pools';

describe('syncPools', () => {
    it('returns only the pools it updated, leaving out failed reads and failed writes', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const pool = (id: string) => ({ id, type: 'WEIGHTED' as const, version: 1, typeData: {} });
        mockFetchPoolSyncData.mockResolvedValue({
            '0xupdated': { poolToken: [] },
            '0xwritefails': { poolToken: [] },
            // 0xreadfails has no on-chain data
        });
        mockTransaction.mockImplementation(async (operations: unknown[]) => operations);
        mockTransaction.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('write failed'));

        const ids = await syncPools(
            [pool('0xupdated'), pool('0xreadfails'), pool('0xwritefails')],
            'BASE',
            '0xvault',
            {} as any,
            1,
        );

        expect(ids).toEqual(['0xupdated']);
    });
});
