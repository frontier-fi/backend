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

import { POOL_SYNC_ERROR_LOG_INTERVAL_MS, resetPoolSyncFailureLogState, syncPools } from './sync-pools';
import { logger } from '../../../common/logger';

describe('syncPools', () => {
    const pool = (id: string) => ({ id, type: 'WEIGHTED' as const, version: 1, typeData: {} });

    beforeEach(() => {
        vi.clearAllMocks();
        resetPoolSyncFailureLogState();
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

    it('throttles repeated per-pool failure logs for an hour, logs new failures immediately, and clears cooldown on recovery', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

        // Run 1 (t = 1_000): initial failures log immediately.
        mockFetchPoolSyncData.mockResolvedValueOnce({
            '0xwritefails': { poolToken: [] },
        });
        mockTransaction.mockRejectedValueOnce(new Error('broken write'));

        const ids1 = await syncPools(
            [pool('0xreadfails'), pool('0xwritefails')],
            'BASE',
            '0xvault',
            {} as any,
            1,
            1_000,
        );
        expect(ids1).toEqual([]);
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

        // Run 2 (t = 31_000): repeated failures stay muted; newly failing pool logs immediately.
        warn.mockClear();
        error.mockClear();
        mockFetchPoolSyncData.mockResolvedValueOnce({
            '0xwritefails': { poolToken: [] },
            '0xnewwritefails': { poolToken: [] },
        });
        mockTransaction
            .mockRejectedValueOnce(new Error('still broken'))
            .mockRejectedValueOnce(new Error('newly broken'));

        await syncPools(
            [pool('0xreadfails'), pool('0xwritefails'), pool('0xnewwritefails')],
            'BASE',
            '0xvault',
            {} as any,
            1,
            31_000,
        );
        expect(warn).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith('Pool sync upsert failed', {
            chain: 'BASE',
            poolId: '0xnewwritefails',
            err: expect.any(Error),
        });

        // Run 3 (t = 61_000): 0xreadfails switches failure kind to upsert -> logs upsert error immediately.
        warn.mockClear();
        error.mockClear();
        mockFetchPoolSyncData.mockResolvedValueOnce({
            '0xreadfails': { poolToken: [] },
        });
        mockTransaction.mockRejectedValueOnce(new Error('now upsert fails'));

        await syncPools([pool('0xreadfails')], 'BASE', '0xvault', {} as any, 1, 61_000);
        expect(warn).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith('Pool sync upsert failed', {
            chain: 'BASE',
            poolId: '0xreadfails',
            err: expect.any(Error),
        });

        // Run 4 (t = 1_000 + POOL_SYNC_ERROR_LOG_INTERVAL_MS): hourly reminder re-logs persistent failures.
        warn.mockClear();
        error.mockClear();
        const afterHour = 1_000 + POOL_SYNC_ERROR_LOG_INTERVAL_MS;
        mockFetchPoolSyncData.mockResolvedValueOnce({
            '0xwritefails': { poolToken: [] },
        });
        mockTransaction.mockRejectedValueOnce(new Error('still broken after 1h'));

        await syncPools([pool('0xreadfails'), pool('0xwritefails')], 'BASE', '0xvault', {} as any, 1, afterHour);
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

        // Run 5: 0xwritefails succeeds -> cooldown clears so a subsequent failure 30s later logs immediately.
        warn.mockClear();
        error.mockClear();
        mockFetchPoolSyncData.mockResolvedValueOnce({
            '0xwritefails': { poolToken: [] },
        });
        mockTransaction.mockResolvedValueOnce([]);
        expect(await syncPools([pool('0xwritefails')], 'BASE', '0xvault', {} as any, 1, afterHour + 30_000)).toEqual([
            '0xwritefails',
        ]);

        mockFetchPoolSyncData.mockResolvedValueOnce({
            '0xwritefails': { poolToken: [] },
        });
        mockTransaction.mockRejectedValueOnce(new Error('regressed right after recovery'));
        await syncPools([pool('0xwritefails')], 'BASE', '0xvault', {} as any, 1, afterHour + 60_000);
        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith('Pool sync upsert failed', {
            chain: 'BASE',
            poolId: '0xwritefails',
            err: expect.any(Error),
        });

        warn.mockRestore();
        error.mockRestore();
    });
});
