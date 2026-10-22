import {
    prismaPoolMinimal,
    PrismaPoolMinimal,
    prismaPoolWithExpandedNesting,
    PrismaPoolWithExpandedNesting,
    HookData,
} from '../../../prisma/prisma-types';
import {
    GqlPoolDynamicData,
    GqlPoolFeaturedPool,
    GqlPoolMinimal,
    GqlPoolUnion,
    GqlPoolUserBalance,
    QueryPoolGetPoolsArgs,
    GqlPoolFilterCategory,
    LiquidityManagement,
} from '../../../apps/api/gql/generated-schema';
import { prisma } from '../../../prisma/prisma-client';
import { Chain, Prisma, PrismaUserWalletBalance } from '@prisma/client';
import { fixedNumber } from '../../view-helpers/fixed-number';
import { GyroData, StableData } from '../subgraph-pool';
import { ZERO_ADDRESS } from '@balancer/sdk';
import { mapHookToGqlHook } from '../../sources/transformers';
import { GraphQLError } from 'graphql';
import { mapPoolToken, enrichWithErc4626Data, mapAprItems } from './pool-gql-mapper-helper';
import { ContentController } from '../../content/content-controller';

const isToken = (text: string) => text.match(/^0x[0-9a-fA-F]{40}$/);
const isPoolId = (text: string) => isToken(text) || text.match(/^0x[0-9a-fA-F]{64}$/);

export class PoolGqlLoaderService {
    public async getPool(fields: any, id: string, chain: Chain, userAddress?: string): Promise<GqlPoolUnion> {
        let pool = undefined;
        pool = await prisma.prismaPool.findUnique({
            where: { id_chain: { id, chain: chain } },
            include: {
                ...this.getPoolInclude(userAddress),
            },
        });

        if (!pool) {
            throw new GraphQLError('Pool with id does not exist', { extensions: { code: 'NOT_FOUND' } });
        }

        const mappedPool = this.mapPoolToGqlPool(pool, pool.userWalletBalances);

        // load rate provider data into PoolTokenDetail model
        await this.enrichWithRateproviderData(mappedPool);

        // load underlying token info into PoolTokenDetail
        await enrichWithErc4626Data(mappedPool.poolTokens, mappedPool.chain);

        return mappedPool;
    }

    private async enrichWithRateproviderData(mappedPool: GqlPoolMinimal | GqlPoolUnion) {
        for (const token of mappedPool.poolTokens) {
            if (token.priceRateProvider && token.priceRateProvider !== ZERO_ADDRESS) {
                const rateproviderData = await prisma.prismaPriceRateProviderData.findUnique({
                    where: {
                        chain_rateProviderAddress: {
                            chain: mappedPool.chain,
                            rateProviderAddress: token.priceRateProvider,
                        },
                    },
                });
                if (rateproviderData) {
                    token.priceRateProviderData = {
                        ...rateproviderData,
                        warnings: rateproviderData.warnings?.split(',') || [],
                        upgradeableComponents:
                            (rateproviderData.upgradableComponents as {
                                implementationReviewed: string;
                                entryPoint: string;
                            }[]) || [],
                        address: rateproviderData.rateProviderAddress,
                        reviewFile: rateproviderData.reviewUrl,
                    };
                }
            }
            if (token.hasNestedPool) {
                for (const nestedToken of token.nestedPool!.tokens) {
                    if (nestedToken.priceRateProvider && nestedToken.priceRateProvider !== ZERO_ADDRESS) {
                        const rateproviderData = await prisma.prismaPriceRateProviderData.findUnique({
                            where: {
                                chain_rateProviderAddress: {
                                    chain: mappedPool.chain,
                                    rateProviderAddress: nestedToken.priceRateProvider,
                                },
                            },
                        });
                        if (rateproviderData) {
                            nestedToken.priceRateProviderData = {
                                ...rateproviderData,
                                warnings: rateproviderData.warnings?.split(',') || [],
                                upgradeableComponents:
                                    (rateproviderData.upgradableComponents as {
                                        implementationReviewed: string;
                                        entryPoint: string;
                                    }[]) || [],
                                address: rateproviderData.rateProviderAddress,
                            };
                        }
                    }
                }
            }
        }
    }

    public async getPools(args: QueryPoolGetPoolsArgs): Promise<GqlPoolMinimal[]> {
        // only include wallet and staked balances if the query requests it
        // this makes sure that we don't load ALL user balances when we don't filter on userAddress
        // need to support ordering and paging by userbalanceUsd. Need to take care of that here, as the DB does not (and should not) store the usd balance
        if (args.where?.userAddress) {
            const first = args.first;
            const skip = args.skip ? args.skip : 0;
            if (args.orderBy === 'userbalanceUsd') {
                // we need to retrieve all pools, regardless of paging request as we can't page on a DB level because there is no balance usd stored
                args.first = undefined;
                args.skip = undefined;
            }
            const pools = await prisma.prismaPool.findMany({
                ...this.mapQueryArgsToPoolQuery(args),
                include: {
                    ...this.getPoolMinimalInclude(args.where.userAddress),
                },
            });

            const gqlPools = pools.map((pool) => this.mapToMinimalGqlPool(pool, pool.userWalletBalances));

            for (const mappedPool of gqlPools) {
                // load rate provider data into PoolTokenDetail model
                await this.enrichWithRateproviderData(mappedPool);

                // load underlying token info into PoolTokenDetail
                await enrichWithErc4626Data(mappedPool.poolTokens, mappedPool.chain);
            }

            if (args.orderBy === 'userbalanceUsd') {
                let sortedPools = [];
                if (args.orderDirection === 'asc') {
                    sortedPools = gqlPools.sort(
                        (a, b) => a.userBalance!.totalBalanceUsd - b.userBalance!.totalBalanceUsd,
                    );
                } else {
                    sortedPools = gqlPools.sort(
                        (a, b) => b.userBalance!.totalBalanceUsd - a.userBalance!.totalBalanceUsd,
                    );
                }
                return first ? sortedPools.slice(skip, skip + first) : sortedPools.slice(skip, undefined);
            }

            if (args.where.reviewedOnly) {
                // if a pool has a rateprovider that is non-zero address, it needs to have a review to be included in the results
                return gqlPools.filter((pool) => {
                    for (const token of pool.poolTokens) {
                        if (token.priceRateProvider && token.priceRateProvider !== ZERO_ADDRESS) {
                            if (!token.priceRateProviderData) {
                                return false;
                            }
                        }
                    }
                    return true;
                });
            }

            return gqlPools;
        }

        const reviewedOnly = args.where?.reviewedOnly;

        // Use full-text search using search_vector
        if (args.textSearch && args.textSearch.trim().length > 0) {
            const orderColumn =
                orderingColumnsMap[(args.orderBy || 'totalLiquidity') as keyof typeof orderingColumnsMap] ||
                'totalLiquidity';

            const searchQuery = sanitiseTextSearch(args.textSearch);
            const limit = Math.min(100, parseInt(`${args.first}`) || 20);
            const offset = parseInt(`${args.skip}`) || 0;
            const filters = searchFilters(args);

            // Use raw SQL for the search vector condition
            // Weighted results don't work yet, because the query is finding IDs for the second query only.
            // But setting it up already so it can be used with the refactored searching
            const query =
                Prisma.raw(`SELECT p.id, p.chain FROM "PrismaPool" p LEFT JOIN "PrismaPoolDynamicData" d on (p.id = d."poolId") WHERE p.search_vector @@ websearch_to_tsquery('simple', '${searchQuery}') AND d."totalSharesNum" > 0.000000000001 AND NOT ('BLACK_LISTED' = ANY(p.categories)) AND ${filters}
            ORDER BY d."${orderColumn}" ${
                    args.orderDirection && args.orderDirection === 'asc' ? 'ASC' : 'DESC'
                } LIMIT ${limit} OFFSET ${offset}`);

            const searchResults = await prisma.$queryRaw<{ id: string }[]>(query);

            // Use the results to show pools
            const idIn = searchResults.map((r) => r.id);
            args.where ||= {};
            args.where.idIn = idIn;
            args.textSearch = undefined;
            args.skip = undefined;
        }

        const pools = await prisma.prismaPool.findMany({
            ...this.mapQueryArgsToPoolQuery(args),
            include: this.getPoolInclude(),
        });

        const gqlPools = pools.map((pool) => this.mapToMinimalGqlPool(pool));

        for (const mappedPool of gqlPools) {
            // load rate provider data into PoolTokenDetail model
            await this.enrichWithRateproviderData(mappedPool);

            // load underlying token info into PoolTokenDetail
            await enrichWithErc4626Data(mappedPool.poolTokens, mappedPool.chain);
        }

        if (reviewedOnly) {
            // if a pool has a rateprovider that is non-zero address, it needs to have a review to be included in the results
            return gqlPools.filter((pool) => {
                for (const token of pool.poolTokens) {
                    if (token.priceRateProvider && token.priceRateProvider !== ZERO_ADDRESS) {
                        if (!token.priceRateProviderData) {
                            return false;
                        }
                    }
                }
                return true;
            });
        }

        return gqlPools;
    }

    public mapToMinimalGqlPool(
        pool: Omit<PrismaPoolMinimal, 'staking'>,
        userWalletbalances: PrismaUserWalletBalance[] = [],
    ): GqlPoolMinimal {
        return {
            ...pool,
            liquidityManagement: (pool.liquidityManagement as LiquidityManagement) || undefined,
            hook: mapHookToGqlHook(pool.hook as HookData),
            incentivized: pool.categories.some((category) => category === 'INCENTIVIZED'),
            vaultVersion: pool.protocolVersion,
            decimals: 18,
            dynamicData: this.getPoolDynamicData(pool),
            poolTokens: pool.tokens.map((token) => mapPoolToken(token, pool.protocolVersion)),
            staking: null,
            userBalance: this.getUserBalance(pool, userWalletbalances),
            categories: pool.categories as GqlPoolFilterCategory[],
            tags: pool.categories,
            hasErc4626: pool.allTokens.some((token) => token.token.types.some((type) => type.type === 'ERC4626')),
            hasNestedErc4626: pool.allTokens.some((token) =>
                token.nestedPool?.allTokens.some((token) => token.token.types.some((type) => type.type === 'ERC4626')),
            ),
            hasAnyAllowedBuffer: pool.allTokens.some(
                (token) => token.token.types.some((type) => type.type === 'ERC4626') && token.token.isBufferAllowed,
            ),
        };
    }

    public async getPoolsCount(args: QueryPoolGetPoolsArgs): Promise<number> {
        if (args.textSearch && args.textSearch.trim().length > 0) {
            const searchQuery = sanitiseTextSearch(args.textSearch);
            const filters = searchFilters(args);

            // Use raw SQL for the search vector condition
            // Weighted results don't work yet, because the query is finding IDs for the second query only.
            // But setting it up already so it can be used with the refactored searching
            const query = Prisma.raw(
                `SELECT count(*) as count FROM "PrismaPool" p LEFT JOIN "PrismaPoolDynamicData" d on (p.id = d."poolId") WHERE p.search_vector @@ websearch_to_tsquery('simple', '${searchQuery}') AND d."totalSharesNum" > 0.000000000001 AND NOT ('BLACK_LISTED' = ANY(p.categories)) AND ${filters}`,
            );

            const searchResults = await prisma.$queryRaw<{ count: bigint }[]>(query);

            // graphql type parsing doesnt seem to understand bigints
            return parseInt(searchResults[0].count as unknown as string);
        } else {
            return prisma.prismaPool.count({ where: this.mapQueryArgsToPoolQuery(args).where });
        }
    }

    public async getFeaturedPools(chains: Chain[]): Promise<GqlPoolFeaturedPool[]> {
        const featuredPoolsFromService = await ContentController().getFeaturedPools(chains);

        const featuredPools: GqlPoolFeaturedPool[] = [];

        for (const contentPool of featuredPoolsFromService) {
            const pool = await this.getPool({}, contentPool.poolId.toLowerCase(), contentPool.chain);
            featuredPools.push({
                poolId: contentPool.poolId,
                primary: contentPool.primary,
                pool: pool,
                description: contentPool.description,
            });
        }

        return featuredPools;
    }

    private mapQueryArgsToPoolQuery(args: QueryPoolGetPoolsArgs): Prisma.PrismaPoolFindManyArgs {
        const orderBy = getOrderBy(args);
        const userAddress = args.where?.userAddress;

        const baseQuery: Prisma.PrismaPoolFindManyArgs = {
            take: args.first || undefined,
            skip: args.skip || undefined,
            orderBy,
        };

        if (!args.where && !args.textSearch) {
            return {
                ...baseQuery,
                where: {
                    NOT: {
                        categories: {
                            has: 'BLACK_LISTED',
                        },
                    },
                    dynamicData: {
                        totalSharesNum: {
                            gt: 0.000000000001,
                        },
                    },
                },
            };
        }

        const where = args.where || {};
        let textSearch: Prisma.StringFilter | undefined;
        if (args.textSearch && isPoolId(args.textSearch)) {
            where.idIn = [args.textSearch];
        } else if (args.textSearch) {
            textSearch = { contains: args.textSearch, mode: 'insensitive' as const };
        }

        const allTokensFilter: { allTokens: { some: { token: { address: { equals: string } } } } }[] = [];
        const allTokensFilterNot = [];
        where?.tokensIn?.forEach((token) => {
            allTokensFilter.push({
                allTokens: {
                    some: {
                        token: {
                            address: {
                                equals: token.toLowerCase(),
                            },
                        },
                    },
                },
            });
        });

        if (where?.tokensNotIn) {
            allTokensFilterNot.push({
                allTokens: {
                    every: {
                        token: {
                            address: {
                                notIn: where.tokensNotIn.map((t) => t.toLowerCase()) || undefined,
                            },
                        },
                    },
                },
            });
        }

        const userArgs: Prisma.PrismaPoolWhereInput = userAddress
            ? {
                  OR: [
                      {
                          userWalletBalances: {
                              some: {
                                  userAddress: {
                                      equals: userAddress.toLowerCase(),
                                  },
                                  balanceNum: { gt: 0 },
                              },
                          },
                      },
                  ],
              }
            : {};

        const filterArgs: Prisma.PrismaPoolWhereInput = {
            dynamicData: {
                totalSharesNum: {
                    gt: 0.000000000001,
                },
                totalLiquidity: {
                    gt: where?.minTvl || undefined,
                },
            },
            chain: {
                in: where?.chainIn || undefined,
                notIn: where?.chainNotIn || undefined,
            },
            protocolVersion: {
                in: where?.protocolVersionIn || undefined,
            },
            type: {
                in: where?.poolTypeIn || undefined,
                notIn: where?.poolTypeNotIn || undefined,
            },
            createTime: {
                gt: where?.createTime?.gt || undefined,
                lt: where?.createTime?.lt || undefined,
            },
            AND: [{ OR: allTokensFilter }, { OR: allTokensFilterNot }],
            id: {
                in: where?.idIn?.map((id) => id.toLowerCase()) || undefined,
                notIn: where?.idNotIn?.map((id) => id.toLowerCase()) || undefined,
            },
            ...(where?.categoryIn && !where?.tagIn
                ? { categories: { hasSome: where.categoryIn.map((s) => s.toUpperCase()) } }
                : {}),
            ...(where?.categoryNotIn && !where?.tagNotIn
                ? { NOT: { categories: { hasSome: where.categoryNotIn.map((s) => s.toUpperCase()) } } }
                : {}),
            ...(where?.tagIn && !where?.categoryIn
                ? { categories: { hasSome: where.tagIn.map((s) => s.toUpperCase()) } }
                : {}),
            ...(where?.tagNotIn && !where?.categoryNotIn
                ? { NOT: { categories: { hasSome: where.tagNotIn.map((s) => s.toUpperCase()) } } }
                : {}),
            filters: {
                ...(where?.filterNotIn
                    ? {
                          every: {
                              filterId: {
                                  notIn: where.filterNotIn,
                              },
                          },
                      }
                    : {}),
                ...(where?.filterIn
                    ? {
                          some: {
                              filterId: {
                                  in: where.filterIn,
                              },
                          },
                      }
                    : {}),
            },
            ...(where?.hasHook !== undefined && where.hasHook
                ? { hook: { path: ['address'], string_starts_with: '0x' } }
                : where?.hasHook !== undefined && !where.hasHook
                ? { hook: { equals: Prisma.DbNull } }
                : {}),
        };

        if (!textSearch) {
            return {
                ...baseQuery,
                where: {
                    ...filterArgs,
                    ...userArgs,
                },
            };
        }

        return {
            ...baseQuery,
            where: {
                OR: [
                    { name: textSearch, ...filterArgs, ...userArgs },
                    { symbol: textSearch, ...filterArgs, ...userArgs },
                    {
                        ...filterArgs,
                        ...userArgs,
                        allTokens: {
                            some: {
                                token: {
                                    OR: [
                                        { symbol: textSearch },
                                        { address: filterArgs.allTokens?.some?.token?.address },
                                        { address: textSearch },
                                    ],
                                },
                            },
                        },
                    },
                ],
            },
        };
    }

    private mapPoolToGqlPool(
        pool: Omit<PrismaPoolWithExpandedNesting, 'staking'>,
        userWalletbalances: PrismaUserWalletBalance[] = [],
    ): GqlPoolUnion {
        const { typeData, ...poolWithoutTypeData } = pool;

        const mappedData = {
            decimals: 18,
            owner: pool.swapFeeManager, // Keep for backwards compatibility
            staking: null,
            dynamicData: this.getPoolDynamicData(pool),
            poolTokens: pool.tokens.map((token) => mapPoolToken(token, pool.protocolVersion)),
            userBalance: this.getUserBalance(pool, userWalletbalances),
            vaultVersion: poolWithoutTypeData.protocolVersion,
            categories: pool.categories as GqlPoolFilterCategory[],
            tags: pool.categories,
            hook: mapHookToGqlHook(pool.hook as HookData),
            liquidityManagement: (pool.liquidityManagement as LiquidityManagement) || undefined,
            hasErc4626: pool.allTokens.some((token) => token.token.types.some((type) => type.type === 'ERC4626')),
            hasNestedErc4626: pool.allTokens.some((token) =>
                token.nestedPool?.allTokens.some((token) => token.token.types.some((type) => type.type === 'ERC4626')),
            ),
            hasAnyAllowedBuffer: pool.allTokens.some(
                (token) => token.token.types.some((type) => type.type === 'ERC4626') && token.token.isBufferAllowed,
            ),
        };

        switch (pool.type) {
            case 'STABLE':
                return {
                    __typename: 'GqlPoolStable',
                    ...poolWithoutTypeData,
                    ...(typeData as StableData),
                    ...mappedData,
                };
            case 'GYROE': {
                const gyroData: GyroData = {
                    alpha: '',
                    beta: '',
                    c: '',
                    s: '',
                    lambda: '',
                    tauAlphaX: '',
                    tauAlphaY: '',
                    tauBetaX: '',
                    tauBetaY: '',
                    u: '',
                    v: '',
                    w: '',
                    z: '',
                    dSq: '',
                    ...(typeData as Partial<GyroData>),
                };
                return {
                    __typename: 'GqlPoolGyro',
                    ...poolWithoutTypeData,
                    ...gyroData,
                    sqrtAlpha: '',
                    sqrtBeta: '',
                    root3Alpha: '',
                    ...mappedData,
                };
            }
        }

        return {
            __typename: 'GqlPoolWeighted',
            ...poolWithoutTypeData,
            ...mappedData,
        };
    }

    private getUserBalance(
        pool: Omit<PrismaPoolMinimal, 'staking'>,
        userWalletBalances: PrismaUserWalletBalance[],
    ): GqlPoolUserBalance {
        let bptPrice = 0;
        if (pool.dynamicData && pool.dynamicData.totalLiquidity > 0 && parseFloat(pool.dynamicData.totalShares) > 0) {
            bptPrice = pool.dynamicData.totalLiquidity / parseFloat(pool.dynamicData.totalShares);
        }
        const walletBalance = userWalletBalances.at(0)?.balance || '0';
        const walletBalanceNum = userWalletBalances.at(0)?.balanceNum || 0;

        return {
            walletBalance: walletBalance,
            walletBalanceUsd: walletBalanceNum * bptPrice,
            totalBalance: walletBalanceNum.toString(),
            totalBalanceUsd: walletBalanceNum * bptPrice,
            stakedBalances: [],
        };
    }

    private getPoolDynamicData(pool: Omit<PrismaPoolMinimal, 'staking'>): GqlPoolDynamicData {
        const {
            fees24h,
            totalLiquidity,
            volume24h,
            surplus24h,
            fees48h,
            volume48h,
            surplus48h,
            yieldCapture24h,
            yieldCapture48h,
            totalLiquidity24hAgo,
            totalShares24hAgo,
            lifetimeVolume,
            lifetimeSwapFees,
            holdersCount,
            swapsCount,
            protocolFees24h,
            protocolFees48h,
            protocolYieldCapture24h,
            protocolYieldCapture48h,
        } = pool.dynamicData!;

        const aprItems = mapAprItems(pool);

        return {
            ...pool.dynamicData!,
            totalLiquidity: `${fixedNumber(totalLiquidity, 2)}`,
            totalLiquidity24hAgo: `${fixedNumber(totalLiquidity24hAgo, 2)}`,
            totalShares24hAgo,
            totalSupply: pool.dynamicData?.totalShares || '0',
            fees24h: `${fixedNumber(fees24h, 2)}`,
            volume24h: `${fixedNumber(volume24h, 2)}`,
            surplus24h: `${fixedNumber(surplus24h, 2)}`,
            surplus48h: `${fixedNumber(surplus48h, 2)}`,
            yieldCapture24h: `${fixedNumber(yieldCapture24h, 2)}`,
            yieldCapture48h: `${fixedNumber(yieldCapture48h, 2)}`,
            fees48h: `${fixedNumber(fees48h, 2)}`,
            volume48h: `${fixedNumber(volume48h, 2)}`,
            lifetimeVolume: `${fixedNumber(lifetimeVolume, 2)}`,
            lifetimeSwapFees: `${fixedNumber(lifetimeSwapFees, 2)}`,
            holdersCount: `${holdersCount}`,
            swapsCount: `${swapsCount}`,
            sharePriceAth: '0',
            sharePriceAtl: '0',
            totalLiquidityAth: '0',
            totalLiquidityAtl: '0',
            volume24hAtl: '0',
            volume24hAth: '0',
            fees24hAtl: '0',
            fees24hAth: '0',
            sharePriceAthTimestamp: 0,
            sharePriceAtlTimestamp: 0,
            totalLiquidityAthTimestamp: 0,
            totalLiquidityAtlTimestamp: 0,
            fees24hAthTimestamp: 0,
            fees24hAtlTimestamp: 0,
            volume24hAthTimestamp: 0,
            volume24hAtlTimestamp: 0,
            protocolYieldCapture24h: `${fixedNumber(protocolYieldCapture24h || 0, 2)}`,
            protocolYieldCapture48h: `${fixedNumber(protocolYieldCapture48h || 0, 2)}`,
            protocolFees24h: `${fixedNumber(protocolFees24h || 0, 2)}`,
            protocolFees48h: `${fixedNumber(protocolFees48h || 0, 2)}`,
            aprItems: aprItems,
        };
    }

    private getPoolMinimalInclude(userAddress?: string) {
        if (!userAddress) {
            const { staking: _staking, ...include } = prismaPoolMinimal.include;
            return {
                ...include,
                userWalletBalances: false,
            };
        }

        const { staking: _staking, ...include } = prismaPoolMinimal.include;
        return {
            ...include,
            userWalletBalances: {
                where: {
                    userAddress: {
                        equals: userAddress.toLowerCase(),
                    },
                    balanceNum: { gt: 0 },
                },
            },
        };
    }

    private getPoolInclude(userAddress?: string) {
        if (!userAddress) {
            const { staking: _staking, ...include } = prismaPoolWithExpandedNesting.include;
            return {
                ...include,
                userWalletBalances: false,
            };
        }

        const { staking: _staking, ...include } = prismaPoolWithExpandedNesting.include;
        return {
            ...include,
            userWalletBalances: {
                where: {
                    userAddress: {
                        equals: userAddress.toLowerCase(),
                    },
                    balanceNum: { gt: 0 },
                },
            },
        };
    }
}

const orderingColumnsMap = {
    totalLiquidity: 'totalLiquidity',
    totalShares: 'totalSharesNum',
    volume24h: 'volume24h',
    fees24h: 'fees24h',
    apr: 'apr',
};

const getOrderBy = (args: QueryPoolGetPoolsArgs) => {
    const orderDirection = args.orderDirection || 'desc';
    const orderColumn = orderingColumnsMap[(args.orderBy || 'totalLiquidity') as keyof typeof orderingColumnsMap];

    if (!orderColumn) {
        return undefined;
    }

    const orderBy = {
        dynamicData: {
            [orderColumn]: orderDirection,
        },
    };

    return orderBy;
};

const sanitizeInput = (input: any) => `${input}`.replace(/[^a-zA-Z0-9._ ]/g, '').trim();

const sanitiseTextSearch = (textSearch: string) => {
    let searchQuery = sanitizeInput(textSearch).toLowerCase();

    // Replace terms like LBP and BTF
    const replacements = {
        lbp: 'LIQUIDITY_BOOTSTRAPPING',
    };

    // Apply replacements for whole words only
    for (const [key, value] of Object.entries(replacements)) {
        const wordRegex = new RegExp(`\\b${key}\\b`, 'g');
        searchQuery = searchQuery.replace(wordRegex, value);
    }

    return searchQuery;
};

const searchFilters = (args: QueryPoolGetPoolsArgs) => {
    let where = '1=1 ';

    if (args.where?.chainIn) {
        where += `AND p.chain = ANY('{${args.where?.chainIn.map(sanitizeInput).join(',')}}')`;
    }

    if (args.where?.protocolVersionIn) {
        where += `AND p."protocolVersion" = ANY('{${args.where?.protocolVersionIn.map(sanitizeInput).join(',')}}')`;
    }

    if (args.where?.poolTypeIn) {
        where += `AND p.type = ANY('{${args.where?.poolTypeIn.map(sanitizeInput).join(',')}}')`;
    }

    if (args.where?.categoryIn) {
        where += `AND p.categories @> ARRAY['${args.where?.categoryIn.map(sanitizeInput).join("','")}']`;
    }

    if (args.where?.tagIn) {
        where += `AND p.categories @> ARRAY['${args.where?.tagIn.map(sanitizeInput).join("','")}']`;
    }

    if (args.where?.minTvl) {
        where += `AND d."totalLiquidity" >= ${args.where?.minTvl}`;
    }

    return where;
};
