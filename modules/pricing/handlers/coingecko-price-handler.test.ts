import { Chain } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoingeckoPriceHandler } from './coingecko-price-handler';
import { ERC4626PriceHandler } from './erc4626-price-handler';
import { PricingManager } from '../pricing-manager';
import { TokenPriceData } from '../types';
import { CoingeckoDataService } from '../../token/lib/coingecko-data.service';

const { getMarketDataForTokenIds } = vi.hoisted(() => ({
    getMarketDataForTokenIds: vi.fn(async (ids: string[]) =>
        ids.filter(Boolean).map((id) => ({
            id,
            current_price: 2500.5,
            last_updated: '2026-10-18T00:00:00.000Z',
        })),
    ),
}));

vi.mock('../../token/lib/coingecko-data.service', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../token/lib/coingecko-data.service')>();
    return {
        ...actual,
        coingeckoDataService: { getMarketDataForTokenIds },
    };
});

describe('CoingeckoPriceHandler', () => {
    const mockConfig = {
        excludedTokenAddresses: [],
    };

    let handler: CoingeckoPriceHandler;

    beforeEach(() => {
        handler = new CoingeckoPriceHandler(mockConfig);
    });

    it('should calculate price for WETH token on mainnet', async () => {
        const tokens: TokenPriceData[] = [
            {
                address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
                chain: Chain.MAINNET,
                coingeckoTokenId: 'weth',
                excludedFromCoingecko: false,
                types: [],
                underlyingTokenAddress: undefined,
                unwrapRate: undefined,
                underlyingTokenPrice: undefined,
            },
        ];

        const priceItems = await handler.calculatePricesForTokens(tokens);

        expect(priceItems).toHaveLength(1);
        expect(priceItems[0].address).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
        expect(priceItems[0].chain).toBe(Chain.MAINNET);
        expect(priceItems[0].updatedBy).toBe('CoingeckoPriceHandlerService');
        expect(priceItems[0].updatedAt).toBeInstanceOf(Date);
        expect(Number.isFinite(priceItems[0].price)).toBe(true);
        expect(priceItems[0].price).toBeGreaterThan(0);
    });

    it('should return handler name', () => {
        expect(handler.id).toBe('CoingeckoPriceHandlerService');
    });

    it('should have exitIfFails set to false so downstream handlers can use cached prices on transient failure', () => {
        expect(handler.exitIfFails).toBe(false);
    });

    it('should exclude tokens without coingeckoTokenId', async () => {
        const tokens: TokenPriceData[] = [
            {
                address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
                chain: Chain.MAINNET,
                coingeckoTokenId: undefined,
                excludedFromCoingecko: false,
                types: [],
                underlyingTokenAddress: undefined,
                unwrapRate: undefined,
                underlyingTokenPrice: undefined,
            },
        ];

        const priceItems = await handler.calculatePricesForTokens(tokens);

        expect(priceItems).toHaveLength(0);
    });

    it('should exclude tokens marked as excludedFromCoingecko', async () => {
        const tokens: TokenPriceData[] = [
            {
                address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
                chain: Chain.MAINNET,
                coingeckoTokenId: 'weth',
                excludedFromCoingecko: true,
                types: [],
                underlyingTokenAddress: undefined,
                unwrapRate: undefined,
                underlyingTokenPrice: undefined,
            },
        ];

        const priceItems = await handler.calculatePricesForTokens(tokens);

        expect(priceItems).toHaveLength(0);
    });

    it('should exclude tokens in excludedTokenAddresses config', async () => {
        const handlerWithExclusion = new CoingeckoPriceHandler({
            excludedTokenAddresses: [{ address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', chain: Chain.MAINNET }],
        });

        const tokens: TokenPriceData[] = [
            {
                address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
                chain: Chain.MAINNET,
                coingeckoTokenId: 'weth',
                excludedFromCoingecko: false,
                types: [],
                underlyingTokenAddress: undefined,
                unwrapRate: undefined,
                underlyingTokenPrice: undefined,
            },
        ];

        const priceItems = await handlerWithExclusion.calculatePricesForTokens(tokens);

        expect(priceItems).toHaveLength(0);
    });

    it('allows downstream handlers to price tokens from cached currentPrice when Coingecko fails, and retries 504 in CoingeckoDataService', async () => {
        getMarketDataForTokenIds.mockRejectedValueOnce(new Error('Coingecko API error: 504 Gateway Timeout'));
        const manager = new PricingManager([handler, new ERC4626PriceHandler()]);

        const items = await manager.calculatePricesForTokens([
            {
                address: '0xunderlying',
                chain: Chain.SEPOLIA,
                coingeckoTokenId: 'usd-coin',
                currentPrice: 1,
                pricedBy: 'CoingeckoPriceHandlerService',
                types: [],
            },
            {
                address: '0xwrapped4626',
                chain: Chain.SEPOLIA,
                types: ['ERC4626'],
                underlyingTokenAddress: '0xunderlying',
                unwrapRate: '1.05',
            },
        ]);

        expect(items).toHaveLength(1);
        expect(items[0].address).toBe('0xwrapped4626');
        expect(items[0].price).toBeCloseTo(1.05);

        // CoingeckoDataService retries once on 504 Gateway Timeout
        const service = new CoingeckoDataService();
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce({
                ok: false,
                status: 504,
                statusText: 'Gateway Timeout',
                text: async () => 'Gateway Timeout',
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => [{ id: 'usd-coin', current_price: 1 }],
            } as Response);

        const data = await service.getMarketDataForTokenIds(['usd-coin']);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(data).toEqual([{ id: 'usd-coin', current_price: 1 }]);
        fetchSpy.mockRestore();
    });
});
