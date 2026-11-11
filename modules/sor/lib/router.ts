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
        rebuildGraph = true,
    ): PathLocal[] {
        if (rebuildGraph) {
            const minSwapAmountRatio = graphTraversalConfig?.minSwapAmountRatio ?? 0.1;
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
        }

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

    public getBestPaths(
        paths: PathLocal[],
        swapKind: SwapKind,
        swapAmount: TokenAmount,
        minSplitBenefitBps = 0n,
    ): PathWithAmount[] | null {
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
        const splitCandidatePairs: Array<{ pathUp: PathLocal; pathDown: PathLocal; maxAmountUp?: bigint }> = [];
        const getPairKey = (pathA: PathLocal, pathB: PathLocal) =>
            `${pathA.pools.map((p) => p.id).join('>')}||${pathB.pools.map((p) => p.id).join('>')}`;
        const hasSplitPair = (pathA: PathLocal, pathB: PathLocal) => {
            const keyAB = getPairKey(pathA, pathB);
            return splitCandidatePairs.some(({ pathUp, pathDown }) => getPairKey(pathUp, pathDown) === keyAB);
        };
        const recordSplitPair = (pathUp: PathLocal, pathDown: PathLocal, maxAmountUp?: bigint) => {
            if (!hasSplitPair(pathUp, pathDown)) {
                splitCandidatePairs.push({ pathUp, pathDown, maxAmountUp });
            }
        };

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
                        recordSplitPair(path25, path75);
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
                    if (hasSplitPair(path25, path75)) {
                        paired = true;
                        break;
                    }
                    try {
                        splitPaths.push(this.splitPaths(swapAmount, path25, path75)); // 25/75
                        recordSplitPair(path25, path75);
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
                        recordSplitPair(quotePaths50[i], quotePaths50[j]);
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

        // Buffer-cap split clamping: when a path with BufferPool steps exceeds buffer capacity at a coarse grid checkpoint,
        // clamp its allocation to its exact buffer limit and route the remainder through the best compatible partner path.
        // Include remaining candidate `paths` after grid survivors so small remainders (< 25%) can still pair with
        // shallower partner paths that could not individually handle the 25% checkpoint.
        const seenPartnerKeys = new Set<string>();
        const partnerCandidates: PathLocal[] = [];
        for (const candidate of [...quotePaths100, ...quotePaths75, ...quotePaths50, ...quotePaths25, ...paths]) {
            const key = candidate.pools.map((p) => p.id).join('>');
            if (!seenPartnerKeys.has(key)) {
                seenPartnerKeys.add(key);
                partnerCandidates.push(candidate);
            }
        }
        if (capacityExceededPaths.size > 0 && partnerCandidates.length > 0) {
            for (const cappedPath of capacityExceededPaths) {
                const clampedRaw = this.getBufferConstrainedMaxSwapAmount(cappedPath, swapKind, swapAmount.amount);
                if (clampedRaw === null) {
                    continue;
                }
                const clampedAmount = TokenAmount.fromRawAmount(swapAmount.token, clampedRaw);
                for (const partner of partnerCandidates) {
                    if (!this.canSplitPaths(cappedPath, partner)) {
                        continue;
                    }
                    try {
                        splitPaths.push(this.splitPathsAtAmount(swapAmount, cappedPath, partner, clampedAmount));
                        recordSplitPair(cappedPath, partner, clampedAmount.amount);
                        break;
                    } catch {
                        continue;
                    }
                }
            }
        }

        // If no coarse (100, 75/25, or 50/50) split succeeded yet, pair >=50%-capable anchors with compatible
        // shallower candidates so refinementRatios can evaluate asymmetric splits (e.g. 60/40, 70/30, 80/20, 90/10).
        if (splitPaths.length === 0 && (quotePaths75.length > 0 || quotePaths50.length > 0)) {
            const anchors = quotePaths75.length > 0 ? quotePaths75 : quotePaths50;
            for (const anchor of anchors.slice(0, 2)) {
                for (const candidate of [...quotePaths25, ...paths]) {
                    if (!this.canSplitPaths(candidate, anchor)) {
                        continue;
                    }
                    recordSplitPair(candidate, anchor);
                }
            }
        }

        // Local split refinement: evaluate finer split ratios using the unmutated PathLocal pairs
        if (splitCandidatePairs.length > 0) {
            const refinementRatios = [0.1, 0.15, 0.2, 0.3, 0.35, 0.4, 0.6, 0.65, 0.7, 0.8, 0.85, 0.9];
            for (const { pathUp: pathUpLocal, pathDown: pathDownLocal, maxAmountUp } of splitCandidatePairs) {
                for (const ratio of refinementRatios) {
                    const refinedAmountUp = swapAmount.mulDownFixed(parseEther(String(ratio)));
                    if (maxAmountUp !== undefined && refinedAmountUp.amount >= maxAmountUp) {
                        continue;
                    }
                    try {
                        splitPaths.push(
                            this.splitPathsAtAmount(swapAmount, pathUpLocal, pathDownLocal, refinedAmountUp),
                        );
                    } catch {
                        continue;
                    }
                }
            }
        }

        if (splitPaths.length === 0) {
            const multiPathSplit = this.tryMultiPathCapacitySplit(paths, swapKind, swapAmount, 4);
            if (multiPathSplit) {
                return multiPathSplit;
            }
            // console.log('No valid paths found');
            return null;
        }

        // Find the split path that yields the best result (i.e. maxAmountOut on GivenIn, minAmountIn on GivenOut)
        let bestSplitPaths = this.selectBestSplitCandidate(splitPaths, swapKind);

        // Anti-dust / minimum split hurdle guard: prefer the 100% single path when a 2-path split only improves
        // the quote by fixed-point rounding dust (< 2 wei) or less than the configured minSplitBenefitBps hurdle.
        if (bestSplitPaths.length > 1 && quotePaths100.length > 0) {
            const singleBest = [quotePaths100[0]];
            if (swapKind === SwapKind.GivenIn) {
                const singleOut = singleBest[0].outputAmount.amount;
                const splitOut = bestSplitPaths.reduce((acc, p) => acc + p.outputAmount.amount, 0n);
                const minGain = max([2n, (singleOut * minSplitBenefitBps) / 10_000n]);
                if (splitOut <= singleOut || splitOut - singleOut < minGain) {
                    bestSplitPaths = singleBest;
                }
            } else {
                const singleIn = singleBest[0].inputAmount.amount;
                const splitIn = bestSplitPaths.reduce((acc, p) => acc + p.inputAmount.amount, 0n);
                const minSaving = max([2n, (singleIn * minSplitBenefitBps) / 10_000n]);
                if (singleIn <= splitIn || singleIn - splitIn < minSaving) {
                    bestSplitPaths = singleBest;
                }
            }
        }

        return bestSplitPaths;
    }

    private selectBestSplitCandidate(splitPaths: PathWithAmount[][], swapKind: SwapKind): PathWithAmount[] {
        if (swapKind === SwapKind.GivenIn) {
            const splitPathsAmountsOut = splitPaths.map((paths) =>
                paths.map((path) => path.outputAmount.amount).reduce((acc, amountOut) => acc + amountOut, 0n),
            );
            const maxAmountOutIndex = splitPathsAmountsOut.indexOf(max(splitPathsAmountsOut));
            return splitPaths[maxAmountOutIndex];
        }
        const splitPathsAmountsIn = splitPaths.map((paths) =>
            paths.map((path) => path.inputAmount.amount).reduce((acc, amountIn) => acc + amountIn, 0n),
        );
        const minAmountInIndex = splitPathsAmountsIn.indexOf(min(splitPathsAmountsIn));
        return splitPaths[minAmountInIndex];
    }

    private getBufferConstrainedMaxSwapAmount(
        path: PathLocal,
        swapKind: SwapKind,
        maxSwapAmount: bigint,
    ): bigint | null {
        if (!path.isBuffer.some(Boolean)) {
            return null;
        }
        let bestLimit: bigint | null = null;

        if (swapKind === SwapKind.GivenIn) {
            for (let k = 0; k < path.pools.length; k++) {
                if (!path.isBuffer[k]) continue;
                let limit = path.pools[k].getLimitAmountSwap(path.tokens[k], path.tokens[k + 1], SwapKind.GivenIn);
                if (limit <= 0n) return null;
                let valid = true;
                for (let i = k - 1; i >= 0; i--) {
                    try {
                        limit = path.pools[i].swapGivenOut(
                            path.tokens[i],
                            path.tokens[i + 1],
                            TokenAmount.fromRawAmount(path.tokens[i + 1], limit),
                        ).amount;
                    } catch {
                        valid = false;
                        break;
                    }
                }
                if (valid && limit > 0n && (bestLimit === null || limit < bestLimit)) {
                    bestLimit = limit;
                }
            }
        } else {
            for (let k = 0; k < path.pools.length; k++) {
                if (!path.isBuffer[k]) continue;
                let limit = path.pools[k].getLimitAmountSwap(path.tokens[k], path.tokens[k + 1], SwapKind.GivenOut);
                if (limit <= 0n) return null;
                let valid = true;
                for (let i = k + 1; i < path.pools.length; i++) {
                    try {
                        limit = path.pools[i].swapGivenIn(
                            path.tokens[i],
                            path.tokens[i + 1],
                            TokenAmount.fromRawAmount(path.tokens[i], limit),
                        ).amount;
                    } catch {
                        valid = false;
                        break;
                    }
                }
                if (valid && limit > 0n && (bestLimit === null || limit < bestLimit)) {
                    bestLimit = limit;
                }
            }
        }

        if (bestLimit === null || bestLimit <= 0n || bestLimit >= maxSwapAmount) {
            return null;
        }

        // Verify that forward (GivenIn) / backward (GivenOut) path evaluation at bestLimit does not
        // overshoot any buffer step limit due to multi-hop swapGivenOut/swapGivenIn rounding.
        const swapToken = swapKind === SwapKind.GivenIn ? path.tokens[0] : path.tokens[path.tokens.length - 1];
        let candidateLimit = bestLimit;
        for (let attempt = 0; attempt < 4 && candidateLimit > 0n; attempt++) {
            try {
                const probe = new PathWithAmount(
                    path.tokens,
                    path.pools,
                    path.isBuffer,
                    TokenAmount.fromRawAmount(swapToken, candidateLimit),
                );
                if (probe.swapStepsExceedingBufferCapacity === 0) {
                    return candidateLimit;
                }
                let nextLimit = candidateLimit - 1n;
                for (let k = 0; k < path.pools.length; k++) {
                    if (!path.isBuffer[k]) continue;
                    const stepLimit = path.pools[k].getLimitAmountSwap(path.tokens[k], path.tokens[k + 1], swapKind);
                    const stepActual =
                        swapKind === SwapKind.GivenIn ? probe.amounts[k].amount : probe.amounts[k + 1].amount;
                    if (stepActual > stepLimit && stepActual > 0n) {
                        const scaled = (candidateLimit * stepLimit) / stepActual;
                        const adjusted = scaled < candidateLimit ? scaled : candidateLimit - 1n;
                        if (adjusted < nextLimit) {
                            nextLimit = adjusted;
                        }
                    }
                }
                candidateLimit = nextLimit;
            } catch {
                return null;
            }
        }
        return null;
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
        return this.splitPathsAtAmount(swapAmount, pathA, pathB, pathA.swapAmount);
    }

    private splitPathsAtAmount(swapAmount: TokenAmount, pathA: PathLocal, pathB: PathLocal, swapAmountUp: TokenAmount) {
        const swapAmountDown = swapAmount.sub(swapAmountUp);
        if (swapAmountUp.amount <= 0n || swapAmountDown.amount <= 0n) {
            throw new Error('Split path amount must be positive');
        }

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

        const calcUp = pathUp.swapKind === SwapKind.GivenIn ? pathUp.outputAmount : pathUp.inputAmount;
        const calcDown = pathDown.swapKind === SwapKind.GivenIn ? pathDown.outputAmount : pathDown.inputAmount;
        if (calcUp.amount <= 0n || calcDown.amount <= 0n) {
            throw new Error('Split path returned zero amount');
        }

        // Restore unmutated pool references so downstream consumers (e.g. priceImpact probe quoting)
        // observe the pre-swap pool state, matching single-path quotes.
        (pathUp as { pools: BasePool[] }).pools = pathA.pools;
        (pathDown as { pools: BasePool[] }).pools = pathB.pools;

        return [pathUp, pathDown];
    }

    /**
     * Capacity-rescue fallback invoked strictly when all 1-path and 2-path splits fail (`splitPaths.length === 0`).
     * Greedily packs up to `maxLegs` mutually pool-disjoint paths (accounting for shared `BufferPool` consumption
     * statefully) and evaluates both proportional-to-capacity and best-first allocations summing to exact `swapAmount`.
     */
    private tryMultiPathCapacitySplit(
        paths: PathLocal[],
        swapKind: SwapKind,
        swapAmount: TokenAmount,
        maxLegs = 4,
    ): PathWithAmount[] | null {
        if (paths.length < 2 || swapAmount.amount <= 0n || maxLegs < 2) {
            return null;
        }

        const swapToken = swapAmount.token;
        const ranked: Array<{ path: PathLocal; initialCap: bigint; swapRef: bigint; calcRef: bigint }> = [];

        for (const path of paths) {
            const identityPools = new Map(path.pools.map((pool) => [pool.id, pool]));
            const initialCap = this.getPathMaxSafeAmount(path, identityPools, swapKind, swapAmount.amount);
            if (initialCap === null || initialCap <= 0n) {
                continue;
            }

            let quote: PathWithAmount | null = null;
            const halfCap = initialCap / 2n;
            for (const probeAmt of halfCap > 0n ? [halfCap, initialCap] : [initialCap]) {
                try {
                    const candidateQuote = new PathWithAmount(
                        path.tokens,
                        path.pools,
                        path.isBuffer,
                        TokenAmount.fromRawAmount(swapToken, probeAmt),
                    );
                    if (candidateQuote.swapStepsExceedingBufferCapacity === 0) {
                        quote = candidateQuote;
                        break;
                    }
                } catch {
                    continue;
                }
            }
            if (!quote) {
                continue;
            }

            const calcRef = swapKind === SwapKind.GivenIn ? quote.outputAmount.amount : quote.inputAmount.amount;
            if (calcRef <= 0n) {
                continue;
            }
            ranked.push({
                path,
                initialCap,
                swapRef: quote.swapAmount.amount,
                calcRef,
            });
        }

        if (ranked.length < 2) {
            return null;
        }

        ranked.sort((a, b) => {
            if (swapKind === SwapKind.GivenIn) {
                // Maximize output / input => compare b.calcRef * a.swapRef vs a.calcRef * b.swapRef
                const lhs = b.calcRef * a.swapRef;
                const rhs = a.calcRef * b.swapRef;
                return lhs > rhs ? 1 : lhs < rhs ? -1 : 0;
            }
            // Minimize input / output => compare a.calcRef * b.swapRef vs b.calcRef * a.swapRef
            const lhs = a.calcRef * b.swapRef;
            const rhs = b.calcRef * a.swapRef;
            return lhs > rhs ? 1 : lhs < rhs ? -1 : 0;
        });

        const validSplits: PathWithAmount[][] = [];
        const maxAnchorStarts = Math.min(4, ranked.length);

        for (let startIdx = 0; startIdx < maxAnchorStarts; startIdx++) {
            const order = [startIdx];
            for (let idx = 0; idx < ranked.length; idx++) {
                if (idx !== startIdx) {
                    order.push(idx);
                }
            }

            const simPools = new Map<string, BasePool>();
            const selected: Array<{ path: PathLocal; cap: bigint }> = [];
            let runningCap = 0n;

            for (const idx of order) {
                if (selected.length >= maxLegs) {
                    break;
                }
                const cand = ranked[idx];
                if (!selected.every((s) => this.canSplitPaths(s.path, cand.path))) {
                    continue;
                }

                for (const pool of cand.path.pools) {
                    if (!simPools.has(pool.id)) {
                        simPools.set(pool.id, pool.copy());
                    }
                }

                const cap = this.getPathMaxSafeAmount(cand.path, simPools, swapKind, swapAmount.amount);
                if (cap === null || cap <= 0n) {
                    continue;
                }

                selected.push({ path: cand.path, cap });
                runningCap += cap;

                if (runningCap >= swapAmount.amount) {
                    break;
                }

                // Deduct shared BufferPool capacity on simPools before sizing subsequent legs
                try {
                    const mappedSimPools = cand.path.pools.map((pool) => simPools.get(pool.id)!) as BasePool[];
                    new PathWithAmount(
                        cand.path.tokens,
                        mappedSimPools,
                        cand.path.isBuffer,
                        TokenAmount.fromRawAmount(swapToken, cap),
                        true,
                    );
                } catch {
                    // Safe capacity already validated; ignore if non-critical
                }
            }

            if (selected.length < 2 || runningCap < swapAmount.amount) {
                continue;
            }

            const selectedPaths = selected.map((s) => s.path);

            // Allocation Strategy A: Proportional to each leg's capacity (stays away from 30% max-ratio slippage wall)
            const allocProp = selected.map((s) => (swapAmount.amount * s.cap) / runningCap);
            let remProp = swapAmount.amount - allocProp.reduce((acc, v) => acc + v, 0n);
            for (let i = 0; i < selected.length && remProp > 0n; i++) {
                const headroom = selected[i].cap - allocProp[i];
                if (headroom > 0n) {
                    const add = remProp < headroom ? remProp : headroom;
                    allocProp[i] += add;
                    remProp -= add;
                }
            }

            // Allocation Strategy B: Best-first greedy fill up to capacity (optimal when top legs are flat Stable/Buffer paths)
            const allocGreedy = new Array<bigint>(selected.length).fill(0n);
            let remGreedy = swapAmount.amount;
            for (let i = 0; i < selected.length - 1; i++) {
                const maxForLeg = remGreedy - BigInt(selected.length - 1 - i);
                if (maxForLeg <= 0n) {
                    break;
                }
                const take = selected[i].cap < maxForLeg ? selected[i].cap : maxForLeg;
                allocGreedy[i] = take;
                remGreedy -= take;
            }
            allocGreedy[selected.length - 1] = remGreedy;

            for (const alloc of [allocProp, allocGreedy]) {
                if (alloc.reduce((acc, v) => acc + v, 0n) !== swapAmount.amount) {
                    continue;
                }
                try {
                    validSplits.push(this.executeMultiPathSplit(selectedPaths, alloc, swapToken));
                } catch {
                    continue;
                }
            }
        }

        if (validSplits.length === 0) {
            return null;
        }

        return this.selectBestSplitCandidate(validSplits, swapKind);
    }

    private getPathMaxSafeAmount(
        path: PathLocal,
        poolsById: Map<string, BasePool>,
        swapKind: SwapKind,
        maxTarget: bigint,
    ): bigint | null {
        const rawLimit = this.getPathLimitAmountWithPools(path, poolsById, swapKind);
        if (rawLimit <= 0n) {
            return null;
        }

        const cappedLimit = rawLimit < maxTarget ? rawLimit : maxTarget;
        const swapToken = swapKind === SwapKind.GivenIn ? path.tokens[0] : path.tokens[path.tokens.length - 1];
        const mappedPools = path.pools.map((pool) => poolsById.get(pool.id) ?? pool);

        for (const bps of [10_000n, 9_999n, 9_990n, 9_950n, 9_900n]) {
            const candidateAmt = (cappedLimit * bps) / 10_000n;
            if (candidateAmt <= 0n) {
                continue;
            }
            try {
                const probe = new PathWithAmount(
                    path.tokens,
                    mappedPools,
                    path.isBuffer,
                    TokenAmount.fromRawAmount(swapToken, candidateAmt),
                    false,
                );
                if (probe.swapStepsExceedingBufferCapacity > 0) {
                    continue;
                }
                const calculated = swapKind === SwapKind.GivenIn ? probe.outputAmount : probe.inputAmount;
                if (calculated.amount > 0n) {
                    return candidateAmt;
                }
            } catch {
                continue;
            }
        }

        return null;
    }

    private getPathLimitAmountWithPools(path: PathLocal, poolsById: Map<string, BasePool>, swapKind: SwapKind): bigint {
        const pools = path.pools.map((pool) => poolsById.get(pool.id) ?? pool);
        const lastIdx = pools.length - 1;

        if (swapKind === SwapKind.GivenIn) {
            let limit = pools[lastIdx].getLimitAmountSwap(
                path.tokens[lastIdx],
                path.tokens[lastIdx + 1],
                SwapKind.GivenIn,
            );
            for (let i = lastIdx - 1; i >= 0; i--) {
                if (limit <= 0n) {
                    return 0n;
                }
                const poolLimitExactIn = pools[i].getLimitAmountSwap(
                    path.tokens[i],
                    path.tokens[i + 1],
                    SwapKind.GivenIn,
                );
                const poolLimitExactOut = pools[i].getLimitAmountSwap(
                    path.tokens[i],
                    path.tokens[i + 1],
                    SwapKind.GivenOut,
                );
                if (poolLimitExactOut <= limit) {
                    limit = poolLimitExactIn;
                } else {
                    try {
                        const pulled = pools[i].swapGivenOut(
                            path.tokens[i],
                            path.tokens[i + 1],
                            TokenAmount.fromRawAmount(path.tokens[i + 1], limit),
                        ).amount;
                        limit = pulled > poolLimitExactIn ? poolLimitExactIn : pulled;
                    } catch {
                        limit = poolLimitExactOut > 0n ? (poolLimitExactIn * limit) / poolLimitExactOut : 0n;
                    }
                }
            }
            return limit;
        }

        let limit = pools[0].getLimitAmountSwap(path.tokens[0], path.tokens[1], SwapKind.GivenOut);
        for (let i = 1; i <= lastIdx; i++) {
            if (limit <= 0n) {
                return 0n;
            }
            const poolLimitExactIn = pools[i].getLimitAmountSwap(path.tokens[i], path.tokens[i + 1], SwapKind.GivenIn);
            const poolLimitExactOut = pools[i].getLimitAmountSwap(
                path.tokens[i],
                path.tokens[i + 1],
                SwapKind.GivenOut,
            );
            if (poolLimitExactIn <= limit) {
                limit = poolLimitExactOut;
            } else {
                try {
                    const pushed = pools[i].swapGivenIn(
                        path.tokens[i],
                        path.tokens[i + 1],
                        TokenAmount.fromRawAmount(path.tokens[i], limit),
                    ).amount;
                    limit = pushed > poolLimitExactOut ? poolLimitExactOut : pushed;
                } catch {
                    limit = poolLimitExactIn > 0n ? (poolLimitExactOut * limit) / poolLimitExactIn : 0n;
                }
            }
        }
        return limit;
    }

    private executeMultiPathSplit(paths: PathLocal[], amounts: bigint[], swapToken: Token): PathWithAmount[] {
        if (paths.length !== amounts.length || paths.length === 0) {
            throw new Error('Invalid multi-path split inputs');
        }
        if (amounts.some((amt) => amt <= 0n)) {
            throw new Error('Split path amount must be positive');
        }

        const uniquePools = [...new Map(paths.flatMap((p) => p.pools).map((pool) => [pool.id, pool])).values()];
        const poolsCopyById = new Map(uniquePools.map((pool) => [pool.id, pool.copy()]));

        const result: PathWithAmount[] = [];
        for (let i = 0; i < paths.length; i++) {
            const path = paths[i];
            const legPools = path.pools.map((pool) => poolsCopyById.get(pool.id)!) as BasePool[];
            const quotedLeg = new PathWithAmount(
                path.tokens,
                legPools,
                path.isBuffer,
                TokenAmount.fromRawAmount(swapToken, amounts[i]),
                true,
            );
            if (quotedLeg.swapStepsExceedingBufferCapacity > 0) {
                throw new Error('Split path exceeds buffer capacity');
            }
            const calculated = quotedLeg.swapKind === SwapKind.GivenIn ? quotedLeg.outputAmount : quotedLeg.inputAmount;
            if (calculated.amount <= 0n) {
                throw new Error('Split path returned zero amount');
            }
            (quotedLeg as { pools: BasePool[] }).pools = path.pools;
            result.push(quotedLeg);
        }

        return result;
    }
}
