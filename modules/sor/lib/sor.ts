import { SwapKind, Token } from '@balancer/sdk';

import { Router } from './router';
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_DEPTH_FALLBACK } from './pathGraph/pathGraph';
import { SorAbortError } from '../errors';
import { PrismaPoolAndHookWithDynamic } from '../../../prisma/prisma-types';
import { computeStableAmp, StableData } from '../../pool/subgraph-pool';
import { checkInputs, isLiquidityManagement } from './utils/helpers';
import { BasePool } from './basePool';
import { SorSwapOptions } from './types';
import { PathWithAmount } from './path';
import { BufferPool, GyroECLPPool, StablePoolV3, WeightedPoolV3 } from './poolsV3';
import { BufferPoolData } from '../utils/data';

export class SOR {
    private static readonly prismaPoolCache = new WeakMap<
        PrismaPoolAndHookWithDynamic,
        { stateKey: string; pool: BasePool }
    >();
    private static readonly bufferPoolCache = new WeakMap<BufferPoolData, { stateKey: string; pool: BufferPool }>();

    static async getPathsWithPools(
        tokenIn: Token,
        tokenOut: Token,
        swapKind: SwapKind,
        swapAmountEvm: bigint,
        prismaPools: PrismaPoolAndHookWithDynamic[],
        bufferPools: BufferPoolData[],
        protocolVersion: number,
        tokenPrices: Map<string, number>,
        swapOptions?: Omit<SorSwapOptions, 'graphTraversalConfig.poolIdsToInclude'>,
        signal?: AbortSignal,
    ): Promise<PathWithAmount[] | null> {
        // Check if already aborted
        if (signal?.aborted) {
            throw new SorAbortError();
        }

        const checkedSwapAmount = checkInputs(tokenIn, tokenOut, swapKind, swapAmountEvm);

        // get current block timestamp if not provided
        const currentTimestamp = swapOptions?.currentTimestamp ?? BigInt(Date.now()) / 1000n;

        const basePools: BasePool[] = [];

        for (const prismaPool of prismaPools) {
            // Check for abort periodically
            if (signal?.aborted) {
                throw new SorAbortError();
            }

            if (prismaPool.protocolVersion !== 3) {
                continue;
            }
            if (!isLiquidityManagement(prismaPool.liquidityManagement)) {
                console.log('LiquidityManagement incorrect for pool', prismaPool.id);
                continue;
            }
            try {
                const stableAmpKey =
                    prismaPool.type === 'STABLE'
                        ? String(computeStableAmp(prismaPool.typeData as StableData, currentTimestamp))
                        : '';
                const stateKey = `${prismaPool.dynamicData?.swapFee ?? ''}:${prismaPool.dynamicData?.aggregateSwapFee ?? ''}:${prismaPool.dynamicData?.isInRecoveryMode ?? false}:${prismaPool.dynamicData?.totalShares ?? ''}:${stableAmpKey}:${prismaPool.tokens.map((t) => `${t.balance}:${t.priceRate}`).join(',')}`;
                const cached = this.prismaPoolCache.get(prismaPool);
                if (cached && cached.stateKey === stateKey) {
                    basePools.push(cached.pool.copy());
                    continue;
                }

                let pool: BasePool | undefined;
                switch (prismaPool.type) {
                    case 'WEIGHTED':
                        pool = WeightedPoolV3.fromPrismaPool(prismaPool);
                        break;
                    case 'STABLE':
                        pool = StablePoolV3.fromPrismaPool(prismaPool, currentTimestamp);
                        break;
                    case 'ECLP':
                        pool = GyroECLPPool.fromPrismaPool(prismaPool);
                        break;
                    default:
                        console.log('Unsupported pool type');
                        break;
                }
                if (pool) {
                    this.prismaPoolCache.set(prismaPool, { stateKey, pool });
                    basePools.push(pool.copy());
                }
            } catch (e: any) {
                // Do nothing, just skip the pool
                console.error('Skipping pool', prismaPool.id, prismaPool.chain, e.message);
            }
        }

        if (protocolVersion === 3) {
            for (const bufferPool of bufferPools) {
                const stateKey = `${bufferPool.unwrapRate}:${bufferPool.mainToken.balance}:${bufferPool.underlyingToken.balance}:${bufferPool.maxDeposit}:${bufferPool.maxWithdraw}`;
                const cached = this.bufferPoolCache.get(bufferPool);
                if (cached && cached.stateKey === stateKey) {
                    basePools.push(cached.pool.copy());
                    continue;
                }
                const pool = BufferPool.fromBufferPoolData(bufferPool);
                this.bufferPoolCache.set(bufferPool, { stateKey, pool });
                basePools.push(pool.copy());
            }
        }

        // Check for abort before starting router
        if (signal?.aborted) {
            throw new SorAbortError();
        }

        const router = new Router();

        const candidatePaths = router.getCandidatePaths(
            tokenIn,
            tokenOut,
            basePools,
            checkedSwapAmount,
            swapKind,
            protocolVersion === 3,
            tokenPrices,
            swapOptions?.graphTraversalConfig,
            signal,
        );

        if (candidatePaths.length === 0) return null;

        // Check for abort before getBestPaths
        if (signal?.aborted) {
            throw new SorAbortError();
        }

        let bestPaths = router.getBestPaths(
            candidatePaths,
            swapKind,
            checkedSwapAmount,
            swapOptions?.minSplitBenefitBps,
        );

        // Retry traversal with maxDepthFallback on the already-built graph if shallow paths were found by BFS
        // but all failed end-to-end quoting in getBestPaths
        const maxDepth = swapOptions?.graphTraversalConfig?.maxDepth ?? DEFAULT_MAX_DEPTH;
        const maxDepthFallback = swapOptions?.graphTraversalConfig?.maxDepthFallback ?? DEFAULT_MAX_DEPTH_FALLBACK;
        if (!bestPaths && maxDepthFallback > maxDepth) {
            if (signal?.aborted) {
                throw new SorAbortError();
            }
            const fallbackCandidates = router.getCandidatePaths(
                tokenIn,
                tokenOut,
                basePools,
                checkedSwapAmount,
                swapKind,
                protocolVersion === 3,
                tokenPrices,
                {
                    ...swapOptions?.graphTraversalConfig,
                    maxDepth: maxDepthFallback,
                    maxDepthFallback,
                },
                signal,
                false,
            );
            if (fallbackCandidates.length > 0) {
                if (signal?.aborted) {
                    throw new SorAbortError();
                }
                bestPaths = router.getBestPaths(
                    fallbackCandidates,
                    swapKind,
                    checkedSwapAmount,
                    swapOptions?.minSplitBenefitBps,
                );
            }
        }

        if (!bestPaths) return null;

        return bestPaths;
    }
}
