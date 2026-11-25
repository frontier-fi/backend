import { $Enums, PrismaPoolAprItem, PrismaPoolAprType } from '@prisma/client';
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
    `https://api.merkl.xyz/v4/opportunities/?status=LIVE&chainId=${chainId}&explorerAddress=${tokenAddress}`;

interface MerklOpportunity {
    chainId: number;
    identifier: string;
    dailyRewards: number;
    explorerAddress: string;
    apr: number;
    campaigns?: {
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

    private async fetchMerklOpportunities(chainId: number) {
        const data: MerklOpportunity[] = [];
        for (let page = 0; page < MAX_PAGES; page++) {
            const pageData = await this.fetchOpportunitiesCached(opportunityUrl(chainId, page));
            data.push(...pageData);
            if (pageData.length < PAGE_SIZE) {
                break;
            }
        }

        // remove opportunities with whitelist
        return data.filter((opportunity) =>
            (opportunity.campaigns ?? []).every((campaign) => (campaign.params?.whitelist?.length ?? 0) === 0),
        );
    }

    public async calculateAprForPools(
        pools: PoolAPRData[],
    ): Promise<Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[]> {
        const aprsFromOpportunities = await this.findPoolOpportunities(pools);

        // for boosted pools
        const aprsFromTokenOpportunities = await this.findTokenOpportunities(pools);

        const data = this.combineAndDeduplicateAprs([...aprsFromOpportunities, ...aprsFromTokenOpportunities]);

        return data.map((apr) => ({
            id: apr.id,
            type: apr.type,
            title: apr.title,
            chain: apr.chain,
            poolId: apr.poolId,
            apr: apr.apr,
            rewardTokenAddress: null,
            rewardTokenSymbol: null,
        }));
    }

    private combineAndDeduplicateAprs(
        aprs: {
            id: string;
            type: PrismaPoolAprType;
            title: string;
            chain: $Enums.Chain;
            poolId: string;
            apr: number;
        }[],
    ): Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[] {
        // Combine APRs by summing APR values for the same pool
        const aprMap: Map<string, Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>> = new Map();

        for (const apr of aprs) {
            if (aprMap.has(apr.poolId)) {
                const existingApr = aprMap.get(apr.poolId)!;
                existingApr.apr += apr.apr; // Sum the APR values
                aprMap.set(apr.poolId, existingApr);
            } else {
                aprMap.set(apr.poolId, { ...apr, rewardTokenAddress: null, rewardTokenSymbol: null });
            }
        }
        return Array.from(aprMap.values());
    }

    private async findPoolOpportunities(pools: PoolAPRData[]) {
        const chain = pools[0].chain;
        const opportunities = await this.fetchMerklOpportunities(config[chain].chain.id);

        const allAffectedPoolAddresses = opportunities.map((campaign) => campaign.identifier.toLowerCase());

        const affectedPools = pools.filter((pool) => allAffectedPoolAddresses.includes(pool.address.toLowerCase()));

        const aprsFromOpportunities = this.mapOpportunitiesToAprs(opportunities, affectedPools);
        return aprsFromOpportunities;
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

        const tokensWithUnderlying: string[] = [];
        pools.forEach((pool) => {
            tokensWithUnderlying.push(
                ...pool.tokens
                    .filter((token) => token.token.underlyingTokenAddress)
                    .map((token) =>
                        aaveTokenMappings.get(token.address.toLowerCase()) // we replace the waTokens with aTokens as merkl tracks aTokens
                            ? aaveTokenMappings.get(token.address.toLowerCase())!
                            : token.address.toLowerCase(),
                    )
                    .flat(),
            );
        });
        const uniqueTokensWithUnderlying = Array.from(new Set(tokensWithUnderlying));

        let tokenOpportunities: MerklOpportunity[] = [];

        if (uniqueTokensWithUnderlying.length > 0) {
            const tokenOpportunityResponses: MerklOpportunity[][] = [];
            for (let i = 0; i < uniqueTokensWithUnderlying.length; i += TOKEN_BATCH_SIZE) {
                const batch = uniqueTokensWithUnderlying.slice(i, i + TOKEN_BATCH_SIZE);
                const batchResponses = await Promise.all(
                    batch.map((tokenAddress) =>
                        this.fetchOpportunitiesCached(tokenOpportunityUrl(chainId, tokenAddress)),
                    ),
                );
                tokenOpportunityResponses.push(...batchResponses);
                if (i + TOKEN_BATCH_SIZE < uniqueTokensWithUnderlying.length && this.batchDelayMs > 0) {
                    await this.sleep(this.batchDelayMs);
                }
            }

            tokenOpportunities = tokenOpportunityResponses.flat();
        }

        return this.mapTokenOpportunitiesToAprs(tokenOpportunities, pools, aaveTokenMappings);
    }

    private mapTokenOpportunitiesToAprs(
        opportunities: MerklOpportunity[],
        affectedPools: PoolAPRData[],
        aaveTokenMappings: Map<string, string>,
    ): {
        id: string;
        type: PrismaPoolAprType;
        title: string;
        chain: $Enums.Chain;
        poolId: string;
        apr: number;
    }[] {
        const aprs: {
            id: string;
            type: PrismaPoolAprType;
            title: string;
            chain: $Enums.Chain;
            poolId: string;
            apr: number;
        }[] = [];

        for (const opportunity of opportunities) {
            const pools = affectedPools.filter(
                (pool) =>
                    pool.chain === chainIdToChain[opportunity.chainId] &&
                    pool.tokens.some((token) =>
                        this.tokenMatchesExplorer(token.address, opportunity.explorerAddress, aaveTokenMappings),
                    ),
            );

            for (const pool of pools) {
                if (!pool || !pool.dynamicData?.totalLiquidity) {
                    continue;
                }

                const tvl = pool.tokens.map((t) => t.balanceUSD).reduce((a, b) => a + b, 0);
                const tokenTvl =
                    pool.tokens.find((token) =>
                        this.tokenMatchesExplorer(token.address, opportunity.explorerAddress, aaveTokenMappings),
                    )?.balanceUSD || 0;

                const tokenShareOfPoolTvl = tokenTvl === 0 || tvl === 0 ? 0 : tokenTvl / tvl;

                aprs.push({
                    id: `${pool.id}-merkl`,
                    type: PrismaPoolAprType.MERKL,
                    title: `Merkl Rewards`,
                    chain: chainIdToChain[opportunity.chainId],
                    poolId: pool.id,
                    apr: (opportunity.apr / 100) * tokenShareOfPoolTvl,
                });
            }
        }

        return aprs.filter((item) => item !== null);
    }

    private mapOpportunitiesToAprs(
        opportunities: MerklOpportunity[],
        affectedPools: PoolAPRData[],
    ): {
        id: string;
        type: PrismaPoolAprType;
        title: string;
        chain: $Enums.Chain;
        poolId: string;
        apr: number;
    }[] {
        const aprs: {
            id: string;
            type: PrismaPoolAprType;
            title: string;
            chain: $Enums.Chain;
            poolId: string;
            apr: number;
        }[] = [];

        for (const opportunity of opportunities) {
            const pool = affectedPools.find(
                (pool) =>
                    addressesMatch(pool.address, opportunity.identifier) &&
                    pool.chain === chainIdToChain[opportunity.chainId],
            );

            if (!pool || !pool.dynamicData?.totalLiquidity) {
                continue;
            }

            aprs.push({
                id: `${pool.id}-merkl`,
                type: PrismaPoolAprType.MERKL,
                title: `Merkl Rewards`,
                chain: chainIdToChain[opportunity.chainId],
                poolId: pool.id,
                apr: opportunity.apr / 100,
            });
        }

        return aprs.filter((item) => item !== null);
    }

    private tokenMatchesExplorer(
        tokenAddress: string,
        explorerAddress: string,
        mappings: Map<string, string>,
    ): boolean {
        const mapped = mappings.get(tokenAddress.toLowerCase());
        return addressesMatch(mapped ?? tokenAddress, explorerAddress);
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
