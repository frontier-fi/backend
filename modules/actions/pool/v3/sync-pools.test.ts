import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    const pool = (id: string) => ({ id, type: 'WEIGHTED' as const, version: 1, typeData: {} });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns only the pools it updated, leaving out failed reads and failed writes', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('syncPools skipped 1 pools with no on-chain token data on BASE');
        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith('Error: failed to upsert pool 0xwritefails on BASE', expect.any(Error));
        log.mockRestore();
        error.mockRestore();
    });

    it('suppresses per-pool failure logs for pools already marked pending resync', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mockFetchPoolSyncData.mockResolvedValue({
            '0xwritefails': { poolToken: [] },
            '0xnewwritefails': { poolToken: [] },
        });
        mockTransaction
            .mockRejectedValueOnce(new Error('still broken'))
            .mockRejectedValueOnce(new Error('newly broken'));

        const ids = await syncPools(
            [pool('0xreadfails'), pool('0xwritefails'), pool('0xnewwritefails')],
            'BASE',
            '0xvault',
            {} as any,
            1,
            new Set(['0xreadfails', '0xwritefails']),
        );

        expect(ids).toEqual([]);
        expect(log).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith('Error: failed to upsert pool 0xnewwritefails on BASE', expect.any(Error));

        mockFetchPoolSyncData.mockResolvedValueOnce({
            '0xwritefails': { poolToken: [] },
        });
        mockTransaction.mockRejectedValueOnce(new Error('still broken'));
        log.mockClear();
        error.mockClear();

        await syncPools(
            [pool('0xreadfails'), pool('0xwritefails')],
            'BASE',
            '0xvault',
            {} as any,
            1,
            new Set(['0xreadfails', '0xwritefails']),
        );

        expect(log).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        log.mockRestore();
        error.mockRestore();
    });
});
