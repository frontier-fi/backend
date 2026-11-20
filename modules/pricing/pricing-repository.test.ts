import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chain } from '@prisma/client';

const { mockTokenPriceUpsert, mockTokenCurrentPriceUpsert, mockTokenUpdateMany, mockBulkExecute } = vi.hoisted(() => ({
    mockTokenPriceUpsert: vi.fn((args: unknown) => ({ op: 'tokenPriceUpsert', args })),
    mockTokenCurrentPriceUpsert: vi.fn((args: unknown) => ({ op: 'tokenCurrentPriceUpsert', args })),
    mockTokenUpdateMany: vi.fn((args: unknown) => ({ op: 'tokenUpdateMany', args })),
    mockBulkExecute: vi.fn(async (ops: unknown[]) => ops),
}));

vi.mock('../../prisma/prisma-client', () => ({
    prisma: {
        prismaTokenPrice: { upsert: mockTokenPriceUpsert },
        prismaTokenCurrentPrice: { upsert: mockTokenCurrentPriceUpsert },
        prismaToken: { updateMany: mockTokenUpdateMany },
    },
}));

vi.mock('../../prisma/prisma-util', () => ({
    prismaBulkExecuteOperations: mockBulkExecute,
}));

import { PricingRepository } from './pricing-repository';

describe('PricingRepository.updatePrices logoURI backfill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('backfills missing logoURI guarded by null/empty check even when the price is unchanged, and skips curated logos', async () => {
        const repo = new PricingRepository({ getSwapsForPricing: vi.fn().mockResolvedValue([]) });
        const balAddress = '0xba100000625a3754423978a60c9317c58a424e3d';
        const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

        await repo.updatePrices(
            [
                {
                    address: balAddress,
                    chain: Chain.MAINNET,
                    price: 2.5,
                    updatedAt: new Date('2026-11-20T10:00:00.000Z'),
                    updatedBy: 'CoingeckoPriceHandlerService',
                    logoURI: 'https://coin-images.coingecko.com/coins/images/11683/large/Balancer.png',
                },
                {
                    address: usdcAddress,
                    chain: Chain.MAINNET,
                    price: 1,
                    updatedAt: new Date('2026-11-20T10:00:00.000Z'),
                    updatedBy: 'CoingeckoPriceHandlerService',
                    logoURI: 'https://coin-images.coingecko.com/coins/images/6319/large/usdc.png',
                },
            ],
            [
                {
                    address: balAddress,
                    chain: Chain.MAINNET,
                    currentPrice: 2.5, // unchanged price should still backfill missing logoURI
                    types: [],
                },
                {
                    address: usdcAddress,
                    chain: Chain.MAINNET,
                    logoURI: 'https://raw.githubusercontent.com/frontier-fi/tokenlists/main/usdc.png',
                    currentPrice: 1,
                    types: ['WHITE_LISTED'],
                },
            ],
        );

        expect(mockTokenCurrentPriceUpsert).not.toHaveBeenCalled();
        expect(mockTokenUpdateMany).toHaveBeenCalledTimes(1);
        expect(mockTokenUpdateMany).toHaveBeenCalledWith({
            where: {
                address: balAddress,
                chain: Chain.MAINNET,
                OR: [{ logoURI: null }, { logoURI: '' }],
            },
            data: {
                logoURI: 'https://coin-images.coingecko.com/coins/images/11683/large/Balancer.png',
            },
        });
    });
});
