import { Chain, PrismaPoolType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PoolAPRData } from '../../types';

vi.mock('../../../../prisma/prisma-client', () => ({
    prisma: {
        $queryRawUnsafe: vi.fn(),
    },
}));

import { prisma } from '../../../../prisma/prisma-client';
import { SwapFeeAprHandler } from './swap-fee-apr-handler';

const queryRaw = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;

const pool = (overrides: Record<string, unknown> = {}) =>
    ({
        id: 'pool',
        chain: Chain.SEPOLIA,
        type: PrismaPoolType.WEIGHTED,
        version: 3,
        dynamicData: {
            totalLiquidity: 3650,
            protocolSwapFee: '0',
            protocolYieldFee: '0',
            aggregateSwapFee: '0.1',
            isInRecoveryMode: false,
        },
        ...overrides,
    }) as unknown as PoolAPRData;

describe('SwapFeeAprHandler', () => {
    beforeEach(() => {
        queryRaw.mockReset();
    });

    it('annualizes 24h swap and dynamic fees after the protocol fee', async () => {
        queryRaw.mockResolvedValue([{ poolId: 'pool', dynamic_fees_24h: 20, fees_24h: 10 }]);

        const items = await new SwapFeeAprHandler().calculateAprForPools([pool()]);

        expect(items.find((item) => item.type === 'SWAP_FEE_24H')?.apr).toBeCloseTo(0.9);
        expect(items.find((item) => item.type === 'DYNAMIC_SWAP_FEE_24H')?.apr).toBeCloseTo(1.8);
    });

    it('does not charge a protocol fee while the pool is in recovery mode', async () => {
        queryRaw.mockResolvedValue([{ poolId: 'pool', dynamic_fees_24h: 0, fees_24h: 10 }]);

        const items = await new SwapFeeAprHandler().calculateAprForPools([
            pool({
                dynamicData: {
                    totalLiquidity: 3650,
                    protocolSwapFee: '0',
                    protocolYieldFee: '0',
                    aggregateSwapFee: '0.5',
                    isInRecoveryMode: true,
                },
            }),
        ]);

        expect(items.find((item) => item.type === 'SWAP_FEE_24H')?.apr).toBeCloseTo(1);
    });

    it('uses the yield fee for a GyroE pool that is not protocol version 3', async () => {
        queryRaw.mockResolvedValue([{ poolId: 'pool', dynamic_fees_24h: 0, fees_24h: 10 }]);

        const items = await new SwapFeeAprHandler().calculateAprForPools([
            pool({
                type: PrismaPoolType.ECLP,
                version: 1,
                dynamicData: {
                    totalLiquidity: 3650,
                    protocolSwapFee: '0.9',
                    protocolYieldFee: '0.5',
                    aggregateSwapFee: '0',
                    isInRecoveryMode: false,
                },
            }),
        ]);

        expect(items.find((item) => item.type === 'SWAP_FEE_24H')?.apr).toBeCloseTo(0.5);
    });

    it('skips a pool with no swaps or no liquidity', async () => {
        queryRaw.mockResolvedValue([{ poolId: 'other', dynamic_fees_24h: 10, fees_24h: 10 }]);

        const missing = await new SwapFeeAprHandler().calculateAprForPools([pool()]);
        expect(missing).toEqual([]);

        queryRaw.mockResolvedValue([{ poolId: 'pool', dynamic_fees_24h: 10, fees_24h: 10 }]);
        const empty = await new SwapFeeAprHandler().calculateAprForPools([
            pool({
                dynamicData: {
                    totalLiquidity: 0,
                    protocolSwapFee: '0',
                    protocolYieldFee: '0',
                    aggregateSwapFee: '0',
                    isInRecoveryMode: false,
                },
            }),
        ]);

        expect(empty.find((item) => item.type === 'SWAP_FEE_24H')?.apr).toBe(0);
    });
});
