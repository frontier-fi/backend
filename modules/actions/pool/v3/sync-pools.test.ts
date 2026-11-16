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
import { logger } from '../../../common/logger';

describe('syncPools', () => {
    const pool = (id: string) => ({ id, type: 'WEIGHTED' as const, version: 1, typeData: {} });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns only the pools it updated, leaving out failed reads and failed writes', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
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
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith('Skipped pools missing on-chain token data', {
            chain: 'BASE',
            skippedCount: 1,
            poolIds: ['0xreadfails'],
        });
        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith('Pool sync upsert failed', {
            chain: 'BASE',
            poolId: '0xwritefails',
            err: expect.any(Error),
        });
        warn.mockRestore();
        error.mockRestore();
    });

    it('suppresses per-pool failure logs for pools already marked pending resync', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
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
        expect(warn).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith('Pool sync upsert failed', {
            chain: 'BASE',
            poolId: '0xnewwritefails',
            err: expect.any(Error),
        });

        mockFetchPoolSyncData.mockResolvedValueOnce({
            '0xwritefails': { poolToken: [] },
        });
        mockTransaction.mockRejectedValueOnce(new Error('still broken'));
        warn.mockClear();
        error.mockClear();

        await syncPools(
            [pool('0xreadfails'), pool('0xwritefails')],
            'BASE',
            '0xvault',
            {} as any,
            1,
            new Set(['0xreadfails', '0xwritefails']),
        );

        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        warn.mockRestore();
        error.mockRestore();
    });
});
