import { Chain } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../prisma/prisma-client';
import * as contentControllerModule from '../../content/content-controller';
import { PoolGqlLoaderService } from './pool-gql-loader.service';
import { PoolAggregatorLoader } from './pool-aggregator-loader';
import { tokenService } from '../../token/token.service';

describe('PoolGqlLoaderService', () => {
    const loader = new PoolGqlLoaderService();

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('excludes BLACK_LISTED pools when where filters are provided unless explicitly requested', async () => {
        const findManySpy = vi.spyOn(prisma.prismaPool, 'findMany').mockResolvedValue([]);

        await loader.getPools({ where: { chainIn: [Chain.SEPOLIA] } });

        expect(findManySpy).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    NOT: { categories: { hasSome: ['BLACK_LISTED'] } },
                }),
            }),
        );

        findManySpy.mockClear();
        await loader.getPools({ where: { chainIn: [Chain.SEPOLIA], categoryIn: ['BLACK_LISTED'] } });

        const callWhere = findManySpy.mock.calls[0][0]?.where as Record<string, unknown>;
        expect(callWhere.categories).toEqual({ hasSome: ['BLACK_LISTED'] });
        expect(callWhere.NOT).toBeUndefined();
    });

    it('joins on poolId and chain in textSearch and does not double-apply pagination', async () => {
        const queryRawSpy = vi
            .spyOn(prisma, '$queryRaw')
            .mockResolvedValue([{ id: '0x0000000000000000000000000000000000000001' }]);
        const findManySpy = vi.spyOn(prisma.prismaPool, 'findMany').mockResolvedValue([]);

        await loader.getPools({
            textSearch: 'usdc',
            first: 10,
            skip: 5,
            where: { chainIn: [Chain.SEPOLIA] },
        });

        expect(queryRawSpy).toHaveBeenCalledTimes(1);
        const sqlArg = queryRawSpy.mock.calls[0][0] as { strings: string[]; values: unknown[] };
        const joinedSql = sqlArg.strings.join('?');
        expect(joinedSql).toContain('p.id = d."poolId" AND p.chain = d.chain');

        // Secondary findMany must not re-apply take/skip
        expect(findManySpy).toHaveBeenCalledWith(
            expect.objectContaining({
                take: undefined,
                skip: undefined,
                where: expect.objectContaining({
                    id: { in: ['0x0000000000000000000000000000000000000001'], notIn: undefined },
                }),
            }),
        );
    });

    it('returns empty array without querying findMany when textSearch matches no pools', async () => {
        vi.spyOn(prisma, '$queryRaw').mockResolvedValue([]);
        const findManySpy = vi.spyOn(prisma.prismaPool, 'findMany').mockResolvedValue([]);

        const result = await loader.getPools({ textSearch: 'nonexistent' });

        expect(result).toEqual([]);
        expect(findManySpy).not.toHaveBeenCalled();
    });

    it('skips missing featured pools instead of crashing getFeaturedPools', async () => {
        vi.spyOn(contentControllerModule, 'ContentController').mockReturnValue({
            getFeaturedPools: vi.fn().mockResolvedValue([
                { poolId: '0xmissing', chain: Chain.SEPOLIA, primary: true, description: 'Missing' },
                { poolId: '0xpresent', chain: Chain.SEPOLIA, primary: false, description: 'Present' },
            ]),
        } as any);

        vi.spyOn(loader, 'getPool').mockImplementation(async (_fields, id) => {
            if (id === '0xmissing') {
                throw new Error('Pool with id does not exist');
            }
            return { id: '0xpresent', chain: Chain.SEPOLIA } as any;
        });

        const featured = await loader.getFeaturedPools([Chain.SEPOLIA]);

        expect(featured).toHaveLength(1);
        expect(featured[0].poolId).toBe('0xpresent');
    });

    it('returns undefined priceRateProviderData for zeroAddress and explicit unreviewed unsafe data for unreviewed non-zero rate providers', async () => {
        const aggregatorLoader = new PoolAggregatorLoader();
        vi.spyOn(prisma.prismaToken, 'findMany').mockResolvedValue([
            {
                address: '0xtoken0',
                chain: Chain.SEPOLIA,
                name: 'Token 0',
                symbol: 'TK0',
                decimals: 18,
                isBufferAllowed: true,
                maxDeposit: '0',
                maxWithdraw: '0',
                underlyingTokenAddress: null,
            } as any,
        ]);
        vi.spyOn(prisma.prismaTokenType, 'findMany').mockResolvedValue([]);
        vi.spyOn(prisma.prismaErc4626ReviewData, 'findMany').mockResolvedValue([]);
        vi.spyOn(prisma.prismaPriceRateProviderData, 'findMany').mockResolvedValue([]);
        const basePool = {
            id: '0xpool1',
            address: '0xpool1',
            chain: Chain.SEPOLIA,
            protocolVersion: 3,
            type: 'WEIGHTED',
            typeData: {},
            hook: null,
            liquidityManagement: null,
            dynamicData: {
                poolId: '0xpool1',
                swapFee: '0.003',
                aggregateSwapFee: '0.5',
                aggregateYieldFee: '0.5',
                totalShares: '100',
                totalShares24hAgo: '100',
                totalLiquidity: 1000,
                totalLiquidity24hAgo: 1000,
                isInRecoveryMode: false,
                isPaused: false,
                swapEnabled: true,
            },
            tokens: [
                {
                    id: '0xpool1-0xtoken0',
                    poolId: '0xpool1',
                    chain: Chain.SEPOLIA,
                    address: '0xtoken0',
                    index: 0,
                    balance: '1000',
                    balanceUSD: 1000,
                    weight: '0.5',
                    priceRate: '1',
                    priceRateProvider: '0x0000000000000000000000000000000000000000',
                    exemptFromProtocolYieldFee: false,
                    scalingFactor: '1',
                },
            ],
        };
        vi.spyOn(prisma.prismaPool, 'findMany').mockResolvedValue([basePool as any]);

        const pools = await aggregatorLoader.aggregatorPools({ where: { chainIn: [Chain.SEPOLIA] } });
        expect(pools).toHaveLength(1);
        expect(pools[0].poolTokens[0].priceRateProviderData).toBeUndefined();

        // Non-zero unreviewed rate provider: mapPoolToAggregatorPool populates explicit unsafe/unreviewed data, and aggregatorPools filters it out
        const unreviewedPool = {
            ...basePool,
            id: '0xpool2',
            address: '0xpool2',
            tokens: [
                {
                    ...basePool.tokens[0],
                    priceRateProvider: '0x0000000000000000000000000000000000000099',
                    token: {
                        address: '0xtoken0',
                        chain: Chain.SEPOLIA,
                        name: 'Token 0',
                        symbol: 'TK0',
                        decimals: 18,
                        isBufferAllowed: true,
                        maxDeposit: '0',
                        maxWithdraw: '0',
                        underlyingTokenAddress: null,
                        types: [],
                    },
                },
            ],
        };
        const mappedUnreviewed = (aggregatorLoader as any).mapPoolToAggregatorPool(unreviewedPool, {}, {}, {});
        expect(mappedUnreviewed.poolTokens[0].priceRateProviderData).toEqual({
            address: '0x0000000000000000000000000000000000000099',
            reviewed: false,
            name: null,
            summary: 'unsafe',
            reviewFile: null,
            warnings: [],
            upgradeableComponents: [],
        });

        // PoolGqlLoaderService.enrichWithRateproviderData also populates explicit unreviewed data and filters when reviewedOnly is true
        vi.spyOn(prisma.prismaPriceRateProviderData, 'findUnique').mockResolvedValue(null);
        const gqlPoolMock: any = {
            id: '0xpool2',
            chain: Chain.SEPOLIA,
            poolTokens: [
                {
                    address: '0xtoken0',
                    priceRateProvider: '0x0000000000000000000000000000000000000099',
                    hasNestedPool: false,
                },
            ],
        };
        await (loader as any).enrichWithRateproviderData(gqlPoolMock);
        expect(gqlPoolMock.poolTokens[0].priceRateProviderData).toEqual({
            address: '0x0000000000000000000000000000000000000099',
            reviewed: false,
            name: null,
            summary: 'unsafe',
            reviewFile: null,
            warnings: [],
            upgradeableComponents: [],
        });
    });

    it('keys rateProviderData by address and chain in TokenService.getTokenDefinition and returns empty warnings array for empty string', async () => {
        const tokenAddress = '0x0000000000000000000000000000000000000010';
        vi.spyOn(prisma.prismaToken, 'findUnique').mockResolvedValue({
            address: tokenAddress,
            chain: Chain.SEPOLIA,
            name: 'Token 0',
            symbol: 'TK0',
            decimals: 18,
            isBufferAllowed: true,
            coingeckoTokenId: null,
            underlyingTokenAddress: null,
            types: [],
        } as any);
        vi.spyOn(prisma.prismaPriceRateProviderData, 'findMany').mockResolvedValue([
            {
                chain: Chain.SEPOLIA,
                tokenAddress,
                rateProviderAddress: '0x0000000000000000000000000000000000000020',
                reviewed: true,
                summary: 'safe',
                warnings: '',
            } as any,
        ]);
        vi.spyOn(prisma.prismaErc4626ReviewData, 'findMany').mockResolvedValue([]);

        const def = await tokenService.getTokenDefinition(tokenAddress, Chain.SEPOLIA);
        expect(def?.rateProviderData?.address).toBe('0x0000000000000000000000000000000000000020');
        expect(def?.priceRateProviderData?.address).toBe('0x0000000000000000000000000000000000000020');
        expect(def?.rateProviderData?.warnings).toEqual([]);
    });
});
