import { Chain, PrismaPoolAprType } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../../../apps/env';
import type { PoolAPRData } from '../../types';
import { clearMerklResponseCache, MerklAprHandler } from './merkl-apr-handler';
import { createHandlers } from '../create-handlers';

const fetchMock = vi.fn();

const WRAPPER = '0x1111111111111111111111111111111111111111';
const STATA = '0x2222222222222222222222222222222222222222';
const A_TOKEN = '0x3333333333333333333333333333333333333333';
const SECOND_MARKET_WRAPPER = '0x4444444444444444444444444444444444444444';
const SECOND_MARKET_A_TOKEN = '0x5555555555555555555555555555555555555555';
const POOL = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

vi.mock('../../../../config', () => ({
    default: {
        SEPOLIA: {
            chain: { id: 11155111, prismaId: 'SEPOLIA' },
            aprHandlers: {
                ybAprHandler: {
                    aave: {
                        markets: [
                            {
                                CHAIN_ID: 11155111,
                                ASSETS: {
                                    USDC: {
                                        STATIC_A_TOKEN: '0x1111111111111111111111111111111111111111',
                                        STATA_TOKEN: '0x2222222222222222222222222222222222222222',
                                        A_TOKEN: '0x3333333333333333333333333333333333333333',
                                    },
                                },
                            },
                            {
                                CHAIN_ID: 11155111,
                                ASSETS: {
                                    WETH: {
                                        STATIC_A_TOKEN: '0x4444444444444444444444444444444444444444',
                                        A_TOKEN: '0x5555555555555555555555555555555555555555',
                                    },
                                },
                            },
                        ],
                    },
                },
            },
        },
        BASE: {
            chain: { id: 8453, prismaId: 'BASE' },
            aprHandlers: {
                merklAprHandler: true,
            },
        },
        MAINNET: {
            chain: { id: 1, prismaId: 'MAINNET' },
            aprHandlers: {
                merklAprHandler: true,
            },
        },
        MONAD: {
            chain: { id: 143, prismaId: 'MONAD' },
            aprHandlers: {
                merklAprHandler: true,
            },
        },
    },
}));

type Opportunity = {
    chainId: number;
    identifier: string;
    dailyRewards: number;
    explorerAddress: string;
    apr: number;
    campaigns?: { params?: { whitelist?: string[] } }[];
};

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
    return {
        chainId: 11155111,
        identifier: POOL,
        dailyRewards: 1,
        explorerAddress: POOL,
        apr: 10,
        campaigns: [{ params: { whitelist: [] } }],
        ...overrides,
    };
}

function pool(overrides: Record<string, unknown> = {}): PoolAPRData {
    return {
        id: 'pool-1',
        address: POOL,
        chain: Chain.SEPOLIA,
        tokens: [
            {
                address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                balanceUSD: 100,
                token: { underlyingTokenAddress: null },
            },
        ],
        dynamicData: { totalLiquidity: 100 },
        ...overrides,
    } as unknown as PoolAPRData;
}

function json(body: unknown, init?: ResponseInit) {
    return Promise.resolve(new Response(JSON.stringify(body), init));
}

describe('MerklAprHandler', () => {
    const noSleep = () => Promise.resolve();
    const handler = new MerklAprHandler({ sleep: noSleep, batchDelayMs: 0, retryBaseDelayMs: 0 });
    const previousKey = env.MERKL_API_KEY;

    beforeEach(() => {
        clearMerklResponseCache();
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
        env.MERKL_API_KEY = undefined;
    });

    afterEach(() => {
        clearMerklResponseCache();
        env.MERKL_API_KEY = previousKey;
        vi.unstubAllGlobals();
    });

    it('names itself MerklAprHandler and owns MERKL APR type', () => {
        expect(handler.getAprServiceName()).toBe('MerklAprHandler');
        expect(handler.getAprTypes()).toEqual([PrismaPoolAprType.MERKL]);
    });

    it('turns a live pool opportunity into an APR fraction and sends the API key', async () => {
        env.MERKL_API_KEY = 'merkl-test-key';
        fetchMock.mockImplementation((url: string) => {
            if (String(url).includes('mainProtocolId=frontier')) return json([opportunity({ apr: 12.5 })]);
            return json([]);
        });

        const items = await handler.calculateAprForPools([pool()]);

        expect(items).toEqual([
            expect.objectContaining({
                id: 'pool-1-merkl',
                type: PrismaPoolAprType.MERKL,
                title: 'Merkl Rewards',
                chain: Chain.SEPOLIA,
                poolId: 'pool-1',
                apr: 0.125,
            }),
        ]);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('mainProtocolId=frontier&chainId=11155111&page=0&items=100'),
            expect.objectContaining({
                headers: { 'X-API-Key': 'merkl-test-key' },
            }),
        );
    });

    it('drops whitelisted campaigns, other chains, and pools with no liquidity, and tolerates missing campaign params', async () => {
        fetchMock.mockImplementation((url: string) => {
            if (!String(url).includes('mainProtocolId=frontier')) return json([]);
            return json([
                opportunity({ campaigns: [{ params: { whitelist: ['0xabc'] } }] }),
                opportunity({ chainId: 1, identifier: POOL }),
                opportunity({ identifier: '0xcccccccccccccccccccccccccccccccccccccccc' }),
                opportunity({ apr: 5, campaigns: [{ params: {} }] }),
            ]);
        });

        const items = await handler.calculateAprForPools([
            pool(),
            pool({
                id: 'empty',
                address: POOL,
                dynamicData: { totalLiquidity: 0 },
            }),
        ]);

        expect(items).toEqual([expect.objectContaining({ poolId: 'pool-1', apr: 0.05 })]);
        expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ headers: {} }));
    });

    it('sums pool and token opportunities that land on the same pool and scopes token lookups by chainId', async () => {
        fetchMock.mockImplementation((url: string) => {
            if (String(url).includes('mainProtocolId=frontier')) return json([opportunity({ apr: 10 })]);
            return json([
                opportunity({
                    explorerAddress: A_TOKEN,
                    apr: 20,
                    campaigns: [{ params: { whitelist: ['ignored-for-token-opportunities'] } }],
                }),
            ]);
        });

        const items = await handler.calculateAprForPools([
            pool({
                tokens: [
                    {
                        address: WRAPPER,
                        balanceUSD: 25,
                        token: { underlyingTokenAddress: '0xunderlying' },
                    },
                    {
                        address: STATA,
                        balanceUSD: 75,
                        token: { underlyingTokenAddress: null },
                    },
                ],
            }),
        ]);

        // Pool APR 10% plus the wrapper's 20% scaled by its 25/100 share of TVL.
        expect(items).toHaveLength(1);
        expect(items[0].apr).toBeCloseTo(0.1 + 0.2 * 0.25);
        expect(String(fetchMock.mock.calls[1][0])).toContain(`chainId=11155111&explorerAddress=${A_TOKEN}`);
        expect(String(fetchMock.mock.calls[1][0])).not.toContain(WRAPPER);
    });

    it('asks Merkl once per underlying token in batches of 4 and skips trailing batch sleep', async () => {
        const sleepMock = vi.fn().mockResolvedValue(undefined);
        const pacedHandler = new MerklAprHandler({ sleep: sleepMock, batchDelayMs: 300 });
        const tokens = Array.from({ length: 11 }, (_, index) => {
            const address = `0x${(index + 1).toString(16).padStart(40, '0')}`;
            return {
                address,
                balanceUSD: 1,
                token: { underlyingTokenAddress: '0xunderlying' },
            };
        });
        fetchMock.mockImplementation(() => json([]));

        await pacedHandler.calculateAprForPools([pool({ tokens })]);

        const tokenCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('explorerAddress='));
        expect(tokenCalls).toHaveLength(11);
        expect(fetchMock).toHaveBeenCalledTimes(12);
        // 11 tokens in batches of 4 -> 3 batches -> 2 sleeps between batches (no sleep after final batch)
        expect(sleepMock).toHaveBeenCalledTimes(2);
        expect(sleepMock).toHaveBeenCalledWith(300);
    });

    it('paginates through opportunities when a page returns 100 items and stops on a short page', async () => {
        const fullPage = Array.from({ length: 100 }, (_, i) =>
            opportunity({ identifier: `0x${i.toString(16).padStart(40, '0')}`, apr: 1 }),
        );
        fetchMock.mockImplementation((url: string) => {
            const urlStr = String(url);
            if (urlStr.includes('page=0')) return json(fullPage);
            if (urlStr.includes('page=1')) return json([opportunity({ apr: 15 })]);
            return json([]);
        });

        const items = await handler.calculateAprForPools([pool()]);

        expect(items).toEqual([expect.objectContaining({ poolId: 'pool-1', apr: 0.15 })]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(String(fetchMock.mock.calls[0][0])).toContain('page=0&items=100');
        expect(String(fetchMock.mock.calls[1][0])).toContain('page=1&items=100');
    });

    it('caches successful responses across handler instances until max-age expires', async () => {
        let nowMs = 1_000_000;
        const firstHandler = new MerklAprHandler({ now: () => nowMs, sleep: noSleep });
        const secondHandler = new MerklAprHandler({ now: () => nowMs, sleep: noSleep });

        fetchMock.mockImplementation(() =>
            json([opportunity({ apr: 12 })], {
                headers: { 'Cache-Control': 'public, max-age=120' },
            }),
        );

        const firstItems = await firstHandler.calculateAprForPools([pool()]);
        nowMs += 60_000;
        const cachedItems = await secondHandler.calculateAprForPools([pool()]);

        expect(firstItems).toEqual([expect.objectContaining({ apr: 0.12 })]);
        expect(cachedItems).toEqual([expect.objectContaining({ apr: 0.12 })]);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        nowMs += 60_000; // 120s elapsed -> expired
        fetchMock.mockImplementation(() =>
            json([opportunity({ apr: 18 })], {
                headers: { 'Cache-Control': 'public, max-age=120' },
            }),
        );

        const refreshedItems = await secondHandler.calculateAprForPools([pool()]);
        expect(refreshedItems).toEqual([expect.objectContaining({ apr: 0.18 })]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('deduplicates concurrent in-flight requests for the same URL', async () => {
        let resolveFetch!: (value: Response) => void;
        fetchMock.mockImplementationOnce(
            () =>
                new Promise<Response>((resolve) => {
                    resolveFetch = resolve;
                }),
        );

        const firstHandler = new MerklAprHandler({ sleep: noSleep });
        const secondHandler = new MerklAprHandler({ sleep: noSleep });

        const p1 = firstHandler.calculateAprForPools([pool()]);
        const p2 = secondHandler.calculateAprForPools([pool()]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        resolveFetch(new Response(JSON.stringify([opportunity({ apr: 9 })])));

        const [res1, res2] = await Promise.all([p1, p2]);
        expect(res1).toEqual([expect.objectContaining({ apr: 0.09 })]);
        expect(res2).toEqual([expect.objectContaining({ apr: 0.09 })]);
    });

    it('retries on 429 using Retry-After and does not cache failures', async () => {
        const sleepMock = vi.fn().mockResolvedValue(undefined);
        const retryHandler = new MerklAprHandler({ sleep: sleepMock, retryBaseDelayMs: 500, maxRetries: 2 });

        fetchMock
            .mockImplementationOnce(() =>
                json(
                    { message: 'rate limited' },
                    { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '2' } },
                ),
            )
            .mockImplementationOnce(() =>
                json({ message: 'upstream error' }, { status: 503, statusText: 'Service Unavailable' }),
            )
            .mockImplementationOnce(() => json([opportunity({ apr: 14 })]));

        const items = await retryHandler.calculateAprForPools([pool()]);

        expect(items).toEqual([expect.objectContaining({ apr: 0.14 })]);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(sleepMock).toHaveBeenNthCalledWith(1, 2_000);
        expect(sleepMock).toHaveBeenNthCalledWith(2, 1_000);
    });

    it('throws after exhausting retries on 429 and allows subsequent calls to retry', async () => {
        const sleepMock = vi.fn().mockResolvedValue(undefined);
        const retryHandler = new MerklAprHandler({ sleep: sleepMock, retryBaseDelayMs: 100, maxRetries: 2 });

        fetchMock.mockImplementation(() =>
            json({ message: 'rate limited' }, { status: 429, statusText: 'Too Many Requests' }),
        );

        await expect(retryHandler.calculateAprForPools([pool()])).rejects.toThrow(
            'Merkl API error: 429 Too Many Requests',
        );
        expect(fetchMock).toHaveBeenCalledTimes(3);

        // Failures were not cached, so a later call fetches again.
        fetchMock.mockImplementationOnce(() => json([opportunity({ apr: 7 })]));
        const recovered = await retryHandler.calculateAprForPools([pool()]);
        expect(recovered).toEqual([expect.objectContaining({ apr: 0.07 })]);
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('does not retry on non-retryable 400 responses', async () => {
        const sleepMock = vi.fn().mockResolvedValue(undefined);
        const retryHandler = new MerklAprHandler({ sleep: sleepMock, retryBaseDelayMs: 100, maxRetries: 2 });

        fetchMock.mockImplementation(() =>
            json({ message: 'bad request' }, { status: 400, statusText: 'Bad Request' }),
        );

        await expect(retryHandler.calculateAprForPools([pool()])).rejects.toThrow('Merkl API error: 400 Bad Request');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(sleepMock).not.toHaveBeenCalled();
    });

    it('maps wrappers across all configured Aave markets on the same chain', async () => {
        fetchMock.mockImplementation((url: string) => {
            if (String(url).includes('mainProtocolId=frontier')) return json([]);
            return json([
                opportunity({
                    explorerAddress: SECOND_MARKET_A_TOKEN,
                    apr: 8,
                    campaigns: [{ params: { whitelist: [] } }],
                }),
            ]);
        });

        const items = await handler.calculateAprForPools([
            pool({
                tokens: [
                    {
                        address: SECOND_MARKET_WRAPPER,
                        balanceUSD: 100,
                        token: { underlyingTokenAddress: '0xunderlying' },
                    },
                ],
            }),
        ]);

        expect(items).toEqual([expect.objectContaining({ poolId: 'pool-1', apr: 0.08 })]);
        expect(String(fetchMock.mock.calls[1][0])).toContain(SECOND_MARKET_A_TOKEN);
        expect(String(fetchMock.mock.calls[1][0])).not.toContain(SECOND_MARKET_WRAPPER);
    });

    it('rejects an empty pool list', async () => {
        fetchMock.mockImplementation(() => json([]));
        await expect(handler.calculateAprForPools([])).rejects.toThrow();
    });
});

describe('APR handler chain gating', () => {
    it('enables MerklAprHandler only on chains with aprHandlers.merklAprHandler set', () => {
        expect(createHandlers(Chain.SEPOLIA).map((h) => h.getAprServiceName())).not.toContain('MerklAprHandler');
        expect(createHandlers(Chain.BASE).map((h) => h.getAprServiceName())).toContain('MerklAprHandler');
        expect(createHandlers(Chain.MAINNET).map((h) => h.getAprServiceName())).toContain('MerklAprHandler');
        expect(createHandlers(Chain.MONAD).map((h) => h.getAprServiceName())).toContain('MerklAprHandler');
    });
});
