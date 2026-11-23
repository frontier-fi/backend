import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chain } from '@prisma/client';
import { env } from '../../../apps/env';

const { mockTokenFindMany, mockTokenUpdate, mockTransaction } = vi.hoisted(() => ({
    mockTokenFindMany: vi.fn(),
    mockTokenUpdate: vi.fn((args: unknown) => args),
    mockTransaction: vi.fn(async (ops: unknown[]) => ops),
}));

vi.mock('limiter', () => ({
    RateLimiter: class {
        async removeTokens() {
            return 1;
        }
    },
}));

vi.mock('../../../prisma/prisma-client', () => ({
    prisma: {
        prismaToken: {
            findMany: mockTokenFindMany,
            update: mockTokenUpdate,
        },
        $transaction: mockTransaction,
    },
}));

import {
    COIN_LIST_CACHE_TTL_MS,
    CoingeckoDataService,
    MARKET_DATA_CACHE_TTL_MS,
    normalizeCoingeckoLogoUri,
} from './coingecko-data.service';

describe('CoingeckoDataService.syncCoingeckoIds', () => {
    let previousCoingeckoKey: string | undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        previousCoingeckoKey = env.COINGECKO_API_KEY;
        env.COINGECKO_API_KEY = '';
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        env.COINGECKO_API_KEY = previousCoingeckoKey;
        vi.restoreAllMocks();
    });

    it('queries only non-BPT, non-excluded tokens missing coingeckoTokenId and skips no-op updates when unmatched', async () => {
        const fetchSpy = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => [{ id: 'unrelated', symbol: 'x', name: 'X', platforms: { ethereum: '0x1' } }],
        }));
        vi.stubGlobal('fetch', fetchSpy);

        mockTokenFindMany.mockResolvedValueOnce([
            { address: '0xunmatched', chain: Chain.BASE, coingeckoTokenId: null },
        ]);

        const service = new CoingeckoDataService();
        await service.syncCoingeckoIds(1_000);

        expect(mockTokenFindMany).toHaveBeenCalledWith({
            where: {
                chain: { in: [Chain.BASE, Chain.MAINNET, Chain.MONAD] },
                coingeckoTokenId: null,
                excludedFromCoingecko: false,
                types: { none: { type: 'BPT' } },
            },
            select: {
                address: true,
                chain: true,
                coingeckoTokenId: true,
            },
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(mockTokenUpdate).not.toHaveBeenCalled();
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('caches the CoinGecko coin map and unmatched token checks for 24h before refreshing', async () => {
        const fetchSpy = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => [
                { id: 'usd-coin', symbol: 'usdc', name: 'USD Coin', platforms: { base: '0xMatchedA' } },
                { id: 'wrapped-eeth', symbol: 'weeth', name: 'Wrapped eETH', platforms: { base: '0xMatchedB' } },
                { id: 'ignored-chain', symbol: 'ign', name: 'Ignored', platforms: { arbitrum: '0x999' } },
            ],
        }));
        vi.stubGlobal('fetch', fetchSpy);

        const service = new CoingeckoDataService();

        // 1st run (t = 0): fetches /coins/list once, maps 0xmatcheda, records 0xunmatched as missing.
        mockTokenFindMany.mockResolvedValueOnce([
            { address: '0xmatcheda', chain: Chain.BASE, coingeckoTokenId: null },
            { address: '0xunmatched', chain: Chain.BASE, coingeckoTokenId: null },
        ]);
        await service.syncCoingeckoIds(0);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(mockTokenUpdate).toHaveBeenCalledTimes(1);
        expect(mockTokenUpdate).toHaveBeenCalledWith({
            where: { address_chain: { address: '0xmatcheda', chain: Chain.BASE } },
            data: { coingeckoTokenId: 'usd-coin' },
        });
        expect(mockTransaction).toHaveBeenCalledTimes(1);

        // 2nd run (t = 5m): only the already-checked unmatched token remains -> 0 fetch calls, 0 updates.
        mockTokenFindMany.mockResolvedValueOnce([
            { address: '0xunmatched', chain: Chain.BASE, coingeckoTokenId: null },
        ]);
        await service.syncCoingeckoIds(5 * 60_000);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(mockTokenUpdate).toHaveBeenCalledTimes(1);
        expect(mockTransaction).toHaveBeenCalledTimes(1);

        // 3rd run (t = 10m): a brand-new token appears and resolves from the cached compact map with 0 fetch calls.
        mockTokenFindMany.mockResolvedValueOnce([
            { address: '0xunmatched', chain: Chain.BASE, coingeckoTokenId: null },
            { address: '0xmatchedb', chain: Chain.BASE, coingeckoTokenId: null },
        ]);
        await service.syncCoingeckoIds(10 * 60_000);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(mockTokenUpdate).toHaveBeenCalledTimes(2);
        expect(mockTokenUpdate).toHaveBeenLastCalledWith({
            where: { address_chain: { address: '0xmatchedb', chain: Chain.BASE } },
            data: { coingeckoTokenId: 'wrapped-eeth' },
        });
        expect(mockTransaction).toHaveBeenCalledTimes(2);

        // 4th run (t = 24h + 1ms): cache and negative-check TTL expired -> refreshes /coins/list once.
        mockTokenFindMany.mockResolvedValueOnce([
            { address: '0xunmatched', chain: Chain.BASE, coingeckoTokenId: null },
        ]);
        await service.syncCoingeckoIds(COIN_LIST_CACHE_TTL_MS + 1);

        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('remembers Demo API mode on the shared instance after error 10011 without re-probing pro-api', async () => {
        env.COINGECKO_API_KEY = 'demo-test-key';
        const fetchSpy = vi
            .fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 400,
                statusText: 'Bad Request',
                text: async () => JSON.stringify({ status: { error_code: 10011 } }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => [{ id: 'usd-coin', current_price: 1 }],
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => [{ id: 'usd-coin', current_price: 1 }],
            });
        vi.stubGlobal('fetch', fetchSpy);

        const service = new CoingeckoDataService();
        await service.getMarketDataForTokenIds(['usd-coin']);
        await service.getMarketDataForTokenIds(['usd-coin']);

        expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
            expect.stringMatching(/^https:\/\/pro-api\.coingecko\.com\//),
            expect.stringMatching(/^https:\/\/api\.coingecko\.com\//),
            expect.stringMatching(/^https:\/\/api\.coingecko\.com\//),
        ]);
    });

    it('scopes syncCoingeckoIds to requested chains and addresses while indexing all chains in the 24h coin map', async () => {
        const fetchSpy = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => [
                {
                    id: 'balancer',
                    symbol: 'bal',
                    name: 'Balancer',
                    platforms: {
                        ethereum: '0xba100000625a3754423978a60c9317c58a424e3d',
                        base: '0x4158734d47fc9692176b5085e0f52ee0da5d47f1',
                    },
                },
            ],
        }));
        vi.stubGlobal('fetch', fetchSpy);

        const service = new CoingeckoDataService();

        // Scoped to MAINNET + uppercase address: fetches /coins/list once and indexes both MAINNET and BASE.
        mockTokenFindMany.mockResolvedValueOnce([
            { address: '0xba100000625a3754423978a60c9317c58a424e3d', chain: Chain.MAINNET, coingeckoTokenId: null },
        ]);
        const mainnetUpdated = await service.syncCoingeckoIds(0, {
            chains: [Chain.MAINNET],
            filterAddresses: ['0xBA100000625A3754423978A60C9317C58A424E3D'],
        });

        expect(mainnetUpdated).toEqual(['0xba100000625a3754423978a60c9317c58a424e3d']);
        expect(mockTokenFindMany).toHaveBeenCalledWith({
            where: {
                chain: { in: [Chain.MAINNET] },
                address: { in: ['0xba100000625a3754423978a60c9317c58a424e3d'] },
                coingeckoTokenId: null,
                excludedFromCoingecko: false,
                types: { none: { type: 'BPT' } },
            },
            select: {
                address: true,
                chain: true,
                coingeckoTokenId: true,
            },
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Later BASE sync reuses the warm 24h map with 0 extra HTTP calls.
        mockTokenFindMany.mockResolvedValueOnce([
            { address: '0x4158734d47fc9692176b5085e0f52ee0da5d47f1', chain: Chain.BASE, coingeckoTokenId: null },
        ]);
        const baseUpdated = await service.syncCoingeckoIds(60_000, {
            chains: [Chain.BASE],
            filterAddresses: ['0x4158734d47fc9692176b5085e0f52ee0da5d47f1'],
        });

        expect(baseUpdated).toEqual(['0x4158734d47fc9692176b5085e0f52ee0da5d47f1']);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(mockTokenUpdate).toHaveBeenLastCalledWith({
            where: {
                address_chain: { address: '0x4158734d47fc9692176b5085e0f52ee0da5d47f1', chain: Chain.BASE },
            },
            data: { coingeckoTokenId: 'balancer' },
        });

        // Sepolia and empty address filters short-circuit before hitting Prisma or CoinGecko.
        expect(await service.syncCoingeckoIds(60_000, { chains: [Chain.SEPOLIA] })).toEqual([]);
        expect(await service.syncCoingeckoIds(60_000, { chains: [Chain.MAINNET], filterAddresses: [] })).toEqual([]);
        expect(mockTokenFindMany).toHaveBeenCalledTimes(2);
    });

    it('coalesces concurrent cold-start /coins/list fetches into one request', async () => {
        let resolveFetch!: (value: unknown) => void;
        let markFetchStarted!: () => void;
        const fetchStarted = new Promise<void>((resolve) => {
            markFetchStarted = resolve;
        });
        const fetchSpy = vi.fn(
            () =>
                new Promise((resolve) => {
                    resolveFetch = resolve;
                    markFetchStarted();
                }),
        );
        vi.stubGlobal('fetch', fetchSpy);

        mockTokenFindMany
            .mockResolvedValueOnce([{ address: '0xbal-mainnet', chain: Chain.MAINNET, coingeckoTokenId: null }])
            .mockResolvedValueOnce([{ address: '0xbal-base', chain: Chain.BASE, coingeckoTokenId: null }]);

        const service = new CoingeckoDataService();
        const first = service.syncCoingeckoIds(1_000, { chains: [Chain.MAINNET] });
        const second = service.syncCoingeckoIds(1_000, { chains: [Chain.BASE] });

        await fetchStarted;
        resolveFetch({
            ok: true,
            status: 200,
            json: async () => [
                {
                    id: 'balancer',
                    symbol: 'bal',
                    name: 'Balancer',
                    platforms: { ethereum: '0xbal-mainnet', base: '0xbal-base' },
                },
            ],
        });

        expect(await Promise.all([first, second])).toEqual([['0xbal-mainnet'], ['0xbal-base']]);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('caches /coins/markets responses and supports useCache and cacheOnly lookups without redundant API calls', async () => {
        const fetchSpy = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => [
                    {
                        id: 'balancer',
                        current_price: 2.5,
                        image: 'https://coin-images.coingecko.com/coins/images/11683/large/Balancer.png',
                        last_updated: '2026-11-20T10:00:00.000Z',
                    },
                ],
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => [
                    {
                        id: 'aave',
                        current_price: 150,
                        image: 'https://coin-images.coingecko.com/coins/images/12645/large/AAVE.png',
                        last_updated: '2026-11-20T10:01:00.000Z',
                    },
                ],
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => [
                    {
                        id: 'balancer',
                        current_price: 2.75,
                        image: 'https://coin-images.coingecko.com/coins/images/11683/large/Balancer.png',
                        last_updated: '2026-11-20T10:20:00.000Z',
                    },
                ],
            });
        vi.stubGlobal('fetch', fetchSpy);

        const service = new CoingeckoDataService();

        // Warm via default live call (as scheduled update-token-prices does); 'delisted' is negative-cached.
        const initial = await service.getMarketDataForTokenIds(['balancer', 'delisted'], { nowMs: 1_000 });
        expect(initial).toHaveLength(1);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // cacheOnly serves warm hit and ignores misses with 0 HTTP calls.
        const fromCacheOnly = await service.getMarketDataForTokenIds(['balancer', 'aave'], {
            cacheOnly: true,
            nowMs: 2_000,
        });
        expect(fromCacheOnly.map((item) => item.id)).toEqual(['balancer']);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // useCache reuses 'balancer' and negative-cached 'delisted', fetching only 'aave'.
        const mixed = await service.getMarketDataForTokenIds(['balancer', 'delisted', 'aave'], {
            useCache: true,
            nowMs: 3_000,
        });
        expect(mixed.map((item) => item.id)).toEqual(['balancer', 'aave']);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy.mock.calls[1][0]).toContain('ids=aave&');

        // After TTL expires, useCache refreshes from CoinGecko.
        const refreshed = await service.getMarketDataForTokenIds(['balancer'], {
            useCache: true,
            nowMs: 1_000 + MARKET_DATA_CACHE_TTL_MS + 1,
        });
        expect(refreshed[0]?.current_price).toBe(2.75);
        expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
});

describe('normalizeCoingeckoLogoUri', () => {
    it('accepts valid HTTPS logo URLs and rejects CoinGecko placeholders and non-HTTPS values', () => {
        expect(
            normalizeCoingeckoLogoUri('  https://coin-images.coingecko.com/coins/images/11683/large/Balancer.png  '),
        ).toBe('https://coin-images.coingecko.com/coins/images/11683/large/Balancer.png');
        expect(normalizeCoingeckoLogoUri('missing_large.png')).toBeUndefined();
        expect(normalizeCoingeckoLogoUri('https://static.coingecko.com/s/missing_large.png')).toBeUndefined();
        expect(normalizeCoingeckoLogoUri('http://coin-images.coingecko.com/logo.png')).toBeUndefined();
        expect(normalizeCoingeckoLogoUri('')).toBeUndefined();
        expect(normalizeCoingeckoLogoUri(null)).toBeUndefined();
    });
});
