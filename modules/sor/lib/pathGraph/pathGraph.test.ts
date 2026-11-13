import { SwapKind, Token, TokenAmount } from '@frontier-fi/maths';
import { PathGraph } from './pathGraph';
import { BasePool } from '../basePool';
import { describe, test, expect, beforeEach } from 'vitest';

const baseConfig = {
    maxDepth: 6,
    maxDepthFallback: 5,
    maxQueue: 1_000_000,
    maxTokenPaths: 50,
    maxBuffersInPath: 5,
    maxCandidatesPerTokenPath: 20,
    minSwapAmountRatio: 0.5,
};

function createMockPool(id: string, tokens: Token[], opts: Partial<BasePool> = {}): BasePool {
    return {
        id,
        address: id,
        poolType: opts.poolType ?? 'Weighted',
        tokens: tokens.map((t) => ({ token: t })),
        getNormalizedLiquidity: opts.getNormalizedLiquidity ?? (() => 100n),
        getLimitAmountSwap: opts.getLimitAmountSwap ?? (() => 1_000_000n),
        swapGivenOut: opts.swapGivenOut ?? ((_in: Token, _out: Token, amt: TokenAmount) => amt),
        ...opts,
    } as unknown as BasePool;
}

describe('PathGraph search algorithms', () => {
    const tokenA = new Token(1, '0xa', 18);
    const tokenB = new Token(1, '0xb', 18);
    const tokenC = new Token(1, '0xc', 18);
    const tokenD = new Token(1, '0xd', 18);

    let pools: BasePool[];
    let graph: PathGraph;

    beforeEach(() => {
        pools = [
            createMockPool('0xp1', [tokenA, tokenB]),
            createMockPool('0xp2', [tokenB, tokenC]),
            createMockPool('0xp3', [tokenC, tokenD]),
            createMockPool('0xp4', [tokenA, tokenD], { poolType: 'Buffer' }),
        ];
        graph = new PathGraph();
        graph.buildGraph({
            pools,
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });
    });

    test('addEdge throws error for invalid vertices', () => {
        const g = new PathGraph();
        const orphanToken = new Token(1, '0xorphan', 18);

        g.buildGraph({
            pools: [createMockPool('p1', [tokenA, tokenB])],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const pathSegment = {
            pool: createMockPool('test', [tokenA, tokenB]),
            tokenIn: tokenA,
            tokenOut: orphanToken,
            normalizedLiquidity: 100n,
            isBuffer: false,
            limitUSD: undefined,
        };

        expect(() => {
            g['addEdge']({ pathSegment, maxPathSegmentsPerTokenPair: 2 });
        }).toThrow('Attempting to add invalid edge');
    });

    test('finds direct path', () => {
        const paths = graph['findAllValidTokenPaths']({
            tokenIn: tokenA.address,
            tokenOut: tokenB.address,
            config: { ...baseConfig },
        });

        expect(paths).toContainEqual([tokenA.address, tokenB.address]);
    });

    test('avoids revisiting tokens (no cycles)', () => {
        // path A -> B -> A -> B should not appear
        const paths = graph['findAllValidTokenPaths']({
            tokenIn: tokenA.address,
            tokenOut: tokenC.address,
            config: { ...baseConfig },
        });

        for (const path of paths) {
            const visited = new Set(path);
            expect(visited.size).toBe(path.length); // ensures no duplicate token
        }
    });

    test('respects maxDepth limit', () => {
        const paths = graph['findAllValidTokenPaths']({
            tokenIn: tokenA.address,
            tokenOut: tokenD.address,
            config: { ...baseConfig, maxDepth: 2, maxDepthFallback: 2 },
        });

        // Only A -> D (buffer pool) should be valid, not A -> B -> C -> D
        expect(paths).toContainEqual([tokenA.address, tokenD.address]);
        expect(paths).not.toContainEqual([tokenA.address, tokenB.address, tokenC.address, tokenD.address]);
    });

    test('algorithm explores longer paths in queue before finding shorter optimal ones', () => {
        // This test demonstrates the dual-phase maxDepth behavior:
        // Phase 1: Uses maxDepthFallback while results.length === 0
        // Phase 2: Switches to maxDepth once results.length > 0
        //
        // This can cause issues where you need maxDepth much higher than expected
        // to find all paths, especially when a short path is found first

        const g = new PathGraph();
        const tokenE = new Token(1, '0xe', 18);
        const tokenF = new Token(1, '0xf', 18);
        const tokenG = new Token(1, '0xg', 18);

        // Create a graph where:
        // - A short direct path exists: A -> B -> D (3 nodes)
        // - A longer valuable path exists: A -> E -> F -> G -> D (5 nodes)
        const localPools = [
            // Short path (found first in BFS, triggers phase switch)
            createMockPool('pAB', [tokenA, tokenB], { getNormalizedLiquidity: () => 100n }),
            createMockPool('pBD', [tokenB, tokenD], { getNormalizedLiquidity: () => 100n }),

            // Longer path (needs to be explored after short path is found)
            createMockPool('pAE', [tokenA, tokenE], { getNormalizedLiquidity: () => 50n }),
            createMockPool('pEF', [tokenE, tokenF], { getNormalizedLiquidity: () => 50n }),
            createMockPool('pFG', [tokenF, tokenG], { getNormalizedLiquidity: () => 50n }),
            createMockPool('pGD', [tokenG, tokenD], { getNormalizedLiquidity: () => 50n }),
        ];

        g.buildGraph({
            pools: localPools,
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        // Scenario 1: maxDepth=3, maxDepthFallback=5
        // - Short path (3 nodes) will be found using maxDepthFallback=5
        // - Once found, switches to maxDepth=3
        // - Longer path (5 nodes) gets cut off because 5 > 3
        const pathsRestrictive = g['findAllValidTokenPaths']({
            tokenIn: tokenA.address,
            tokenOut: tokenD.address,
            config: { ...baseConfig, maxDepth: 3, maxDepthFallback: 5 },
        });
        expect(pathsRestrictive.length).toBe(1); // Only short path found
        expect(pathsRestrictive).toContainEqual([tokenA.address, tokenB.address, tokenD.address]);

        // Scenario 2: maxDepth=5, maxDepthFallback=5
        // - Both paths can be found because maxDepth doesn't restrict after switch
        const pathsPermissive = g['findAllValidTokenPaths']({
            tokenIn: tokenA.address,
            tokenOut: tokenD.address,
            config: { ...baseConfig, maxDepth: 5, maxDepthFallback: 5 },
        });
        expect(pathsPermissive.length).toBe(2); // Both paths found
        expect(pathsPermissive).toContainEqual([tokenA.address, tokenB.address, tokenD.address]);
        expect(pathsPermissive).toContainEqual([
            tokenA.address,
            tokenE.address,
            tokenF.address,
            tokenG.address,
            tokenD.address,
        ]);

        // This demonstrates why you might need maxDepth=9 to find a 5-node path:
        // If shorter paths are found first, they trigger the phase switch,
        // and maxDepth must be high enough to continue exploring longer paths
    });

    test('expandTokenPathWithRanks expands a simple path', () => {
        const edgesAB = (graph as any).edges.get(tokenA.address).get(tokenB.address);
        const edgesBC = (graph as any).edges.get(tokenB.address).get(tokenC.address);

        const result = graph['expandTokenPathWithRanks']({
            pathSegmentsPerTokenPair: [edgesAB, edgesBC],
            ranks: [0, 0],
        });

        expect(result.length).toBe(2);
        expect(result[0].pool.id).toBe('0xp1');
        expect(result[1].pool.id).toBe('0xp2');
    });

    test('findAllValidTokenPaths traversal order is breadth-first', () => {
        const g = new PathGraph();
        const localPools = [
            createMockPool('pAB', [tokenA, tokenB]),
            createMockPool('pAC', [tokenA, tokenC]),
            createMockPool('pBD', [tokenB, tokenD]),
            createMockPool('pCD', [tokenC, tokenD]),
        ];
        g.buildGraph({
            pools: localPools,
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const paths = g['findAllValidTokenPaths']({
            tokenIn: tokenA.address,
            tokenOut: tokenD.address,
            config: { ...baseConfig },
        });

        // Expect BFS-like order
        expect(paths[0]).toEqual([tokenA.address, tokenB.address, tokenD.address]);
        expect(paths[1]).toEqual([tokenA.address, tokenC.address, tokenD.address]);
    });

    test('isValidPath rejects paths that reuse the same pool within a single path', () => {
        const g = new PathGraph();
        const tri = createMockPool('pTri', [tokenA, tokenB, tokenC]);
        g.buildGraph({
            pools: [tri],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const paths = g.getCandidatePaths({
            tokenIn: tokenA,
            tokenOut: tokenC,
            swapAmount: TokenAmount.fromRawAmount(tokenA, 1_000n),
            swapKind: SwapKind.GivenIn,
            graphTraversalConfig: { ...baseConfig },
        });

        let foundPathWithReusedPool = false;
        for (const path of paths) {
            const poolIds = path.pools.map((p) => p.id);
            if (new Set(poolIds).size !== poolIds.length) {
                foundPathWithReusedPool = true;
                break;
            }
        }

        expect(foundPathWithReusedPool).toBe(false);
    });

    test('getCandidatePaths respects poolIdsToInclude whitelist (filters mixed paths)', () => {
        const g = new PathGraph();
        const p1 = createMockPool('p1', [tokenA, tokenB]);
        const p2 = createMockPool('p2', [tokenB, tokenC]);
        g.buildGraph({
            pools: [p1, p2],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const paths = g.getCandidatePaths({
            tokenIn: tokenA,
            tokenOut: tokenC,
            swapAmount: TokenAmount.fromRawAmount(tokenA, 1_000n),
            swapKind: SwapKind.GivenIn,
            graphTraversalConfig: {
                ...baseConfig,
                poolIdsToInclude: ['p2'], // p1 not allowed
            },
        });

        expect(paths.length).toBe(0);
    });

    test('maxBuffersInPath is enforced', () => {
        const g = new PathGraph();
        const buf1 = createMockPool('buf1', [tokenA, tokenB], { poolType: 'Buffer' });
        const buf2 = createMockPool('buf2', [tokenB, tokenC], { poolType: 'Buffer' });
        g.buildGraph({
            pools: [buf1, buf2],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const paths = g.getCandidatePaths({
            tokenIn: tokenA,
            tokenOut: tokenC,
            swapAmount: TokenAmount.fromRawAmount(tokenA, 1_000n),
            swapKind: SwapKind.GivenIn,
            graphTraversalConfig: {
                ...baseConfig,
                maxBuffersInPath: 1, // path has 2 buffers -> invalid
            },
        });

        expect(paths.length).toBe(0);
    });

    test('respects maxPathSegmentsPerTokenPair (keeps only top-K ranked edges for a pair)', () => {
        const g = new PathGraph();

        const pAB1 = createMockPool('pAB1', [tokenA, tokenB], { getNormalizedLiquidity: () => 300n });
        const pAB2 = createMockPool('pAB2', [tokenA, tokenB], { getNormalizedLiquidity: () => 200n });
        const pAB3 = createMockPool('pAB3', [tokenA, tokenB], { getNormalizedLiquidity: () => 100n });

        g.buildGraph({
            pools: [pAB1, pAB2, pAB3],
            enableAddRemoveLiquidityPaths: false,
            maxPathSegmentsPerTokenPair: 2,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const edges = (g as any).edges.get(tokenA.address).get(tokenB.address);
        expect(edges.length).toBe(2);
        expect(edges.map((e: any) => e.pool.id)).toEqual(['pAB1', 'pAB2']);
    });

    test('expandTokenPathWithRanks throws on invalid rank', () => {
        const edgesAB = (graph as any).edges.get(tokenA.address).get(tokenB.address);
        expect(() => {
            graph['expandTokenPathWithRanks']({
                pathSegmentsPerTokenPair: [edgesAB],
                ranks: [10], // rank 10 does not exist
            });
        }).toThrow('Missing rank on edge for segment');
    });

    test('minSwapAmountRatio quantization can yield zero threshold for tiny ratios', () => {
        const g = new PathGraph();
        const pAB = createMockPool('pAB', [tokenA, tokenB], {
            getLimitAmountSwap: () => 5n,
        });
        g.buildGraph({
            pools: [pAB],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const tinyRatio = 0.009; // floor(0.9)/100 = 0 => zero threshold with current logic
        const paths = g.getCandidatePaths({
            tokenIn: tokenA,
            tokenOut: tokenB,
            swapAmount: TokenAmount.fromRawAmount(tokenA, 100n),
            swapKind: SwapKind.GivenIn,
            graphTraversalConfig: { ...baseConfig, minSwapAmountRatio: tinyRatio },
        });

        expect(paths.length).toBeGreaterThan(0);
    });

    test('reuses a pool across selected paths', () => {
        const g = new PathGraph();
        const pAB = createMockPool('pAB', [tokenA, tokenB]);
        const pAC = createMockPool('pAC', [tokenA, tokenC]);
        const pShared = createMockPool('pShared', [tokenB, tokenC, tokenD]);

        g.buildGraph({
            pools: [pAB, pAC, pShared],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const paths = g.getCandidatePaths({
            tokenIn: tokenA,
            tokenOut: tokenD,
            swapAmount: TokenAmount.fromRawAmount(tokenA, 10_000n),
            swapKind: SwapKind.GivenIn,
            graphTraversalConfig: { ...baseConfig },
        });

        expect(paths.length).toBe(2);
    });

    test('enforces maxTokenPaths limit during token path discovery', () => {
        const g = new PathGraph();

        // Create a hub-and-spoke topology to generate many paths
        const hub = new Token(1, '0xhub', 18);
        const spokes = Array.from({ length: 10 }, (_, i) => new Token(1, `0xspoke${i}`, 18));
        const target = new Token(1, '0xtarget', 18);

        const hubPools = spokes.map((spoke, i) => createMockPool(`hub${i}`, [hub, spoke]));
        const spokePools = spokes.map((spoke, i) => createMockPool(`spoke${i}`, [spoke, target]));

        g.buildGraph({
            pools: [...hubPools, ...spokePools],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        // This should generate 10 possible token paths: hub -> spoke[i] -> target
        const paths = g['findAllValidTokenPaths']({
            tokenIn: hub.address,
            tokenOut: target.address,
            config: { ...baseConfig, maxTokenPaths: 5 }, // limit to 5
        });

        expect(paths.length).toBe(5); // Should be capped at maxTokenPaths
    });

    test('handles SwapKind.GivenOut correctly', () => {
        const g = new PathGraph();
        const pAB = createMockPool('pAB', [tokenA, tokenB], {
            getLimitAmountSwap: (tokenIn: Token, tokenOut: Token, swapKind: SwapKind) => {
                // Return different limits based on swap kind
                return swapKind === SwapKind.GivenOut ? 500n : 1000n;
            },
        });
        g.buildGraph({
            pools: [pAB],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const pathsGivenIn = g.getCandidatePaths({
            tokenIn: tokenA,
            tokenOut: tokenB,
            swapAmount: TokenAmount.fromRawAmount(tokenA, 1000n),
            swapKind: SwapKind.GivenIn,
            graphTraversalConfig: { ...baseConfig, minSwapAmountRatio: 0.8 }, // requires 800n
        });

        const pathsGivenOut = g.getCandidatePaths({
            tokenIn: tokenA,
            tokenOut: tokenB,
            swapAmount: TokenAmount.fromRawAmount(tokenB, 1000n),
            swapKind: SwapKind.GivenOut,
            graphTraversalConfig: { ...baseConfig, minSwapAmountRatio: 0.8 }, // requires 800n
        });

        expect(pathsGivenIn.length).toBe(1); // 1000n >= 800n threshold
        expect(pathsGivenOut.length).toBe(0); // 500n < 800n threshold
    });

    test('filters paths based on limit amount calculations', () => {
        const g = new PathGraph();

        const highLiquidityPool = createMockPool('highLiq', [tokenA, tokenB], {
            getNormalizedLiquidity: () => 1000n,
            getLimitAmountSwap: () => 2000n, // High limit
        });

        const lowLiquidityPool = createMockPool('lowLiq', [tokenA, tokenB], {
            getNormalizedLiquidity: () => 999n, // Slightly lower NL so it's ranked second
            getLimitAmountSwap: () => 100n, // Low limit
        });

        g.buildGraph({
            pools: [highLiquidityPool, lowLiquidityPool],
            enableAddRemoveLiquidityPaths: false,
            maxPathSegmentsPerTokenPair: 2,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const paths = g.getCandidatePaths({
            tokenIn: tokenA,
            tokenOut: tokenB,
            swapAmount: TokenAmount.fromRawAmount(tokenA, 1000n),
            swapKind: SwapKind.GivenIn,
            graphTraversalConfig: {
                ...baseConfig,
                minSwapAmountRatio: 0.15, // requires 150n minimum
                maxCandidatesPerTokenPath: 10,
            },
        });

        // Only the high liquidity pool should pass the limit filter
        expect(paths.length).toBe(1);
        expect(paths[0].pools[0].id as string).toBe('highLiq');
    });

    test('filters edges based on minLimitThresholdUSD', () => {
        graph = new PathGraph();

        const pool1 = createMockPool('p1', [tokenA, tokenB], {
            getLimitAmountSwap: () => 1000n * 10n ** 18n, // 1000 tokens
        });

        const tokenPrices = new Map<string, number>();
        tokenPrices.set(tokenA.address.toLowerCase(), 1.5);
        tokenPrices.set(tokenB.address.toLowerCase(), 1.0);

        // swapKind = GivenIn
        // A->B: priceToken=A, price=1.5, limitUSD=1500
        // B->A: priceToken=B, price=1.0, limitUSD=1000
        graph.buildGraph({
            pools: [pool1],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices,
            minLimitThresholdUSD: 1200,
        });

        // A->B should be created (1500 > 1200)
        const edgesAB = graph['edges'].get(tokenA.address)?.get(tokenB.address);
        expect(edgesAB?.length).toBe(1);
        expect(edgesAB && edgesAB[0].limitUSD).toBe(1500);

        // B->A should NOT be created (1000 < 1200)
        const edgesBA = graph['edges'].get(tokenB.address)?.get(tokenA.address);
        expect(edgesBA).toBeUndefined();
    });

    test('buildPathSegment sets limitUSD as undefined when tokenPrices is missing an entry', () => {
        const g = new PathGraph();

        const pAB = createMockPool('pAB', [tokenA, tokenB], {
            getLimitAmountSwap: () => 1000n * 10n ** 18n, // 1000 tokens
        });

        // Price map only has tokenA, missing tokenB
        const tokenPrices = new Map<string, number>();
        tokenPrices.set(tokenA.address.toLowerCase(), 2.0);

        g.buildGraph({
            pools: [pAB],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenOut, // for GivenOut, limitUSD uses tokenOut’s price (tokenB in this case)
            tokenPrices,
            minLimitThresholdUSD: 0,
        });

        // For GivenOut swap, priceToken = tokenOut = tokenB, but
        // we *did not* provide price for tokenB. So limitUSD should be undefined.
        const edges = (g as any).edges.get(tokenA.address).get(tokenB.address);
        expect(edges.length).toBe(1);
        expect(edges[0].limitUSD).toBeUndefined();
    });

    test('beam search considers bottleneck liquidity across path segments', () => {
        const g = new PathGraph();

        // Create a scenario to test beam search behavior
        const midToken = new Token(1, '0xmid', 18);

        // Path 1: A -> mid -> D (high first hop, low second hop)
        const highFirst = createMockPool('highFirst', [tokenA, midToken], {
            getNormalizedLiquidity: () => 1000n,
        });
        const lowSecond = createMockPool('lowSecond', [midToken, tokenD], {
            getNormalizedLiquidity: () => 200n,
        });

        // Path 2: A -> mid -> D (medium first hop, high second hop)
        const medFirst = createMockPool('medFirst', [tokenA, midToken], {
            getNormalizedLiquidity: () => 800n,
        });
        const highSecond = createMockPool('highSecond', [midToken, tokenD], {
            getNormalizedLiquidity: () => 900n,
        });

        g.buildGraph({
            pools: [highFirst, lowSecond, medFirst, highSecond],
            enableAddRemoveLiquidityPaths: false,
            maxPathSegmentsPerTokenPair: 2,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const paths = g.getCandidatePaths({
            tokenIn: tokenA,
            tokenOut: tokenD,
            swapAmount: TokenAmount.fromRawAmount(tokenA, 1000n),
            swapKind: SwapKind.GivenIn,
            graphTraversalConfig: {
                ...baseConfig,
                maxCandidatesPerTokenPath: 10,
                minSwapAmountRatio: 0.0,
            },
        });

        expect(paths.length).toBeGreaterThan(0);

        // Test that beam search generates multiple path combinations when available
        // The algorithm should explore different combinations of pools across segments
        const pathPools = paths.map((path) => path.pools.map((p) => p.id));

        // Should have at least one path (the algorithm always returns some result)
        expect(pathPools.length).toBeGreaterThanOrEqual(1);

        // Verify that valid pool combinations are created
        for (const poolIds of pathPools) {
            expect(poolIds.length).toBe(2); // Two-hop path
            expect(['highFirst', 'medFirst']).toContain(poolIds[0]);
            expect(['lowSecond', 'highSecond']).toContain(poolIds[1]);
        }
    });

    test('beam search maintains diversity across multiple good paths', () => {
        const g = new PathGraph();

        // Create multiple paths with similar quality to test diversity
        const mid1 = new Token(1, '0xmid1', 18);
        const mid2 = new Token(1, '0xmid2', 18);

        // Path 1: A -> mid1 -> D
        const path1_seg1 = createMockPool('p1s1', [tokenA, mid1], { getNormalizedLiquidity: () => 900n });
        const path1_seg2 = createMockPool('p1s2', [mid1, tokenD], { getNormalizedLiquidity: () => 850n });

        // Path 2: A -> mid2 -> D
        const path2_seg1 = createMockPool('p2s1', [tokenA, mid2], { getNormalizedLiquidity: () => 880n });
        const path2_seg2 = createMockPool('p2s2', [mid2, tokenD], { getNormalizedLiquidity: () => 870n });

        g.buildGraph({
            pools: [path1_seg1, path1_seg2, path2_seg1, path2_seg2],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const paths = g.getCandidatePaths({
            tokenIn: tokenA,
            tokenOut: tokenD,
            swapAmount: TokenAmount.fromRawAmount(tokenA, 1000n),
            swapKind: SwapKind.GivenIn,
            graphTraversalConfig: {
                ...baseConfig,
                maxCandidatesPerTokenPath: 5,
                minSwapAmountRatio: 0.0,
            },
        });

        // Should find both paths since they have similar quality
        expect(paths.length).toBe(2);

        const usedMidTokens = new Set(paths.map((path) => path.tokens[1].address));
        expect(usedMidTokens.size).toBe(2); // Should use both mid tokens for diversity
    });

    test('handles add/remove liquidity paths when enabled', () => {
        const g = new PathGraph();

        // Create a more realistic scenario for add/remove liquidity paths
        // When enabled, pools can act as intermediate "tokens" for routing
        const bptPool = createMockPool('0xbptpool', [tokenA, tokenB]);
        const regularPool = createMockPool('regular', [tokenB, tokenC]);

        g.buildGraph({
            pools: [bptPool, regularPool],
            enableAddRemoveLiquidityPaths: true,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const paths = g.getCandidatePaths({
            tokenIn: tokenA,
            tokenOut: tokenC,
            swapAmount: TokenAmount.fromRawAmount(tokenA, 1000n),
            swapKind: SwapKind.GivenIn,
            graphTraversalConfig: { ...baseConfig },
        });

        // Should find the regular path A -> B -> C
        expect(paths.length).toBeGreaterThan(0);

        // Verify we can route through the intermediate token
        const pathExists = paths.some(
            (path) =>
                path.tokens.length === 3 &&
                path.tokens[0].address === tokenA.address &&
                path.tokens[1].address === tokenB.address &&
                path.tokens[2].address === tokenC.address,
        );
        expect(pathExists).toBe(true);

        // When enableAddRemoveLiquidityPaths is true, the pool address should be added as a potential node
        const nodes = (g as any).nodes;
        expect(nodes.has('0xbptpool')).toBe(true);
    });

    test('returns empty array when no edges exist for input token', () => {
        const g = new PathGraph();
        const orphanToken = new Token(1, '0xorphan', 18);

        g.buildGraph({
            pools: [createMockPool('p1', [tokenA, tokenB])],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const paths = g.getCandidatePaths({
            tokenIn: orphanToken, // Not connected to any pool
            tokenOut: tokenB,
            swapAmount: TokenAmount.fromRawAmount(orphanToken, 1000n),
            swapKind: SwapKind.GivenIn,
            graphTraversalConfig: { ...baseConfig },
        });

        expect(paths.length).toBe(0);
    });

    test('returns empty array when no edges exist for output token', () => {
        const g = new PathGraph();
        const orphanToken = new Token(1, '0xorphan', 18);

        g.buildGraph({
            pools: [createMockPool('p1', [tokenA, tokenB])],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const paths = g.getCandidatePaths({
            tokenIn: tokenA,
            tokenOut: orphanToken, // Not connected to any pool
            swapAmount: TokenAmount.fromRawAmount(tokenA, 1000n),
            swapKind: SwapKind.GivenIn,
            graphTraversalConfig: { ...baseConfig },
        });

        expect(paths.length).toBe(0);
    });

    test('handles pool swap failures gracefully during limit calculation', () => {
        const g = new PathGraph();

        const flakyPool = createMockPool('flaky', [tokenA, tokenB], {
            getLimitAmountSwap: () => {
                throw new Error('Pool swap failed');
            },
        });

        const goodPool = createMockPool('good', [tokenA, tokenB], {
            getLimitAmountSwap: () => 1000n,
        });

        g.buildGraph({
            pools: [flakyPool, goodPool],
            enableAddRemoveLiquidityPaths: false,
            maxPathSegmentsPerTokenPair: 2,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const paths = g.getCandidatePaths({
            tokenIn: tokenA,
            tokenOut: tokenB,
            swapAmount: TokenAmount.fromRawAmount(tokenA, 1000n),
            swapKind: SwapKind.GivenIn,
            graphTraversalConfig: {
                ...baseConfig,
                minSwapAmountRatio: 0.5, // requires 500n
            },
        });

        // Should only return the good pool path, flaky pool should be filtered out
        expect(paths.length).toBe(1);
        expect(paths[0].pools[0].id as string).toBe('good');
    });

    test('handles zero normalizedLiquidity pools correctly', () => {
        const g = new PathGraph();

        const zeroLiqPool = createMockPool('zeroLiq', [tokenA, tokenB], {
            getNormalizedLiquidity: () => 0n,
            getLimitAmountSwap: () => 0n,
        });

        g.buildGraph({
            pools: [zeroLiqPool],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const paths = g.getCandidatePaths({
            tokenIn: tokenA,
            tokenOut: tokenB,
            swapAmount: TokenAmount.fromRawAmount(tokenA, 1000n),
            swapKind: SwapKind.GivenIn,
            graphTraversalConfig: {
                ...baseConfig,
                minSwapAmountRatio: 0.1, // requires 100n
            },
        });

        expect(paths.length).toBe(0); // Should be filtered out due to insufficient limit
    });

    test('selectTopCandidatesPerTokenPath handles empty edge arrays', () => {
        const g = new PathGraph();
        g.buildGraph({
            pools: [createMockPool('p1', [tokenA, tokenB])],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        const edgesAB = (g as any).edges.get(tokenA.address).get(tokenB.address);
        const result = (g as any).selectTopCandidatesPerTokenPath(
            [edgesAB, []], // second segment has no edges
            5,
        );

        expect(result.length).toBe(0);
    });

    test('isValidPath correctly validates complex path constraints', () => {
        const g = new PathGraph();

        const bufferPool1 = createMockPool('buf1', [tokenA, tokenB], { poolType: 'Buffer' });
        const bufferPool2 = createMockPool('buf2', [tokenB, tokenC], { poolType: 'Buffer' });
        const bufferPool3 = createMockPool('buf3', [tokenC, tokenD], { poolType: 'Buffer' });

        g.buildGraph({
            pools: [bufferPool1, bufferPool2, bufferPool3],
            enableAddRemoveLiquidityPaths: false,
            swapKind: SwapKind.GivenIn,
            tokenPrices: new Map<string, number>(),
            minLimitThresholdUSD: 0,
        });

        // Create a path with 3 buffers
        const pathWith3Buffers = [
            {
                pool: bufferPool1,
                tokenIn: tokenA,
                tokenOut: tokenB,
                isBuffer: true,
                normalizedLiquidity: 100n,
                limitUSD: 1000,
            },
            {
                pool: bufferPool2,
                tokenIn: tokenB,
                tokenOut: tokenC,
                isBuffer: true,
                normalizedLiquidity: 100n,
                limitUSD: 1000,
            },
            {
                pool: bufferPool3,
                tokenIn: tokenC,
                tokenOut: tokenD,
                isBuffer: true,
                normalizedLiquidity: 100n,
                limitUSD: 1000,
            },
        ];

        const validResult = g['isValidPath']({
            path: pathWith3Buffers,
            config: { ...baseConfig, maxBuffersInPath: 5 },
            swapKind: SwapKind.GivenIn,
            minLimitThreshold: 0n,
        });

        const invalidResult = g['isValidPath']({
            path: pathWith3Buffers,
            config: { ...baseConfig, maxBuffersInPath: 2 },
            swapKind: SwapKind.GivenIn,
            minLimitThreshold: 0n,
        });

        expect(validResult).toBe(true);
        expect(invalidResult).toBe(false);
    });

    describe('performance-safety invariants', () => {
        const tokenA = new Token(1, '0xa', 18);
        const tokenB = new Token(1, '0xb', 18);
        const tokenC = new Token(1, '0xc', 18);

        test('edges are trimmed to top-K and kept in descending normalizedLiquidity order', () => {
            const g = new PathGraph();

            const pAB4 = createMockPool('pAB4', [tokenA, tokenB], { getNormalizedLiquidity: () => 400n });
            const pAB3 = createMockPool('pAB3', [tokenA, tokenB], { getNormalizedLiquidity: () => 300n });
            const pAB2 = createMockPool('pAB2', [tokenA, tokenB], { getNormalizedLiquidity: () => 200n });
            const pAB1 = createMockPool('pAB1', [tokenA, tokenB], { getNormalizedLiquidity: () => 100n });

            g.buildGraph({
                pools: [pAB1, pAB2, pAB3, pAB4],
                enableAddRemoveLiquidityPaths: false,
                maxPathSegmentsPerTokenPair: 3,
                swapKind: SwapKind.GivenIn,
                tokenPrices: new Map<string, number>(),
                minLimitThresholdUSD: 0,
            });

            const edges = (g as any).edges.get(tokenA.address).get(tokenB.address);
            const liqs = edges.map((e: any) => e.normalizedLiquidity);

            expect(edges.length).toBe(3);
            expect(liqs).toEqual([400n, 300n, 200n]); // strictly descending and top-3 kept
        });

        test('selectTopCandidatesPerTokenPath respects beamWidth cap', () => {
            const g = new PathGraph();

            const abPools = Array.from({ length: 5 }, (_, i) =>
                createMockPool(`pAB${i}`, [tokenA, tokenB], { getNormalizedLiquidity: () => BigInt(1000 - i) }),
            );
            const bcPools = Array.from({ length: 5 }, (_, i) =>
                createMockPool(`pBC${i}`, [tokenB, tokenC], { getNormalizedLiquidity: () => BigInt(1000 - i) }),
            );

            g.buildGraph({
                pools: [...abPools, ...bcPools],
                enableAddRemoveLiquidityPaths: false,
                maxPathSegmentsPerTokenPair: 5,
                swapKind: SwapKind.GivenIn,
                tokenPrices: new Map<string, number>(),
                minLimitThresholdUSD: 0,
            });

            const edgesAB = (g as any).edges.get(tokenA.address).get(tokenB.address);
            const edgesBC = (g as any).edges.get(tokenB.address).get(tokenC.address);

            const result = (g as any).selectTopCandidatesPerTokenPath(
                [edgesAB, edgesBC],
                3, // beamWidth
            );

            expect(result.length).toBeLessThanOrEqual(3);
        });

        test('getCandidatePaths respects maxCandidatesPerTokenPath when there is only a single token path', () => {
            const g = new PathGraph();

            const abPools = Array.from({ length: 6 }, (_, i) =>
                createMockPool(`pAB${i}`, [tokenA, tokenB], { getNormalizedLiquidity: () => BigInt(1000 - i) }),
            );
            const bcPools = Array.from({ length: 6 }, (_, i) =>
                createMockPool(`pBC${i}`, [tokenB, tokenC], { getNormalizedLiquidity: () => BigInt(1000 - i) }),
            );

            g.buildGraph({
                pools: [...abPools, ...bcPools],
                enableAddRemoveLiquidityPaths: false,
                maxPathSegmentsPerTokenPair: 6,
                swapKind: SwapKind.GivenIn,
                tokenPrices: new Map<string, number>(),
                minLimitThresholdUSD: 0,
            });

            const paths = g.getCandidatePaths({
                tokenIn: tokenA,
                tokenOut: tokenC,
                swapAmount: TokenAmount.fromRawAmount(tokenA, 1_000n),
                swapKind: SwapKind.GivenIn,
                graphTraversalConfig: {
                    ...baseConfig,
                    maxCandidatesPerTokenPath: 5,
                    minSwapAmountRatio: 0.0,
                },
            });

            expect(paths.length).toBeLessThanOrEqual(5);
        });

        test('selectTopCandidatesPerTokenPath computes non-zero bottleneck boundNL and ranks most liquid combinations first', () => {
            const g = new PathGraph();

            const pABHigh = createMockPool('pABHigh', [tokenA, tokenB], { getNormalizedLiquidity: () => 1000n });
            const pABLow = createMockPool('pABLow', [tokenA, tokenB], { getNormalizedLiquidity: () => 100n });
            const pBCHigh = createMockPool('pBCHigh', [tokenB, tokenC], { getNormalizedLiquidity: () => 900n });
            const pBCLow = createMockPool('pBCLow', [tokenB, tokenC], { getNormalizedLiquidity: () => 50n });

            g.buildGraph({
                pools: [pABHigh, pABLow, pBCHigh, pBCLow],
                enableAddRemoveLiquidityPaths: false,
                maxPathSegmentsPerTokenPair: 2,
                swapKind: SwapKind.GivenIn,
                tokenPrices: new Map<string, number>(),
                minLimitThresholdUSD: 0,
            });

            const edgesAB = (g as any).edges.get(tokenA.address).get(tokenB.address);
            const edgesBC = (g as any).edges.get(tokenB.address).get(tokenC.address);

            const top1 = (g as any).selectTopCandidatesPerTokenPath([edgesAB, edgesBC], 1);

            expect(top1).toHaveLength(1);
            // Best combination is [0, 0] (pABHigh=1000n + pBCHigh=900n -> bottleneck 900n), NOT [1, 1] (boundNL=0n)
            expect(top1[0].ranks).toEqual([0, 0]);
            expect(top1[0].boundNL).toBe(900n);
        });

        test('buildGraph does not allow zero-limit dead pools to evict live pools when tokenPrices is missing', () => {
            const g = new PathGraph();

            // A dead/paused pool or depleted buffer with stale high normalizedLiquidity (2000n) but 0n swap limit
            const deadHighNLPool = createMockPool('deadHighNL', [tokenA, tokenB], {
                getNormalizedLiquidity: () => 2000n,
                getLimitAmountSwap: () => 0n,
            });
            // A live pool with lower normalizedLiquidity (500n) and healthy swap limit (10000n)
            const livePool = createMockPool('livePool', [tokenA, tokenB], {
                getNormalizedLiquidity: () => 500n,
                getLimitAmountSwap: () => 10_000n,
            });

            // Even when tokenPrices is empty (e.g. unpriced Sepolia test tokens -> minLimitThresholdUSD = 0),
            // deadHighNLPool (limit = 0n) must not evict livePool when maxPathSegmentsPerTokenPair = 1
            g.buildGraph({
                pools: [deadHighNLPool, livePool],
                enableAddRemoveLiquidityPaths: false,
                maxPathSegmentsPerTokenPair: 1,
                swapKind: SwapKind.GivenIn,
                tokenPrices: new Map<string, number>(),
                minLimitThresholdUSD: 0,
            });

            const paths = g.getCandidatePaths({
                tokenIn: tokenA,
                tokenOut: tokenB,
                swapAmount: TokenAmount.fromRawAmount(tokenA, 1_000n),
                swapKind: SwapKind.GivenIn,
                graphTraversalConfig: { ...baseConfig },
            });

            expect(paths).toHaveLength(1);
            expect(paths[0].pools[0].id).toBe('livePool');
        });

        test('getCandidatePaths does not discard a valid multi-hop path when upstream swapGivenOut throws near the downstream pool limit boundary', () => {
            const g = new PathGraph();

            // Hop 1 (A -> B): supports up to 10,000 ExactIn and 9,900 ExactOut,
            // but its math throws a convergence error when queried via swapGivenOut above 9,500 (near its 9,900 asymptote)
            const poolAB = createMockPool('poolAB', [tokenA, tokenB], {
                getNormalizedLiquidity: () => 1000n,
                getLimitAmountSwap: (_tIn: Token, _tOut: Token, kind: SwapKind) =>
                    kind === SwapKind.GivenIn ? 10_000n * 10n ** 18n : 9_900n * 10n ** 18n,
                swapGivenOut: (tIn: Token, _tOut: Token, amountOut: TokenAmount) => {
                    if (amountOut.amount > 9_500n * 10n ** 18n) {
                        throw new Error('Newton-Raphson failed to converge near asymptotic pool limit');
                    }
                    return TokenAmount.fromRawAmount(tIn, amountOut.amount);
                },
            });

            // Hop 2 (B -> C): has a GivenIn limit of 9,800 (which is < poolAB's 9,900 ExactOut limit,
            // causing getLimitAmountSwapForPath to call poolAB.swapGivenOut(9,800) and trigger the boundary throw)
            const poolBC = createMockPool('poolBC', [tokenB, tokenC], {
                getNormalizedLiquidity: () => 1000n,
                getLimitAmountSwap: () => 9_800n * 10n ** 18n,
            });

            g.buildGraph({
                pools: [poolAB, poolBC],
                enableAddRemoveLiquidityPaths: false,
                swapKind: SwapKind.GivenIn,
                tokenPrices: new Map<string, number>(),
                minLimitThresholdUSD: 0,
            });

            // User only wants to swap 100 tokenA (minLimitThreshold = 50 tokenA), well within both pools' safe capacity
            const paths = g.getCandidatePaths({
                tokenIn: tokenA,
                tokenOut: tokenC,
                swapAmount: TokenAmount.fromRawAmount(tokenA, 100n * 10n ** 18n),
                swapKind: SwapKind.GivenIn,
                graphTraversalConfig: { ...baseConfig },
            });

            expect(paths).toHaveLength(1);
            expect(paths[0].pools.map((p) => p.id)).toEqual(['poolAB', 'poolBC']);
        });

        test('getCandidatePaths computes multi-hop SwapKind.GivenOut path limits in tokenOut units rather than tokenIn units (6-dec tokenIn -> 18-dec tokenOut)', () => {
            const g = new PathGraph();
            const usdc6 = new Token(1, '0xusdc', 6, 'USDC');
            const weth18 = new Token(1, '0xweth', 18, 'WETH');
            const dai18 = new Token(1, '0xdai', 18, 'DAI');

            // Hop 1 (USDC 6-dec -> WETH 18-dec): max 30,000 USDC in (3e10 raw), max 10 WETH out (10e18 raw)
            const poolUsdcWeth = createMockPool('poolUsdcWeth', [usdc6, weth18], {
                getNormalizedLiquidity: () => 1000n,
                getLimitAmountSwap: (_tIn: Token, _tOut: Token, kind: SwapKind) =>
                    kind === SwapKind.GivenIn ? 30_000n * 10n ** 6n : 10n * 10n ** 18n,
            });

            // Hop 2 (WETH 18-dec -> DAI 18-dec): max 50 WETH in (50e18 raw), max 100,000 DAI out (100,000e18 raw),
            // and 1 WETH in swaps to 2,000 DAI out (so 10 WETH from Hop 1 produces 20,000 DAI max output)
            const poolWethDai = createMockPool('poolWethDai', [weth18, dai18], {
                getNormalizedLiquidity: () => 1000n,
                getLimitAmountSwap: (_tIn: Token, _tOut: Token, kind: SwapKind) =>
                    kind === SwapKind.GivenIn ? 50n * 10n ** 18n : 100_000n * 10n ** 18n,
                swapGivenIn: (_tIn: Token, tOut: Token, amountIn: TokenAmount) =>
                    TokenAmount.fromRawAmount(tOut, amountIn.amount * 2_000n),
            });

            g.buildGraph({
                pools: [poolUsdcWeth, poolWethDai],
                enableAddRemoveLiquidityPaths: false,
                swapKind: SwapKind.GivenOut,
                tokenPrices: new Map<string, number>(),
                minLimitThresholdUSD: 0,
            });

            // 1. A GivenOut swap for 1,000 DAI (minLimitThreshold = 500e18 DAI) is well within the 20,000 DAI path limit
            const validPaths = g.getCandidatePaths({
                tokenIn: usdc6,
                tokenOut: dai18,
                swapAmount: TokenAmount.fromRawAmount(dai18, 1_000n * 10n ** 18n),
                swapKind: SwapKind.GivenOut,
                graphTraversalConfig: { ...baseConfig, minSwapAmountRatio: 0.5 },
            });

            expect(validPaths).toHaveLength(1);
            expect(validPaths[0].pools.map((p) => p.id)).toEqual(['poolUsdcWeth', 'poolWethDai']);

            // 2. A GivenOut swap for 50,000 DAI (minLimitThreshold = 25,000e18 DAI) exceeds the 20,000 DAI bottleneck from Hop 1
            const excessivePaths = g.getCandidatePaths({
                tokenIn: usdc6,
                tokenOut: dai18,
                swapAmount: TokenAmount.fromRawAmount(dai18, 50_000n * 10n ** 18n),
                swapKind: SwapKind.GivenOut,
                graphTraversalConfig: { ...baseConfig, minSwapAmountRatio: 0.5 },
            });

            expect(excessivePaths).toHaveLength(0);
        });

        test('getCandidatePaths falls back to maxDepthFallback when all paths within maxDepth fail validation', () => {
            const g = new PathGraph();
            const hop1 = new Token(1, '0xhop1', 18, 'HOP1');
            const hop2 = new Token(1, '0xhop2', 18, 'HOP2');
            const hop3 = new Token(1, '0xhop3', 18, 'HOP3');

            // Shallow 2-hop path (A -> B -> D, tokenPath length = 3 <= maxDepth 3):
            // Exists in the graph so findAllValidTokenPaths sees results.length > 0,
            // but its second hop has a tiny limit (100n < minLimitThreshold 500n) so isValidPath rejects it!
            const shallowPool1 = createMockPool('shallow1', [tokenA, tokenB], {
                getLimitAmountSwap: () => 10_000n,
            });
            const shallowPool2Bottleneck = createMockPool('shallow2', [tokenB, tokenD], {
                getLimitAmountSwap: () => 100n,
            });

            // Deeper 4-hop path (A -> hop1 -> hop2 -> hop3 -> D, tokenPath length = 5 > maxDepth 3, <= maxDepthFallback 5):
            // Has ample capacity (10,000n >= 500n) on every hop.
            const deep1 = createMockPool('deep1', [tokenA, hop1], { getLimitAmountSwap: () => 10_000n });
            const deep2 = createMockPool('deep2', [hop1, hop2], { getLimitAmountSwap: () => 10_000n });
            const deep3 = createMockPool('deep3', [hop2, hop3], { getLimitAmountSwap: () => 10_000n });
            const deep4 = createMockPool('deep4', [hop3, tokenD], { getLimitAmountSwap: () => 10_000n });

            g.buildGraph({
                pools: [shallowPool1, shallowPool2Bottleneck, deep1, deep2, deep3, deep4],
                enableAddRemoveLiquidityPaths: false,
                swapKind: SwapKind.GivenIn,
                tokenPrices: new Map<string, number>(),
                minLimitThresholdUSD: 0,
            });

            const paths = g.getCandidatePaths({
                tokenIn: tokenA,
                tokenOut: tokenD,
                swapAmount: TokenAmount.fromRawAmount(tokenA, 1_000n),
                swapKind: SwapKind.GivenIn,
                graphTraversalConfig: {
                    ...baseConfig,
                    maxDepth: 3,
                    maxDepthFallback: 5,
                    minSwapAmountRatio: 0.5, // minLimitThreshold = 500n
                },
            });

            expect(paths).toHaveLength(1);
            expect(paths[0].pools.map((p) => p.id)).toEqual(['deep1', 'deep2', 'deep3', 'deep4']);
        });

        test('maxDepthFallback discovers deeper paths even when >= maxTokenPaths shallow paths exist and fail validation', () => {
            const g = new PathGraph();
            const hop1 = new Token(1, '0xhop1_50', 18, 'HOP1');
            const hop2 = new Token(1, '0xhop2_50', 18, 'HOP2');
            const hop3 = new Token(1, '0xhop3_50', 18, 'HOP3');

            // Create 5 shallow 2-hop paths (length = 3 <= maxDepth 3) when maxTokenPaths = 3,
            // all of which fail validation due to a second-hop limit below minLimitThreshold (500n)
            const shallowPools = Array.from({ length: 5 }, (_, i) => {
                const mid = new Token(1, `0xshallowmid_${i}`, 18, `SM${i}`);
                return [
                    createMockPool(`s1_${i}`, [tokenA, mid], { getLimitAmountSwap: () => 10_000n }),
                    createMockPool(`s2_${i}`, [mid, tokenD], { getLimitAmountSwap: () => 100n }),
                ];
            }).flat();

            const deep1 = createMockPool('deep1_50', [tokenA, hop1], { getLimitAmountSwap: () => 10_000n });
            const deep2 = createMockPool('deep2_50', [hop1, hop2], { getLimitAmountSwap: () => 10_000n });
            const deep3 = createMockPool('deep3_50', [hop2, hop3], { getLimitAmountSwap: () => 10_000n });
            const deep4 = createMockPool('deep4_50', [hop3, tokenD], { getLimitAmountSwap: () => 10_000n });

            g.buildGraph({
                pools: [...shallowPools, deep1, deep2, deep3, deep4],
                enableAddRemoveLiquidityPaths: false,
                swapKind: SwapKind.GivenIn,
                tokenPrices: new Map<string, number>(),
                minLimitThresholdUSD: 0,
            });

            const paths = g.getCandidatePaths({
                tokenIn: tokenA,
                tokenOut: tokenD,
                swapAmount: TokenAmount.fromRawAmount(tokenA, 1_000n),
                swapKind: SwapKind.GivenIn,
                graphTraversalConfig: {
                    ...baseConfig,
                    maxTokenPaths: 3,
                    maxDepth: 3,
                    maxDepthFallback: 5,
                    minSwapAmountRatio: 0.5,
                },
            });

            expect(paths).toHaveLength(1);
            expect(paths[0].pools.map((p) => p.id)).toEqual(['deep1_50', 'deep2_50', 'deep3_50', 'deep4_50']);
        });

        test('default maxDepth (8) discovers multi-hop Regular + Boosted (5 tokens) and Boosted + Boosted (7 tokens) routes alongside a direct pool', () => {
            const g = new PathGraph();
            const wA = new Token(1, '0xwa', 18, 'wA');
            const wB1 = new Token(1, '0xwb1', 18, 'wB1');
            const wB2 = new Token(1, '0xwb2', 18, 'wB2');
            const wD = new Token(1, '0xwd', 18, 'wD');

            // 1. Direct shallow pool (A -> D, 2 tokens)
            const directPool = createMockPool('directAD', [tokenA, tokenD]);

            // 2. 7-token (6-hop) Boosted -> Boosted route: A -> [bufA] -> wA -> [boosted1] -> wB1 -> [bufB1] -> B -> [bufB2] -> wB2 -> [boosted2] -> wD -> [bufD] -> D
            const bufA = createMockPool('bufA', [tokenA, wA], { poolType: 'Buffer' });
            const boosted1 = createMockPool('boosted1', [wA, wB1]);
            const bufB1 = createMockPool('bufB1', [wB1, tokenB], { poolType: 'Buffer' });
            const bufB2 = createMockPool('bufB2', [tokenB, wB2], { poolType: 'Buffer' });
            const boosted2 = createMockPool('boosted2', [wB2, wD]);
            const bufD = createMockPool('bufD', [wD, tokenD], { poolType: 'Buffer' });

            g.buildGraph({
                pools: [directPool, bufA, boosted1, bufB1, bufB2, boosted2, bufD],
                enableAddRemoveLiquidityPaths: false,
                swapKind: SwapKind.GivenIn,
                tokenPrices: new Map<string, number>(),
                minLimitThresholdUSD: 0,
            });

            // Using PathGraph's default traversal config (no maxDepth override)
            const paths = g.getCandidatePaths({
                tokenIn: tokenA,
                tokenOut: tokenD,
                swapAmount: TokenAmount.fromRawAmount(tokenA, 1_000n),
                swapKind: SwapKind.GivenIn,
            });

            const poolIdLists = paths.map((p) => p.pools.map((pool) => pool.id));
            expect(poolIdLists).toContainEqual(['directAD']);
            expect(poolIdLists).toContainEqual(['bufA', 'boosted1', 'bufB1', 'bufB2', 'boosted2', 'bufD']);
        });

        test('findAllValidTokenPaths expands neighbors in descending normalizedLiquidity order when maxTokenPaths caps BFS', () => {
            const g = new PathGraph();
            const hub = new Token(1, '0xhub', 18);
            const target = new Token(1, '0xtarget', 18);
            const spokes = Array.from({ length: 6 }, (_, i) => new Token(1, `0xspoke${i}`, 18));

            // Insert spokes in ascending liquidity order (spoke0 = 100n ... spoke5 = 600n)
            const pools = spokes.flatMap((spoke, i) => {
                const liq = BigInt((i + 1) * 100);
                return [
                    createMockPool(`hub_${i}`, [hub, spoke], { getNormalizedLiquidity: () => liq }),
                    createMockPool(`spoke_${i}`, [spoke, target], { getNormalizedLiquidity: () => liq }),
                ];
            });

            g.buildGraph({
                pools,
                enableAddRemoveLiquidityPaths: false,
                swapKind: SwapKind.GivenIn,
                tokenPrices: new Map<string, number>(),
                minLimitThresholdUSD: 0,
            });

            const tokenPaths = g['findAllValidTokenPaths']({
                tokenIn: hub.address,
                tokenOut: target.address,
                config: { ...baseConfig, maxTokenPaths: 3 },
            });

            // Must prioritize the 3 highest-liquidity spokes (spoke5, spoke4, spoke3) rather than insertion order (spoke0, spoke1, spoke2)
            expect(tokenPaths).toEqual([
                [hub.address, spokes[5].address, target.address],
                [hub.address, spokes[4].address, target.address],
                [hub.address, spokes[3].address, target.address],
            ]);
        });

        test('getCandidatePaths applies selectTopCandidatesGlobally (maxCandidatesGlobally) across all token paths by bottleneck liquidity', () => {
            const g = new PathGraph();
            const midLow = new Token(1, '0xmidlow', 18);
            const midHigh = new Token(1, '0xmidhigh', 18);

            // Token path 1 (A -> midLow -> D): bottleneck liquidity = 200n
            const pLow1 = createMockPool('pLow1', [tokenA, midLow], { getNormalizedLiquidity: () => 900n });
            const pLow2 = createMockPool('pLow2', [midLow, tokenD], { getNormalizedLiquidity: () => 200n });

            // Token path 2 (A -> midHigh -> D): 2 candidates with bottleneck liquidity 850n and 750n
            const pHigh1a = createMockPool('pHigh1a', [tokenA, midHigh], { getNormalizedLiquidity: () => 850n });
            const pHigh1b = createMockPool('pHigh1b', [tokenA, midHigh], { getNormalizedLiquidity: () => 750n });
            const pHigh2 = createMockPool('pHigh2', [midHigh, tokenD], { getNormalizedLiquidity: () => 950n });

            g.buildGraph({
                pools: [pLow1, pLow2, pHigh1a, pHigh1b, pHigh2],
                enableAddRemoveLiquidityPaths: false,
                maxPathSegmentsPerTokenPair: 4,
                swapKind: SwapKind.GivenIn,
                tokenPrices: new Map<string, number>(),
                minLimitThresholdUSD: 0,
            });

            const paths = g.getCandidatePaths({
                tokenIn: tokenA,
                tokenOut: tokenD,
                swapAmount: TokenAmount.fromRawAmount(tokenA, 1_000n),
                swapKind: SwapKind.GivenIn,
                graphTraversalConfig: {
                    ...baseConfig,
                    maxCandidatesPerTokenPath: 5,
                    maxCandidatesGlobally: 2,
                    minSwapAmountRatio: 0,
                },
            });

            // Global beam search must keep only the top 2 candidates by bottleneck NL (850n and 750n on midHigh),
            // pruning the 200n bottleneck candidate on midLow even though pLow1 had 900n first-hop liquidity!
            expect(paths).toHaveLength(2);
            expect(paths.map((p) => p.pools.map((pool) => pool.id))).toEqual([
                ['pHigh1a', 'pHigh2'],
                ['pHigh1b', 'pHigh2'],
            ]);
        });
    });
});
