import { Chain, PrismaPoolAprType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../../../apps/env';
import type { PoolAPRData } from '../../types';
import { MerklAprHandler } from './merkl-apr-handler';

const fetchMock = vi.fn();

const WRAPPER = '0x1111111111111111111111111111111111111111';
const STATA = '0x2222222222222222222222222222222222222222';
const A_TOKEN = '0x3333333333333333333333333333333333333333';
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
                        ],
                    },
                },
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
    campaigns: { params: { whitelist: string[] } }[];
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

function json(body: unknown) {
    return Promise.resolve(new Response(JSON.stringify(body)));
}

describe('MerklAprHandler', () => {
    const handler = new MerklAprHandler();
    const previousKey = env.MERKL_API_KEY;

    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
        env.MERKL_API_KEY = undefined;
    });

    afterEach(() => {
        env.MERKL_API_KEY = previousKey;
        vi.unstubAllGlobals();
    });

    it('names itself MerklAprHandler', () => {
        expect(handler.getAprServiceName()).toBe('MerklAprHandler');
    });

    it('turns a live pool opportunity into an APR fraction and sends the API key', async () => {
        env.MERKL_API_KEY = 'merkl-test-key';
        fetchMock.mockImplementation((url: string) => {
            if (String(url).includes('mainProtocolId=balancer')) return json([opportunity({ apr: 12.5 })]);
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
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('api.merkl.xyz'), {
            headers: { 'X-API-Key': 'merkl-test-key' },
        });
    });

    it('drops whitelisted campaigns, other chains, and pools with no liquidity', async () => {
        fetchMock.mockImplementation((url: string) => {
            if (!String(url).includes('mainProtocolId=balancer')) return json([]);
            return json([
                opportunity({ campaigns: [{ params: { whitelist: ['0xabc'] } }] }),
                opportunity({ chainId: 1, identifier: POOL }),
                opportunity({ identifier: '0xcccccccccccccccccccccccccccccccccccccccc' }),
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

        expect(items).toEqual([]);
        expect(fetchMock.mock.calls[0][1]).toEqual({ headers: {} });
    });

    it('sums pool and token opportunities that land on the same pool', async () => {
        fetchMock.mockImplementation((url: string) => {
            if (String(url).includes('mainProtocolId=balancer')) return json([opportunity({ apr: 10 })]);
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
        expect(String(fetchMock.mock.calls[1][0])).toContain(A_TOKEN);
        expect(String(fetchMock.mock.calls[1][0])).not.toContain(WRAPPER);
    });

    it('asks Merkl once per underlying token, ten at a time', async () => {
        const tokens = Array.from({ length: 11 }, (_, index) => {
            const address = `0x${(index + 1).toString(16).padStart(40, '0')}`;
            return {
                address,
                balanceUSD: 1,
                token: { underlyingTokenAddress: '0xunderlying' },
            };
        });
        fetchMock.mockImplementation(() => json([]));

        await handler.calculateAprForPools([pool({ tokens })]);

        const tokenCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('explorerAddress='));
        expect(tokenCalls).toHaveLength(11);
        expect(fetchMock).toHaveBeenCalledTimes(12);
    }, 10_000);

    it('rejects an empty pool list', async () => {
        fetchMock.mockImplementation(() => json([]));
        await expect(handler.calculateAprForPools([])).rejects.toThrow();
    });
});
