import * as Sentry from '@sentry/node';
import { Address, formatUnits } from 'viem';

import { GqlSorGetSwapPaths, QuerySorGetSwapPathsArgs } from '../../apps/api/gql/generated-schema';
import { GetSwapPathsInput } from './types';
import { SOR } from './lib/sor';
import { SorAbortError } from './errors';
import {
    getBasePoolsFromDb,
    getToken,
    getTokenPricesMap,
    isValidSwapRequest,
    mapSwapKind,
    mapToGetSwapPathsInput,
    mapToSorSwapPaths,
    swapPathsZeroResponse,
    validateTokens,
} from './utils';
import { PathWithAmount } from './lib/path';
import { getInputAmount, getOutputAmount } from './lib/utils';
import { PathGraphTraversalConfig } from './lib/pathGraph/pathGraphTypes';
import { Chain } from '@prisma/client';

const DEFAULT_MAX_DEPTH = 4;

export class SorService {
    async getSorSwapPaths(args: QuerySorGetSwapPathsArgs, signal?: AbortSignal): Promise<GqlSorGetSwapPaths> {
        const tokenIn = args.tokenIn.toLowerCase();
        const tokenOut = args.tokenOut.toLowerCase();

        const chain = args.chain as Chain;

        // early returns for invalid requests
        if (!isValidSwapRequest(tokenIn, tokenOut, args.swapAmount, chain)) {
            return swapPathsZeroResponse(args.tokenIn, args.tokenOut, chain);
        }
        if (!(await validateTokens(tokenIn, tokenOut, chain))) {
            return swapPathsZeroResponse(args.tokenIn, args.tokenOut, chain);
        }

        // map SOR Service inputs to SOR inputs
        const getSwapPathsInput = await mapToGetSwapPathsInput({ ...args, tokenIn, tokenOut });

        const { paths, protocolVersion } = await this.getSwapPaths({
            ...getSwapPathsInput,
            protocolVersion: 3,
            signal,
        });

        // return zero response if no paths are found
        if (!paths) {
            return swapPathsZeroResponse(
                getSwapPathsInput.tokenIn,
                getSwapPathsInput.tokenOut,
                getSwapPathsInput.chain,
            );
        }

        // map SOR output to SOR Service output
        const mappedPaths = await mapToSorSwapPaths(paths, args.swapType, chain, protocolVersion);

        return mappedPaths;
    }

    private async getSwapPaths(
        input: GetSwapPathsInput & { signal?: AbortSignal },
    ): Promise<{ paths: PathWithAmount[] | null; protocolVersion: number; returnAmount: string }> {
        try {
            // Check if already aborted
            if (input.signal?.aborted) {
                throw new SorAbortError();
            }

            const { pools: poolsFromDb, bufferPools } = await getBasePoolsFromDb(
                input.chain,
                input.protocolVersion,
                input.considerPoolsWithHooks,
                input.poolIds,
            );

            // Check again after async operation
            if (input.signal?.aborted) {
                throw new SorAbortError();
            }

            const tokenIn = await getToken(input.tokenIn as Address, input.chain);
            const tokenOut = await getToken(input.tokenOut as Address, input.chain);
            const swapKind = mapSwapKind(input.swapType);

            // Check if the tokens are in the pools
            const allTokens = [
                ...new Set(
                    poolsFromDb
                        .flatMap((pool) => [
                            ...pool.tokens.flatMap((t) => [t.token.address, t.token.underlyingTokenAddress]),
                            // v3 supports add/remove liquidity paths, so BPT addresses are valid swap tokens
                            ...(input.protocolVersion === 3 ? [pool.address] : []),
                        ])
                        .filter((t) => t !== null),
                ),
            ];

            const tokenInFound = allTokens.find((t) => tokenIn.isSameAddress(t as Address));
            const tokenOutFound = allTokens.find((t) => tokenOut.isSameAddress(t as Address));

            if (!tokenInFound || !tokenOutFound) {
                return { paths: null, protocolVersion: input.protocolVersion, returnAmount: '0' };
            }

            // used for early pruning of paths based on swap limits
            const tokenPrices = await getTokenPricesMap(input.chain);

            // Check again after async operation
            if (input.signal?.aborted) {
                throw new SorAbortError();
            }

            // retry with different max depth if no paths are found
            let swapOptions = this.buildSwapOptions(DEFAULT_MAX_DEPTH);
            let paths = await SOR.getPathsWithPools(
                tokenIn,
                tokenOut,
                swapKind,
                input.swapAmount.amount,
                poolsFromDb,
                bufferPools,
                input.protocolVersion,
                tokenPrices,
                swapOptions,
                input.signal,
            );

            if (!paths) {
                return { paths: null, protocolVersion: input.protocolVersion, returnAmount: '0' };
            }

            // add returnAmount to result using getInputAmount and getOutputAmount
            const inputAmount = getInputAmount(paths);
            const outputAmount = getOutputAmount(paths);
            const returnAmountEvm = input.swapType === 'EXACT_IN' ? outputAmount : inputAmount;
            const returnAmount = formatUnits(returnAmountEvm.amount, returnAmountEvm.token.decimals);

            return { paths, protocolVersion: input.protocolVersion, returnAmount };
        } catch (err: any) {
            // Re-throw if it's an abort error
            if (err instanceof SorAbortError || err.name === 'AbortError' || input.signal?.aborted) {
                throw err;
            }
            this.logSwapPathError(err, input);
            return { paths: null, protocolVersion: input.protocolVersion, returnAmount: '0' };
        }
    }

    private buildSwapOptions(maxDepth: number): {
        graphTraversalConfig: Partial<PathGraphTraversalConfig>;
    } {
        return {
            graphTraversalConfig: {
                maxDepth,
                maxDepthFallback: maxDepth + 1,
            },
        };
    }

    private logSwapPathError(err: any, input: GetSwapPathsInput): void {
        console.table({
            error: 'SOR_V2_ERROR',
            message: err.message,
            tokenIn: input.tokenIn,
            tokenOut: input.tokenOut,
            swapAmount: input.swapAmount.amount,
            swapType: input.swapType,
            chain: input.chain,
        });

        Sentry.captureException(err.message, {
            tags: {
                service: 'sorV2',
                tokenIn: input.tokenIn,
                tokenOut: input.tokenOut,
                swapAmount: input.swapAmount.amount,
                swapType: input.swapType,
                chain: input.chain,
            },
        });
    }
}

export const sorService = new SorService();
