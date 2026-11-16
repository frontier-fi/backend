import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chain } from '@prisma/client';
import { env } from '../../../apps/env';

const { mockTokenFindMany, mockTokenUpdate, mockTransaction } = vi.hoisted(() => ({
    mockTokenFindMany: vi.fn(),
    mockTokenUpdate: vi.fn((args: unknown) => args),
    mockTransaction: vi.fn(async (ops: unknown[]) => ops),
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

import { COIN_LIST_CACHE_TTL_MS, CoingeckoDataService } from './coingecko-data.service';

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
                chain: { in: [Chain.BASE] },
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
});
