import { TokenPriceItem } from './token-types';
import { prisma } from '../../prisma/prisma-client';
import { TokenPriceService } from './lib/token-price.service';
import {
    Chain,
    Prisma,
    PrismaToken,
    PrismaTokenCurrentPrice,
    PrismaTokenDynamicData,
    PrismaTokenPrice,
    PrismaTokenTypeOption,
} from '@prisma/client';
import { Cache, CacheClass } from 'memory-cache';
import {
    Erc4626ReviewData,
    GqlChain,
    GqlPriceRateProviderData,
    GqlToken,
    GqlTokenChartDataRange,
    MutationTokenDeleteTokenTypeArgs,
    QueryTokenGetTokensArgs,
} from '../../apps/api/gql/generated-schema';
import { createHash } from 'node:crypto';
import { Dictionary } from 'lodash';
import config from '../../config';
import { addressesMatch, normalizeAddress } from '../web3/addresses';
import { BoundedLruCache } from '../common/bounded-cache';
import { stableStringify } from '../common/stable-stringify';

const TOKEN_PRICES_CACHE_KEY = `token:prices:current`;
const TOKEN_PRICES_24H_AGO_CACHE_KEY = `token:prices:24h-ago`;
const ALL_TOKENS_CACHE_KEY = `tokens:all`;
const ERC4626_REVIEW_DATA_CACHE_KEY = `erc4626:review-data`;
const TOKEN_DEFINITIONS_TTL_MS = 30 * 1000;
const TOKEN_DEFINITIONS_MAX_ENTRIES = 64;
const TOKEN_DEFINITIONS_MAX_BYTES = 8 * 1024 * 1024;

export class TokenService {
    cache: CacheClass<string, any>;
    private inFlight = new Map<string, Promise<unknown>>();
    private cacheGeneration = 0;
    private definitionsCache = new BoundedLruCache<GqlToken[]>({
        maxEntries: TOKEN_DEFINITIONS_MAX_ENTRIES,
        maxBytes: TOKEN_DEFINITIONS_MAX_BYTES,
        defaultTtlMs: TOKEN_DEFINITIONS_TTL_MS,
    });

    constructor(private readonly tokenPriceService: TokenPriceService) {
        this.cache = new Cache<string, any>();
    }

    public invalidateTokenCaches(): void {
        this.cacheGeneration += 1;
        this.definitionsCache.clear();
        this.cache.clear();
        this.inFlight.clear();
    }

    private singleFlight<T>(key: string, load: (generationAtStart: number) => Promise<T>): Promise<T> {
        const generationAtStart = this.cacheGeneration;
        const scopedKey = `${generationAtStart}:${key}`;
        const existing = this.inFlight.get(scopedKey) as Promise<T> | undefined;
        if (existing) {
            return existing;
        }
        const promise = load(generationAtStart).finally(() => {
            if (this.inFlight.get(scopedKey) === promise) {
                this.inFlight.delete(scopedKey);
            }
        });
        this.inFlight.set(scopedKey, promise);
        return promise;
    }

    public async getToken(address: string, chain: Chain): Promise<PrismaToken | null> {
        return prisma.prismaToken.findUnique({
            where: {
                address_chain: {
                    address: normalizeAddress(address),
                    chain,
                },
            },
        });
    }

    /**
     * Use cached tokens to get decimals from memory to enable fast SOR lookups without hitting the database.
     * @param chain
     */
    async getTokenDecimals(address: string, chain: Chain): Promise<number | undefined> {
        const tokens = await this.getTokens(chain, [address]);
        if (tokens.length === 0) return;

        return tokens[0].decimals;
    }

    public async getTokens(chain: Chain, addresses?: string[]): Promise<PrismaToken[]> {
        const cacheKey = `${ALL_TOKENS_CACHE_KEY}:${chain}`;
        let tokens: PrismaToken[] | null = this.cache.get(cacheKey);
        if (!tokens) {
            tokens = await this.singleFlight(cacheKey, async (generationAtStart) => {
                const loaded = await prisma.prismaToken.findMany({ where: { chain: chain } });
                // An empty list must not be cached. A quote before the first sync would
                // otherwise hide every token added during the next five minutes.
                if (loaded.length > 0 && generationAtStart === this.cacheGeneration) {
                    this.cache.put(cacheKey, loaded, 5 * 60 * 1000);
                }
                return loaded;
            });
        }
        if (addresses) {
            const wanted = new Set(addresses.map((address) => normalizeAddress(address)));
            return tokens.filter((token) => wanted.has(token.address.toLowerCase()));
        }
        return tokens;
    }

    public async getTokenDefinition(address: string, chain: Chain): Promise<GqlToken | undefined> {
        const token = await prisma.prismaToken.findUnique({
            where: { address_chain: { address: normalizeAddress(address), chain: chain } },
            include: { types: true },
        });

        if (token) {
            const rateProviderData = await this.getPriceRateProviderData([token]);
            const erc4626Data = await this.getErc4626Data();
            return {
                ...token,
                chain: token.chain as GqlChain,
                types: token.types.map((type) => type.type),
                isBufferAllowed: token.isBufferAllowed,
                chainId: config[chain].chain.id,
                tradable: !token.types.find((type) => type.type === 'BPT'),
                rateProviderData: rateProviderData[`${token.address}-${token.chain}`],
                priceRateProviderData: rateProviderData[`${token.address}-${token.chain}`],
                coingeckoId: token.coingeckoTokenId,
                isErc4626: token.types.some((type) => type.type === 'ERC4626'),
                erc4626ReviewData: erc4626Data[`${token.address}-${token.chain}`],
            };
        }

        return undefined;
    }

    public async getTokenDefinitions(args: QueryTokenGetTokensArgs): Promise<GqlToken[]> {
        const cacheKey = createHash('sha256')
            .update(stableStringify({ chains: args.chains ?? [], where: args.where ?? null }))
            .digest('hex');
        const cached = this.definitionsCache.getSync(cacheKey);
        if (cached) {
            return cached;
        }
        return this.singleFlight(`token:definitions:${cacheKey}`, async (generationAtStart) => {
            const definitions = await this.loadTokenDefinitions(args);
            if (generationAtStart === this.cacheGeneration) {
                this.definitionsCache.setSync(cacheKey, definitions);
            }
            return definitions;
        });
    }

    private async loadTokenDefinitions(args: QueryTokenGetTokensArgs): Promise<GqlToken[]> {
        const chains = args.chains!;
        const types = (args.where?.typeIn || []) as PrismaTokenTypeOption[];
        const where: Prisma.PrismaTokenWhereInput = {
            chain: { in: chains },
        };

        if (args.where?.tokensIn) {
            where.address = { in: args.where.tokensIn };
        }

        const [dbTokens, typesMap] = await Promise.all([
            prisma.prismaToken.findMany({
                where,
                orderBy: { tvl: 'desc' },
            }),
            prisma.prismaTokenType
                .findMany({
                    where: {
                        chain: {
                            in: chains,
                        },
                    },
                })
                .then((types) =>
                    types.reduce(
                        (agg, item) => {
                            agg[`${item.chain}-${item.tokenAddress}`] ||= [];
                            agg[`${item.chain}-${item.tokenAddress}`].push(item.type);
                            return agg;
                        },
                        {} as Record<string, PrismaTokenTypeOption[]>,
                    ),
                ),
        ]);

        const tokens = dbTokens
            .map((token) => ({ ...token, types: typesMap[`${token.chain}-${token.address}`] || [] }))
            .filter(
                (token) =>
                    // Always include WHITE_LISTED
                    token.types.includes('WHITE_LISTED') ||
                    // Exclude BPT tokens
                    !token.types.includes('BPT'),
            )
            .filter((token) => types.every((type) => token.types.includes(type)));

        // Use once prisma is setup with relationJoins, otherwise fails with too many bindings
        // if (args.where?.typeIn) {
        //     where.types = { some: { type: { in: args.where.typeIn } } };
        // }
        // const tokens = await prisma.prismaToken
        //     .findMany({
        //         where,
        //         include: {
        //             types: true,
        //         },
        //         orderBy: { tvl: 'desc' },
        //     })
        //     .then((tokens) => tokens.map((token) => ({ ...token, types: token.types.map((type) => type.type) || [] })));

        for (const chain of chains) {
            const weth = tokens.find(
                (token) => token.chain === chain && addressesMatch(token.address, config[chain].weth.address),
            );

            if (weth) {
                tokens.push({
                    ...weth,
                    name: config[chain].eth.name,
                    address: config[chain].eth.address,
                    symbol: config[chain].eth.symbol,
                    logoURI: config[chain].eth.logoURI ?? weth.logoURI,
                    chain: config[chain].chain.prismaId,
                });
            }
        }

        const rateProviderData = await this.getPriceRateProviderData(tokens, chains);
        const erc4626Data = await this.getErc4626Data();

        return tokens.map((token) => ({
            ...token,
            chain: token.chain as GqlChain,
            chainId: config[token.chain].chain.id,
            tradable: !token.types.find((type) => type === 'BPT'),
            rateProviderData: rateProviderData[`${token.address}-${token.chain}`],
            priceRateProviderData: rateProviderData[`${token.address}-${token.chain}`],
            coingeckoId: token.coingeckoTokenId,
            isErc4626: token.types.some((type) => type === 'ERC4626'),
            underlyingTokenAddress: token.underlyingTokenAddress,
            erc4626ReviewData: erc4626Data[`${token.address}-${token.chain}`],
        }));
    }

    private async getPriceRateProviderData(
        tokens: PrismaToken[],
        chains?: Chain[],
    ): Promise<Record<string, GqlPriceRateProviderData | undefined>> {
        const priceRateProviders = await prisma.prismaPriceRateProviderData.findMany({
            where: {
                ...(tokens.length < 20
                    ? {
                          tokenAddress: {
                              in: tokens.map((t) => t.address),
                          },
                      }
                    : {}),
                ...(chains
                    ? {
                          chain: {
                              in: chains,
                          },
                      }
                    : {}),
            },
        });

        const priceRateProviderDataResult: Record<string, GqlPriceRateProviderData | undefined> = {};

        for (const token of tokens) {
            const key = `${token.address}-${token.chain}`;
            const providersForToken = priceRateProviders.filter(
                (provider) => provider.tokenAddress === token.address && provider.chain === token.chain,
            );

            if (providersForToken.length === 1) {
                priceRateProviderDataResult[key] = {
                    ...providersForToken[0],
                    warnings: providersForToken[0].warnings?.split(',').filter(Boolean) || [],
                    address: providersForToken[0].rateProviderAddress,
                };
            } else if (providersForToken.length > 1) {
                // need to find the "preferred" price rate provider
                // only return the safe one
                // if all are reviewed and safe, we can just return the first one
                for (const provider of providersForToken) {
                    if (provider.reviewed && provider.summary === 'safe') {
                        priceRateProviderDataResult[key] = {
                            ...provider,
                            warnings: provider.warnings?.split(',').filter(Boolean) || [],
                            address: provider.rateProviderAddress,
                        };
                    }
                }
            } else {
                priceRateProviderDataResult[key] = undefined;
            }
        }
        return priceRateProviderDataResult;
    }

    async getErc4626Data(): Promise<
        Record<string, (Erc4626ReviewData & { erc4626Address: string; assetAddress: string; chain: Chain }) | undefined>
    > {
        let erc4626Data: Record<
            string,
            Erc4626ReviewData & { erc4626Address: string; assetAddress: string; chain: Chain }
        > | null = this.cache.get(ERC4626_REVIEW_DATA_CACHE_KEY);

        if (!erc4626Data) {
            erc4626Data = await this.singleFlight(ERC4626_REVIEW_DATA_CACHE_KEY, async (generationAtStart) => {
                const reviews = await prisma.prismaErc4626ReviewData.findMany();
                // Remove all duplicates, keeping only items that appear exactly once
                const addressChainCounts = new Map<string, number>();
                for (const review of reviews) {
                    const key = `${review.erc4626Address}-${review.chain}`;
                    addressChainCounts.set(key, (addressChainCounts.get(key) || 0) + 1);
                }

                const data = Object.fromEntries(
                    reviews
                        .filter((review) => addressChainCounts.get(`${review.erc4626Address}-${review.chain}`) === 1)
                        .map((review) => [
                            `${review.erc4626Address}-${review.chain}`,
                            {
                                ...review,
                                warnings: review.warnings?.split(',').filter(Boolean) || [],
                            },
                        ]),
                );
                if (generationAtStart === this.cacheGeneration) {
                    this.cache.put(ERC4626_REVIEW_DATA_CACHE_KEY, data, 10 * 60 * 1000); // cache for 10 min
                }
                return data;
            });
        }

        return erc4626Data;
    }

    public async getTokenPrices(chain: Chain): Promise<PrismaTokenCurrentPrice[]> {
        const cacheKey = `${TOKEN_PRICES_CACHE_KEY}:${chain}`;
        let tokenPrices: PrismaTokenCurrentPrice[] | null = this.cache.get(cacheKey);
        if (!tokenPrices) {
            tokenPrices = await this.singleFlight(cacheKey, async (generationAtStart) => {
                const prices = await this.tokenPriceService.getCurrentTokenPrices([chain]);
                if (generationAtStart === this.cacheGeneration) {
                    this.cache.put(cacheKey, prices, 30 * 1000);
                }
                return prices;
            });
        }
        return tokenPrices;
    }

    public async getTokenPricesForChains(chains: Chain[]): Promise<Dictionary<PrismaTokenCurrentPrice[]>> {
        const response: Dictionary<PrismaTokenCurrentPrice[]> = {};

        for (const chain of chains) {
            response[chain] = await this.getTokenPrices(chain);
        }

        return response;
    }

    public async getCurrentTokenPrices(chains: Chain[]): Promise<PrismaTokenCurrentPrice[]> {
        return this.tokenPriceService.getCurrentTokenPrices(chains);
    }

    public getPriceForToken(tokenPrices: PrismaTokenCurrentPrice[], tokenAddress: string, chain: Chain): number {
        return this.tokenPriceService.getPriceForToken(tokenPrices, tokenAddress, chain);
    }

    public async getTokenDynamicData(tokenAddress: string, chain: Chain): Promise<PrismaTokenDynamicData | null> {
        const token = await prisma.prismaToken.findUnique({
            where: {
                address_chain: {
                    address: normalizeAddress(tokenAddress),
                    chain: chain,
                },
            },
            include: {
                dynamicData: true,
            },
        });

        if (token) {
            return token.dynamicData;
        }

        return null;
    }

    public async getTokensDynamicData(tokenAddresses: string[], chain: Chain): Promise<PrismaTokenDynamicData[]> {
        const tokens = await prisma.prismaToken.findMany({
            where: {
                address: { in: tokenAddresses.map((address) => normalizeAddress(address)) },
                chain: chain,
            },
            include: {
                dynamicData: true,
            },
        });

        // why doesn't this work with map??
        const dynamicData: PrismaTokenDynamicData[] = [];
        for (const token of tokens) {
            if (token.dynamicData) {
                dynamicData.push(token.dynamicData);
            }
        }

        return dynamicData;
    }

    public async getTokenPricesForRange(
        tokenAddress: string[],
        range: GqlTokenChartDataRange,
        chain: Chain,
    ): Promise<PrismaTokenPrice[]> {
        return this.tokenPriceService.getTokenPricesForRange(tokenAddress, range, chain);
    }

    public async getRelativeDataForRange(
        tokenIn: string,
        tokenOut: string,
        range: GqlTokenChartDataRange,
        chain: Chain,
    ): Promise<TokenPriceItem[]> {
        return this.tokenPriceService.getRelativeDataForRange(tokenIn, tokenOut, range, chain);
    }

    public async purgeOldTokenPricesForAllChains() {
        return this.tokenPriceService.purgeOldTokenPricesForAllChains();
    }

    public async deleteTokenType({ tokenAddress, type }: MutationTokenDeleteTokenTypeArgs, chain: Chain) {
        await prisma.prismaTokenType.delete({
            where: {
                tokenAddress_type_chain: {
                    tokenAddress,
                    type,
                    chain,
                },
            },
        });
        this.invalidateTokenCaches();
    }
}

export const tokenService = new TokenService(new TokenPriceService());
