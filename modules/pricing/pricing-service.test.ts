import { Chain } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingService } from './pricing-service';
import { PricingRepository } from './pricing-repository';
import { PriceItem, TokenPriceData } from './types';
import { logger } from '../common/logger';

const { getMarketDataForTokenIds } = vi.hoisted(() => ({
    getMarketDataForTokenIds: vi.fn(),
}));

vi.mock('../token/lib/coingecko-data.service', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../token/lib/coingecko-data.service')>();
    return {
        ...actual,
        coingeckoDataService: { getMarketDataForTokenIds },
    };
});

vi.mock('../../prisma/prisma-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../prisma/prisma-client')>();
    return {
        ...actual,
        prisma: {
            ...actual.prisma,
            prismaPool: {
                findMany: vi.fn(async () => []),
            },
        },
    };
});

describe('PricingService.updatePricesForChains', () => {
    let getTokensSpy: ReturnType<typeof vi.fn<PricingRepository['getTokensForPricing']>>;
    let updatePricesSpy: ReturnType<typeof vi.fn<PricingRepository['updatePrices']>>;

    beforeEach(() => {
        vi.clearAllMocks();
        getTokensSpy = vi.fn<PricingRepository['getTokensForPricing']>();
        updatePricesSpy = vi.fn<PricingRepository['updatePrices']>(async (items) => {
            return items.map((item) => item.address);
        });
        vi.spyOn(PricingRepository.prototype, 'getTokensForPricing').mockImplementation(getTokensSpy);
        vi.spyOn(PricingRepository.prototype, 'updatePrices').mockImplementation(updatePricesSpy);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('batches CoinGecko fetches into one request across chains while keeping downstream pricing isolated per chain', async () => {
        const sharedWrapperAddress = '0x0000000000000000000000000000000000004626';

        const tokensByChain: Partial<Record<Chain, TokenPriceData[]>> = {
            [Chain.SEPOLIA]: [
                {
                    address: '0xsepolia-weth',
                    chain: Chain.SEPOLIA,
                    coingeckoTokenId: 'weth',
                    types: [],
                },
                {
                    address: '0xsepolia-usdc',
                    chain: Chain.SEPOLIA,
                    coingeckoTokenId: 'usd-coin',
                    types: [],
                },
                {
                    address: sharedWrapperAddress,
                    chain: Chain.SEPOLIA,
                    types: ['ERC4626'],
                    underlyingTokenAddress: '0xsepolia-weth',
                    unwrapRate: '1.1',
                },
            ],
            [Chain.BASE]: [
                {
                    address: '0xbase-weth',
                    chain: Chain.BASE,
                    coingeckoTokenId: 'weth',
                    types: [],
                },
                {
                    address: '0xbase-usdc',
                    chain: Chain.BASE,
                    coingeckoTokenId: 'usd-coin',
                    types: [],
                },
                {
                    address: '0xbase-dai',
                    chain: Chain.BASE,
                    coingeckoTokenId: 'dai',
                    types: [],
                },
                {
                    address: sharedWrapperAddress,
                    chain: Chain.BASE,
                    types: ['ERC4626'],
                    underlyingTokenAddress: '0xbase-weth',
                    unwrapRate: '1.25',
                },
            ],
        };

        getTokensSpy.mockImplementation(async (chain: Chain) => tokensByChain[chain] ?? []);
        getMarketDataForTokenIds.mockResolvedValueOnce([
            { id: 'weth', current_price: 2000, last_updated: '2026-11-17T10:00:00.000Z' },
            { id: 'usd-coin', current_price: 1, last_updated: '2026-11-17T10:00:00.000Z' },
            { id: 'dai', current_price: 0.999, last_updated: '2026-11-17T10:00:00.000Z' },
        ]);

        const service = new PricingService([Chain.SEPOLIA, Chain.BASE]);
        await service.updatePricesForChains([Chain.SEPOLIA, Chain.BASE]);

        expect(getMarketDataForTokenIds).toHaveBeenCalledTimes(1);
        expect(getMarketDataForTokenIds).toHaveBeenCalledWith(['weth', 'usd-coin', 'dai']);

        expect(updatePricesSpy).toHaveBeenCalledTimes(2);

        const sepoliaCall = updatePricesSpy.mock.calls.find(([items]) => items[0]?.chain === Chain.SEPOLIA) as [
            PriceItem[],
            TokenPriceData[],
        ];
        const baseCall = updatePricesSpy.mock.calls.find(([items]) => items[0]?.chain === Chain.BASE) as [
            PriceItem[],
            TokenPriceData[],
        ];

        expect(sepoliaCall).toBeDefined();
        expect(baseCall).toBeDefined();

        const [sepoliaItems] = sepoliaCall;
        expect(sepoliaItems.every((item) => item.chain === Chain.SEPOLIA)).toBe(true);
        expect(sepoliaItems).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ address: '0xsepolia-weth', chain: Chain.SEPOLIA, price: 2000 }),
                expect.objectContaining({ address: '0xsepolia-usdc', chain: Chain.SEPOLIA, price: 1 }),
                expect.objectContaining({
                    address: sharedWrapperAddress,
                    chain: Chain.SEPOLIA,
                    price: 2200,
                    updatedBy: 'ERC4626PriceHandlerService',
                }),
            ]),
        );

        const [baseItems] = baseCall;
        expect(baseItems.every((item) => item.chain === Chain.BASE)).toBe(true);
        expect(baseItems).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ address: '0xbase-weth', chain: Chain.BASE, price: 2000 }),
                expect.objectContaining({ address: '0xbase-usdc', chain: Chain.BASE, price: 1 }),
                expect.objectContaining({ address: '0xbase-dai', chain: Chain.BASE, price: 0.999 }),
                expect.objectContaining({
                    address: sharedWrapperAddress,
                    chain: Chain.BASE,
                    price: 2500,
                    updatedBy: 'ERC4626PriceHandlerService',
                }),
            ]),
        );
    });

    it('falls back to cached currentPrice for downstream ERC4626 pricing when CoinGecko rejects', async () => {
        const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
        const sharedWrapperAddress = '0x0000000000000000000000000000000000004626';

        getTokensSpy.mockImplementation(async (chain: Chain) => {
            if (chain === Chain.SEPOLIA) {
                return [
                    {
                        address: '0xsepolia-weth',
                        chain: Chain.SEPOLIA,
                        coingeckoTokenId: 'weth',
                        currentPrice: 1800,
                        pricedBy: 'CoingeckoPriceHandlerService',
                        types: [],
                    },
                    {
                        address: sharedWrapperAddress,
                        chain: Chain.SEPOLIA,
                        types: ['ERC4626'],
                        underlyingTokenAddress: '0xsepolia-weth',
                        unwrapRate: '1.1',
                    },
                ];
            }
            return [
                {
                    address: '0xbase-weth',
                    chain: Chain.BASE,
                    coingeckoTokenId: 'weth',
                    currentPrice: 1850,
                    pricedBy: 'CoingeckoPriceHandlerService',
                    types: [],
                },
                {
                    address: sharedWrapperAddress,
                    chain: Chain.BASE,
                    types: ['ERC4626'],
                    underlyingTokenAddress: '0xbase-weth',
                    unwrapRate: '1.2',
                },
            ];
        });
        getMarketDataForTokenIds.mockRejectedValueOnce(new Error('Coingecko ratelimit: 429 Too Many Requests'));

        const service = new PricingService([Chain.SEPOLIA, Chain.BASE]);
        await expect(service.updatePricesForChains([Chain.SEPOLIA, Chain.BASE])).resolves.toBeUndefined();

        expect(getMarketDataForTokenIds).toHaveBeenCalledTimes(1);
        expect(loggerErrorSpy).toHaveBeenCalledWith(
            'Price handler failed',
            expect.objectContaining({ handler: 'CoingeckoPriceHandlerService' }),
        );
        expect(updatePricesSpy).toHaveBeenCalledTimes(2);

        const [sepoliaItems] = updatePricesSpy.mock.calls.find(([items]) => items[0]?.chain === Chain.SEPOLIA) as [
            PriceItem[],
            TokenPriceData[],
        ];
        const [baseItems] = updatePricesSpy.mock.calls.find(([items]) => items[0]?.chain === Chain.BASE) as [
            PriceItem[],
            TokenPriceData[],
        ];

        expect(sepoliaItems.find((item) => item.address === sharedWrapperAddress)?.price).toBeCloseTo(1980);
        expect(baseItems.find((item) => item.address === sharedWrapperAddress)?.price).toBeCloseTo(2220);
    });

    it('updates healthy chains before throwing aggregated errors from a failing chain', async () => {
        vi.spyOn(logger, 'error').mockImplementation(() => undefined);

        getTokensSpy.mockImplementation(async (chain: Chain) => {
            if (chain === Chain.SEPOLIA) {
                throw new Error('sepolia db read failed');
            }
            return [
                {
                    address: '0xbase-weth',
                    chain: Chain.BASE,
                    coingeckoTokenId: 'weth',
                    types: [],
                },
            ];
        });
        getMarketDataForTokenIds.mockResolvedValueOnce([
            { id: 'weth', current_price: 2000, last_updated: '2026-11-17T10:00:00.000Z' },
        ]);

        const service = new PricingService([Chain.SEPOLIA, Chain.BASE]);
        await expect(service.updatePricesForChains([Chain.SEPOLIA, Chain.BASE])).rejects.toThrow(
            'sepolia db read failed',
        );

        expect(updatePricesSpy).toHaveBeenCalledTimes(1);
        expect(updatePricesSpy.mock.calls[0][0]).toEqual([
            expect.objectContaining({ address: '0xbase-weth', chain: Chain.BASE, price: 2000 }),
        ]);
    });

    it('updateDerivedPrices prices ERC4626 tokens from cached underlying prices without calling CoinGecko', async () => {
        const wrapperAddress = '0x0000000000000000000000000000000000004626';
        getTokensSpy.mockResolvedValueOnce([
            {
                address: wrapperAddress,
                chain: Chain.SEPOLIA,
                types: ['ERC4626'],
                underlyingTokenAddress: '0xsepolia-weth',
                underlyingTokenPrice: 2000,
                unwrapRate: '1.1',
            },
        ]);

        const service = new PricingService([Chain.SEPOLIA]);
        const updated = await service.updateDerivedPrices(Chain.SEPOLIA, [wrapperAddress]);

        expect(getMarketDataForTokenIds).not.toHaveBeenCalled();
        expect(getTokensSpy).toHaveBeenCalledWith(Chain.SEPOLIA, [wrapperAddress]);
        expect(updatePricesSpy).toHaveBeenCalledWith(
            [
                expect.objectContaining({
                    address: wrapperAddress,
                    chain: Chain.SEPOLIA,
                    price: 2200,
                    updatedBy: 'ERC4626PriceHandlerService',
                }),
            ],
            expect.any(Array),
        );
        expect(updated).toEqual([wrapperAddress]);
    });

    it('bootstrapTokenPrices fetches cached CoinGecko price and logo only for unpriced tokens and feeds downstream ERC4626 pricing', async () => {
        const balAddress = '0xba100000625a3754423978a60c9317c58a424e3d';
        const wrappedBalAddress = '0x0000000000000000000000000000000000004626';
        const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

        getTokensSpy.mockResolvedValueOnce([
            {
                address: balAddress,
                chain: Chain.MAINNET,
                coingeckoTokenId: 'balancer',
                types: [],
            },
            {
                address: wrappedBalAddress,
                chain: Chain.MAINNET,
                types: ['ERC4626'],
                underlyingTokenAddress: balAddress,
                unwrapRate: '1.1',
            },
            {
                address: usdcAddress,
                chain: Chain.MAINNET,
                logoURI: 'https://raw.githubusercontent.com/frontier-fi/tokenlists/main/usdc.png',
                coingeckoTokenId: 'usd-coin',
                currentPrice: 1,
                pricedBy: 'CoingeckoPriceHandlerService',
                types: ['WHITE_LISTED'],
            },
        ]);
        getMarketDataForTokenIds.mockResolvedValueOnce([
            {
                id: 'balancer',
                current_price: 2.5,
                image: 'https://coin-images.coingecko.com/coins/images/11683/large/Balancer.png',
                last_updated: '2026-11-20T10:00:00.000Z',
            },
        ]);

        const service = new PricingService([Chain.MAINNET]);
        const updated = await service.bootstrapTokenPrices(Chain.MAINNET, [balAddress, wrappedBalAddress, usdcAddress]);

        expect(getMarketDataForTokenIds).toHaveBeenCalledTimes(1);
        expect(getMarketDataForTokenIds).toHaveBeenCalledWith(['balancer'], {
            useCache: true,
            cacheOnly: undefined,
        });
        expect(updatePricesSpy).toHaveBeenCalledTimes(1);
        expect(updatePricesSpy.mock.calls[0][0]).toEqual([
            expect.objectContaining({
                address: balAddress,
                chain: Chain.MAINNET,
                price: 2.5,
                logoURI: 'https://coin-images.coingecko.com/coins/images/11683/large/Balancer.png',
                updatedBy: 'CoingeckoPriceHandlerService',
            }),
            expect.objectContaining({
                address: wrappedBalAddress,
                chain: Chain.MAINNET,
                price: 2.75,
                updatedBy: 'ERC4626PriceHandlerService',
            }),
        ]);
        expect(updated).toEqual([balAddress, wrappedBalAddress]);
    });

    it('bootstrapTokenPrices uses cacheOnly for already-priced tokens missing a logo and makes 0 calls when all tokens are priced with logos', async () => {
        const balAddress = '0xba100000625a3754423978a60c9317c58a424e3d';
        const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

        // Already-priced token missing logoURI checks cacheOnly (0 network calls).
        getTokensSpy.mockResolvedValueOnce([
            {
                address: balAddress,
                chain: Chain.MAINNET,
                coingeckoTokenId: 'balancer',
                currentPrice: 2.5,
                pricedBy: 'CoingeckoPriceHandlerService',
                types: [],
            },
        ]);
        getMarketDataForTokenIds.mockResolvedValueOnce([
            {
                id: 'balancer',
                current_price: 2.5,
                image: 'https://coin-images.coingecko.com/coins/images/11683/large/Balancer.png',
                last_updated: '2026-11-20T10:00:00.000Z',
            },
        ]);

        const service = new PricingService([Chain.MAINNET]);
        await service.bootstrapTokenPrices(Chain.MAINNET, [balAddress]);

        expect(getMarketDataForTokenIds).toHaveBeenCalledWith(['balancer'], {
            useCache: undefined,
            cacheOnly: true,
        });
        expect(updatePricesSpy).toHaveBeenCalledWith(
            [
                expect.objectContaining({
                    address: balAddress,
                    logoURI: 'https://coin-images.coingecko.com/coins/images/11683/large/Balancer.png',
                }),
            ],
            expect.any(Array),
        );

        // Already-priced token WITH logoURI makes 0 CoinGecko calls and 0 DB writes (no FallbackPriceHandler churn).
        vi.clearAllMocks();
        getTokensSpy.mockResolvedValueOnce([
            {
                address: usdcAddress,
                chain: Chain.MAINNET,
                logoURI: 'https://raw.githubusercontent.com/frontier-fi/tokenlists/main/usdc.png',
                coingeckoTokenId: 'usd-coin',
                currentPrice: 1,
                pricedBy: 'CoingeckoPriceHandlerService',
                types: ['WHITE_LISTED'],
            },
        ]);

        const updated = await service.bootstrapTokenPrices(Chain.MAINNET, [usdcAddress]);

        expect(getMarketDataForTokenIds).not.toHaveBeenCalled();
        expect(updatePricesSpy).not.toHaveBeenCalled();
        expect(updated).toEqual([]);
    });

    it('bootstrapTokenPrices still runs downstream ERC4626 pricing when CoinGecko rejects', async () => {
        const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
        const balAddress = '0xba100000625a3754423978a60c9317c58a424e3d';
        const wrapperAddress = '0x0000000000000000000000000000000000004626';

        getTokensSpy.mockResolvedValueOnce([
            {
                address: balAddress,
                chain: Chain.MAINNET,
                coingeckoTokenId: 'balancer',
                types: [],
            },
            {
                address: wrapperAddress,
                chain: Chain.MAINNET,
                types: ['ERC4626'],
                underlyingTokenAddress: '0xusdc',
                underlyingTokenPrice: 1,
                unwrapRate: '1.05',
            },
        ]);
        getMarketDataForTokenIds.mockRejectedValueOnce(new Error('Coingecko ratelimit: 429 Too Many Requests'));

        const service = new PricingService([Chain.MAINNET]);
        const updated = await service.bootstrapTokenPrices(Chain.MAINNET, [balAddress, wrapperAddress]);

        expect(loggerErrorSpy).toHaveBeenCalledWith(
            'Price handler failed',
            expect.objectContaining({ handler: 'CoingeckoPriceHandlerService' }),
        );
        expect(updated).toEqual([wrapperAddress]);
        expect(updatePricesSpy).toHaveBeenCalledWith(
            [
                expect.objectContaining({
                    address: wrapperAddress,
                    price: 1.05,
                    updatedBy: 'ERC4626PriceHandlerService',
                }),
            ],
            expect.any(Array),
        );
    });
});
