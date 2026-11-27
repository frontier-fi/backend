import { Chain, PrismaPoolAprType } from '@prisma/client';
import {
    ContractFunctionExecutionError,
    ContractFunctionRevertedError,
    ContractFunctionZeroDataError,
    InternalRpcError,
} from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../../../apps/env';
import type { PoolAPRData } from '../../types';
import { aaveV4TokenizationSpokeAbi } from '../../../token-yields/handlers/sources/aave-v4-onchain-handler';
import { clearMerklResponseCache, MerklAprHandler } from './merkl-apr-handler';
import { createHandlers } from '../create-handlers';

const fetchMock = vi.fn();
const multicallMock = vi.fn();

vi.mock('../../../sources/viem-client', () => ({
    getViemClient: () => ({
        multicall: (params: any) => multicallMock(params),
    }),
}));

const WRAPPER = '0x1111111111111111111111111111111111111111';
const STATA = '0x2222222222222222222222222222222222222222';
const A_TOKEN = '0x3333333333333333333333333333333333333333';
const SECOND_MARKET_WRAPPER = '0x4444444444444444444444444444444444444444';
const SECOND_MARKET_A_TOKEN = '0x5555555555555555555555555555555555555555';
const POOL = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND_POOL = '0xdddddddddddddddddddddddddddddddddddddddd';
const VAULT = '0xff00009c1a83ec25434522ef355b99e9a70000ff';
const CORE_HUB = '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9';
const GLOBAL_DOLLAR_HUB = '0x62d63197660c080236193ca60b70e49a08e90368';
const OTHER_HUB = '0x06002e9c4412cb7814a791ea3666d905871e536a';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const USDG = '0xe343167631d89b6ffc58b88d6b7fb0228795491d';
const BTCB = '0x152b9d0fdc40c096757f570a51e494bd4b943e50';
const WA_CORE_USDC = '0x531e90a2376902de8915789fcc1075e3b0c153e7';
const WA_CORE_USDT = '0x5ec44a70f309854fe04d495cfe1b5da63dd1cc73';
const WA_CORE_BTCB = '0x6666666666666666666666666666666666666666';
const WA_GLOBAL_DOLLAR_USDG = '0x378b4a7c394e22bd562f66eb612165893533c124';
const WA_CORE_CIRBTC = '0x092508a2eb395cb3861a3fdb65405744d706476f';
const CIRBTC = '0x72dfb2e44f59c5ad2bafe84314e5b99a7cd5075e';
const NON_V4_WRAPPER = '0x7777777777777777777777777777777777777777';
const BASE_EQUITIES_HUB = '0xa4d5947eb727a052bae69c593ffc84247ec9864e';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WA_EQUITIES_USDC = '0x7081ce7eb1282c53cf38ea9b622f6269cb8fefdc';

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
            contracts: {
                Vault: '0xff00009c1a83ec25434522ef355b99e9a70000ff',
            },
            aprHandlers: {
                merklAprHandler: true,
                ybAprHandler: {
                    aaveV4: {
                        markets: [
                            {
                                CHAIN_ID: 8453,
                                HUBS: {
                                    EQUITIES_HUB: '0xa4d5947Eb727A052bae69C593FfC84247EC9864E',
                                },
                                TOKENIZATION_SPOKES: {
                                    EQUITIES_USDC_TOKENIZATION_SPOKE: '0x7081CE7EB1282c53CF38EA9B622f6269cb8FeFDc',
                                },
                                ASSETS: {
                                    USDC: { UNDERLYING: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
                                },
                            },
                        ],
                    },
                },
            },
        },
        MAINNET: {
            chain: { id: 1, prismaId: 'MAINNET' },
            contracts: {
                Vault: '0xff00009c1a83ec25434522ef355b99e9a70000ff',
            },
            aprHandlers: {
                merklAprHandler: true,
                ybAprHandler: {
                    aaveV4: {
                        markets: [
                            {
                                CHAIN_ID: 1,
                                HUBS: {
                                    CORE_HUB: '0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9',
                                    GLOBAL_DOLLAR_HUB: '0x62d63197660c080236193CA60b70E49A08E90368',
                                },
                                TOKENIZATION_SPOKES: {
                                    CORE_USDC_TOKENIZATION_SPOKE: '0x531E90a2376902DE8915789Fcc1075e3B0c153E7',
                                    CORE_USDT_TOKENIZATION_SPOKE: '0x5eC44a70F309854fe04d495cFE1B5dA63DD1cc73',
                                    CORE_BTCb_TOKENIZATION_SPOKE: '0x6666666666666666666666666666666666666666',
                                    GLOBAL_DOLLAR_USDG_TOKENIZATION_SPOKE: '0x378B4a7c394E22bd562F66eB612165893533c124',
                                },
                                ASSETS: {
                                    USDC: { UNDERLYING: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
                                    USDT: { UNDERLYING: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
                                    USDG: { UNDERLYING: '0xe343167631d89B6Ffc58B88d6b7fB0228795491D' },
                                    'BTC.b': { UNDERLYING: '0x152b9d0FdC40C096757F570A51E494bd4b943E50' },
                                },
                            },
                        ],
                    },
                },
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
    id?: string;
    type?: string;
    action?: string;
    status?: string;
    chainId: number;
    identifier: string;
    dailyRewards: number;
    tvl?: number;
    explorerAddress?: string;
    apr: number;
    nativeApr?: number;
    totalApr?: number;
    tokens?: { address?: string; symbol?: string }[];
    rewardsRecord?: { breakdowns?: { token?: { address?: string; symbol?: string } }[] };
    campaigns?: {
        id?: string;
        campaignId?: string;
        parentCampaignId?: string | null;
        childCampaignIds?: string[];
        rewardToken?: { address?: string; symbol?: string };
        params?: {
            whitelist?: string[];
            blacklist?: string[];
            hooks?: unknown[];
            forwardingEnabled?: boolean;
            hubAddress?: string;
            underlyingToken?: string;
            hubs?: {
                hubAddress?: string;
                lendingAssetIds?: (string | number)[];
                assets?: { assetId?: string | number; underlyingToken?: string }[];
            }[];
        };
    }[];
};

function revertError(functionName = 'hub') {
    return new ContractFunctionExecutionError(
        new ContractFunctionRevertedError({
            abi: aaveV4TokenizationSpokeAbi,
            functionName,
        }),
        {
            abi: aaveV4TokenizationSpokeAbi,
            contractAddress: NON_V4_WRAPPER,
            functionName,
        },
    );
}

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
    return {
        id: '3250124745872902091',
        chainId: 11155111,
        identifier: POOL,
        dailyRewards: 1,
        explorerAddress: POOL,
        apr: 10,
        campaigns: [
            {
                rewardToken: { address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', symbol: 'WMON' },
                params: { whitelist: [] },
            },
        ],
        ...overrides,
    };
}

function pool(overrides: Record<string, unknown> = {}): PoolAPRData {
    return {
        id: 'pool-1',
        address: POOL,
        symbol: '0xFF-avUSD-waMonUSDC',
        chain: Chain.SEPOLIA,
        tokens: [
            {
                address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                balanceUSD: 100,
                token: { symbol: 'avUSD', underlyingTokenAddress: null },
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
        multicallMock.mockReset();
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

    it('turns a live pool opportunity into an APR fraction with opportunity id, pool symbol, reward token, and sends the API key', async () => {
        env.MERKL_API_KEY = 'merkl-test-key';
        fetchMock.mockImplementation((url: string) => {
            if (String(url).includes('mainProtocolId=frontier')) return json([opportunity({ apr: 12.5 })]);
            return json([]);
        });

        const items = await handler.calculateAprForPools([pool()]);

        expect(items).toEqual([
            expect.objectContaining({
                id: 'pool-1-merkl-3250124745872902091',
                type: PrismaPoolAprType.MERKL,
                title: '0xFF-avUSD-waMonUSDC',
                chain: Chain.SEPOLIA,
                poolId: 'pool-1',
                apr: 0.125,
                rewardTokenAddress: '0x3bd359c1119da7da1d913d1c4d2b7c461115433a',
                rewardTokenSymbol: 'WMON',
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
                opportunity({ id: '1', campaigns: [{ params: { whitelist: ['0xabc'] } }] }),
                opportunity({ id: '2', chainId: 1, identifier: POOL }),
                opportunity({ id: '3', identifier: '0xcccccccccccccccccccccccccccccccccccccccc' }),
                opportunity({ id: '4', apr: 5, campaigns: [{ params: {} }] }),
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

        expect(items).toEqual([expect.objectContaining({ id: 'pool-1-merkl-4', poolId: 'pool-1', apr: 0.05 })]);
        expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ headers: {} }));
    });

    it('emits separate APR items for pool and direct wrapped-token opportunities without falling back to the Aave aToken', async () => {
        fetchMock.mockImplementation((url: string) => {
            const urlStr = String(url);
            if (urlStr.includes('mainProtocolId=frontier')) {
                return json([opportunity({ id: '3250124745872902091', apr: 10 })]);
            }
            if (urlStr.includes(`explorerAddress=${WRAPPER}`)) {
                return json([
                    opportunity({
                        id: '9212343318075137075',
                        explorerAddress: WRAPPER,
                        identifier: WRAPPER,
                        apr: 1.08,
                        campaigns: [
                            {
                                rewardToken: { address: '0x561Ad6156D0106E7a59EE788759dF7B7Ec679BD0', symbol: 'WMON' },
                                params: { whitelist: [] },
                            },
                        ],
                    }),
                ]);
            }
            // Should never be queried because WRAPPER already had a direct live opportunity
            return json([
                opportunity({
                    id: '16304919407637138722',
                    type: 'AAVE_NET_LENDING',
                    explorerAddress: A_TOKEN,
                    apr: 5.4,
                }),
            ]);
        });

        const items = await handler.calculateAprForPools([
            pool({
                tokens: [
                    {
                        address: WRAPPER,
                        balanceUSD: 25,
                        token: { symbol: 'waMonUSDC', underlyingTokenAddress: '0xunderlying' },
                    },
                    {
                        address: STATA,
                        balanceUSD: 75,
                        token: { symbol: 'avUSD', underlyingTokenAddress: null },
                    },
                ],
            }),
        ]);

        expect(items).toHaveLength(2);
        expect(items[0]).toEqual(
            expect.objectContaining({
                id: 'pool-1-merkl-3250124745872902091',
                title: '0xFF-avUSD-waMonUSDC',
                apr: 0.1,
                rewardTokenSymbol: 'WMON',
            }),
        );
        expect(items[1]).toEqual(
            expect.objectContaining({
                id: 'pool-1-merkl-9212343318075137075',
                title: 'waMonUSDC',
                rewardTokenSymbol: 'WMON',
            }),
        );
        expect(items[1].apr).toBeCloseTo(0.0108 * 0.25);
        expect(String(fetchMock.mock.calls[1][0])).toContain(
            `campaigns=true&chainId=11155111&explorerAddress=${WRAPPER}`,
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('falls back to Aave aToken when wrapper has no direct opportunity and caps AAVE_NET_LENDING APR by realized gross APR', async () => {
        fetchMock.mockImplementation((url: string) => {
            const urlStr = String(url);
            if (urlStr.includes('mainProtocolId=frontier')) return json([]);
            if (urlStr.includes(`explorerAddress=${WRAPPER}`)) return json([]);
            if (urlStr.includes(`explorerAddress=${A_TOKEN}`)) {
                return json([
                    opportunity({
                        id: '16304919407637138722',
                        type: 'AAVE_NET_LENDING',
                        explorerAddress: A_TOKEN,
                        apr: 5.4,
                        dailyRewards: 2480.77,
                        tvl: 84_370_801,
                    }),
                ]);
            }
            return json([]);
        });

        const items = await handler.calculateAprForPools([
            pool({
                tokens: [
                    {
                        address: WRAPPER,
                        balanceUSD: 50,
                        token: { symbol: 'waMonUSDC', underlyingTokenAddress: '0xunderlying' },
                    },
                    {
                        address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                        balanceUSD: 50,
                        token: { symbol: 'avUSD', underlyingTokenAddress: null },
                    },
                ],
            }),
        ]);

        const expectedRealizedApr = ((2480.77 * 365) / 84_370_801) * 0.5;
        expect(items).toHaveLength(1);
        expect(items[0]).toEqual(
            expect.objectContaining({
                id: 'pool-1-merkl-16304919407637138722',
                title: 'waMonUSDC',
            }),
        );
        expect(items[0].apr).toBeCloseTo(expectedRealizedApr, 6);
    });

    it('filters out whitelisted token opportunities', async () => {
        fetchMock.mockImplementation((url: string) => {
            if (String(url).includes('mainProtocolId=frontier')) return json([]);
            return json([
                opportunity({
                    id: '999',
                    explorerAddress: WRAPPER,
                    apr: 20,
                    campaigns: [{ params: { whitelist: ['0xonly-me'] } }],
                }),
            ]);
        });

        const items = await handler.calculateAprForPools([
            pool({
                tokens: [
                    {
                        address: WRAPPER,
                        balanceUSD: 100,
                        token: { symbol: 'waMonUSDC', underlyingTokenAddress: '0xunderlying' },
                    },
                ],
            }),
        ]);

        expect(items).toEqual([]);
    });

    it('asks Merkl once per underlying token in batches of 4 and skips trailing batch sleep', async () => {
        const sleepMock = vi.fn().mockResolvedValue(undefined);
        const pacedHandler = new MerklAprHandler({ sleep: sleepMock, batchDelayMs: 300 });
        const tokens = Array.from({ length: 11 }, (_, index) => {
            const address = `0x${(index + 10).toString(16).padStart(40, '0')}`;
            return {
                address,
                balanceUSD: 1,
                token: { symbol: `T${index}`, underlyingTokenAddress: '0xunderlying' },
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
            opportunity({ id: `page0-${i}`, identifier: `0x${i.toString(16).padStart(40, '0')}`, apr: 1 }),
        );
        fetchMock.mockImplementation((url: string) => {
            const urlStr = String(url);
            if (urlStr.includes('page=0')) return json(fullPage);
            if (urlStr.includes('page=1')) return json([opportunity({ id: 'page1-0', apr: 15 })]);
            return json([]);
        });

        const items = await handler.calculateAprForPools([pool()]);

        expect(items).toEqual([expect.objectContaining({ id: 'pool-1-merkl-page1-0', poolId: 'pool-1', apr: 0.15 })]);
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

    it('maps wrappers across all configured Aave markets on the same chain when wrapper has no direct opportunity', async () => {
        fetchMock.mockImplementation((url: string) => {
            const urlStr = String(url);
            if (urlStr.includes('mainProtocolId=frontier')) return json([]);
            if (urlStr.includes(`explorerAddress=${SECOND_MARKET_WRAPPER}`)) return json([]);
            return json([
                opportunity({
                    id: 'second-market-opp',
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
                        token: { symbol: 'waWETH', underlyingTokenAddress: '0xunderlying' },
                    },
                ],
            }),
        ]);

        expect(items).toEqual([
            expect.objectContaining({
                id: 'pool-1-merkl-second-market-opp',
                title: 'waWETH',
                poolId: 'pool-1',
                apr: 0.08,
            }),
        ]);
        expect(String(fetchMock.mock.calls[1][0])).toContain(SECOND_MARKET_WRAPPER);
        expect(String(fetchMock.mock.calls[2][0])).toContain(SECOND_MARKET_A_TOKEN);
    });

    it('prefers a direct opportunity on an Aave V4 tokenization spoke over Aave V4 Hub fallback', async () => {
        fetchMock.mockImplementation((url: string) => {
            const urlStr = String(url);
            if (urlStr.includes(`explorerAddress=${WA_CORE_USDC}`)) {
                return json([
                    opportunity({
                        id: 'direct-wacoreusdc',
                        chainId: 1,
                        identifier: WA_CORE_USDC,
                        explorerAddress: WA_CORE_USDC,
                        apr: 1.5,
                        campaigns: [
                            {
                                rewardToken: { address: USDC, symbol: 'USDC' },
                                params: { whitelist: [] },
                            },
                        ],
                    }),
                ]);
            }
            return json([]);
        });

        const items = await handler.calculateAprForPools([
            pool({
                chain: Chain.MAINNET,
                tokens: [
                    {
                        address: WA_CORE_USDC,
                        balanceUSD: 50,
                        token: { symbol: 'waCoreUSDC', underlyingTokenAddress: USDC },
                    },
                    {
                        address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                        balanceUSD: 50,
                        token: { symbol: 'avUSD', underlyingTokenAddress: null },
                    },
                ],
            }),
        ]);

        expect(items).toHaveLength(1);
        expect(items[0]).toEqual(
            expect.objectContaining({
                id: 'pool-1-merkl-direct-wacoreusdc',
                title: 'waCoreUSDC',
                chain: Chain.MAINNET,
                rewardTokenAddress: USDC,
                rewardTokenSymbol: 'USDC',
            }),
        );
        expect(items[0].apr).toBeCloseTo(0.015 * 0.5, 6);
        expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('mainProtocolId=aave'))).toBe(false);
    });

    it('prefers linked pool opportunities over Hub fallback and falls back to eligible Hub campaigns when no linked pool opportunity exists', async () => {
        fetchMock.mockImplementation((url: string) => {
            const urlStr = String(url);
            if (urlStr.includes('mainProtocolId=aave&chainId=1')) {
                return json([
                    // No linked campaigns (childCampaignIds: []) -> falls back to Hub APR (nativeApr stripped, scaled by token TVL share) without querying /linked
                    opportunity({
                        id: '17152770703637026650',
                        type: 'AAVE_V4_HUB_NET_LENDING',
                        action: 'LEND',
                        chainId: 1,
                        identifier: 'f5f71e5054c40630',
                        explorerAddress: undefined,
                        apr: 5.285583423837524,
                        nativeApr: 4.07373595819466,
                        totalApr: 5.285583423837524,
                        dailyRewards: 3570.98,
                        tvl: 106_719_329,
                        rewardsRecord: {
                            breakdowns: [{ token: { address: USDC, symbol: 'USDC' } }],
                        },
                        campaigns: [
                            {
                                id: '13470053144558108519',
                                childCampaignIds: [],
                                rewardToken: { address: USDC, symbol: 'USDC' },
                                params: {
                                    whitelist: [],
                                    blacklist: [],
                                    hooks: [],
                                    forwardingEnabled: true,
                                    hubs: [
                                        {
                                            hubAddress: CORE_HUB,
                                            lendingAssetIds: ['5'],
                                            assets: [
                                                { assetId: '5', underlyingToken: USDC },
                                                { assetId: '4', underlyingToken: USDT },
                                            ],
                                        },
                                    ],
                                },
                            },
                        ],
                    }),
                    // Unlinked Hub campaign whose target APR exceeds realized gross APR -> capped to realized 1%
                    opportunity({
                        id: 'capped-net-lending',
                        type: 'AAVE_V4_HUB_NET_LENDING',
                        action: 'LEND',
                        chainId: 1,
                        identifier: '0x9999999999999999999999999999999999999999',
                        explorerAddress: undefined,
                        apr: 8,
                        nativeApr: 4,
                        totalApr: 8,
                        dailyRewards: 100,
                        tvl: 3_650_000,
                        campaigns: [
                            {
                                id: 'capped-net-lending-campaign',
                                childCampaignIds: [],
                                rewardToken: { address: USDC, symbol: 'USDC' },
                                params: {
                                    whitelist: [],
                                    hooks: [],
                                    forwardingEnabled: true,
                                    hubs: [
                                        {
                                            hubAddress: CORE_HUB,
                                            lendingAssetIds: ['5'],
                                            assets: [{ assetId: '5', underlyingToken: USDC }],
                                        },
                                    ],
                                },
                            },
                        ],
                    }),
                    // Has a 2-hop linked path reaching the pool LPs (Hub -> Spoke -> Pool) -> prefers linked pool APR and suppresses Hub fallback
                    opportunity({
                        id: 'forwarded-hub-opp',
                        type: 'AAVE_V4_HUB_NET_LENDING',
                        action: 'LEND',
                        chainId: 1,
                        identifier: 'hub-forwarded',
                        explorerAddress: undefined,
                        apr: 6,
                        nativeApr: 4,
                        totalApr: 6,
                        dailyRewards: 5000,
                        tvl: 50_000_000,
                        campaigns: [
                            {
                                id: 'parent-forwarded-to-pool',
                                childCampaignIds: ['child-spoke'],
                                rewardToken: { address: USDC, symbol: 'USDC' },
                                params: {
                                    whitelist: [],
                                    blacklist: [],
                                    hooks: [],
                                    forwardingEnabled: true,
                                    hubs: [
                                        {
                                            hubAddress: CORE_HUB,
                                            lendingAssetIds: ['5'],
                                            assets: [
                                                { assetId: '5', underlyingToken: USDC },
                                                { assetId: '4', underlyingToken: USDT },
                                            ],
                                        },
                                    ],
                                },
                            },
                        ],
                    }),
                ]);
            }
            if (urlStr.includes('/v4/campaigns/parent-forwarded-to-pool/linked?campaigns=true')) {
                return json({
                    self: 'parent-forwarded-to-pool',
                    nodes: [
                        {
                            campaignId: 'parent-forwarded-to-pool',
                            parentCampaignId: null,
                            opportunity: { id: 'forwarded-hub-opp', chainId: 1, status: 'LIVE', apr: 6 },
                        },
                        {
                            campaignId: 'child-spoke',
                            parentCampaignId: 'parent-forwarded-to-pool',
                            opportunity: {
                                id: 'spoke-intermediate-opp',
                                type: 'ERC20LOGPROCESSOR',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: WA_CORE_USDC,
                                explorerAddress: WA_CORE_USDC,
                                apr: 1.8,
                                dailyRewards: 200,
                                campaigns: [
                                    {
                                        id: 'child-spoke',
                                        params: { whitelist: [], blacklist: [], hooks: [], forwardingEnabled: true },
                                    },
                                ],
                            },
                        },
                        {
                            campaignId: 'grandchild-pool',
                            onChainCampaignId: '77001',
                            parentCampaignId: 'child-spoke',
                            opportunity: {
                                id: '991234567890',
                                type: 'ERC20LOGPROCESSOR',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: POOL,
                                explorerAddress: POOL,
                                apr: 0.92,
                                dailyRewards: 45,
                                aprRecord: {
                                    cumulated: 0.92,
                                    breakdowns: [{ identifier: '77001', type: 'CAMPAIGN', value: 0.92 }],
                                },
                                rewardsRecord: {
                                    breakdowns: [{ token: { address: USDC, symbol: 'USDC' } }],
                                },
                                campaigns: [
                                    // Historical restricted campaign on the same opportunity must not disqualify the active linked campaign
                                    {
                                        id: 'historical-ended-campaign',
                                        params: { whitelist: ['0x123'], blacklist: [], hooks: [] },
                                    },
                                    {
                                        id: 'grandchild-pool',
                                        campaignId: '77001',
                                        params: { whitelist: [], blacklist: [], hooks: [] },
                                    },
                                ],
                            },
                        },
                        {
                            campaignId: 'grandchild-past-pool',
                            parentCampaignId: 'child-spoke',
                            opportunity: {
                                id: 'linked-past-pool-opp',
                                type: 'ERC20LOGPROCESSOR',
                                chainId: 1,
                                status: 'PAST',
                                identifier: POOL,
                                explorerAddress: POOL,
                                apr: 3,
                                dailyRewards: 100,
                                campaigns: [
                                    {
                                        id: 'grandchild-past-pool',
                                        params: { whitelist: [], blacklist: [], hooks: [] },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }
            return json([]);
        });

        const items = await handler.calculateAprForPools([
            pool({
                chain: Chain.MAINNET,
                tokens: [
                    {
                        address: WA_CORE_USDC,
                        balanceUSD: 50,
                        token: { symbol: 'waCoreUSDC', underlyingTokenAddress: USDC },
                    },
                    {
                        address: WA_CORE_USDT,
                        balanceUSD: 50,
                        token: { symbol: 'waCoreUSDT', underlyingTokenAddress: USDT },
                    },
                ],
            }),
        ]);

        expect(items).toHaveLength(3);
        // Forwarded Hub campaign used its LIVE linked pool opportunity and did NOT emit forwarded-hub-opp
        expect(items[0]).toEqual(
            expect.objectContaining({
                id: 'pool-1-aave-v4-merkl-991234567890',
                title: '0xFF-avUSD-waMonUSDC',
                chain: Chain.MAINNET,
                poolId: 'pool-1',
                apr: 0.0092,
                rewardTokenAddress: USDC,
                rewardTokenSymbol: 'USDC',
            }),
        );
        // Unlinked Hub campaign fell back to nativeApr-stripped Hub APR scaled by tokenShareOfPoolTvl (borrow-only USDT ignored)
        expect(items[1]).toEqual(
            expect.objectContaining({
                id: 'pool-1-aave-v4-merkl-17152770703637026650',
                title: 'waCoreUSDC',
                chain: Chain.MAINNET,
                poolId: 'pool-1',
                rewardTokenAddress: USDC,
                rewardTokenSymbol: 'USDC',
            }),
        );
        expect(items[1].apr).toBeCloseTo(((5.285583423837524 - 4.07373595819466) / 100) * 0.5, 6);
        // Unlinked Hub campaign capped by realized gross APR (1% * 0.5)
        expect(items[2]).toEqual(
            expect.objectContaining({
                id: 'pool-1-aave-v4-merkl-capped-net-lending',
                title: 'waCoreUSDC',
                chain: Chain.MAINNET,
                poolId: 'pool-1',
                rewardTokenAddress: USDC,
                rewardTokenSymbol: 'USDC',
            }),
        );
        expect(items[2].apr).toBeCloseTo(0.01 * 0.5, 6);
        // Campaigns with childCampaignIds: [] were never queried on /linked
        expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('13470053144558108519/linked'))).toBe(
            false,
        );
    });

    it('fails closed when /linked omits campaign details or when any campaign in the linked chain is restricted', async () => {
        const linkedHubCampaign = (id: string) =>
            opportunity({
                id: `hub-${id}`,
                type: 'AAVE_V4_HUB_SUPPLY',
                action: 'LEND',
                chainId: 1,
                apr: 3,
                dailyRewards: 100,
                campaigns: [
                    {
                        id,
                        childCampaignIds: [`child-${id}`],
                        rewardToken: { address: USDC, symbol: 'USDC' },
                        params: {
                            whitelist: [],
                            blacklist: [],
                            hooks: [],
                            forwardingEnabled: true,
                            hubAddress: CORE_HUB,
                            underlyingToken: USDC,
                        },
                    },
                ],
            });

        fetchMock.mockImplementation((url: string) => {
            const urlStr = String(url);
            if (urlStr.includes('mainProtocolId=aave&chainId=1')) {
                return json([
                    linkedHubCampaign('missing-campaigns'),
                    linkedHubCampaign('leaf-whitelisted'),
                    linkedHubCampaign('leaf-pool-blacklisted'),
                    linkedHubCampaign('leaf-vault-blacklisted'),
                    linkedHubCampaign('leaf-has-hooks'),
                    linkedHubCampaign('intermediate-whitelisted'),
                    linkedHubCampaign('intermediate-forwarding-disabled'),
                ]);
            }
            if (urlStr.includes('/v4/campaigns/missing-campaigns/linked?campaigns=true')) {
                return json({
                    self: 'missing-campaigns',
                    nodes: [
                        {
                            campaignId: 'child-missing-campaigns',
                            parentCampaignId: 'missing-campaigns',
                            opportunity: {
                                id: 'opp-missing-campaigns',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: POOL,
                                explorerAddress: POOL,
                                apr: 2,
                                dailyRewards: 50,
                                // campaigns omitted -> must fail closed
                            },
                        },
                    ],
                });
            }
            if (urlStr.includes('/v4/campaigns/leaf-whitelisted/linked?campaigns=true')) {
                return json({
                    self: 'leaf-whitelisted',
                    nodes: [
                        {
                            campaignId: 'child-leaf-whitelisted',
                            parentCampaignId: 'leaf-whitelisted',
                            opportunity: {
                                id: 'opp-leaf-whitelisted',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: POOL,
                                explorerAddress: POOL,
                                apr: 2,
                                dailyRewards: 50,
                                campaigns: [
                                    {
                                        id: 'child-leaf-whitelisted',
                                        params: { whitelist: ['0x123'], blacklist: [], hooks: [] },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }
            if (urlStr.includes('/v4/campaigns/leaf-pool-blacklisted/linked?campaigns=true')) {
                return json({
                    self: 'leaf-pool-blacklisted',
                    nodes: [
                        {
                            campaignId: 'child-leaf-pool-blacklisted',
                            parentCampaignId: 'leaf-pool-blacklisted',
                            opportunity: {
                                id: 'opp-leaf-pool-blacklisted',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: POOL,
                                explorerAddress: POOL,
                                apr: 2,
                                dailyRewards: 50,
                                campaigns: [
                                    {
                                        id: 'child-leaf-pool-blacklisted',
                                        params: { whitelist: [], blacklist: [POOL], hooks: [] },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }
            if (urlStr.includes('/v4/campaigns/leaf-vault-blacklisted/linked?campaigns=true')) {
                return json({
                    self: 'leaf-vault-blacklisted',
                    nodes: [
                        {
                            campaignId: 'child-leaf-vault-blacklisted',
                            parentCampaignId: 'leaf-vault-blacklisted',
                            opportunity: {
                                id: 'opp-leaf-vault-blacklisted',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: POOL,
                                explorerAddress: POOL,
                                apr: 2,
                                dailyRewards: 50,
                                campaigns: [
                                    {
                                        id: 'child-leaf-vault-blacklisted',
                                        params: { whitelist: [], blacklist: [VAULT], hooks: [] },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }
            if (urlStr.includes('/v4/campaigns/leaf-has-hooks/linked?campaigns=true')) {
                return json({
                    self: 'leaf-has-hooks',
                    nodes: [
                        {
                            campaignId: 'child-leaf-has-hooks',
                            parentCampaignId: 'leaf-has-hooks',
                            opportunity: {
                                id: 'opp-leaf-has-hooks',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: POOL,
                                explorerAddress: POOL,
                                apr: 2,
                                dailyRewards: 50,
                                campaigns: [
                                    {
                                        id: 'child-leaf-has-hooks',
                                        params: { whitelist: [], blacklist: [], hooks: [{ hookType: 17 }] },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }
            if (urlStr.includes('/v4/campaigns/intermediate-whitelisted/linked?campaigns=true')) {
                return json({
                    self: 'intermediate-whitelisted',
                    nodes: [
                        {
                            campaignId: 'mid-whitelisted',
                            parentCampaignId: 'intermediate-whitelisted',
                            opportunity: {
                                id: 'opp-mid-whitelisted',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: WA_CORE_USDC,
                                apr: 2,
                                dailyRewards: 50,
                                campaigns: [
                                    {
                                        id: 'mid-whitelisted',
                                        params: { whitelist: ['0xonly'], blacklist: [], hooks: [] },
                                    },
                                ],
                            },
                        },
                        {
                            campaignId: 'child-intermediate-whitelisted',
                            parentCampaignId: 'mid-whitelisted',
                            opportunity: {
                                id: 'opp-leaf-under-mid-whitelisted',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: POOL,
                                apr: 2,
                                dailyRewards: 50,
                                campaigns: [
                                    {
                                        id: 'child-intermediate-whitelisted',
                                        params: { whitelist: [], blacklist: [], hooks: [] },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }
            if (urlStr.includes('/v4/campaigns/intermediate-forwarding-disabled/linked?campaigns=true')) {
                return json({
                    self: 'intermediate-forwarding-disabled',
                    nodes: [
                        {
                            campaignId: 'mid-no-fwd',
                            parentCampaignId: 'intermediate-forwarding-disabled',
                            opportunity: {
                                id: 'opp-mid-no-fwd',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: WA_CORE_USDC,
                                apr: 2,
                                dailyRewards: 50,
                                campaigns: [
                                    {
                                        id: 'mid-no-fwd',
                                        params: {
                                            whitelist: [],
                                            blacklist: [],
                                            hooks: [],
                                            forwardingEnabled: false,
                                        },
                                    },
                                ],
                            },
                        },
                        {
                            campaignId: 'child-intermediate-forwarding-disabled',
                            parentCampaignId: 'mid-no-fwd',
                            opportunity: {
                                id: 'opp-leaf-under-mid-no-fwd',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: POOL,
                                apr: 2,
                                dailyRewards: 50,
                                campaigns: [
                                    {
                                        id: 'child-intermediate-forwarding-disabled',
                                        params: { whitelist: [], blacklist: [], hooks: [] },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }
            return json([]);
        });

        const items = await handler.calculateAprForPools([
            pool({
                chain: Chain.MAINNET,
                tokens: [
                    {
                        address: WA_CORE_USDC,
                        balanceUSD: 100,
                        token: { symbol: 'waCoreUSDC', underlyingTokenAddress: USDC },
                    },
                ],
            }),
        ]);

        expect(items).toEqual([]);
    });

    it('uses only eligible linked campaign APR breakdowns when a restricted campaign shares the same opportunity and fails closed without breakdowns', async () => {
        fetchMock.mockImplementation((url: string) => {
            const urlStr = String(url);
            if (urlStr.includes('mainProtocolId=aave&chainId=1')) {
                return json([
                    opportunity({
                        id: 'hub-usdc',
                        type: 'AAVE_V4_HUB_SUPPLY',
                        action: 'LEND',
                        chainId: 1,
                        apr: 3,
                        dailyRewards: 100,
                        campaigns: [
                            {
                                id: 'hub-usdc-campaign',
                                childCampaignIds: ['leaf-usdc'],
                                rewardToken: { address: USDC, symbol: 'USDC' },
                                params: {
                                    whitelist: [],
                                    blacklist: [],
                                    hooks: [],
                                    forwardingEnabled: true,
                                    hubAddress: CORE_HUB,
                                    underlyingToken: USDC,
                                },
                            },
                        ],
                    }),
                    opportunity({
                        id: 'hub-usdt',
                        type: 'AAVE_V4_HUB_SUPPLY',
                        action: 'LEND',
                        chainId: 1,
                        apr: 2,
                        dailyRewards: 100,
                        campaigns: [
                            {
                                id: 'hub-usdt-campaign',
                                childCampaignIds: ['leaf-usdt', 'leaf-missing-breakdown'],
                                rewardToken: { address: USDC, symbol: 'USDC' },
                                params: {
                                    whitelist: [],
                                    blacklist: [],
                                    hooks: [],
                                    forwardingEnabled: true,
                                    hubAddress: CORE_HUB,
                                    underlyingToken: USDT,
                                },
                            },
                        ],
                    }),
                ]);
            }
            const sharedOpportunity = {
                id: '88001',
                type: 'ERC20LOGPROCESSOR',
                chainId: 1,
                status: 'LIVE',
                identifier: POOL,
                explorerAddress: POOL,
                // Total opportunity APR includes a 4.0% whitelisted sibling campaign alongside the 0.7% + 0.5% eligible campaigns
                apr: 5.2,
                dailyRewards: 100,
                aprRecord: {
                    cumulated: 5.2,
                    breakdowns: [
                        { identifier: '1001', type: 'CAMPAIGN', value: 0.7 },
                        { identifier: '1002', type: 'CAMPAIGN', value: 0.5 },
                        { identifier: '1003', type: 'CAMPAIGN', value: 4.0 },
                    ],
                },
                campaigns: [
                    {
                        id: 'leaf-usdc',
                        campaignId: '1001',
                        rewardToken: { address: USDC, symbol: 'USDC' },
                        params: { whitelist: [], blacklist: [], hooks: [] },
                    },
                    {
                        id: 'leaf-usdt',
                        campaignId: '1002',
                        rewardToken: { address: USDC, symbol: 'USDC' },
                        params: { whitelist: [], blacklist: [], hooks: [] },
                    },
                    {
                        id: 'leaf-restricted',
                        campaignId: '1003',
                        params: { whitelist: ['0xonly-vip'], blacklist: [], hooks: [] },
                    },
                ],
            };
            if (urlStr.includes('/v4/campaigns/hub-usdc-campaign/linked?campaigns=true')) {
                return json({
                    self: 'hub-usdc-campaign',
                    nodes: [
                        {
                            campaignId: 'leaf-usdc',
                            onChainCampaignId: '1001',
                            parentCampaignId: 'hub-usdc-campaign',
                            opportunity: sharedOpportunity,
                        },
                    ],
                });
            }
            if (urlStr.includes('/v4/campaigns/hub-usdt-campaign/linked?campaigns=true')) {
                return json({
                    self: 'hub-usdt-campaign',
                    nodes: [
                        {
                            campaignId: 'leaf-usdt',
                            onChainCampaignId: '1002',
                            parentCampaignId: 'hub-usdt-campaign',
                            opportunity: sharedOpportunity,
                        },
                        {
                            campaignId: 'leaf-missing-breakdown',
                            onChainCampaignId: '2001',
                            parentCampaignId: 'hub-usdt-campaign',
                            opportunity: {
                                id: '88002',
                                type: 'ERC20LOGPROCESSOR',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: POOL,
                                explorerAddress: POOL,
                                apr: 3,
                                dailyRewards: 100,
                                // No aprRecord breakdowns -> must fail closed
                                campaigns: [
                                    {
                                        id: 'leaf-missing-breakdown',
                                        campaignId: '2001',
                                        params: { whitelist: [], blacklist: [], hooks: [] },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }
            return json([]);
        });

        const items = await handler.calculateAprForPools([
            pool({
                chain: Chain.MAINNET,
                tokens: [
                    {
                        address: WA_CORE_USDC,
                        balanceUSD: 50,
                        token: { symbol: 'waCoreUSDC', underlyingTokenAddress: USDC },
                    },
                    {
                        address: WA_CORE_USDT,
                        balanceUSD: 50,
                        token: { symbol: 'waCoreUSDT', underlyingTokenAddress: USDT },
                    },
                ],
            }),
        ]);

        // Only 0.7% + 0.5% = 1.2% is included; the 4.0% whitelisted sibling and the missing-breakdown opp are excluded.
        expect(items).toHaveLength(1);
        expect(items[0]).toEqual(
            expect.objectContaining({
                id: 'pool-1-aave-v4-merkl-88001',
                rewardTokenAddress: USDC,
                rewardTokenSymbol: 'USDC',
            }),
        );
        expect(items[0].apr).toBeCloseTo(0.012, 6);
    });

    it('supports linked Aave V4 Hub opportunities across multi-word hubs, dotted asset keys, and deduplicates against Frontier pool opps', async () => {
        fetchMock.mockImplementation((url: string) => {
            const urlStr = String(url);
            if (urlStr.includes('mainProtocolId=frontier&chainId=1')) {
                return json([
                    opportunity({
                        id: 'shared-pool-opp',
                        chainId: 1,
                        identifier: POOL,
                        explorerAddress: POOL,
                        apr: 1.25,
                        campaigns: [
                            {
                                rewardToken: { address: USDG, symbol: 'USDG' },
                                params: { whitelist: [] },
                            },
                        ],
                    }),
                ]);
            }
            if (urlStr.includes('mainProtocolId=aave&chainId=1')) {
                return json([
                    opportunity({
                        id: 'global-dollar-usdg-hub',
                        type: 'AAVE_V4_HUB_NET_LENDING',
                        action: 'LEND',
                        chainId: 1,
                        identifier: '0x1234567890abcdef1234567890abcdef12345678',
                        explorerAddress: undefined,
                        apr: 2.08,
                        nativeApr: 2.05,
                        totalApr: 4.13,
                        dailyRewards: 367.61,
                        tvl: 6_457_758,
                        campaigns: [
                            {
                                id: 'usdg-hub-campaign',
                                childCampaignIds: ['usdg-pool-child'],
                                rewardToken: { address: USDG, symbol: 'USDG' },
                                params: {
                                    whitelist: [],
                                    hooks: [],
                                    forwardingEnabled: true,
                                    hubs: [
                                        {
                                            hubAddress: GLOBAL_DOLLAR_HUB,
                                            lendingAssetIds: [3],
                                            assets: [{ assetId: 3, underlyingToken: USDG }],
                                        },
                                    ],
                                },
                            },
                        ],
                    }),
                    opportunity({
                        id: 'core-btcb-supply',
                        type: 'AAVE_V4_HUB_SUPPLY',
                        action: 'LEND',
                        chainId: 1,
                        identifier: '0xabcdef1234567890abcdef1234567890abcdef12',
                        explorerAddress: BTCB,
                        apr: 3,
                        totalApr: 3,
                        dailyRewards: 500,
                        tvl: 6_083_333,
                        campaigns: [
                            {
                                id: 'btcb-hub-campaign',
                                childCampaignIds: ['btcb-pool-child'],
                                rewardToken: { address: USDC, symbol: 'USDC' },
                                params: {
                                    whitelist: [],
                                    hooks: [],
                                    forwardingEnabled: true,
                                    hubAddress: CORE_HUB,
                                    underlyingToken: BTCB,
                                },
                            },
                        ],
                    }),
                ]);
            }
            if (urlStr.includes('/v4/campaigns/usdg-hub-campaign/linked?campaigns=true')) {
                return json({
                    self: 'usdg-hub-campaign',
                    nodes: [
                        {
                            campaignId: 'usdg-pool-child',
                            onChainCampaignId: 'usdg-pool-onchain',
                            parentCampaignId: 'usdg-hub-campaign',
                            opportunity: {
                                id: 'shared-pool-opp',
                                type: 'ERC20LOGPROCESSOR',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: POOL,
                                explorerAddress: POOL,
                                apr: 1.25,
                                dailyRewards: 10,
                                aprRecord: {
                                    cumulated: 1.25,
                                    breakdowns: [{ identifier: 'usdg-pool-onchain', type: 'CAMPAIGN', value: 1.25 }],
                                },
                                campaigns: [
                                    {
                                        id: 'usdg-pool-child',
                                        campaignId: 'usdg-pool-onchain',
                                        params: { whitelist: [], blacklist: [], hooks: [] },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }
            if (urlStr.includes('/v4/campaigns/btcb-hub-campaign/linked?campaigns=true')) {
                return json({
                    self: 'btcb-hub-campaign',
                    nodes: [
                        {
                            campaignId: 'btcb-pool-child',
                            onChainCampaignId: 'btcb-pool-onchain',
                            parentCampaignId: 'btcb-hub-campaign',
                            opportunity: {
                                id: 'btcb-linked-pool-opp',
                                type: 'ERC20LOGPROCESSOR',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: 'custom-pool-id',
                                tokens: [{ address: POOL, symbol: 'BPT' }],
                                apr: 1.5,
                                dailyRewards: 25,
                                aprRecord: {
                                    cumulated: 1.5,
                                    breakdowns: [{ identifier: 'btcb-pool-onchain', type: 'CAMPAIGN', value: 1.5 }],
                                },
                                campaigns: [
                                    {
                                        id: 'btcb-pool-child',
                                        campaignId: 'btcb-pool-onchain',
                                        params: { whitelist: [], blacklist: [], hooks: [] },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }
            return json([]);
        });

        const items = await handler.calculateAprForPools([
            pool({
                chain: Chain.MAINNET,
                tokens: [
                    {
                        address: WA_GLOBAL_DOLLAR_USDG,
                        balanceUSD: 50,
                        token: { symbol: 'waGlobalDollarUSDG', underlyingTokenAddress: USDG },
                    },
                    {
                        address: WA_CORE_BTCB,
                        balanceUSD: 50,
                        token: { symbol: 'waCoreBTCb', underlyingTokenAddress: BTCB },
                    },
                ],
            }),
        ]);

        expect(items).toHaveLength(2);
        // shared-pool-opp came from mainProtocolId=frontier and is not double-counted when also returned by /linked
        expect(items[0]).toEqual(
            expect.objectContaining({
                id: 'pool-1-merkl-shared-pool-opp',
                apr: 0.0125,
                rewardTokenAddress: USDG,
                rewardTokenSymbol: 'USDG',
            }),
        );
        // btcb-linked-pool-opp fell back to parent campaign's reward token and uses the Aave V4 linked prefix
        expect(items[1]).toEqual(
            expect.objectContaining({
                id: 'pool-1-aave-v4-merkl-btcb-linked-pool-opp',
                title: '0xFF-avUSD-waMonUSDC',
                apr: 0.015,
                rewardTokenAddress: USDC,
                rewardTokenSymbol: 'USDC',
            }),
        );
    });

    it('filters out ineligible Aave V4 Hub campaigns while falling back to unlinked Base EQUITIES_HUB USDC campaigns', async () => {
        const baseHubParam = {
            hubAddress: CORE_HUB,
            lendingAssetIds: ['5'],
            assets: [{ assetId: '5', underlyingToken: USDC }],
        };
        const baseAaveV4Opp = (id: string, overrides: Partial<Opportunity> = {}): Opportunity =>
            opportunity({
                id,
                type: 'AAVE_V4_HUB_NET_LENDING',
                action: 'LEND',
                chainId: 1,
                explorerAddress: undefined,
                apr: 5,
                nativeApr: 3,
                totalApr: 5,
                dailyRewards: 1000,
                tvl: 1_000_000,
                campaigns: [
                    {
                        id: `campaign-${id}`,
                        childCampaignIds: [`child-${id}`],
                        rewardToken: { address: USDC, symbol: 'USDC' },
                        params: {
                            whitelist: [],
                            blacklist: [],
                            hooks: [],
                            forwardingEnabled: true,
                            hubs: [baseHubParam],
                        },
                    },
                ],
                ...overrides,
            });

        fetchMock.mockImplementation((url: string) => {
            const urlStr = String(url);
            if (urlStr.includes('mainProtocolId=aave&chainId=1')) {
                return json([
                    baseAaveV4Opp('has-hooks', {
                        campaigns: [
                            {
                                id: 'campaign-has-hooks',
                                childCampaignIds: ['child-has-hooks'],
                                params: {
                                    hooks: [{ hookType: 17, healthFactorThreshold: '2' }],
                                    forwardingEnabled: true,
                                    hubs: [baseHubParam],
                                },
                            },
                        ],
                    }),
                    baseAaveV4Opp('whitelisted', {
                        campaigns: [
                            {
                                id: 'campaign-whitelisted',
                                childCampaignIds: ['child-whitelisted'],
                                params: {
                                    whitelist: ['0x123'],
                                    forwardingEnabled: true,
                                    hubs: [baseHubParam],
                                },
                            },
                        ],
                    }),
                    baseAaveV4Opp('forwarding-disabled', {
                        campaigns: [
                            {
                                id: 'campaign-forwarding-disabled',
                                childCampaignIds: ['child-forwarding-disabled'],
                                params: {
                                    forwardingEnabled: false,
                                    hubs: [baseHubParam],
                                },
                            },
                        ],
                    }),
                    baseAaveV4Opp('spoke-blacklisted', {
                        campaigns: [
                            {
                                id: 'campaign-spoke-blacklisted',
                                childCampaignIds: ['child-spoke-blacklisted'],
                                params: {
                                    blacklist: [WA_CORE_USDC],
                                    forwardingEnabled: true,
                                    hubs: [baseHubParam],
                                },
                            },
                        ],
                    }),
                    baseAaveV4Opp('pool-blacklisted', {
                        campaigns: [
                            {
                                id: 'campaign-pool-blacklisted',
                                childCampaignIds: ['child-pool-blacklisted'],
                                params: {
                                    blacklist: [POOL],
                                    forwardingEnabled: true,
                                    hubs: [baseHubParam],
                                },
                            },
                        ],
                    }),
                    baseAaveV4Opp('vault-blacklisted', {
                        campaigns: [
                            {
                                id: 'campaign-vault-blacklisted',
                                childCampaignIds: ['child-vault-blacklisted'],
                                params: {
                                    blacklist: [VAULT],
                                    forwardingEnabled: true,
                                    hubs: [baseHubParam],
                                },
                            },
                        ],
                    }),
                    baseAaveV4Opp('borrow-action', {
                        type: 'AAVE_V4_HUB_NET_BORROWING',
                        action: 'BORROW',
                    }),
                    baseAaveV4Opp('spoke-supply-type', {
                        type: 'AAVE_V4_SPOKE_SUPPLY',
                    }),
                    baseAaveV4Opp('wrong-hub', {
                        campaigns: [
                            {
                                id: 'campaign-wrong-hub',
                                childCampaignIds: ['child-wrong-hub'],
                                params: {
                                    forwardingEnabled: true,
                                    hubs: [{ ...baseHubParam, hubAddress: OTHER_HUB }],
                                },
                            },
                        ],
                    }),
                    baseAaveV4Opp('zero-merkl-topup', {
                        apr: 4,
                        nativeApr: 4.5,
                        totalApr: 4,
                        campaigns: [
                            {
                                id: 'campaign-zero-merkl-topup',
                                childCampaignIds: [],
                                params: {
                                    forwardingEnabled: true,
                                    hubs: [baseHubParam],
                                },
                            },
                        ],
                    }),
                    baseAaveV4Opp('zero-linked-rewards', {
                        campaigns: [
                            {
                                id: 'campaign-zero-linked-rewards',
                                childCampaignIds: ['child-zero-linked-rewards'],
                                params: {
                                    forwardingEnabled: true,
                                    hubs: [baseHubParam],
                                },
                            },
                        ],
                    }),
                ]);
            }
            if (urlStr.includes('/v4/campaigns/campaign-zero-linked-rewards/linked?campaigns=true')) {
                return json({
                    self: 'campaign-zero-linked-rewards',
                    nodes: [
                        {
                            campaignId: 'child-zero-linked-rewards',
                            parentCampaignId: 'campaign-zero-linked-rewards',
                            opportunity: {
                                id: 'zero-reward-pool-opp',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: POOL,
                                apr: 2,
                                dailyRewards: 0,
                                campaigns: [
                                    {
                                        id: 'child-zero-linked-rewards',
                                        params: { whitelist: [], blacklist: [], hooks: [] },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }
            if (urlStr.includes('mainProtocolId=aave&chainId=8453')) {
                return json([
                    opportunity({
                        id: '1829790331693421025',
                        type: 'AAVE_V4_HUB_NET_LENDING',
                        action: 'LEND',
                        chainId: 8453,
                        identifier: '30f5eb12eb8e649a',
                        explorerAddress: undefined,
                        apr: 2.077777329188556,
                        nativeApr: 2.0492747426684708,
                        totalApr: 4.127052071857027,
                        dailyRewards: 367.6105237435708,
                        tvl: 6_457_758.455705378,
                        campaigns: [
                            {
                                id: '4879921432807344506',
                                childCampaignIds: undefined,
                                rewardToken: { address: BASE_USDC, symbol: 'USDC' },
                                params: {
                                    whitelist: [],
                                    blacklist: [],
                                    hooks: [],
                                    forwardingEnabled: true,
                                    hubs: [
                                        {
                                            hubAddress: BASE_EQUITIES_HUB,
                                            lendingAssetIds: ['7'],
                                            assets: [{ assetId: '7', underlyingToken: BASE_USDC }],
                                        },
                                    ],
                                },
                            },
                        ],
                    }),
                ]);
            }
            if (urlStr.includes('/v4/campaigns/4879921432807344506/linked?campaigns=true')) {
                return json({
                    self: '4879921432807344506',
                    nodes: [
                        {
                            campaignId: '4879921432807344506',
                            parentCampaignId: null,
                            opportunity: { id: '1829790331693421025', chainId: 8453, status: 'LIVE', apr: 2.08 },
                        },
                    ],
                });
            }
            return json([]);
        });

        const mainnetItems = await handler.calculateAprForPools([
            pool({
                chain: Chain.MAINNET,
                tokens: [
                    {
                        address: WA_CORE_USDC,
                        balanceUSD: 100,
                        token: { symbol: 'waCoreUSDC', underlyingTokenAddress: USDC },
                    },
                ],
            }),
        ]);
        expect(mainnetItems).toEqual([]);

        const baseItems = await handler.calculateAprForPools([
            pool({
                chain: Chain.BASE,
                tokens: [
                    {
                        address: WA_EQUITIES_USDC,
                        balanceUSD: 100,
                        token: { symbol: 'waEquitiesUSDC', underlyingTokenAddress: BASE_USDC },
                    },
                ],
            }),
        ]);
        expect(baseItems).toHaveLength(1);
        expect(baseItems[0]).toEqual(
            expect.objectContaining({
                id: 'pool-1-aave-v4-merkl-1829790331693421025',
                title: 'waEquitiesUSDC',
                chain: Chain.BASE,
                rewardTokenAddress: BASE_USDC,
                rewardTokenSymbol: 'USDC',
            }),
        );
        expect(baseItems[0].apr).toBeCloseTo(0.02077777, 6);
    });

    it('dynamically discovers newly added Aave V4 spokes on-chain and expires negative probe cache entries after TTL', async () => {
        let nowMs = 1_000_000;
        const timedHandler = new MerklAprHandler({
            now: () => nowMs,
            sleep: noSleep,
            batchDelayMs: 0,
            retryBaseDelayMs: 0,
            negativeProbeCacheTtlMs: 60_000,
            positiveProbeCacheTtlMs: 600_000,
        });

        // First multicall probes hub(), assetId(), asset() for WA_CORE_CIRBTC (valid) and NON_V4_WRAPPER (definitive revert)
        multicallMock.mockResolvedValueOnce([
            { status: 'success', result: CORE_HUB },
            { status: 'success', result: 17n },
            { status: 'success', result: CIRBTC },
            { status: 'failure', error: revertError('hub') },
            { status: 'failure', error: revertError('assetId') },
            { status: 'failure', error: new ContractFunctionZeroDataError({ functionName: 'asset' }) },
        ]);
        // Second multicall confirms isSpokeListed(17n, WA_CORE_CIRBTC) === true on CORE_HUB
        multicallMock.mockResolvedValueOnce([{ status: 'success', result: true }]);

        fetchMock.mockImplementation((url: string) => {
            const urlStr = String(url);
            if (urlStr.includes('mainProtocolId=aave&chainId=1')) {
                return json([
                    opportunity({
                        id: 'core-cirbtc-opp',
                        type: 'AAVE_V4_HUB_SUPPLY',
                        action: 'LEND',
                        chainId: 1,
                        explorerAddress: CIRBTC,
                        apr: 2.5,
                        totalApr: 2.5,
                        dailyRewards: 100,
                        tvl: 1_460_000,
                        campaigns: [
                            {
                                id: 'core-cirbtc-campaign',
                                childCampaignIds: ['core-cirbtc-pool-child'],
                                rewardToken: { address: USDC, symbol: 'USDC' },
                                params: {
                                    whitelist: [],
                                    hooks: [],
                                    forwardingEnabled: true,
                                    hubAddress: CORE_HUB,
                                    underlyingToken: CIRBTC,
                                },
                            },
                        ],
                    }),
                ]);
            }
            if (urlStr.includes('/v4/campaigns/core-cirbtc-campaign/linked?campaigns=true')) {
                return json({
                    self: 'core-cirbtc-campaign',
                    nodes: [
                        {
                            campaignId: 'core-cirbtc-pool-child',
                            onChainCampaignId: 'core-cirbtc-onchain',
                            parentCampaignId: 'core-cirbtc-campaign',
                            opportunity: {
                                id: 'core-cirbtc-linked-pool-opp',
                                type: 'ERC20LOGPROCESSOR',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: POOL,
                                explorerAddress: POOL,
                                apr: 1.25,
                                dailyRewards: 30,
                                aprRecord: {
                                    cumulated: 1.25,
                                    breakdowns: [{ identifier: 'core-cirbtc-onchain', type: 'CAMPAIGN', value: 1.25 }],
                                },
                                campaigns: [
                                    {
                                        id: 'core-cirbtc-pool-child',
                                        campaignId: 'core-cirbtc-onchain',
                                        params: { whitelist: [], blacklist: [], hooks: [] },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }
            return json([]);
        });

        const testPool = pool({
            chain: Chain.MAINNET,
            tokens: [
                {
                    address: WA_CORE_CIRBTC,
                    balanceUSD: 50,
                    token: { symbol: 'waCorecirBTC', underlyingTokenAddress: CIRBTC },
                },
                {
                    address: NON_V4_WRAPPER,
                    balanceUSD: 50,
                    token: { symbol: 'someVault', underlyingTokenAddress: USDC },
                },
            ],
        });

        const firstResult = await timedHandler.calculateAprForPoolsWithFailures([testPool]);

        expect(firstResult.preserveItems).toBeUndefined();
        expect(firstResult.items).toEqual([
            expect.objectContaining({
                id: 'pool-1-aave-v4-merkl-core-cirbtc-linked-pool-opp',
                title: '0xFF-avUSD-waMonUSDC',
                chain: Chain.MAINNET,
                apr: 0.0125,
                rewardTokenSymbol: 'USDC',
            }),
        ]);
        expect(multicallMock).toHaveBeenCalledTimes(2);

        // Within negative TTL: both positive and negative probe results are cached
        nowMs += 30_000;
        const secondResult = await timedHandler.calculateAprForPoolsWithFailures([testPool]);
        expect(secondResult.items).toEqual(firstResult.items);
        expect(multicallMock).toHaveBeenCalledTimes(2);

        // After negative TTL expires (60s total), only NON_V4_WRAPPER is re-probed; positive entry stays cached
        nowMs += 30_000;
        multicallMock.mockResolvedValueOnce([
            { status: 'failure', error: revertError('hub') },
            { status: 'failure', error: revertError('assetId') },
            { status: 'failure', error: revertError('asset') },
        ]);
        await timedHandler.calculateAprForPoolsWithFailures([testPool]);
        expect(multicallMock).toHaveBeenCalledTimes(3);
        expect(multicallMock.mock.calls[2][0].contracts).toHaveLength(3);
        expect(multicallMock.mock.calls[2][0].contracts[0].address).toBe(NON_V4_WRAPPER);
    });

    it('retries indeterminate RPC multicall failures, never caches them as null, and preserves affected pools when retries exhaust', async () => {
        const sleepMock = vi.fn().mockResolvedValue(undefined);
        const retryHandler = new MerklAprHandler({
            sleep: sleepMock,
            batchDelayMs: 0,
            retryBaseDelayMs: 100,
            maxRetries: 1,
        });

        const aggregate3RpcError = new ContractFunctionExecutionError(
            new ContractFunctionRevertedError({
                abi: aaveV4TokenizationSpokeAbi,
                functionName: 'aggregate3',
                cause: new InternalRpcError(new Error('upstream RPC overloaded')),
            }),
            {
                abi: aaveV4TokenizationSpokeAbi,
                contractAddress: WA_CORE_CIRBTC,
                functionName: 'aggregate3',
            },
        );

        // Both attempts fail with indeterminate RPC errors (not a contract revert on the target spoke)
        multicallMock
            .mockResolvedValueOnce([
                { status: 'failure', error: new Error('RPC timeout') },
                { status: 'failure', error: new Error('RPC timeout') },
                { status: 'failure', error: new Error('RPC timeout') },
            ])
            .mockResolvedValueOnce([
                { status: 'failure', error: aggregate3RpcError },
                { status: 'failure', error: aggregate3RpcError },
                { status: 'failure', error: aggregate3RpcError },
            ]);

        fetchMock.mockImplementation((url: string) => {
            const urlStr = String(url);
            if (urlStr.includes('mainProtocolId=frontier&chainId=1')) {
                return json([
                    opportunity({
                        id: 'unrelated-frontier-opp',
                        chainId: 1,
                        identifier: SECOND_POOL,
                        explorerAddress: SECOND_POOL,
                        apr: 8,
                    }),
                ]);
            }
            if (urlStr.includes('mainProtocolId=aave&chainId=1')) {
                return json([
                    opportunity({
                        id: 'core-cirbtc-opp',
                        type: 'AAVE_V4_HUB_SUPPLY',
                        action: 'LEND',
                        chainId: 1,
                        explorerAddress: CIRBTC,
                        apr: 2.5,
                        dailyRewards: 100,
                        campaigns: [
                            {
                                id: 'core-cirbtc-campaign',
                                childCampaignIds: ['core-cirbtc-pool-child'],
                                rewardToken: { address: USDC, symbol: 'USDC' },
                                params: {
                                    forwardingEnabled: true,
                                    hubAddress: CORE_HUB,
                                    underlyingToken: CIRBTC,
                                },
                            },
                        ],
                    }),
                ]);
            }
            if (urlStr.includes('/v4/campaigns/core-cirbtc-campaign/linked?campaigns=true')) {
                return json({
                    self: 'core-cirbtc-campaign',
                    nodes: [
                        {
                            campaignId: 'core-cirbtc-pool-child',
                            onChainCampaignId: 'core-cirbtc-onchain',
                            parentCampaignId: 'core-cirbtc-campaign',
                            opportunity: {
                                id: 'core-cirbtc-linked-pool-opp',
                                type: 'ERC20LOGPROCESSOR',
                                chainId: 1,
                                status: 'LIVE',
                                identifier: POOL,
                                explorerAddress: POOL,
                                apr: 1.5,
                                dailyRewards: 30,
                                aprRecord: {
                                    cumulated: 1.5,
                                    breakdowns: [{ identifier: 'core-cirbtc-onchain', type: 'CAMPAIGN', value: 1.5 }],
                                },
                                campaigns: [
                                    {
                                        id: 'core-cirbtc-pool-child',
                                        campaignId: 'core-cirbtc-onchain',
                                        params: { whitelist: [], blacklist: [], hooks: [] },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }
            return json([]);
        });

        const spokePool = pool({
            id: 'pool-spoke',
            address: POOL,
            chain: Chain.MAINNET,
            tokens: [
                {
                    address: WA_CORE_CIRBTC,
                    balanceUSD: 100,
                    token: { symbol: 'waCorecirBTC', underlyingTokenAddress: CIRBTC },
                },
            ],
        });
        const unrelatedPool = pool({
            id: 'pool-unrelated',
            address: SECOND_POOL,
            chain: Chain.MAINNET,
            tokens: [
                {
                    address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                    balanceUSD: 100,
                    token: { symbol: 'avUSD', underlyingTokenAddress: null },
                },
            ],
        });

        const failedRun = await retryHandler.calculateAprForPoolsWithFailures([spokePool, unrelatedPool]);

        // Unrelated pool still gets its Frontier APR, while only Aave V4 rows on the failed spoke pool are preserved
        expect(failedRun.items).toEqual([
            expect.objectContaining({ id: 'pool-unrelated-merkl-unrelated-frontier-opp', apr: 0.08 }),
        ]);
        expect(failedRun.preserveItems).toEqual([{ poolId: 'pool-spoke', idPrefix: 'pool-spoke-aave-v4-merkl-' }]);
        expect(multicallMock).toHaveBeenCalledTimes(2);
        expect(sleepMock).toHaveBeenCalledWith(100);

        // Next run recovers immediately because the indeterminate RPC failure was NOT cached as null
        multicallMock
            .mockResolvedValueOnce([
                { status: 'success', result: CORE_HUB },
                { status: 'success', result: 17n },
                { status: 'success', result: CIRBTC },
            ])
            .mockResolvedValueOnce([{ status: 'failure', error: new Error('transient isSpokeListed timeout') }])
            .mockResolvedValueOnce([{ status: 'success', result: true }]);

        const recoveredRun = await retryHandler.calculateAprForPoolsWithFailures([spokePool, unrelatedPool]);

        expect(recoveredRun.preserveItems).toBeUndefined();
        expect(recoveredRun.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'pool-unrelated-merkl-unrelated-frontier-opp', apr: 0.08 }),
                expect.objectContaining({ id: 'pool-spoke-aave-v4-merkl-core-cirbtc-linked-pool-opp', apr: 0.015 }),
            ]),
        );
        expect(multicallMock).toHaveBeenCalledTimes(5);
    });

    it('applies Frontier and direct-token Merkl APRs and preserves only Aave V4 rows on affected pools when Aave hub or linked fetches fail', async () => {
        const retryHandler = new MerklAprHandler({
            sleep: noSleep,
            batchDelayMs: 0,
            retryBaseDelayMs: 0,
            maxRetries: 1,
        });

        fetchMock.mockImplementation((url: string) => {
            const urlStr = String(url);
            if (urlStr.includes('mainProtocolId=frontier&chainId=1')) {
                return json([
                    opportunity({
                        id: 'frontier-pool-1',
                        chainId: 1,
                        identifier: POOL,
                        explorerAddress: POOL,
                        apr: 5,
                    }),
                    opportunity({
                        id: 'frontier-pool-2',
                        chainId: 1,
                        identifier: SECOND_POOL,
                        explorerAddress: SECOND_POOL,
                        apr: 10,
                    }),
                ]);
            }
            if (urlStr.includes(`explorerAddress=${WRAPPER}`)) {
                return json([
                    opportunity({
                        id: 'direct-wrapper-opp',
                        chainId: 1,
                        identifier: WRAPPER,
                        explorerAddress: WRAPPER,
                        apr: 4,
                    }),
                ]);
            }
            if (urlStr.includes('mainProtocolId=aave&chainId=1')) {
                return json({ message: 'upstream unavailable' }, { status: 503, statusText: 'Service Unavailable' });
            }
            return json([]);
        });

        const aaveV4Pool = pool({
            id: 'pool-aave-v4',
            address: POOL,
            chain: Chain.MAINNET,
            tokens: [
                {
                    address: WA_CORE_USDC,
                    balanceUSD: 100,
                    token: { symbol: 'waCoreUSDC', underlyingTokenAddress: USDC },
                },
            ],
        });
        const unrelatedPool = pool({
            id: 'pool-unrelated',
            address: SECOND_POOL,
            chain: Chain.MAINNET,
            tokens: [
                {
                    address: WRAPPER,
                    balanceUSD: 100,
                    token: { symbol: 'waDirect', underlyingTokenAddress: USDC },
                },
            ],
        });

        const hubFailureResult = await retryHandler.calculateAprForPoolsWithFailures([aaveV4Pool, unrelatedPool]);

        // Both Frontier pool APRs and the direct-token APR are still returned despite the Aave hub outage
        expect(hubFailureResult.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'pool-aave-v4-merkl-frontier-pool-1', apr: 0.05 }),
                expect.objectContaining({ id: 'pool-unrelated-merkl-frontier-pool-2', apr: 0.1 }),
                expect.objectContaining({ id: 'pool-unrelated-merkl-direct-wrapper-opp', apr: 0.04 }),
            ]),
        );
        expect(hubFailureResult.items).toHaveLength(3);
        // Only Aave V4 linked rows on the affected pool are preserved, excluding any opportunity already returned by Frontier so it cannot double-count
        expect(hubFailureResult.preserveItems).toEqual([
            {
                poolId: 'pool-aave-v4',
                idPrefix: 'pool-aave-v4-aave-v4-merkl-',
                excludeIds: new Set(['pool-aave-v4-aave-v4-merkl-frontier-pool-1']),
            },
        ]);

        // Also verify partial failure when /v4/campaigns/{id}/linked fails for one campaign while Frontier still applies
        clearMerklResponseCache();
        fetchMock.mockImplementation((url: string) => {
            const urlStr = String(url);
            if (urlStr.includes('mainProtocolId=frontier&chainId=1')) {
                return json([
                    opportunity({
                        id: 'frontier-pool-2',
                        chainId: 1,
                        identifier: SECOND_POOL,
                        explorerAddress: SECOND_POOL,
                        apr: 12,
                    }),
                ]);
            }
            if (urlStr.includes(`explorerAddress=${WRAPPER}`)) {
                return json([
                    opportunity({
                        id: 'direct-wrapper-opp-2',
                        chainId: 1,
                        identifier: WRAPPER,
                        explorerAddress: WRAPPER,
                        apr: 6,
                    }),
                ]);
            }
            if (urlStr.includes('mainProtocolId=aave&chainId=1')) {
                return json([
                    opportunity({
                        id: 'hub-opp-1',
                        type: 'AAVE_V4_HUB_SUPPLY',
                        action: 'LEND',
                        chainId: 1,
                        apr: 3,
                        dailyRewards: 100,
                        campaigns: [
                            {
                                id: 'failing-linked-campaign',
                                childCampaignIds: ['child-1'],
                                params: {
                                    forwardingEnabled: true,
                                    hubAddress: CORE_HUB,
                                    underlyingToken: USDC,
                                },
                            },
                        ],
                    }),
                ]);
            }
            if (urlStr.includes('/v4/campaigns/failing-linked-campaign/linked?campaigns=true')) {
                return json({ message: 'rate limited' }, { status: 429, statusText: 'Too Many Requests' });
            }
            return json([]);
        });

        const linkedFailureResult = await retryHandler.calculateAprForPoolsWithFailures([aaveV4Pool, unrelatedPool]);
        expect(linkedFailureResult.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'pool-unrelated-merkl-frontier-pool-2', apr: 0.12 }),
                expect.objectContaining({ id: 'pool-unrelated-merkl-direct-wrapper-opp-2', apr: 0.06 }),
            ]),
        );
        expect(linkedFailureResult.items).toHaveLength(2);
        expect(linkedFailureResult.preserveItems).toEqual([
            { poolId: 'pool-aave-v4', idPrefix: 'pool-aave-v4-aave-v4-merkl-' },
        ]);
    });

    it('skips fetching Aave V4 opportunities when no pool holds an Aave V4 tokenization spoke', async () => {
        fetchMock.mockImplementation(() => json([]));

        const items = await handler.calculateAprForPools([
            pool({
                chain: Chain.MAINNET,
                tokens: [
                    {
                        address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                        balanceUSD: 100,
                        token: { symbol: 'avUSD', underlyingTokenAddress: null },
                    },
                ],
            }),
        ]);

        expect(items).toEqual([]);
        expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('mainProtocolId=aave'))).toBe(false);
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
