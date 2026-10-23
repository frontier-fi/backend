import { SwapKind, Token } from '@balancer/sdk';

import { Router } from './router';
import { SorAbortError } from '../errors';
import { PrismaPoolAndHookWithDynamic } from '../../../prisma/prisma-types';
import { checkInputs, isLiquidityManagement } from './utils/helpers';
import { BasePool } from './basePool';
import { SorSwapOptions } from './types';
import { PathWithAmount } from './path';
import { BufferPool, GyroECLPPool, StablePoolV3, WeightedPoolV3 } from './poolsV3';
import { BufferPoolData } from '../utils/data';

export class SOR {
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
                switch (prismaPool.type) {
                    case 'WEIGHTED':
                        basePools.push(WeightedPoolV3.fromPrismaPool(prismaPool));
                        break;
                    case 'STABLE':
                        basePools.push(StablePoolV3.fromPrismaPool(prismaPool));
                        break;
                    case 'ECLP':
                        basePools.push(GyroECLPPool.fromPrismaPool(prismaPool));
                        break;
                    default:
                        console.log('Unsupported pool type');
                        break;
                }
            } catch (e: any) {
                // Do nothing, just skip the pool
                console.error('Skipping pool', prismaPool.id, prismaPool.chain, e.message);
            }
        }

        if (protocolVersion === 3) {
            for (const bufferPool of bufferPools) {
                basePools.push(BufferPool.fromBufferPoolData(bufferPool));
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

        const bestPaths = router.getBestPaths(candidatePaths, swapKind, checkedSwapAmount);

        if (!bestPaths) return null;

        return bestPaths;
    }
}
