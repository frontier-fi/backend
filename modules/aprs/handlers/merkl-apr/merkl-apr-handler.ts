import { PrismaPoolAprItem, PrismaPoolAprType } from '@prisma/client';
import { AprHandler, PoolAPRData } from '../../types';
import config from '../../../../config';
import { chainIdToChain } from '../../../../config/chain-id-to-chain';
import { env } from '../../../../apps/env';
import { addressesMatch } from '../../../web3/addresses';

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const TOKEN_BATCH_SIZE = 4;
const DEFAULT_BATCH_DELAY_MS = 300;
const DEFAULT_CACHE_TTL_MS = 240_000;
const MIN_CACHE_TTL_MS = 60_000;
const MAX_CACHE_TTL_MS = 300_000;
const MAX_CACHE_ENTRIES = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 10_000;

// Merkl uses mainProtocolId='frontier' for Frontier pool campaigns; token campaigns below do not depend on the protocol.
const opportunityUrl = (chainId: number, page: number) =>
    `https://api.merkl.xyz/v4/opportunities/?test=false&status=LIVE&campaigns=true&mainProtocolId=frontier&chainId=${chainId}&page=${page}&items=${PAGE_SIZE}`;

const tokenOpportunityUrl = (chainId: number, tokenAddress: string) =>
    `https://api.merkl.xyz/v4/opportunities/?status=LIVE&campaigns=true&chainId=${chainId}&explorerAddress=${tokenAddress}`;

interface MerklTokenInfo {
    address?: string;
    symbol?: string;
}

interface MerklOpportunity {
    id?: string;
    type?: string;
    chainId: number;
    identifier: string;
    dailyRewards: number;
    tvl?: number;
    explorerAddress: string;
    apr: number;
    rewardsRecord?: {
        breakdowns?: {
            token?: MerklTokenInfo;
        }[];
    };
    campaigns?: {
        rewardToken?: MerklTokenInfo;
        params?: {
            whitelist?: string[];
        };
    }[];
}

export interface MerklAprHandlerOptions {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    batchDelayMs?: number;
    retryBaseDelayMs?: number;
    maxRetries?: number;
    requestTimeoutMs?: number;
}

interface CacheEntry {
    data: MerklOpportunity[];
    expiresAt: number;
}

const responseCache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, Promise<MerklOpportunity[]>>();

/** Clears the shared Merkl response cache and in-flight dedupe map (intended for tests). */
export function clearMerklResponseCache(): void {
    responseCache.clear();
    inFlightRequests.clear();
}

class NonRetryableMerklError extends Error {}

function parseCacheTtlMs(cacheControl: string | null): number {
    if (!cacheControl) {
        return DEFAULT_CACHE_TTL_MS;
    }
    const match = cacheControl.match(/max-age=(\d+)/i);
    if (!match) {
        return DEFAULT_CACHE_TTL_MS;
    }
    const seconds = Number(match[1]);
    if (!Number.isFinite(seconds)) {
        return DEFAULT_CACHE_TTL_MS;
    }
    return Math.min(MAX_CACHE_TTL_MS, Math.max(MIN_CACHE_TTL_MS, seconds * 1_000));
}

function setCachedEntry(url: string, entry: CacheEntry, currentTime: number): void {
    responseCache.delete(url);
    if (responseCache.size >= MAX_CACHE_ENTRIES) {
        for (const [key, cached] of responseCache) {
            if (cached.expiresAt <= currentTime) {
                responseCache.delete(key);
            }
        }
    }
    while (responseCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = responseCache.keys().next().value;
        if (oldestKey === undefined) break;
        responseCache.delete(oldestKey);
    }
    responseCache.set(url, entry);
}

export class MerklAprHandler implements AprHandler {
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly batchDelayMs: number;
    private readonly retryBaseDelayMs: number;
    private readonly maxRetries: number;
    private readonly requestTimeoutMs: number;

    constructor(options: MerklAprHandlerOptions = {}) {
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.batchDelayMs = options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS;
        this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
        this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    }

    public getAprServiceName(): string {
        return 'MerklAprHandler';
    }

    public getAprTypes(): PrismaPoolAprType[] {
        return [PrismaPoolAprType.MERKL];
    }

    private filterPublicOpportunities(opportunities: MerklOpportunity[]): MerklOpportunity[] {
        return opportunities.filter((opportunity) =>
            (opportunity.campaigns ?? []).every((campaign) => (campaign.params?.whitelist?.length ?? 0) === 0),
        );
    }

    private deduplicateOpportunities(opportunities: MerklOpportunity[]): MerklOpportunity[] {
        const seenIds = new Set<string>();
        const result: MerklOpportunity[] = [];
        for (const opportunity of opportunities) {
            if (opportunity.id) {
                if (seenIds.has(opportunity.id)) {
                    continue;
                }
                seenIds.add(opportunity.id);
            }
            result.push(opportunity);
        }
        return result;
    }

    private extractRewardToken(opportunity: MerklOpportunity): {
        address: string | null;
        symbol: string | null;
    } {
        const token =
            opportunity.rewardsRecord?.breakdowns?.find((b) => b.token?.symbol || b.token?.address)?.token ??
            opportunity.campaigns?.find((c) => c.rewardToken?.symbol || c.rewardToken?.address)?.rewardToken;

        return {
            address: token?.address?.toLowerCase() ?? null,
            symbol: token?.symbol ?? null,
        };
    }

    private getEffectiveTokenOpportunityApr(opportunity: MerklOpportunity): number {
        // AAVE_NET_LENDING opportunities report their MAX_APR target cap rather than realized gross supply APR.
        // Cap fallback APRs by realized dailyRewards * 365 / tvl so wrapped ERC4626 positions aren't overstated.
        if (
            opportunity.type === 'AAVE_NET_LENDING' &&
            typeof opportunity.tvl === 'number' &&
            Number.isFinite(opportunity.tvl) &&
            opportunity.tvl > 0 &&
            typeof opportunity.dailyRewards === 'number' &&
            Number.isFinite(opportunity.dailyRewards) &&
            opportunity.dailyRewards >= 0
        ) {
            const realizedGrossApr = ((opportunity.dailyRewards * 365) / opportunity.tvl) * 100;
            return Math.min(opportunity.apr, realizedGrossApr);
        }
        return opportunity.apr;
    }

    private async fetchMerklOpportunities(chainId: number) {
        const data: MerklOpportunity[] = [];
        for (let page = 0; page < MAX_PAGES; page++) {
            const pageData = await this.fetchOpportunitiesCached(opportunityUrl(chainId, page));
            data.push(...pageData);
            if (pageData.length < PAGE_SIZE) {
                break;
            }
        }

        // remove opportunities with whitelist and dedupe across pages
        return this.deduplicateOpportunities(this.filterPublicOpportunities(data));
    }

    public async calculateAprForPools(
        pools: PoolAPRData[],
    ): Promise<Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[]> {
        const aprsFromOpportunities = await this.findPoolOpportunities(pools);

        // for boosted pools
        const aprsFromTokenOpportunities = await this.findTokenOpportunities(pools);

        return this.combineAndDeduplicateAprs([...aprsFromOpportunities, ...aprsFromTokenOpportunities]);
    }

    private combineAndDeduplicateAprs(
        aprs: Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[],
    ): Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[] {
        // Keep one APR item per Merkl opportunity (keyed by item id) and sum if multiple tokens in the same pool share an opportunity.
        const aprMap: Map<string, Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>> = new Map();

        for (const apr of aprs) {
            const existing = aprMap.get(apr.id);
            if (existing) {
                existing.apr += apr.apr;
            } else {
                aprMap.set(apr.id, { ...apr });
            }
        }
        return Array.from(aprMap.values());
    }

    private async findPoolOpportunities(pools: PoolAPRData[]) {
        const chain = pools[0].chain;
        const opportunities = await this.fetchMerklOpportunities(config[chain].chain.id);

        const allAffectedPoolAddresses = opportunities.map((campaign) => campaign.identifier.toLowerCase());

        const affectedPools = pools.filter((pool) => allAffectedPoolAddresses.includes(pool.address.toLowerCase()));

        return this.mapOpportunitiesToAprs(opportunities, affectedPools);
    }

    private async fetchTokenOpportunitiesBatched(
        chainId: number,
        tokenAddresses: string[],
    ): Promise<Map<string, MerklOpportunity[]>> {
        const byAddress = new Map<string, MerklOpportunity[]>();
        for (let i = 0; i < tokenAddresses.length; i += TOKEN_BATCH_SIZE) {
            const batch = tokenAddresses.slice(i, i + TOKEN_BATCH_SIZE);
            const batchResponses = await Promise.all(
                batch.map((tokenAddress) => this.fetchOpportunitiesCached(tokenOpportunityUrl(chainId, tokenAddress))),
            );
            batch.forEach((tokenAddress, index) => {
                byAddress.set(
                    tokenAddress,
                    this.deduplicateOpportunities(this.filterPublicOpportunities(batchResponses[index])),
                );
            });
            if (i + TOKEN_BATCH_SIZE < tokenAddresses.length && this.batchDelayMs > 0) {
                await this.sleep(this.batchDelayMs);
            }
        }
        return byAddress;
    }

    // for boosted pools, merkl doesnt forward the APR to the pools so we need to query merkl for any apr of any pool tokens (we limit to tokens that have underlying)
    private async findTokenOpportunities(pools: PoolAPRData[]) {
        const chain = pools[0].chain;
        const chainId = config[chain].chain.id;
        const aaveMarkets = config[chain].aprHandlers.ybAprHandler?.aave?.markets ?? [];
        const aaveMarketsForChain = aaveMarkets.filter((market) => chainIdToChain[market.CHAIN_ID] === chain);
        const aaveAssets = aaveMarketsForChain.flatMap((market) => (market.ASSETS ? Object.values(market.ASSETS) : []));
        const aaveTokenMappings =
            aaveAssets.length > 0 ? await this.getTokenMappings(aaveAssets) : new Map<string, string>();

        const directTokenAddresses: string[] = [];
        pools.forEach((pool) => {
            directTokenAddresses.push(
                ...pool.tokens
                    .filter((token) => token.token.underlyingTokenAddress)
                    .map((token) => token.address.toLowerCase()),
            );
        });
        const uniqueDirectTokens = Array.from(new Set(directTokenAddresses));

        // First query each wrapped token directly (e.g. waMonUSDC has its own forwarded child opportunity with actual APR).
        const directOppsByToken =
            uniqueDirectTokens.length > 0
                ? await this.fetchTokenOpportunitiesBatched(chainId, uniqueDirectTokens)
                : new Map<string, MerklOpportunity[]>();

        // Only fall back to the underlying Aave aToken when the wrapper itself has no live Merkl opportunities.
        const fallbackATokens = Array.from(
            new Set(
                uniqueDirectTokens
                    .filter((tokenAddress) => (directOppsByToken.get(tokenAddress)?.length ?? 0) === 0)
                    .map((tokenAddress) => aaveTokenMappings.get(tokenAddress))
                    .filter((aToken): aToken is string => Boolean(aToken)),
            ),
        );

        let fallbackOppsByAToken = new Map<string, MerklOpportunity[]>();
        if (fallbackATokens.length > 0) {
            if (uniqueDirectTokens.length > 0 && this.batchDelayMs > 0) {
                await this.sleep(this.batchDelayMs);
            }
            fallbackOppsByAToken = await this.fetchTokenOpportunitiesBatched(chainId, fallbackATokens);
        }

        return this.mapTokenOpportunitiesToAprs(
            pools,
            chainId,
            directOppsByToken,
            fallbackOppsByAToken,
            aaveTokenMappings,
        );
    }

    private mapTokenOpportunitiesToAprs(
        pools: PoolAPRData[],
        chainId: number,
        directOppsByToken: Map<string, MerklOpportunity[]>,
        fallbackOppsByAToken: Map<string, MerklOpportunity[]>,
        aaveTokenMappings: Map<string, string>,
    ): Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[] {
        const aprs: Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[] = [];

        for (const pool of pools) {
            if (!pool || !pool.dynamicData?.totalLiquidity) {
                continue;
            }

            const tvl = pool.tokens.map((t) => t.balanceUSD).reduce((a, b) => a + b, 0);
            if (tvl === 0) {
                continue;
            }

            for (const token of pool.tokens) {
                if (!token.token.underlyingTokenAddress) {
                    continue;
                }

                const tokenTvl = token.balanceUSD || 0;
                const tokenShareOfPoolTvl = tokenTvl === 0 ? 0 : tokenTvl / tvl;
                if (tokenShareOfPoolTvl === 0) {
                    continue;
                }

                const tokenAddress = token.address.toLowerCase();
                const directOpportunities = (directOppsByToken.get(tokenAddress) ?? []).filter(
                    (opportunity) =>
                        opportunity.chainId === chainId && addressesMatch(tokenAddress, opportunity.explorerAddress),
                );

                let matchedOpportunities = directOpportunities;
                if (matchedOpportunities.length === 0) {
                    const mappedAToken = aaveTokenMappings.get(tokenAddress);
                    if (mappedAToken) {
                        matchedOpportunities = (fallbackOppsByAToken.get(mappedAToken) ?? []).filter(
                            (opportunity) =>
                                opportunity.chainId === chainId &&
                                addressesMatch(mappedAToken, opportunity.explorerAddress),
                        );
                    }
                }

                for (const opportunity of matchedOpportunities) {
                    const rewardToken = this.extractRewardToken(opportunity);
                    const effectiveApr = this.getEffectiveTokenOpportunityApr(opportunity);

                    aprs.push({
                        id: opportunity.id ? `${pool.id}-merkl-${opportunity.id}` : `${pool.id}-merkl-${tokenAddress}`,
                        type: PrismaPoolAprType.MERKL,
                        title: token.token.symbol || token.address,
                        chain: chainIdToChain[opportunity.chainId],
                        poolId: pool.id,
                        apr: (effectiveApr / 100) * tokenShareOfPoolTvl,
                        rewardTokenAddress: rewardToken.address,
                        rewardTokenSymbol: rewardToken.symbol,
                    });
                }
            }
        }

        return aprs;
    }

    private mapOpportunitiesToAprs(
        opportunities: MerklOpportunity[],
        affectedPools: PoolAPRData[],
    ): Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[] {
        const aprs: Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[] = [];

        for (const opportunity of opportunities) {
            const pool = affectedPools.find(
                (pool) =>
                    addressesMatch(pool.address, opportunity.identifier) &&
                    pool.chain === chainIdToChain[opportunity.chainId],
            );

            if (!pool || !pool.dynamicData?.totalLiquidity) {
                continue;
            }

            const rewardToken = this.extractRewardToken(opportunity);

            aprs.push({
                id: opportunity.id ? `${pool.id}-merkl-${opportunity.id}` : `${pool.id}-merkl`,
                type: PrismaPoolAprType.MERKL,
                title: pool.symbol || 'Pool',
                chain: chainIdToChain[opportunity.chainId],
                poolId: pool.id,
                apr: opportunity.apr / 100,
                rewardTokenAddress: rewardToken.address,
                rewardTokenSymbol: rewardToken.symbol,
            });
        }

        return aprs;
    }

    private async getTokenMappings(assets?: any[]) {
        const wrapperToATokenMap = new Map<string, string>();
        if (!assets || assets.length === 0) return wrapperToATokenMap;
        // create map wrapper -> aToken
        for (const asset of assets) {
            const wrappers = [asset.STATIC_A_TOKEN?.toLowerCase(), asset.STATA_TOKEN?.toLowerCase()].filter((w) => !!w);
            for (const wrapper of wrappers) {
                wrapperToATokenMap.set(wrapper, asset.A_TOKEN.toLowerCase());
            }
        }
        return wrapperToATokenMap;
    }

    private fetchOpportunitiesCached(url: string): Promise<MerklOpportunity[]> {
        const currentTime = this.now();
        const cached = responseCache.get(url);
        if (cached) {
            if (cached.expiresAt > currentTime) {
                return Promise.resolve(cached.data);
            }
            responseCache.delete(url);
        }

        const existingInFlight = inFlightRequests.get(url);
        if (existingInFlight) {
            return existingInFlight;
        }

        const requestPromise = this.fetchJsonWithRetry(url)
            .then(({ data, ttlMs }) => {
                const storedAt = this.now();
                setCachedEntry(url, { data, expiresAt: storedAt + ttlMs }, storedAt);
                return data;
            })
            .finally(() => {
                inFlightRequests.delete(url);
            });

        inFlightRequests.set(url, requestPromise);
        return requestPromise;
    }

    private parseRetryAfterMs(retryAfter: string | null, attempt: number): number {
        const fallback = Math.min(MAX_RETRY_AFTER_MS, this.retryBaseDelayMs * 2 ** attempt);
        if (!retryAfter) {
            return fallback;
        }

        const trimmed = retryAfter.trim();
        if (/^\d+(\.\d+)?$/.test(trimmed)) {
            return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.ceil(Number(trimmed) * 1_000)));
        }

        const targetMs = Date.parse(trimmed);
        if (!Number.isNaN(targetMs)) {
            return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, targetMs - this.now()));
        }

        return fallback;
    }

    private async fetchJsonWithRetry(url: string): Promise<{ data: MerklOpportunity[]; ttlMs: number }> {
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                const response = await this.merklFetch(url);
                if (response.ok) {
                    const ttlMs = parseCacheTtlMs(response.headers.get('cache-control'));
                    const data = (await response.json()) as MerklOpportunity[];
                    return { data, ttlMs };
                }

                const { status, statusText } = response;
                const retryAfter = response.headers.get('retry-after');
                await response.body?.cancel().catch(() => undefined);

                const retryable = status === 429 || status >= 500;
                if (retryable && attempt < this.maxRetries) {
                    const delay = this.parseRetryAfterMs(retryAfter, attempt);
                    if (delay > 0) {
                        await this.sleep(delay);
                    }
                    continue;
                }

                const message = `Merkl API error: ${status} ${statusText}`;
                throw retryable ? new Error(message) : new NonRetryableMerklError(message);
            } catch (error) {
                if (error instanceof NonRetryableMerklError || attempt >= this.maxRetries) {
                    throw error;
                }
                const delay = Math.min(MAX_RETRY_AFTER_MS, this.retryBaseDelayMs * 2 ** attempt);
                if (delay > 0) {
                    await this.sleep(delay);
                }
            }
        }

        throw new Error('Merkl API error: retries exhausted');
    }

    private async merklFetch(url: string): Promise<Response> {
        const apiKey = env.MERKL_API_KEY;
        const headers: Record<string, string> = apiKey ? { 'X-API-Key': apiKey } : {};
        return fetch(url, {
            headers,
            signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
    }
}
