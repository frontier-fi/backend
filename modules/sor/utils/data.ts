import { Cache } from 'memory-cache';
import { Address, parseEther, parseUnits } from 'viem';
import { Chain, PrismaPoolType, PrismaToken } from '@prisma/client';

import { prisma } from '../../../prisma/prisma-client';
import { PrismaPoolAndHookWithDynamic, HookData } from '../../../prisma/prisma-types';
import { chainToChainId } from '../../../config/chain-id-to-chain';
import { poolsToIgnore } from './constants';
import { tokenService } from '../../token/token.service';
import { env } from '../../../apps/env';
import { ZERO_ADDRESS } from '@balancer/sdk';

export type BufferPoolData = {
    poolId: string;
    address: Address;
    chainId: number;
    mainToken: { address: Address; decimals: number; balance: bigint };
    underlyingToken: { address: Address; decimals: number; balance: bigint };
    poolType: string;
    unwrapRate: bigint;
    maxDeposit: bigint;
    maxWithdraw: bigint;
};

export type SORDbPool = PrismaPoolAndHookWithDynamic;

const cache = new Cache<string, { pools: SORDbPool[]; bufferPools: BufferPoolData[] }>();
const SOR_POOLS_CACHE_KEY = `sor:pools`;

export async function getBasePoolsFromDb(
    chain: Chain,
    protocolVersion: number,
    considerPoolsWithHooks: boolean,
    poolIds?: string[],
): Promise<{ pools: SORDbPool[]; bufferPools: BufferPoolData[] }> {
    const cacheKey = `${SOR_POOLS_CACHE_KEY}:${chain}:${poolIds}`;

    let cached = cache.get(cacheKey);

    if (!cached) {
        // get pools
        console.time('SOR:getpools');
        const pools = await getPools(chain, poolIds);
        console.timeEnd('SOR:getpools');
        const bufferPools = await getBufferPoolsFromDBPools(pools, chain);
        cached = cache.put(cacheKey, { pools, bufferPools }, parseInt(env.SOR_POOLS_CACHE_TTL_SECONDS) * 1000);
    }

    // Filter by protocol version and hook preferences
    const pools = cached.pools
        .filter((pool) => pool.protocolVersion === protocolVersion)
        .filter((pool) => {
            if (considerPoolsWithHooks) return true;
            return !pool.hook || Object.keys(pool.hook).length === 0;
        });

    const activeTokenAddresses = new Set(pools.flatMap((pool) => pool.tokens.map((t) => t.address.toLowerCase())));

    const bufferPools = cached.bufferPools.filter((bufferPool) =>
        activeTokenAddresses.has(bufferPool.address.toLowerCase()),
    );

    return { pools, bufferPools };
}

async function getPools(chain: Chain, poolIds?: string[]): Promise<SORDbPool[]> {
    const type = {
        in: ['WEIGHTED', 'STABLE', 'ECLP'] as PrismaPoolType[],
    };

    let pools = [] as SORDbPool[];

    if (poolIds && poolIds.length > 0) {
        pools = await prisma.prismaPool.findMany({
            where: {
                id: { in: poolIds },
                chain,
                type,
                dynamicData: {
                    totalSharesNum: { gt: 0.000000000001 },
                    swapEnabled: true,
                    isPaused: false,
                },
            },
            include: {
                tokens: {
                    orderBy: [{ index: 'asc' }],
                    include: {
                        token: true,
                    },
                },
                dynamicData: true,
            },
        });
    } else {
        pools = await prisma.prismaPool.findMany({
            where: {
                id: { notIn: [...poolsToIgnore] },
                chain,
                type,
                dynamicData: {
                    OR: [
                        {
                            totalLiquidity: { gte: 100 },
                        },
                        {
                            chain: 'SEPOLIA',
                        },
                    ],
                    totalSharesNum: { gt: 0.000000000001 },
                    swapEnabled: true,
                    isPaused: false,
                },
            },
            include: {
                tokens: {
                    orderBy: [{ index: 'asc' }],
                    include: {
                        token: true,
                    },
                },
                dynamicData: true,
            },
        });
    }

    // Remove pools with unsupported hooks (invariant regardless of caller preferences)
    pools = pools.filter((pool) => {
        if (!pool.hook || Object.keys(pool.hook).length === 0) return true;
        const hook = pool.hook as HookData;
        // UNKNOWN means the address is stored, but this deployment has no math for it yet.
        const isSupportedHookType = hook.type !== undefined && hook.type !== 'UNKNOWN';
        if (!isSupportedHookType) {
            console.log('Pool has unsupported hook type', pool.id, hook.type);
        }
        return isSupportedHookType;
    });

    // Only allow pools where every token with a rate provider has been explicitly reviewed
    const reviewedProviders = await prisma.prismaPriceRateProviderData.findMany({
        where: { chain, reviewed: true },
        select: { rateProviderAddress: true },
    });
    const reviewedAddresses = new Set(reviewedProviders.map((p) => p.rateProviderAddress.toLowerCase()));

    return pools.filter((pool) =>
        pool.tokens.every(
            (t) =>
                !t.priceRateProvider ||
                t.priceRateProvider === ZERO_ADDRESS ||
                reviewedAddresses.has(t.priceRateProvider.toLowerCase()),
        ),
    );
}

export async function getBufferPoolsFromDBPools(pools: SORDbPool[], chain: Chain): Promise<BufferPoolData[]> {
    const v3Pools = pools.filter((pool) => pool.protocolVersion === 3);

    const tokensWithUnderlying = v3Pools.flatMap((pool) =>
        pool.tokens.filter((token) => token.token.underlyingTokenAddress !== null).map((token) => token.address),
    );

    const erc4626Reviews = await tokenService.getErc4626Data();

    const erc4626ThatCanBeUsedForSwaps = Object.values(erc4626Reviews)
        .filter(
            (review): review is NonNullable<typeof review> =>
                review?.chain === chain &&
                review?.canUseBufferForSwaps === true &&
                tokensWithUnderlying.includes(review?.erc4626Address),
        )
        .map((review) => review);

    const wrappedTokenAddresses = erc4626ThatCanBeUsedForSwaps.map((data) => data.erc4626Address);
    const underlyingTokenAddresses = erc4626ThatCanBeUsedForSwaps.map((data) => data.assetAddress);

    const tokens = await tokenService.getTokens(chain);
    const tokensMap = Object.fromEntries(tokens.map((token) => [token.address.toLowerCase(), token]));

    logMissingTokens(tokens, underlyingTokenAddresses);

    // instead of an actual buffer pool, I'd like to return an object that can be used to build a buffer pool
    const bufferPools: BufferPoolData[] = [];
    const seenAddresses = new Set<string>();
    for (const pool of v3Pools) {
        for (const poolToken of pool.tokens) {
            const normalizedTokenAddress = poolToken.address.toLowerCase();
            if (seenAddresses.has(normalizedTokenAddress)) {
                continue;
            }
            // check if token can be used for swaps through buffer pools
            if (poolToken.token.underlyingTokenAddress && wrappedTokenAddresses.includes(poolToken.address)) {
                // check if underlying token exists in the database
                const underlyingToken = tokensMap[poolToken.token.underlyingTokenAddress];
                if (underlyingToken) {
                    seenAddresses.add(normalizedTokenAddress);
                    bufferPools.push({
                        poolId: pool.id,
                        address: normalizedTokenAddress as Address,
                        chainId: Number(chainToChainId[chain]),
                        mainToken: {
                            address: normalizedTokenAddress as Address,
                            decimals: poolToken.token.decimals,
                            balance: parseUnits(poolToken.token.bufferBalanceWrapped, poolToken.token.decimals),
                        },
                        underlyingToken: {
                            address: underlyingToken.address.toLowerCase() as Address,
                            decimals: underlyingToken.decimals,
                            balance: parseUnits(poolToken.token.bufferBalanceUnderlying, underlyingToken.decimals),
                        },
                        poolType: 'Buffer',
                        unwrapRate: parseEther(poolToken.token.unwrapRate), // the way we store rates already takes into account main/underlying decimals differences
                        maxWithdraw: parseUnits(poolToken.token.maxWithdraw, underlyingToken.decimals),
                        maxDeposit: parseUnits(poolToken.token.maxDeposit, underlyingToken.decimals),
                    });
                }
            }
        }
    }
    return bufferPools;
}

function logMissingTokens(underlyingTokens: PrismaToken[], underlyingTokenAddresses: string[]) {
    if (underlyingTokens.length !== underlyingTokenAddresses.length) {
        underlyingTokenAddresses.forEach((address) => {
            if (!underlyingTokens.find((token) => token.address === address)) {
                console.error(`Underlying prisma token not found for ${address}`);
            }
        });
    }
}

/**
 * Fetches current token prices for a chain and returns a lowercase-address -> price map.
 * Uses the shared tokenService cache to avoid redundant DB hits.
 */
export async function getTokenPricesMap(chain: Chain): Promise<Map<string, number>> {
    const prices = await tokenService.getTokenPrices(chain);
    const map = new Map<string, number>();
    for (const p of prices) {
        map.set(p.tokenAddress.toLowerCase(), p.price);
    }
    return map;
}
