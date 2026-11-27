import { Chain, PrismaPoolAprItem, PrismaPoolAprType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = vi.hoisted(() => ({
    prismaPool: { findMany: vi.fn() },
    prismaPoolDynamicData: { findMany: vi.fn() },
    prismaPoolToken: { findMany: vi.fn() },
    prismaPoolAprItem: {
        findMany: vi.fn(),
        deleteMany: vi.fn(),
        upsert: vi.fn(),
    },
    $executeRaw: vi.fn(),
}));

const mockBulkExecute = vi.hoisted(() => vi.fn());

vi.mock('../../prisma/prisma-client', () => ({
    prisma: mockPrisma,
}));

vi.mock('../../prisma/prisma-util', () => ({
    prismaBulkExecuteOperations: mockBulkExecute,
}));

vi.mock('../common/logger', () => ({
    logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
    },
}));

import { AprManager } from './apr-manager';
import { AprRepository } from './apr-repository';
import type { AprHandler, PoolAPRData } from './types';

function aprItem(overrides: Partial<Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>> = {}) {
    return {
        id: 'pool-1-merkl',
        type: PrismaPoolAprType.MERKL,
        title: 'Merkl Rewards',
        chain: Chain.MONAD,
        poolId: 'pool-1',
        apr: 0.02,
        rewardTokenAddress: null,
        rewardTokenSymbol: null,
        ...overrides,
    };
}

describe('AprManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPrisma.prismaPool.findMany.mockResolvedValue([{ id: 'pool-1', chain: Chain.MONAD }]);
        mockPrisma.prismaPoolDynamicData.findMany.mockResolvedValue([{ id: 'pool-1', totalLiquidity: 100 }]);
        mockPrisma.prismaPoolToken.findMany.mockResolvedValue([]);
        mockPrisma.prismaPoolAprItem.deleteMany.mockResolvedValue({ count: 0 });
        mockPrisma.prismaPoolAprItem.upsert.mockImplementation((args: unknown) => args);
        mockBulkExecute.mockResolvedValue(undefined);
        mockPrisma.$executeRaw.mockResolvedValue(1);
    });

    it('preserves existing APR rows for a failed handler while still updating and pruning other handlers', async () => {
        const existingMerkl = aprItem();
        const existingYb = aprItem({
            id: 'pool-1-yb-keep',
            type: PrismaPoolAprType.IB_YIELD,
            title: 'waMonUSDC APR',
            apr: 0.015,
        });
        const staleYb = aprItem({
            id: 'pool-1-yb-stale',
            type: PrismaPoolAprType.IB_YIELD,
            title: 'stale APR',
            apr: 0.01,
        });
        mockPrisma.prismaPoolAprItem.findMany.mockResolvedValue([existingMerkl, existingYb, staleYb]);

        const failingMerklHandler: AprHandler = {
            getAprServiceName: () => 'MerklAprHandler',
            getAprTypes: () => [PrismaPoolAprType.MERKL],
            calculateAprForPools: vi.fn().mockRejectedValue(new Error('Merkl API error: 429 Too Many Requests')),
        };
        const updatedYb = aprItem({
            id: 'pool-1-yb-keep',
            type: PrismaPoolAprType.IB_YIELD,
            title: 'waMonUSDC APR',
            apr: 0.02,
        });
        const succeedingYbHandler: AprHandler = {
            getAprServiceName: () => 'YbTokensAprHandler',
            getAprTypes: () => [PrismaPoolAprType.IB_YIELD],
            calculateAprForPools: vi.fn().mockResolvedValue([updatedYb]),
        };

        const manager = new AprManager(new AprRepository(), [failingMerklHandler, succeedingYbHandler]);
        const changedPools = await manager.updateAprs(Chain.MONAD);

        expect(changedPools).toEqual(['pool-1']);
        expect(mockPrisma.prismaPoolAprItem.deleteMany).toHaveBeenCalledTimes(1);
        expect(mockPrisma.prismaPoolAprItem.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ['pool-1-yb-stale'] },
                chain: Chain.MONAD,
            },
        });
        expect(mockPrisma.prismaPoolAprItem.upsert).toHaveBeenCalledWith({
            where: { id_chain: { id: 'pool-1-yb-keep', chain: Chain.MONAD } },
            create: updatedYb,
            update: {
                apr: 0.02,
                title: updatedYb.title,
                rewardTokenAddress: updatedYb.rewardTokenAddress,
                rewardTokenSymbol: updatedYb.rewardTokenSymbol,
            },
        });
        expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('deletes existing APR rows when a handler succeeds and returns empty', async () => {
        const existingMerkl = aprItem();
        mockPrisma.prismaPoolAprItem.findMany.mockResolvedValue([existingMerkl]);

        const succeedingEmptyMerklHandler: AprHandler = {
            getAprServiceName: () => 'MerklAprHandler',
            getAprTypes: () => [PrismaPoolAprType.MERKL],
            calculateAprForPools: vi.fn().mockResolvedValue([]),
        };

        const manager = new AprManager(new AprRepository(), [succeedingEmptyMerklHandler]);
        const changedPools = await manager.updateAprs(Chain.MONAD);

        expect(changedPools).toEqual(['pool-1']);
        expect(mockPrisma.prismaPoolAprItem.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ['pool-1-merkl'] },
                chain: Chain.MONAD,
            },
        });
        expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('skips updatePoolTotalApr when the only handler fails and no other items change', async () => {
        const existingMerkl = aprItem();
        mockPrisma.prismaPoolAprItem.findMany.mockResolvedValue([existingMerkl]);

        const failingMerklHandler: AprHandler = {
            getAprServiceName: () => 'MerklAprHandler',
            getAprTypes: () => [PrismaPoolAprType.MERKL],
            calculateAprForPools: vi.fn().mockRejectedValue(new Error('network timeout')),
        };

        const manager = new AprManager(new AprRepository(), [failingMerklHandler]);
        const changedPools = await manager.updateAprs(Chain.MONAD);

        expect(changedPools).toEqual([]);
        expect(mockPrisma.prismaPoolAprItem.deleteMany).not.toHaveBeenCalled();
        expect(mockBulkExecute).not.toHaveBeenCalled();
        expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('returns only succeeded handler items from calculateAprs without mutating the DB', async () => {
        const failingHandler: AprHandler = {
            getAprServiceName: () => 'MerklAprHandler',
            getAprTypes: () => [PrismaPoolAprType.MERKL],
            calculateAprForPools: vi.fn().mockRejectedValue(new Error('boom')),
        };
        const ybItem = aprItem({
            id: 'pool-1-yb',
            type: PrismaPoolAprType.IB_YIELD,
            title: 'waMonUSDC APR',
            apr: 0.015,
        });
        const succeedingHandler: AprHandler = {
            getAprServiceName: () => 'YbTokensAprHandler',
            getAprTypes: () => [PrismaPoolAprType.IB_YIELD],
            calculateAprForPools: vi.fn().mockResolvedValue([ybItem]),
        };

        const manager = new AprManager(new AprRepository(), [failingHandler, succeedingHandler]);
        const items = await manager.calculateAprs(Chain.MONAD);

        expect(items).toEqual([ybItem]);
        expect(mockPrisma.prismaPoolAprItem.findMany).not.toHaveBeenCalled();
        expect(mockPrisma.prismaPoolAprItem.deleteMany).not.toHaveBeenCalled();
        expect(mockBulkExecute).not.toHaveBeenCalled();
    });

    it('upserts metadata changes even when APR is unchanged without recalculating pool total APR', async () => {
        const existingMerkl = aprItem({
            id: 'pool-1-merkl-123',
            title: 'Old Title',
            rewardTokenSymbol: null,
            apr: 0.02,
        });
        mockPrisma.prismaPoolAprItem.findMany.mockResolvedValue([existingMerkl]);

        const updatedMerkl = aprItem({
            id: 'pool-1-merkl-123',
            title: 'waMonUSDC',
            rewardTokenAddress: '0x561ad6156d0106e7a59ee788759df7b7ec679bd0',
            rewardTokenSymbol: 'WMON',
            apr: 0.02,
        });
        const merklHandler: AprHandler = {
            getAprServiceName: () => 'MerklAprHandler',
            getAprTypes: () => [PrismaPoolAprType.MERKL],
            calculateAprForPools: vi.fn().mockResolvedValue([updatedMerkl]),
        };

        const manager = new AprManager(new AprRepository(), [merklHandler]);
        const changedPools = await manager.updateAprs(Chain.MONAD);

        expect(changedPools).toEqual([]);
        expect(mockPrisma.prismaPoolAprItem.upsert).toHaveBeenCalledWith({
            where: { id_chain: { id: 'pool-1-merkl-123', chain: Chain.MONAD } },
            create: updatedMerkl,
            update: {
                apr: 0.02,
                title: 'waMonUSDC',
                rewardTokenAddress: '0x561ad6156d0106e7a59ee788759df7b7ec679bd0',
                rewardTokenSymbol: 'WMON',
            },
        });
        expect(mockBulkExecute).toHaveBeenCalledTimes(1);
        expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });
});

void (0 as unknown as PoolAPRData);
