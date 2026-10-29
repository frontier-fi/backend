import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chain } from '@prisma/client';

const { mockTokenCurrentPriceFindMany, mockPoolDynamicDataFindMany, mockPoolDynamicDataUpdate, mockPoolTokenUpdate } =
    vi.hoisted(() => ({
        mockTokenCurrentPriceFindMany: vi.fn(),
        mockPoolDynamicDataFindMany: vi.fn(),
        mockPoolDynamicDataUpdate: vi.fn((args: unknown) => Promise.resolve(args)),
        mockPoolTokenUpdate: vi.fn((args: unknown) => Promise.resolve(args)),
    }));

vi.mock('../../../prisma/prisma-client', () => ({
    prisma: {
        prismaTokenCurrentPrice: {
            findMany: mockTokenCurrentPriceFindMany,
        },
        prismaPoolDynamicData: {
            findMany: mockPoolDynamicDataFindMany,
            update: mockPoolDynamicDataUpdate,
        },
        prismaPoolToken: {
            update: mockPoolTokenUpdate,
        },
    },
}));

import { updateLiquidityValuesForPools } from './update-liquidity';

describe('updateLiquidityValuesForPools', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('updates balanceUSD and totalLiquidity when transitioning from 0 to a sub-$1 positive value', async () => {
        const tokenAddress = '0xde46e43f46ff74a23a65ebb0580cbe3dfe684a17';
        mockTokenCurrentPriceFindMany.mockResolvedValue([
            {
                tokenAddress,
                chain: Chain.SEPOLIA,
                price: 1.05,
            },
        ]);
        mockPoolDynamicDataFindMany.mockResolvedValue([
            {
                id: '0xpool1',
                poolId: '0xpool1',
                chain: Chain.SEPOLIA,
                totalLiquidity: 0,
                pool: {
                    id: '0xpool1',
                    name: 'Test Pool',
                    address: '0xpool1',
                    chain: Chain.SEPOLIA,
                    tokens: [
                        {
                            id: '0xpool1-0xde46',
                            address: tokenAddress,
                            balance: '0.2',
                            balanceUSD: 0,
                        },
                    ],
                },
            },
        ]);

        await updateLiquidityValuesForPools(Chain.SEPOLIA, ['0xpool1']);

        expect(mockPoolTokenUpdate).toHaveBeenCalledWith({
            where: { id_chain: { id: '0xpool1-0xde46', chain: Chain.SEPOLIA } },
            data: { balanceUSD: expect.closeTo(0.21, 5) },
        });
        expect(mockPoolDynamicDataUpdate).toHaveBeenCalledWith({
            where: { id_chain: { id: '0xpool1', chain: Chain.SEPOLIA } },
            data: { totalLiquidity: expect.closeTo(0.21, 5) },
        });
    });
});
