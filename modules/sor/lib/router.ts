import { SwapKind, Token, TokenAmount } from '@balancer/sdk';
import { PathGraph } from './pathGraph/pathGraph';
import { PathGraphTraversalConfig } from './pathGraph/pathGraphTypes';
import { max, min } from './utils/math';
import { BasePool } from './basePool';
import { PathLocal, PathWithAmount } from './path';
import { formatUnits, parseEther } from 'viem';

export class Router {
    private readonly pathGraph: PathGraph;

    constructor() {
        this.pathGraph = new PathGraph();
    }

    public getCandidatePaths(
        tokenIn: Token,
        tokenOut: Token,
        pools: BasePool[],
        swapAmount: TokenAmount,
        swapKind: SwapKind,
        enableAddRemoveLiquidityPaths: boolean,
        tokenPrices: Map<string, number>,
        graphTraversalConfig?: Partial<PathGraphTraversalConfig>,
        signal?: AbortSignal,
    ): PathLocal[] {
        const minSwapAmountRatio = graphTraversalConfig?.minSwapAmountRatio ?? 0.5;
        // Compute USD threshold if prices provided
        const priceToken = swapKind === SwapKind.GivenIn ? tokenIn : tokenOut;
        const price = tokenPrices.get(priceToken.address.toLowerCase());
        const amount = Number(formatUnits(swapAmount.amount, priceToken.decimals));
        const minLimitThresholdUSD = amount * minSwapAmountRatio * (price ?? 0);

        this.pathGraph.buildGraph({
            pools,
            enableAddRemoveLiquidityPaths,
            swapKind,
            tokenPrices,
            minLimitThresholdUSD,
        });

        const candidatePaths = this.pathGraph.getCandidatePaths({
            tokenIn,
            tokenOut,
            swapAmount,
            swapKind,
            graphTraversalConfig,
            signal,
        });

        return candidatePaths;
    }

    public getBestPaths(paths: PathLocal[], swapKind: SwapKind, swapAmount: TokenAmount): PathWithAmount[] | null {
        if (paths.length === 0) {
            throw new Error('No potential swap paths provided');
        }

        // break swapAmount into 25%, 50%, 75% and 100% ratios, so we're able to split quote into multiple paths
        const swapAmounts = [
            swapAmount.mulDownFixed(parseEther(String(0.25))),
            swapAmount.mulDownFixed(parseEther(String(0.5))),
            swapAmount.mulDownFixed(parseEther(String(0.75))),
            swapAmount,
        ];

        // initialize quotePaths arrays for each swapAmount ratio
        const quotePathsByRatio: PathWithAmount[][] = swapAmounts.map(() => []);

        // Track paths that have already exceeded buffer/pool capacity at a smaller ratio
        const capacityExceededPaths = new Set<PathLocal>();

        // Quote paths for each swapAmount ratio
        swapAmounts.forEach((amount, i) => {
            if (amount.amount === 0n) {
                return;
            }
            paths.forEach((path) => {
                if (capacityExceededPaths.has(path)) {
                    return;
                }
                try {
                    const pathWithAmount = new PathWithAmount(path.tokens, path.pools, path.isBuffer, amount);

                    // remove paths with buffer steps that would revert onchain because the swap
                    // amount exceeds the buffer's capacity (buffer balance + erc4626 maxDeposit/maxWithdraw)
                    const exceedsBufferCapacity = pathWithAmount.swapStepsExceedingBufferCapacity > 0;
                    if (exceedsBufferCapacity) {
                        capacityExceededPaths.add(path);
                        return;
                    }

                    /**
                     * Remove paths that return 0 amount
                     * It usually happens when low swapAmounts are provided and return amounts rounded down to zero
                     */
                    const calculatedAmount =
                        pathWithAmount.swapKind === SwapKind.GivenIn
                            ? pathWithAmount.outputAmount
                            : pathWithAmount.inputAmount;
                    if (calculatedAmount.amount > 0n) {
                        quotePathsByRatio[i].push(pathWithAmount);
                    }
                } catch (error) {
                    // const pathString =
                    //     path.tokens[0].address +
                    //     ' ' +
                    //     path.pools.map((pool, index) => `[${pool.id}] ${path.tokens[index + 1].address}`).join(' ');
                    // console.log('Invalid path: ' + pathString);
                    // console.log(error);
                    return;
                }
            });
        });

        // sort each quotePaths array by outputAmount or inputAmount
        quotePathsByRatio.forEach((quotePaths) => {
            quotePaths.sort((a, b) => {
                if (swapKind === SwapKind.GivenIn) {
                    if (b.outputAmount.amount > a.outputAmount.amount) {
                        return 1;
                    } else if (b.outputAmount.amount < a.outputAmount.amount) {
                        return -1;
                    } else {
                        return 0;
                    }
                } else {
                    if (a.inputAmount.amount > b.inputAmount.amount) {
                        return 1;
                    } else if (a.inputAmount.amount < b.inputAmount.amount) {
                        return -1;
                    } else {
                        return 0;
                    }
                }
            });
        });

        // select best split path candidates based on their ratio combination
        const quotePaths25 = quotePathsByRatio[0];
        const quotePaths50 = quotePathsByRatio[1];
        const quotePaths75 = quotePathsByRatio[2];
        const quotePaths100 = quotePathsByRatio[3];

        const splitPaths: PathWithAmount[][] = [];

        if (quotePaths100.length > 0) {
            splitPaths.push([quotePaths100[0]]);
        }

        if (quotePaths75.length > 0 && quotePaths25.length > 0) {
            // select first valid 25/75 pair anchored on the best 75% path
            for (const path75 of quotePaths75) {
                let paired = false;
                for (const path25 of quotePaths25) {
                    if (!this.canSplitPaths(path75, path25)) {
                        continue;
                    }
                    try {
                        splitPaths.push(this.splitPaths(swapAmount, path25, path75)); // 25/75
                        paired = true;
                        break;
                    } catch (error) {
                        console.log('Error splitting paths 25/75: ', error);
                    }
                }
                if (paired) {
                    break;
                }
            }

            // also try anchoring on the best 25% path paired with a compatible 75% path
            for (const path25 of quotePaths25) {
                let paired = false;
                for (const path75 of quotePaths75) {
                    if (!this.canSplitPaths(path25, path75)) {
                        continue;
                    }
                    try {
                        splitPaths.push(this.splitPaths(swapAmount, path25, path75)); // 25/75
                        paired = true;
                        break;
                    } catch (error) {
                        console.log('Error splitting paths 25/75: ', error);
                    }
                }
                if (paired) {
                    break;
                }
            }
        }

        if (quotePaths50.length > 1) {
            for (let i = 0; i < quotePaths50.length; i++) {
                let paired = false;
                for (let j = i + 1; j < quotePaths50.length; j++) {
                    if (!this.canSplitPaths(quotePaths50[i], quotePaths50[j])) {
                        continue;
                    }
                    try {
                        splitPaths.push(this.splitPaths(swapAmount, quotePaths50[i], quotePaths50[j])); // 50/50
                        paired = true;
                        break;
                    } catch (error) {
                        console.log('Error splitting paths 50/50: ', error);
                    }
                }
                if (paired) {
                    break;
                }
            }
        }

        if (splitPaths.length === 0) {
            // console.log('No valid paths found');
            return null;
        }

        // Find the split path that yields the best result (i.e. maxAmountOut on GivenIn, minAmountIn on GivenOut)
        let bestSplitPaths: PathWithAmount[] = [];
        if (swapKind === SwapKind.GivenIn) {
            const splitPathsAmountsOut = splitPaths.map((paths) =>
                paths.map((path) => path.outputAmount.amount).reduce((acc, amountOut) => acc + amountOut, 0n),
            );
            const maxAmountOutIndex = splitPathsAmountsOut.indexOf(max(splitPathsAmountsOut));
            bestSplitPaths = splitPaths[maxAmountOutIndex];
        } else {
            const splitPathsAmountsIn = splitPaths.map((paths) =>
                paths.map((path) => path.inputAmount.amount).reduce((acc, amountIn) => acc + amountIn, 0n),
            );
            const minAmountInIndex = splitPathsAmountsIn.indexOf(min(splitPathsAmountsIn));
            bestSplitPaths = splitPaths[minAmountInIndex];
        }

        return bestSplitPaths;
    }

    private canSplitPaths(pathA: PathLocal, pathB: PathLocal): boolean {
        const hasNonBufferPool =
            pathA.pools.some((pool) => pool.poolType !== 'Buffer') ||
            pathB.pools.some((pool) => pool.poolType !== 'Buffer');
        if (!hasNonBufferPool) {
            return !pathA.pools.some((pool) => pathB.pools.some((p) => p.id === pool.id));
        }
        return !pathA.pools.some((pool) => pool.poolType !== 'Buffer' && pathB.pools.some((p) => p.id === pool.id));
    }

    // split paths making sure there is no dust left behind from rounding swapAmount ratios
    private splitPaths(swapAmount: TokenAmount, pathA: PathWithAmount, pathB: PathWithAmount) {
        const swapAmountUp = pathA.swapAmount;
        const swapAmountDown = swapAmount.sub(swapAmountUp);

        // copy pools to avoid mutating the original pools
        const pools = [...new Set(pathA.pools.concat(pathB.pools))];
        const poolsCopy = pools.map((pool) => pool.copy());
        const poolsA = pathA.pools.map((pool) => poolsCopy.find((p) => p.id === pool.id)) as BasePool[];
        const poolsB = pathB.pools.map((pool) => poolsCopy.find((p) => p.id === pool.id)) as BasePool[];

        // create paths with copied pools and `mutateBalances = true` to make sure reusing pools works as expected
        const pathUp = new PathWithAmount(pathA.tokens, poolsA, pathA.isBuffer, swapAmountUp, true);
        const pathDown = new PathWithAmount(pathB.tokens, poolsB, pathB.isBuffer, swapAmountDown, true);

        if (pathUp.swapStepsExceedingBufferCapacity > 0 || pathDown.swapStepsExceedingBufferCapacity > 0) {
            throw new Error('Split path exceeds buffer capacity');
        }

        return [pathUp, pathDown];
    }
}
