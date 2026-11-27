import { Chain, PrismaPoolAprItem, PrismaPoolAprType } from '@prisma/client';
import {
    AbiDecodingDataSizeTooSmallError,
    AbiDecodingZeroDataError,
    BaseError,
    ContractFunctionExecutionError,
    ContractFunctionRevertedError,
    ContractFunctionZeroDataError,
    Hex,
    InternalRpcError,
    parseAbi,
    RawContractError,
} from 'viem';
import { AprCalculationResult, AprHandler, PoolAPRData } from '../../types';
import type { AaveV4AddressBookEntry } from '../../../token-yields/types';
import { aaveV4TokenizationSpokeAbi } from '../../../token-yields/handlers/sources/aave-v4-onchain-handler';
import { getViemClient } from '../../../sources/viem-client';
import { logger } from '../../../common/logger';
import config from '../../../../config';
import { chainIdToChain } from '../../../../config/chain-id-to-chain';
import { env } from '../../../../apps/env';
import { addressesMatch } from '../../../web3/addresses';

const aaveV4HubSpokeCheckAbi = parseAbi(['function isSpokeListed(uint256 assetId, address spoke) view returns (bool)']);

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const TOKEN_BATCH_SIZE = 4;
const DEFAULT_BATCH_DELAY_MS = 300;
const DEFAULT_CACHE_TTL_MS = 240_000;
const MIN_CACHE_TTL_MS = 60_000;
const MAX_CACHE_TTL_MS = 300_000;
const DEFAULT_NEGATIVE_PROBE_CACHE_TTL_MS = 300_000;
const DEFAULT_POSITIVE_PROBE_CACHE_TTL_MS = 3_600_000;
const MAX_CACHE_ENTRIES = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 10_000;

// Merkl uses mainProtocolId='frontier' for Frontier pool campaigns; token campaigns below do not depend on the protocol.
const opportunityUrl = (chainId: number, page: number) =>
    `https://api.merkl.xyz/v4/opportunities/?test=false&status=LIVE&campaigns=true&mainProtocolId=frontier&chainId=${chainId}&page=${page}&items=${PAGE_SIZE}`;

// Aave V4 Hub lending campaigns have no explorerAddress; they are listed under mainProtocolId='aave'.
const aaveOpportunityUrl = (chainId: number, page: number) =>
    `https://api.merkl.xyz/v4/opportunities/?test=false&status=LIVE&campaigns=true&mainProtocolId=aave&chainId=${chainId}&page=${page}&items=${PAGE_SIZE}`;

const tokenOpportunityUrl = (chainId: number, tokenAddress: string) =>
    `https://api.merkl.xyz/v4/opportunities/?status=LIVE&campaigns=true&chainId=${chainId}&explorerAddress=${tokenAddress}`;

const linkedCampaignsUrl = (campaignId: string) =>
    `https://api.merkl.xyz/v4/campaigns/${campaignId}/linked?campaigns=true`;

// Distinct prefix before `-merkl-<oppId>` preserves frontend `/-merkl-(\d+)$/` matching
// while letting partial Aave V4 failures preserve only Aave V4 rows without keeping expired Frontier rows.
const aaveV4LinkedItemPrefix = (poolId: string) => `${poolId}-aave-v4-merkl-`;

interface MerklTokenInfo {
    address?: string;
    symbol?: string;
}

interface MerklAaveV4HubAsset {
    assetId?: string | number;
    underlyingToken?: string;
}

interface MerklAaveV4HubParam {
    hubAddress?: string;
    lendingAssetIds?: (string | number)[];
    assets?: MerklAaveV4HubAsset[];
}

interface MerklCampaignParams {
    whitelist?: string[];
    blacklist?: string[];
    hooks?: unknown[];
    forwardingEnabled?: boolean;
    hubAddress?: string;
    underlyingToken?: string;
    hubs?: MerklAaveV4HubParam[];
}

interface MerklCampaign {
    id?: string;
    campaignId?: string;
    parentCampaignId?: string | null;
    childCampaignIds?: string[];
    rewardToken?: MerklTokenInfo;
    params?: MerklCampaignParams;
}

interface MerklAprBreakdown {
    identifier?: string;
    type?: string;
    value?: number;
}

interface MerklOpportunity {
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
    tokens?: MerklTokenInfo[];
    aprRecord?: {
        cumulated?: number;
        breakdowns?: MerklAprBreakdown[];
    };
    rewardsRecord?: {
        breakdowns?: {
            token?: MerklTokenInfo;
        }[];
    };
    campaigns?: MerklCampaign[];
}

interface MerklLinkedCampaignNode {
    campaignId: string;
    onChainCampaignId?: string;
    parentCampaignId?: string | null;
    opportunity?: MerklOpportunity;
}

interface MerklLinkedCampaignsResponse {
    self?: string;
    nodes?: MerklLinkedCampaignNode[];
}

interface AaveV4SpokeMapping {
    hubAddress: string;
    underlyingAddress: string;
}

export interface MerklAprHandlerOptions {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    batchDelayMs?: number;
    retryBaseDelayMs?: number;
    maxRetries?: number;
    requestTimeoutMs?: number;
    negativeProbeCacheTtlMs?: number;
    positiveProbeCacheTtlMs?: number;
}

interface CacheEntry {
    data: unknown;
    expiresAt: number;
}

interface SpokeProbeCacheEntry {
    mapping: AaveV4SpokeMapping | null;
    expiresAt: number;
}

const responseCache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, Promise<unknown>>();
const aaveV4SpokeProbeCache = new Map<string, SpokeProbeCacheEntry>();

/** Clears the shared Merkl response cache, spoke probe cache, and in-flight dedupe map (intended for tests). */
export function clearMerklResponseCache(): void {
    responseCache.clear();
    inFlightRequests.clear();
    aaveV4SpokeProbeCache.clear();
}

function setSpokeProbeCacheEntry(
    key: string,
    mapping: AaveV4SpokeMapping | null,
    ttlMs: number,
    currentTime: number,
): void {
    aaveV4SpokeProbeCache.delete(key);
    if (aaveV4SpokeProbeCache.size >= MAX_CACHE_ENTRIES) {
        for (const [cachedKey, cached] of aaveV4SpokeProbeCache) {
            if (cached.expiresAt <= currentTime) {
                aaveV4SpokeProbeCache.delete(cachedKey);
            }
        }
    }
    while (aaveV4SpokeProbeCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = aaveV4SpokeProbeCache.keys().next().value;
        if (oldestKey === undefined) break;
        aaveV4SpokeProbeCache.delete(oldestKey);
    }
    aaveV4SpokeProbeCache.set(key, { mapping, expiresAt: currentTime + ttlMs });
}

/**
 * Returns true only when a viem multicall failure represents a definitive contract-level rejection
 * (e.g. missing function selector / revert / empty return data on the target contract) rather than
 * an RPC transport error, timeout, or Multicall3 aggregate3 failure.
 */
function isDefinitiveProbeRejection(error: unknown, expectedFunctionName: string): boolean {
    if (!(error instanceof BaseError)) {
        return false;
    }
    const executionError = error.walk((err) => err instanceof ContractFunctionExecutionError);
    if (
        executionError instanceof ContractFunctionExecutionError &&
        executionError.functionName &&
        executionError.functionName !== expectedFunctionName
    ) {
        return false;
    }
    return Boolean(
        error.walk(
            (err) =>
                err instanceof RawContractError ||
                err instanceof ContractFunctionZeroDataError ||
                err instanceof AbiDecodingZeroDataError ||
                err instanceof AbiDecodingDataSizeTooSmallError ||
                (err instanceof ContractFunctionRevertedError &&
                    !err.walk((inner) => inner instanceof InternalRpcError)),
        ),
    );
}

function formatProbeError(error: unknown): string {
    if (error instanceof BaseError) {
        return error.details || error.shortMessage;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
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
    private readonly negativeProbeCacheTtlMs: number;
    private readonly positiveProbeCacheTtlMs: number;

    constructor(options: MerklAprHandlerOptions = {}) {
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.batchDelayMs = options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS;
        this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
        this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.negativeProbeCacheTtlMs = options.negativeProbeCacheTtlMs ?? DEFAULT_NEGATIVE_PROBE_CACHE_TTL_MS;
        this.positiveProbeCacheTtlMs = options.positiveProbeCacheTtlMs ?? DEFAULT_POSITIVE_PROBE_CACHE_TTL_MS;
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

    private extractRewardToken(
        opportunity: MerklOpportunity,
        options?: {
            preferredCampaign?: MerklCampaign;
            fallbackCampaign?: MerklCampaign;
            fallbackOpportunity?: MerklOpportunity;
        },
    ): {
        address: string | null;
        symbol: string | null;
    } {
        const hasTokenInfo = (token?: MerklTokenInfo) => Boolean(token?.symbol || token?.address);
        const token =
            opportunity.rewardsRecord?.breakdowns?.find((b) => hasTokenInfo(b.token))?.token ??
            (hasTokenInfo(options?.preferredCampaign?.rewardToken)
                ? options?.preferredCampaign?.rewardToken
                : undefined) ??
            opportunity.campaigns?.find((c) => hasTokenInfo(c.rewardToken))?.rewardToken ??
            (hasTokenInfo(options?.fallbackCampaign?.rewardToken)
                ? options?.fallbackCampaign?.rewardToken
                : undefined) ??
            options?.fallbackOpportunity?.rewardsRecord?.breakdowns?.find((b) => hasTokenInfo(b.token))?.token ??
            options?.fallbackOpportunity?.campaigns?.find((c) => hasTokenInfo(c.rewardToken))?.rewardToken;

        return {
            address: token?.address?.toLowerCase() ?? null,
            symbol: token?.symbol ?? null,
        };
    }

    private getEffectiveTokenOpportunityApr(opportunity: MerklOpportunity): number {
        const isAaveV4Hub = opportunity.type === 'AAVE_V4_HUB_NET_LENDING' || opportunity.type === 'AAVE_V4_HUB_SUPPLY';

        // AAVE_V4_NET_APR campaigns include nativeApr inside opportunity.apr (= totalApr), while
        // additive campaigns set totalApr = nativeApr + apr. Subtracting nativeApr from totalApr
        // isolates the Merkl-only top-up in both conventions so IB_YIELD is not double-counted.
        const baseApr =
            isAaveV4Hub && opportunity.totalApr !== undefined && opportunity.nativeApr !== undefined
                ? Math.max(0, opportunity.totalApr - opportunity.nativeApr)
                : opportunity.apr;

        // AAVE_NET_LENDING and AAVE_V4_HUB_NET_LENDING opportunities can report their MAX_APR target cap rather than
        // realized gross supply APR. Cap fallback APRs by realized dailyRewards * 365 / tvl so wrapped ERC4626
        // positions aren't overstated.
        if (
            (opportunity.type === 'AAVE_NET_LENDING' || opportunity.type === 'AAVE_V4_HUB_NET_LENDING') &&
            typeof opportunity.tvl === 'number' &&
            Number.isFinite(opportunity.tvl) &&
            opportunity.tvl > 0 &&
            typeof opportunity.dailyRewards === 'number' &&
            Number.isFinite(opportunity.dailyRewards) &&
            opportunity.dailyRewards >= 0
        ) {
            const realizedGrossApr = ((opportunity.dailyRewards * 365) / opportunity.tvl) * 100;
            return Math.min(baseApr, realizedGrossApr);
        }
        return baseApr;
    }

    private async fetchProtocolOpportunities(
        chainId: number,
        buildUrl: (chainId: number, page: number) => string,
    ): Promise<MerklOpportunity[]> {
        const data: MerklOpportunity[] = [];
        for (let page = 0; page < MAX_PAGES; page++) {
            const pageData = await this.fetchOpportunitiesCached(buildUrl(chainId, page));
            data.push(...pageData);
            if (pageData.length < PAGE_SIZE) {
                break;
            }
        }
        return data;
    }

    private async fetchMerklOpportunities(chainId: number) {
        const data = await this.fetchProtocolOpportunities(chainId, opportunityUrl);

        // remove opportunities with whitelist and dedupe across pages
        return this.deduplicateOpportunities(this.filterPublicOpportunities(data));
    }

    public async calculateAprForPools(
        pools: PoolAPRData[],
    ): Promise<Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[]> {
        const { items } = await this.calculateAprForPoolsWithFailures(pools);
        return items;
    }

    public async calculateAprForPoolsWithFailures(pools: PoolAPRData[]): Promise<AprCalculationResult> {
        const { items: aprsFromOpportunities, frontierOppIdsByPool } = await this.findPoolOpportunities(pools);

        // for boosted pools
        const { items: aprsFromTokenOpportunities, failedAaveV4PoolIds } = await this.findTokenOpportunities(
            pools,
            frontierOppIdsByPool,
        );

        const preserveItems =
            failedAaveV4PoolIds.size > 0
                ? Array.from(failedAaveV4PoolIds, (poolId) => {
                      const idPrefix = aaveV4LinkedItemPrefix(poolId);
                      const frontierOppIds = frontierOppIdsByPool.get(poolId);
                      const excludeIds =
                          frontierOppIds && frontierOppIds.size > 0
                              ? new Set(Array.from(frontierOppIds, (oppId) => `${idPrefix}${oppId}`))
                              : undefined;
                      return excludeIds ? { poolId, idPrefix, excludeIds } : { poolId, idPrefix };
                  })
                : undefined;

        return {
            items: this.combineAndDeduplicateAprs([...aprsFromOpportunities, ...aprsFromTokenOpportunities]),
            preserveItems,
        };
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

    private async findPoolOpportunities(pools: PoolAPRData[]): Promise<{
        items: Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[];
        frontierOppIdsByPool: Map<string, Set<string>>;
    }> {
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
    private async findTokenOpportunities(
        pools: PoolAPRData[],
        frontierOppIdsByPool: ReadonlyMap<string, ReadonlySet<string>>,
    ): Promise<{
        items: Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[];
        failedAaveV4PoolIds: Set<string>;
    }> {
        const chain = pools[0].chain;
        const chainId = config[chain].chain.id;
        const failedAaveV4PoolIds = new Set<string>();
        const aaveMarkets = config[chain].aprHandlers.ybAprHandler?.aave?.markets ?? [];
        const aaveMarketsForChain = aaveMarkets.filter((market) => chainIdToChain[market.CHAIN_ID] === chain);
        const aaveAssets = aaveMarketsForChain.flatMap((market) => (market.ASSETS ? Object.values(market.ASSETS) : []));
        const aaveTokenMappings =
            aaveAssets.length > 0 ? await this.getTokenMappings(aaveAssets) : new Map<string, string>();

        const aaveV4Markets = (config[chain].aprHandlers.ybAprHandler?.aaveV4?.markets ?? []).filter(
            (market) => chainIdToChain[market.CHAIN_ID] === chain,
        );
        const aaveV4TokenMappings = this.getAaveV4TokenMappings(aaveV4Markets);
        const aaveV4HubAddresses = new Set(
            aaveV4Markets.flatMap((market) => Object.values(market.HUBS).map((hub) => hub.toLowerCase())),
        );

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

        // Only fall back to the underlying Aave V3 aToken or Aave V4 Hub when the wrapper itself has no live Merkl opportunities.
        const tokensWithoutDirectOpps = uniqueDirectTokens.filter(
            (tokenAddress) => (directOppsByToken.get(tokenAddress)?.length ?? 0) === 0,
        );

        const fallbackATokens = Array.from(
            new Set(
                tokensWithoutDirectOpps
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

        const unmappedAaveV4Candidates = tokensWithoutDirectOpps.filter(
            (tokenAddress) => !aaveTokenMappings.has(tokenAddress) && !aaveV4TokenMappings.has(tokenAddress),
        );
        if (aaveV4HubAddresses.size > 0 && unmappedAaveV4Candidates.length > 0) {
            const failedProbeTokens = await this.resolveDynamicAaveV4Spokes(
                chain,
                chainId,
                unmappedAaveV4Candidates,
                aaveV4HubAddresses,
                aaveV4TokenMappings,
            );
            if (failedProbeTokens.size > 0) {
                for (const pool of pools) {
                    if (
                        pool.tokens.some(
                            (token) =>
                                token.token.underlyingTokenAddress &&
                                failedProbeTokens.has(token.address.toLowerCase()),
                        )
                    ) {
                        failedAaveV4PoolIds.add(pool.id);
                    }
                }
            }
        }

        const directAndV3Items = this.mapTokenOpportunitiesToAprs(
            pools,
            chainId,
            directOppsByToken,
            fallbackOppsByAToken,
            aaveTokenMappings,
        );

        const aaveV4FallbackTokens = new Set(
            tokensWithoutDirectOpps.filter((tokenAddress) => aaveV4TokenMappings.has(tokenAddress)),
        );
        const aaveV4LinkedItems =
            aaveV4FallbackTokens.size > 0
                ? await this.findAaveV4LinkedPoolOpportunities(
                      chain,
                      chainId,
                      pools,
                      aaveV4FallbackTokens,
                      aaveV4TokenMappings,
                      config[chain].contracts?.Vault,
                      frontierOppIdsByPool,
                      failedAaveV4PoolIds,
                  )
                : [];

        return {
            items: [...directAndV3Items, ...aaveV4LinkedItems],
            failedAaveV4PoolIds,
        };
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
                        opportunity.chainId === chainId &&
                        Boolean(opportunity.explorerAddress) &&
                        addressesMatch(tokenAddress, opportunity.explorerAddress!),
                );

                let matchedOpportunities = directOpportunities;
                if (matchedOpportunities.length === 0) {
                    const mappedAToken = aaveTokenMappings.get(tokenAddress);
                    if (mappedAToken) {
                        matchedOpportunities = (fallbackOppsByAToken.get(mappedAToken) ?? []).filter(
                            (opportunity) =>
                                opportunity.chainId === chainId &&
                                Boolean(opportunity.explorerAddress) &&
                                addressesMatch(mappedAToken, opportunity.explorerAddress!),
                        );
                    }
                }

                for (const opportunity of matchedOpportunities) {
                    const effectiveApr = this.getEffectiveTokenOpportunityApr(opportunity);
                    if (effectiveApr <= 0) {
                        continue;
                    }
                    const rewardToken = this.extractRewardToken(opportunity);

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

    /**
     * Resolves Aave V4 Hub campaigns for pools holding Aave V4 tokenization spokes without direct token opportunities:
     * 1. Prefers LIVE linked descendant opportunities targeting `pool.address` (via `/linked?campaigns=true`),
     *    enforcing forwarding-chain restrictions and campaign-level APR breakdowns.
     * 2. Falls back to eligible Hub campaigns scaled by `tokenShareOfPoolTvl` (matching Aave V3 aToken fallback)
     *    when Merkl has not yet created a LIVE linked opportunity targeting `pool.address`.
     * Failures fetching Aave hub or linked campaigns are isolated to the affected pools rather than
     * stalling unrelated Frontier or direct-token Merkl APR updates.
     */
    private async findAaveV4LinkedPoolOpportunities(
        chain: Chain,
        chainId: number,
        pools: PoolAPRData[],
        aaveV4FallbackTokens: ReadonlySet<string>,
        aaveV4TokenMappings: ReadonlyMap<string, AaveV4SpokeMapping>,
        vaultAddress: string | undefined,
        frontierOppIdsByPool: ReadonlyMap<string, ReadonlySet<string>>,
        failedPoolIds: Set<string>,
    ): Promise<Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[]> {
        const affectedPools = pools.filter((pool) => {
            if (!pool || !pool.dynamicData?.totalLiquidity) {
                return false;
            }
            const tvl = pool.tokens.map((t) => t.balanceUSD).reduce((a, b) => a + b, 0);
            if (tvl === 0) {
                return false;
            }
            return pool.tokens.some(
                (token) =>
                    Boolean(token.token.underlyingTokenAddress) &&
                    (token.balanceUSD || 0) > 0 &&
                    aaveV4FallbackTokens.has(token.address.toLowerCase()),
            );
        });

        if (affectedPools.length === 0) {
            return [];
        }

        let aaveOpportunities: MerklOpportunity[];
        try {
            aaveOpportunities = this.deduplicateOpportunities(
                await this.fetchProtocolOpportunities(chainId, aaveOpportunityUrl),
            );
        } catch (error) {
            logger.error('Failed to fetch Aave V4 Merkl opportunities', {
                chain,
                poolIds: affectedPools.map((pool) => pool.id),
                err: error instanceof Error ? error.message : String(error),
            });
            for (const pool of affectedPools) {
                failedPoolIds.add(pool.id);
            }
            return [];
        }

        const candidateCampaigns = new Map<
            string,
            {
                campaignId: string;
                parentOpportunity: MerklOpportunity;
                campaign: MerklCampaign;
                pools: Map<string, PoolAPRData>;
            }
        >();

        const hubFallbackCandidates: {
            pool: PoolAPRData;
            token: PoolAPRData['tokens'][number];
            tokenAddress: string;
            tokenShareOfPoolTvl: number;
            opportunity: MerklOpportunity;
        }[] = [];

        for (const pool of affectedPools) {
            const tvl = pool.tokens.map((t) => t.balanceUSD).reduce((a, b) => a + b, 0);
            if (tvl === 0) {
                continue;
            }

            for (const token of pool.tokens) {
                if (!token.token.underlyingTokenAddress || (token.balanceUSD || 0) <= 0) {
                    continue;
                }
                const tokenAddress = token.address.toLowerCase();
                if (!aaveV4FallbackTokens.has(tokenAddress)) {
                    continue;
                }
                const mapping = aaveV4TokenMappings.get(tokenAddress);
                if (!mapping) {
                    continue;
                }
                const tokenShareOfPoolTvl = (token.balanceUSD || 0) / tvl;

                for (const opportunity of aaveOpportunities) {
                    if (
                        opportunity.chainId !== chainId ||
                        opportunity.action !== 'LEND' ||
                        (opportunity.type !== 'AAVE_V4_HUB_NET_LENDING' && opportunity.type !== 'AAVE_V4_HUB_SUPPLY')
                    ) {
                        continue;
                    }

                    const campaigns = opportunity.campaigns ?? [];
                    if (campaigns.length === 0) {
                        continue;
                    }

                    let allCampaignsEligible = true;
                    for (const campaign of campaigns) {
                        const eligible = this.isAaveV4CampaignEligible(
                            opportunity.type,
                            campaign.params,
                            tokenAddress,
                            mapping,
                            pool.address,
                            vaultAddress,
                        );
                        if (!eligible) {
                            allCampaignsEligible = false;
                            continue;
                        }

                        // Query /linked only when the campaign has an id and is not already proven to have zero children.
                        if (
                            campaign.id &&
                            !(Array.isArray(campaign.childCampaignIds) && campaign.childCampaignIds.length === 0)
                        ) {
                            let entry = candidateCampaigns.get(campaign.id);
                            if (!entry) {
                                entry = {
                                    campaignId: campaign.id,
                                    parentOpportunity: opportunity,
                                    campaign,
                                    pools: new Map(),
                                };
                                candidateCampaigns.set(campaign.id, entry);
                            }
                            entry.pools.set(pool.id, pool);
                        }
                    }

                    if (allCampaignsEligible) {
                        hubFallbackCandidates.push({
                            pool,
                            token,
                            tokenAddress,
                            tokenShareOfPoolTvl,
                            opportunity,
                        });
                    }
                }
            }
        }

        const entries = Array.from(candidateCampaigns.values());
        const linkedByCampaignId = new Map<string, MerklLinkedCampaignsResponse>();
        const failedLinkedCampaignIds = new Set<string>();

        for (let i = 0; i < entries.length; i += TOKEN_BATCH_SIZE) {
            const batch = entries.slice(i, i + TOKEN_BATCH_SIZE);
            const settled = await Promise.allSettled(
                batch.map((entry) => this.fetchLinkedCampaignsCached(entry.campaignId)),
            );
            settled.forEach((result, index) => {
                const entry = batch[index];
                if (result.status === 'fulfilled') {
                    linkedByCampaignId.set(entry.campaignId, result.value);
                } else {
                    failedLinkedCampaignIds.add(entry.campaignId);
                    logger.error('Failed to fetch linked Merkl campaigns for Aave V4 Hub campaign', {
                        chain,
                        campaignId: entry.campaignId,
                        poolIds: Array.from(entry.pools.keys()),
                        err: result.reason instanceof Error ? result.reason.message : String(result.reason),
                    });
                    for (const poolId of entry.pools.keys()) {
                        failedPoolIds.add(poolId);
                    }
                }
            });
            if (i + TOKEN_BATCH_SIZE < entries.length && this.batchDelayMs > 0) {
                await this.sleep(this.batchDelayMs);
            }
        }

        const linkedAprByItemId = new Map<
            string,
            {
                item: Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>;
                maxAprFraction: number;
            }
        >();
        const countedCampaignKeys = new Set<string>();
        // Tracks (poolId:hubCampaignId) pairs that already have a LIVE linked pool opportunity targeting pool.address
        // (whether eligible, already emitted by Frontier, or explicitly restricted), so Hub fallback never double-counts
        // or bypasses linked-campaign restrictions.
        const poolLinkedCampaignKeys = new Set<string>();

        for (const entry of entries) {
            const linkedResponse = linkedByCampaignId.get(entry.campaignId);
            const nodes = linkedResponse?.nodes ?? [];
            if (nodes.length === 0) {
                continue;
            }
            const nodesById = new Map(nodes.map((node) => [node.campaignId, node]));

            for (const pool of entry.pools.values()) {
                for (const node of nodes) {
                    const descendantChain = this.getDescendantChain(node, entry.campaignId, nodesById);
                    if (!descendantChain) {
                        continue;
                    }
                    const linkedOpp = node.opportunity;
                    if (!linkedOpp || linkedOpp.chainId !== chainId || linkedOpp.status !== 'LIVE') {
                        continue;
                    }
                    if (!this.opportunityTargetsPool(linkedOpp, pool.address)) {
                        continue;
                    }

                    poolLinkedCampaignKeys.add(`${pool.id}:${entry.campaignId}`);

                    if (!this.isLinkedCampaignChainEligible(descendantChain, pool.address, vaultAddress)) {
                        continue;
                    }
                    if (
                        typeof linkedOpp.dailyRewards === 'number' &&
                        (!Number.isFinite(linkedOpp.dailyRewards) || linkedOpp.dailyRewards <= 0)
                    ) {
                        continue;
                    }
                    if (linkedOpp.id && frontierOppIdsByPool.get(pool.id)?.has(linkedOpp.id)) {
                        continue;
                    }

                    const matchedLeafCampaign = linkedOpp.campaigns?.find((c) => c.id === node.campaignId);
                    if (!matchedLeafCampaign) {
                        continue;
                    }

                    const effectiveOppApr = this.getEffectiveTokenOpportunityApr(linkedOpp);
                    if (!Number.isFinite(effectiveOppApr) || effectiveOppApr <= 0) {
                        continue;
                    }

                    const eligibleCampaignApr = this.getEligibleLinkedCampaignApr(
                        node,
                        linkedOpp,
                        matchedLeafCampaign,
                        effectiveOppApr,
                    );
                    if (!Number.isFinite(eligibleCampaignApr) || eligibleCampaignApr <= 0) {
                        continue;
                    }

                    const itemId = linkedOpp.id
                        ? `${aaveV4LinkedItemPrefix(pool.id)}${linkedOpp.id}`
                        : `${aaveV4LinkedItemPrefix(pool.id)}${entry.campaignId}`;
                    const campaignKey = `${itemId}:${node.campaignId}`;
                    if (countedCampaignKeys.has(campaignKey)) {
                        continue;
                    }
                    countedCampaignKeys.add(campaignKey);

                    const existing = linkedAprByItemId.get(itemId);
                    if (existing) {
                        existing.item.apr = Math.min(
                            existing.maxAprFraction,
                            existing.item.apr + eligibleCampaignApr / 100,
                        );
                        continue;
                    }

                    const rewardToken = this.extractRewardToken(linkedOpp, {
                        preferredCampaign: matchedLeafCampaign,
                        fallbackCampaign: entry.campaign,
                        fallbackOpportunity: entry.parentOpportunity,
                    });

                    linkedAprByItemId.set(itemId, {
                        item: {
                            id: itemId,
                            type: PrismaPoolAprType.MERKL,
                            title: pool.symbol || 'Pool',
                            chain: chainIdToChain[linkedOpp.chainId],
                            poolId: pool.id,
                            apr: eligibleCampaignApr / 100,
                            rewardTokenAddress: rewardToken.address,
                            rewardTokenSymbol: rewardToken.symbol,
                        },
                        maxAprFraction: effectiveOppApr / 100,
                    });
                }
            }
        }

        const hubFallbackAprs: Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[] = [];
        for (const { pool, token, tokenAddress, tokenShareOfPoolTvl, opportunity } of hubFallbackCandidates) {
            if (opportunity.id && frontierOppIdsByPool.get(pool.id)?.has(opportunity.id)) {
                continue;
            }
            const campaigns = opportunity.campaigns ?? [];
            if (campaigns.some((c) => Boolean(c.id && failedLinkedCampaignIds.has(c.id)))) {
                continue;
            }
            if (campaigns.some((c) => Boolean(c.id && poolLinkedCampaignKeys.has(`${pool.id}:${c.id}`)))) {
                continue;
            }

            const effectiveApr = this.getEffectiveTokenOpportunityApr(opportunity);
            if (!Number.isFinite(effectiveApr) || effectiveApr <= 0) {
                continue;
            }

            const rewardToken = this.extractRewardToken(opportunity);

            hubFallbackAprs.push({
                id: opportunity.id
                    ? `${aaveV4LinkedItemPrefix(pool.id)}${opportunity.id}`
                    : `${aaveV4LinkedItemPrefix(pool.id)}${tokenAddress}`,
                type: PrismaPoolAprType.MERKL,
                title: token.token.symbol || token.address,
                chain: chainIdToChain[opportunity.chainId],
                poolId: pool.id,
                apr: (effectiveApr / 100) * tokenShareOfPoolTvl,
                rewardTokenAddress: rewardToken.address,
                rewardTokenSymbol: rewardToken.symbol,
            });
        }

        return [...Array.from(linkedAprByItemId.values(), ({ item }) => item), ...hubFallbackAprs];
    }

    /**
     * Returns only the APR contribution belonging to the eligible linked campaign from
     * `opportunity.aprRecord.breakdowns` so restricted sibling campaigns sharing the same
     * opportunity cannot inflate the displayed pool APR. Fails closed when breakdown data is missing.
     */
    private getEligibleLinkedCampaignApr(
        node: MerklLinkedCampaignNode,
        opportunity: MerklOpportunity,
        matchedLeafCampaign: MerklCampaign,
        effectiveOppApr: number,
    ): number {
        const breakdowns = opportunity.aprRecord?.breakdowns;
        if (!breakdowns || breakdowns.length === 0) {
            return 0;
        }

        const identifiers = new Set(
            [node.onChainCampaignId, matchedLeafCampaign.campaignId, node.campaignId]
                .filter((id): id is string => Boolean(id))
                .map((id) => id.toLowerCase()),
        );
        if (identifiers.size === 0) {
            return 0;
        }

        const matchingValues = breakdowns
            .filter(
                (breakdown) =>
                    (!breakdown.type || breakdown.type === 'CAMPAIGN') &&
                    Boolean(breakdown.identifier && identifiers.has(breakdown.identifier.toLowerCase())) &&
                    typeof breakdown.value === 'number' &&
                    Number.isFinite(breakdown.value) &&
                    breakdown.value > 0,
            )
            .map((breakdown) => breakdown.value!);

        if (matchingValues.length === 0) {
            return 0;
        }

        const campaignApr = matchingValues.reduce((sum, value) => sum + value, 0);
        return Math.min(campaignApr, effectiveOppApr);
    }

    /**
     * Returns the chain of descendant nodes from `rootCampaignId` down to `node` (excluding root),
     * ordered `[firstChild, ..., node]`, or null if `node` is not a strict descendant of `rootCampaignId`.
     */
    private getDescendantChain(
        node: MerklLinkedCampaignNode,
        rootCampaignId: string,
        nodesById: ReadonlyMap<string, MerklLinkedCampaignNode>,
    ): MerklLinkedCampaignNode[] | null {
        if (!node.parentCampaignId || node.campaignId === rootCampaignId) {
            return null;
        }
        const chain: MerklLinkedCampaignNode[] = [node];
        const visited = new Set<string>([node.campaignId]);
        let currentParentId: string | null | undefined = node.parentCampaignId;
        while (currentParentId) {
            if (currentParentId === rootCampaignId) {
                return chain.reverse();
            }
            if (visited.has(currentParentId)) {
                return null;
            }
            visited.add(currentParentId);
            const parentNode = nodesById.get(currentParentId);
            if (!parentNode) {
                return null;
            }
            chain.push(parentNode);
            currentParentId = parentNode.parentCampaignId;
        }
        return null;
    }

    private opportunityTargetsPool(opportunity: MerklOpportunity, poolAddress: string): boolean {
        if (opportunity.identifier && addressesMatch(opportunity.identifier, poolAddress)) {
            return true;
        }
        if (opportunity.explorerAddress && addressesMatch(opportunity.explorerAddress, poolAddress)) {
            return true;
        }
        return (opportunity.tokens ?? []).some((token) =>
            Boolean(token.address && addressesMatch(token.address, poolAddress)),
        );
    }

    /**
     * Fails closed unless every linked campaign along the forwarding chain includes explicit
     * campaign params from `/linked?campaigns=true` with no whitelist, hooks, or blacklist
     * disqualifying the pool or Vault (and forwarding not disabled on intermediate hops).
     */
    private isLinkedCampaignChainEligible(
        descendantChain: readonly MerklLinkedCampaignNode[],
        poolAddress: string,
        vaultAddress?: string,
    ): boolean {
        if (descendantChain.length === 0) {
            return false;
        }

        for (let i = 0; i < descendantChain.length; i++) {
            const hop = descendantChain[i];
            const isLeaf = i === descendantChain.length - 1;
            const matchedCampaign = hop.opportunity?.campaigns?.find((campaign) => campaign.id === hop.campaignId);
            const params = matchedCampaign?.params;
            if (!params) {
                return false;
            }
            if ((params.whitelist?.length ?? 0) > 0) {
                return false;
            }
            if ((params.hooks?.length ?? 0) > 0) {
                return false;
            }
            if (!isLeaf && params.forwardingEnabled === false) {
                return false;
            }
            const blacklist = params.blacklist ?? [];
            if (
                blacklist.some(
                    (address) =>
                        addressesMatch(address, poolAddress) || (vaultAddress && addressesMatch(address, vaultAddress)),
                )
            ) {
                return false;
            }
        }

        return true;
    }

    private isAaveV4CampaignEligible(
        opportunityType: string,
        params: MerklCampaignParams | undefined,
        spokeAddress: string,
        mapping: AaveV4SpokeMapping,
        poolAddress: string,
        vaultAddress?: string,
    ): boolean {
        if (!params) {
            return false;
        }
        if ((params.whitelist?.length ?? 0) > 0) {
            return false;
        }
        if ((params.hooks?.length ?? 0) > 0) {
            return false;
        }
        if (params.forwardingEnabled === false) {
            return false;
        }
        const blacklist = params.blacklist ?? [];
        if (
            blacklist.some(
                (address) =>
                    addressesMatch(address, spokeAddress) ||
                    addressesMatch(address, poolAddress) ||
                    (vaultAddress && addressesMatch(address, vaultAddress)),
            )
        ) {
            return false;
        }

        if (opportunityType === 'AAVE_V4_HUB_NET_LENDING') {
            return (params.hubs ?? []).some(
                (hub) =>
                    Boolean(hub.hubAddress && addressesMatch(hub.hubAddress, mapping.hubAddress)) &&
                    (hub.assets ?? []).some(
                        (asset) =>
                            Boolean(
                                asset.underlyingToken &&
                                asset.assetId !== undefined &&
                                addressesMatch(asset.underlyingToken, mapping.underlyingAddress),
                            ) && (hub.lendingAssetIds ?? []).some((id) => String(id) === String(asset.assetId)),
                    ),
            );
        }

        return Boolean(
            params.hubAddress &&
            params.underlyingToken &&
            addressesMatch(params.hubAddress, mapping.hubAddress) &&
            addressesMatch(params.underlyingToken, mapping.underlyingAddress),
        );
    }

    private async resolveDynamicAaveV4Spokes(
        chain: Chain,
        chainId: number,
        candidateAddresses: string[],
        knownHubAddresses: Set<string>,
        aaveV4TokenMappings: Map<string, AaveV4SpokeMapping>,
    ): Promise<Set<string>> {
        const failedTokens = new Set<string>();
        const uncached: string[] = [];
        const currentTime = this.now();

        for (const tokenAddress of candidateAddresses) {
            const cacheKey = `${chainId}:${tokenAddress}`;
            const cached = aaveV4SpokeProbeCache.get(cacheKey);
            if (cached) {
                if (cached.expiresAt > currentTime) {
                    if (cached.mapping) {
                        aaveV4TokenMappings.set(tokenAddress, cached.mapping);
                    }
                    continue;
                }
                aaveV4SpokeProbeCache.delete(cacheKey);
            }
            uncached.push(tokenAddress);
        }

        if (uncached.length === 0) {
            return failedTokens;
        }

        const client = getViemClient(chain);
        const multicallAddress = config[chain]?.multicall3 as Hex | undefined;
        const multicallOptions = multicallAddress ? { multicallAddress } : {};

        const matchedCandidates: {
            tokenAddress: string;
            hubAddress: Hex;
            assetId: bigint;
            underlyingAddress: string;
        }[] = [];

        let lastError: unknown;
        let pendingProbeTokens = uncached;

        for (let attempt = 0; attempt <= this.maxRetries && pendingProbeTokens.length > 0; attempt++) {
            if (attempt > 0) {
                const delay = Math.min(MAX_RETRY_AFTER_MS, this.retryBaseDelayMs * 2 ** (attempt - 1));
                if (delay > 0) {
                    await this.sleep(delay);
                }
            }

            try {
                const probeResults = await client.multicall({
                    contracts: pendingProbeTokens.flatMap((tokenAddress) => [
                        { address: tokenAddress as Hex, abi: aaveV4TokenizationSpokeAbi, functionName: 'hub' as const },
                        {
                            address: tokenAddress as Hex,
                            abi: aaveV4TokenizationSpokeAbi,
                            functionName: 'assetId' as const,
                        },
                        {
                            address: tokenAddress as Hex,
                            abi: aaveV4TokenizationSpokeAbi,
                            functionName: 'asset' as const,
                        },
                    ]),
                    allowFailure: true,
                    ...multicallOptions,
                });

                const storedAt = this.now();
                const nextPending: string[] = [];

                for (let i = 0; i < pendingProbeTokens.length; i++) {
                    const tokenAddress = pendingProbeTokens[i];
                    const hubRes = probeResults[i * 3];
                    const assetIdRes = probeResults[i * 3 + 1];
                    const assetRes = probeResults[i * 3 + 2];

                    if (
                        hubRes.status === 'success' &&
                        assetIdRes.status === 'success' &&
                        assetRes.status === 'success'
                    ) {
                        const hubAddress = (hubRes.result as string).toLowerCase() as Hex;
                        if (knownHubAddresses.has(hubAddress)) {
                            matchedCandidates.push({
                                tokenAddress,
                                hubAddress,
                                assetId: assetIdRes.result as bigint,
                                underlyingAddress: (assetRes.result as string).toLowerCase(),
                            });
                        } else {
                            setSpokeProbeCacheEntry(
                                `${chainId}:${tokenAddress}`,
                                null,
                                this.negativeProbeCacheTtlMs,
                                storedAt,
                            );
                        }
                        continue;
                    }

                    const definitiveRejection =
                        (hubRes.status === 'failure' && isDefinitiveProbeRejection(hubRes.error, 'hub')) ||
                        (assetIdRes.status === 'failure' && isDefinitiveProbeRejection(assetIdRes.error, 'assetId')) ||
                        (assetRes.status === 'failure' && isDefinitiveProbeRejection(assetRes.error, 'asset'));

                    if (definitiveRejection) {
                        setSpokeProbeCacheEntry(
                            `${chainId}:${tokenAddress}`,
                            null,
                            this.negativeProbeCacheTtlMs,
                            storedAt,
                        );
                    } else {
                        nextPending.push(tokenAddress);
                        lastError =
                            (hubRes.status === 'failure' && hubRes.error) ||
                            (assetIdRes.status === 'failure' && assetIdRes.error) ||
                            (assetRes.status === 'failure' && assetRes.error) ||
                            lastError;
                    }
                }

                pendingProbeTokens = nextPending;
            } catch (error) {
                lastError = error;
            }
        }

        for (const tokenAddress of pendingProbeTokens) {
            failedTokens.add(tokenAddress);
        }

        let pendingListedCandidates = matchedCandidates;

        for (let attempt = 0; attempt <= this.maxRetries && pendingListedCandidates.length > 0; attempt++) {
            if (attempt > 0) {
                const delay = Math.min(MAX_RETRY_AFTER_MS, this.retryBaseDelayMs * 2 ** (attempt - 1));
                if (delay > 0) {
                    await this.sleep(delay);
                }
            }

            try {
                const listedResults = await client.multicall({
                    contracts: pendingListedCandidates.map(({ hubAddress, assetId, tokenAddress }) => ({
                        address: hubAddress,
                        abi: aaveV4HubSpokeCheckAbi,
                        functionName: 'isSpokeListed' as const,
                        args: [assetId, tokenAddress as Hex] as const,
                    })),
                    allowFailure: true,
                    ...multicallOptions,
                });

                const storedAt = this.now();
                const nextPendingListed: typeof pendingListedCandidates = [];

                pendingListedCandidates.forEach((candidate, idx) => {
                    const listedRes = listedResults[idx];
                    const cacheKey = `${chainId}:${candidate.tokenAddress}`;
                    if (listedRes.status === 'success') {
                        if (listedRes.result === true) {
                            const mapping: AaveV4SpokeMapping = {
                                hubAddress: candidate.hubAddress,
                                underlyingAddress: candidate.underlyingAddress,
                            };
                            setSpokeProbeCacheEntry(cacheKey, mapping, this.positiveProbeCacheTtlMs, storedAt);
                            aaveV4TokenMappings.set(candidate.tokenAddress, mapping);
                        } else {
                            setSpokeProbeCacheEntry(cacheKey, null, this.negativeProbeCacheTtlMs, storedAt);
                        }
                    } else if (isDefinitiveProbeRejection(listedRes.error, 'isSpokeListed')) {
                        setSpokeProbeCacheEntry(cacheKey, null, this.negativeProbeCacheTtlMs, storedAt);
                    } else {
                        nextPendingListed.push(candidate);
                        lastError = listedRes.error;
                    }
                });

                pendingListedCandidates = nextPendingListed;
            } catch (error) {
                lastError = error;
            }
        }

        for (const candidate of pendingListedCandidates) {
            failedTokens.add(candidate.tokenAddress);
        }

        if (failedTokens.size > 0) {
            logger.error('Failed to probe Aave V4 tokenization spokes onchain', {
                chain,
                tokenAddresses: Array.from(failedTokens),
                err: formatProbeError(lastError),
            });
        }

        return failedTokens;
    }

    private getAaveV4TokenMappings(markets: AaveV4AddressBookEntry[]): Map<string, AaveV4SpokeMapping> {
        const spokeMap = new Map<string, AaveV4SpokeMapping>();
        for (const market of markets) {
            if (!market.TOKENIZATION_SPOKES || !market.ASSETS) continue;

            // Match longest hub prefix first (e.g. GLOBAL_DOLLAR_ before shorter prefixes).
            const hubPrefixes = Object.entries(market.HUBS)
                .map(([hubKey, hubAddress]) => [hubKey.replace(/_HUB$/, '_'), hubAddress.toLowerCase()] as const)
                .sort((a, b) => b[0].length - a[0].length);

            const underlyingByAssetKey = new Map<string, string>();
            for (const [assetKey, asset] of Object.entries(market.ASSETS)) {
                const underlying = asset.UNDERLYING.toLowerCase();
                underlyingByAssetKey.set(assetKey, underlying);
                underlyingByAssetKey.set(assetKey.replace(/\./g, ''), underlying);
            }

            for (const [spokeKey, spokeAddress] of Object.entries(market.TOKENIZATION_SPOKES)) {
                const withoutSuffix = spokeKey.replace(/_TOKENIZATION_SPOKE$/, '');
                const matchedHub = hubPrefixes.find(([prefix]) => withoutSuffix.startsWith(prefix));
                if (!matchedHub) continue;

                const assetKey = withoutSuffix.slice(matchedHub[0].length);
                const underlyingAddress = underlyingByAssetKey.get(assetKey);
                if (!underlyingAddress) continue;

                spokeMap.set(spokeAddress.toLowerCase(), {
                    hubAddress: matchedHub[1],
                    underlyingAddress,
                });
            }
        }
        return spokeMap;
    }

    private mapOpportunitiesToAprs(
        opportunities: MerklOpportunity[],
        affectedPools: PoolAPRData[],
    ): {
        items: Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[];
        frontierOppIdsByPool: Map<string, Set<string>>;
    } {
        const aprs: Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[] = [];
        const frontierOppIdsByPool = new Map<string, Set<string>>();

        for (const opportunity of opportunities) {
            const pool = affectedPools.find(
                (pool) =>
                    addressesMatch(pool.address, opportunity.identifier) &&
                    pool.chain === chainIdToChain[opportunity.chainId],
            );

            if (!pool || !pool.dynamicData?.totalLiquidity) {
                continue;
            }

            if (opportunity.id) {
                let poolOppIds = frontierOppIdsByPool.get(pool.id);
                if (!poolOppIds) {
                    poolOppIds = new Set();
                    frontierOppIdsByPool.set(pool.id, poolOppIds);
                }
                poolOppIds.add(opportunity.id);
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

        return { items: aprs, frontierOppIdsByPool };
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
        return this.fetchJsonCached<MerklOpportunity[]>(url);
    }

    private fetchLinkedCampaignsCached(campaignId: string): Promise<MerklLinkedCampaignsResponse> {
        return this.fetchJsonCached<MerklLinkedCampaignsResponse>(linkedCampaignsUrl(campaignId));
    }

    private fetchJsonCached<T>(url: string): Promise<T> {
        const currentTime = this.now();
        const cached = responseCache.get(url);
        if (cached) {
            if (cached.expiresAt > currentTime) {
                return Promise.resolve(cached.data as T);
            }
            responseCache.delete(url);
        }

        const existingInFlight = inFlightRequests.get(url);
        if (existingInFlight) {
            return existingInFlight as Promise<T>;
        }

        const requestPromise = this.fetchJsonWithRetry<T>(url)
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

    private async fetchJsonWithRetry<T>(url: string): Promise<{ data: T; ttlMs: number }> {
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                const response = await this.merklFetch(url);
                if (response.ok) {
                    const ttlMs = parseCacheTtlMs(response.headers.get('cache-control'));
                    const data = (await response.json()) as T;
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
