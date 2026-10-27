import { Chain } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../prisma/prisma-client';
import * as blockNumbersModule from '../../block-numbers';
import { eventsRepository } from '../../repositories/events';
import * as lastSyncedBlockModule from '../last-synced-block';
import { syncSnapshots } from './sync-snapshots';

describe('syncSnapshots', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not overwrite SNAPSHOTS lastSyncedBlock with 0 on a quiet day with no swaps', async () => {
        vi.spyOn(lastSyncedBlockModule, 'getLastSyncedBlock').mockResolvedValue(12_345_678);
        vi.spyOn(blockNumbersModule, 'blockNumbers').mockReturnValue({
            getTimestamp: vi.fn().mockResolvedValue(Math.floor(Date.now() / 1000)),
        } as any);
        vi.spyOn(prisma.prismaPoolDynamicData, 'findMany').mockResolvedValue([
            {
                poolId: '0xpool1',
                totalLiquidity: 1000,
                totalShares: '100',
                pool: { protocolVersion: 3 },
            } as any,
        ]);
        vi.spyOn(prisma.prismaPoolToken, 'findMany').mockResolvedValue([]);
        vi.spyOn(eventsRepository, 'getDailySwapsStats').mockResolvedValue([]);
        vi.spyOn(prisma.prismaPoolSnapshot, 'upsert').mockReturnValue({} as any);
        vi.spyOn(prisma, '$transaction').mockResolvedValue([]);
        const lastBlockUpsertSpy = vi.spyOn(prisma.prismaLastBlockSynced, 'upsert').mockResolvedValue({} as any);

        await syncSnapshots(Chain.SEPOLIA);

        expect(lastBlockUpsertSpy).not.toHaveBeenCalled();
    });

    it('updates SNAPSHOTS lastSyncedBlock when swap stats include a positive latestBlockNumber', async () => {
        vi.spyOn(lastSyncedBlockModule, 'getLastSyncedBlock').mockResolvedValue(12_345_678);
        vi.spyOn(blockNumbersModule, 'blockNumbers').mockReturnValue({
            getTimestamp: vi.fn().mockResolvedValue(Math.floor(Date.now() / 1000)),
        } as any);
        vi.spyOn(prisma.prismaPoolDynamicData, 'findMany').mockResolvedValue([
            {
                poolId: '0xpool1',
                totalLiquidity: 1000,
                totalShares: '100',
                pool: { protocolVersion: 3 },
            } as any,
        ]);
        vi.spyOn(prisma.prismaPoolToken, 'findMany').mockResolvedValue([]);
        vi.spyOn(eventsRepository, 'getDailySwapsStats').mockResolvedValue([
            {
                timestamp: Math.floor(Date.now() / 1000),
                poolId: '0xpool1',
                volume24h: 100,
                fees24h: 1,
                surplus24h: 0,
                swapsCount: 1n,
                latestBlockNumber: 12_345_999,
            },
        ]);
        vi.spyOn(prisma.prismaPoolSnapshot, 'upsert').mockReturnValue({} as any);
        vi.spyOn(prisma, '$transaction').mockResolvedValue([]);
        const lastBlockUpsertSpy = vi.spyOn(prisma.prismaLastBlockSynced, 'upsert').mockResolvedValue({} as any);

        await syncSnapshots(Chain.SEPOLIA);

        expect(lastBlockUpsertSpy).toHaveBeenCalledWith({
            where: { category_chain: { chain: Chain.SEPOLIA, category: 'SNAPSHOTS' } },
            create: { chain: Chain.SEPOLIA, category: 'SNAPSHOTS', blockNumber: 12_345_999 },
            update: { blockNumber: 12_345_999 },
        });
    });
});
