import { Chain } from '@prisma/client';
import { SwapKind, Token, TokenAmount } from '@balancer/sdk';
import { parseEther } from 'viem';

import { Router } from './router';
import { PathLocal, PathWithAmount } from './path';
import { BufferPool } from './poolsV3/buffer/bufferPool';
import { WeightedPoolV3 } from './poolsV3/weighted/weightedPool';
import { StablePoolV3 } from './poolsV3/stable/stablePool';
import { BasePoolToken } from './utils/basePoolToken';
import { getInputAmount, getOutputAmount } from './utils/helpers';
import {
    poolTokenFactory,
    prismaPoolDynamicDataFactory,
    prismaPoolFactory,
    prismaPoolTokenFactory,
} from '../../../test/factories';

/**
 * Regression scenario: a boosted pool swap that requires wrapping more underlying than the
 * lending protocol accepts (erc4626 maxDeposit almost exhausted, e.g. an Aave market at its
 * supply cap). The SOR used to quote these paths anyway and the swap reverted onchain with
 * an opaque EstimateGasExecutionError.
 */
describe('Router buffer capacity limits', () => {
    const chainId = 1;
    const underlying = new Token(chainId, '0x000000000000000000000000000000000000aaa1', 6);
    const wrapped = new Token(chainId, '0x000000000000000000000000000000000000bbb1', 6);

    // buffer holds 100/100, lending protocol has room for 696.89 more underlying
    const bufferBalance = 100_000000n;
    const maxDeposit = 696_890000n;
    const maxWithdraw = 1_000_000_000000n;

    function createBufferPool(): BufferPool {
        return new BufferPool(
            '0x000000000000000000000000000000000000bbb1',
            '0x000000000000000000000000000000000000bbb1',
            chainId,
            parseEther('1'), // 1:1 unwrap rate
            new BasePoolToken(wrapped, bufferBalance, 0),
            new BasePoolToken(underlying, bufferBalance, 1),
            maxDeposit,
            maxWithdraw,
        );
    }

    function createWrapPath(): PathLocal {
        return new PathLocal([underlying, wrapped], [createBufferPool()], [true]);
    }

    describe('PathWithAmount.swapStepsExceedingBufferCapacity', () => {
        it('flags a wrap that exceeds the lending protocol deposit capacity', () => {
            const path = createWrapPath();
            const swapAmount = TokenAmount.fromRawAmount(underlying, 699_729300n);

            const pathWithAmount = new PathWithAmount(path.tokens, path.pools, path.isBuffer, swapAmount);

            expect(pathWithAmount.swapStepsExceedingBufferCapacity).toBe(1);
        });

        it('does not flag a wrap within the deposit capacity', () => {
            const path = createWrapPath();
            const swapAmount = TokenAmount.fromRawAmount(underlying, 690_000000n);

            const pathWithAmount = new PathWithAmount(path.tokens, path.pools, path.isBuffer, swapAmount);

            expect(pathWithAmount.swapStepsExceedingBufferCapacity).toBe(0);
        });
    });

    describe('Router.getBestPaths', () => {
        it('returns no paths when the only path exceeds buffer capacity', () => {
            const router = new Router();
            const swapAmount = TokenAmount.fromRawAmount(underlying, 699_729300n);

            const bestPaths = router.getBestPaths([createWrapPath()], SwapKind.GivenIn, swapAmount);

            expect(bestPaths).toBeNull();
        });

        it('returns a quote when the swap is within buffer capacity', () => {
            const router = new Router();
            const swapAmount = TokenAmount.fromRawAmount(underlying, 690_000000n);

            const bestPaths = router.getBestPaths([createWrapPath()], SwapKind.GivenIn, swapAmount);

            expect(bestPaths).not.toBeNull();
            expect(bestPaths![0].outputAmount.amount).toBe(690_000000n);
        });

        it('returns no paths when a givenOut swap exceeds buffer capacity', () => {
            const router = new Router();
            // givenOut wrap limit = buffer wrapped balance + maxDeposit room = 100 + 696.89
            const swapAmount = TokenAmount.fromRawAmount(wrapped, 800_000000n);

            const bestPaths = router.getBestPaths([createWrapPath()], SwapKind.GivenOut, swapAmount);

            expect(bestPaths).toBeNull();
        });

        it('rejects a multi-hop path when an intermediate hop returns 0n', () => {
            const tokenC = new Token(chainId, '0x000000000000000000000000000000000000ccc1', 6);
            const zeroPool = {
                id: '0x000000000000000000000000000000000000ddd1',
                address: '0x000000000000000000000000000000000000ddd1',
                poolType: 'Weighted',
                swapGivenIn: () => TokenAmount.fromRawAmount(tokenC, 0n),
                swapGivenOut: () => TokenAmount.fromRawAmount(wrapped, 0n),
            } as any;

            const multiHopPath = new PathLocal(
                [underlying, wrapped, tokenC],
                [createBufferPool(), zeroPool],
                [true, false],
            );

            expect(() => {
                new PathWithAmount(
                    multiHopPath.tokens,
                    multiHopPath.pools,
                    multiHopPath.isBuffer,
                    TokenAmount.fromRawAmount(underlying, 10_000000n),
                );
            }).toThrow(/Zero output amount/);

            expect(() => {
                new PathWithAmount(
                    multiHopPath.tokens,
                    multiHopPath.pools,
                    multiHopPath.isBuffer,
                    TokenAmount.fromRawAmount(tokenC, 10_000000n),
                );
            }).toThrow(/Zero input amount/);
        });
    });
});

describe('Router split-routing & conservation invariants', () => {
    const chainId = 11155111;
    const tokenA = new Token(chainId, '0x00000000000000000000000000000000000000a1', 18, 'TKA');
    const tokenB = new Token(chainId, '0x00000000000000000000000000000000000000b1', 18, 'TKB');
    const tokenC = new Token(chainId, '0x00000000000000000000000000000000000000c1', 18, 'TKC');

    function createWeightedPairPool(
        address: `0x${string}`,
        t0: Token,
        t1: Token,
        balance0 = '10000',
        balance1 = '10000',
        swapFee = '0.003',
        normalizedLiquidity = '5000000000000000000000',
    ): WeightedPoolV3 {
        const pt0 = prismaPoolTokenFactory.build({
            address: t0.address,
            index: 0,
            balance: balance0,
            weight: '0.5',
            priceRate: '1',
            token: poolTokenFactory.build({ address: t0.address, decimals: t0.decimals }),
        });
        const pt1 = prismaPoolTokenFactory.build({
            address: t1.address,
            index: 1,
            balance: balance1,
            weight: '0.5',
            priceRate: '1',
            token: poolTokenFactory.build({ address: t1.address, decimals: t1.decimals }),
        });

        return WeightedPoolV3.fromPrismaPool(
            prismaPoolFactory.build({
                id: address,
                address,
                chain: Chain.SEPOLIA,
                type: 'WEIGHTED',
                protocolVersion: 3,
                tokens: [pt0, pt1],
                dynamicData: prismaPoolDynamicDataFactory.build({
                    swapFee,
                    aggregateSwapFee: '0',
                    totalShares: '10000',
                    tokenPairsData: [
                        {
                            tokenA: t0.address,
                            tokenB: t1.address,
                            normalizedLiquidity,
                            spotPrice: '1',
                        },
                    ],
                }),
                liquidityManagement: {
                    disableUnbalancedLiquidity: true,
                    enableAddLiquidityCustom: false,
                    enableDonation: false,
                    enableRemoveLiquidityCustom: false,
                },
            }),
        );
    }

    it('conserves exact input amount (zero wei lost) across odd and even swapAmounts when 50/50 split is chosen (GivenIn)', () => {
        const router = new Router();
        const pool1 = createWeightedPairPool('0x0000000000000000000000000000000000001001', tokenA, tokenB);
        const pool2 = createWeightedPairPool('0x0000000000000000000000000000000000001002', tokenA, tokenB);

        const candidatePaths = [
            new PathLocal([tokenA, tokenB], [pool1], [false]),
            new PathLocal([tokenA, tokenB], [pool2], [false]),
        ];

        // Test both even and odd wei amounts that trigger a 50/50 split across two identical pools
        const amountsToTest = [
            100_000000000000000000n, // even
            100_000000000000000001n, // odd (+1 wei)
            500_123456789012345679n, // odd
            999_999999999999999999n, // odd
        ];

        for (const rawAmount of amountsToTest) {
            const swapAmount = TokenAmount.fromRawAmount(tokenA, rawAmount);
            const bestPaths = router.getBestPaths(candidatePaths, SwapKind.GivenIn, swapAmount);

            expect(bestPaths).not.toBeNull();
            expect(bestPaths!.length).toBe(2);

            const totalQuotedInput = getInputAmount(bestPaths!).amount;
            expect(totalQuotedInput).toBe(rawAmount);
        }
    });

    it('conserves exact output amount (zero wei lost) across odd and even swapAmounts when 50/50 split is chosen (GivenOut)', () => {
        const router = new Router();
        const pool1 = createWeightedPairPool('0x0000000000000000000000000000000000001001', tokenA, tokenB);
        const pool2 = createWeightedPairPool('0x0000000000000000000000000000000000001002', tokenA, tokenB);

        const candidatePaths = [
            new PathLocal([tokenA, tokenB], [pool1], [false]),
            new PathLocal([tokenA, tokenB], [pool2], [false]),
        ];

        const oddOutputAmount = 100_000000000000000001n;
        const swapAmount = TokenAmount.fromRawAmount(tokenB, oddOutputAmount);
        const bestPaths = router.getBestPaths(candidatePaths, SwapKind.GivenOut, swapAmount);

        expect(bestPaths).not.toBeNull();
        expect(bestPaths!.length).toBe(2);

        const totalQuotedOutput = getOutputAmount(bestPaths!).amount;
        expect(totalQuotedOutput).toBe(oddOutputAmount);
    });

    it('does not drop a valid 100% single-path swap when the 25% checkpoint rounds down to 0 output (Bug: 25%-first cascading pruning)', () => {
        const router = new Router();
        const tokenIn18 = new Token(chainId, '0x0000000000000000000000000000000000000018', 18, 'WETH');
        const tokenOut6 = new Token(chainId, '0x0000000000000000000000000000000000000006', 6, 'USDC');

        const pool = createWeightedPairPool(
            '0x0000000000000000000000000000000000001009',
            tokenIn18,
            tokenOut6,
            '100000',
            '100000',
        );
        const path = new PathLocal([tokenIn18, tokenOut6], [pool], [false]);

        // 3e12 wei of 18-decimal tokenIn (~0.000003 tokenIn):
        // - At 100% (3e12 wei), output in 6-decimal tokenOut is 2n (> 0n), so a direct 100% swap is valid!
        // - At 25% (7.5e11 wei), output in 6-decimal tokenOut rounds down to 0n.
        const smallSwapAmount = TokenAmount.fromRawAmount(tokenIn18, 3_000_000_000_000n);
        const direct100Quote = new PathWithAmount(path.tokens, path.pools, path.isBuffer, smallSwapAmount);
        expect(direct100Quote.outputAmount.amount).toBeGreaterThan(0n);

        // Router.getBestPaths must still return the valid 100% path rather than returning null
        const bestPaths = router.getBestPaths([path], SwapKind.GivenIn, smallSwapAmount);
        expect(bestPaths).not.toBeNull();
        expect(getOutputAmount(bestPaths!).amount).toBe(direct100Quote.outputAmount.amount);
    });

    it('does not return a split path where the rounding remainder pushes pathDown over buffer capacity (Bug: splitPaths remainder overflow)', () => {
        const router = new Router();
        const underlying = new Token(chainId, '0x000000000000000000000000000000000000aaa1', 6, 'USDC');
        const wrapped1 = new Token(chainId, '0x000000000000000000000000000000000000bbb1', 6, 'stataUSDC1');
        const wrapped2 = new Token(chainId, '0x000000000000000000000000000000000000bbb2', 6, 'stataUSDC2');

        // Buffer 1 and Buffer 2 each have a wrap limit of exactly 50_000000n (50 USDC):
        // balance = 50 USDC each, maxDeposit = 50 USDC -> wrapRequiredToRebalance = 0 -> wrapLimit = 50_000000n
        const buf1 = new BufferPool(
            wrapped1.address,
            wrapped1.address,
            chainId,
            parseEther('1'),
            new BasePoolToken(wrapped1, 50_000000n, 0),
            new BasePoolToken(underlying, 50_000000n, 1),
            50_000000n,
            1_000_000_000000n,
        );
        const buf2 = new BufferPool(
            wrapped2.address,
            wrapped2.address,
            chainId,
            parseEther('1'),
            new BasePoolToken(wrapped2, 50_000000n, 0),
            new BasePoolToken(underlying, 50_000000n, 1),
            50_000000n,
            1_000_000_000000n,
        );

        const pool1 = createWeightedPairPool(
            '0x0000000000000000000000000000000000004001',
            wrapped1,
            tokenC,
            '100000',
            '100000',
        );
        const pool2 = createWeightedPairPool(
            '0x0000000000000000000000000000000000004002',
            wrapped2,
            tokenC,
            '100000',
            '100000',
        );

        const path1 = new PathLocal([underlying, wrapped1, tokenC], [buf1, pool1], [true, false]);
        const path2 = new PathLocal([underlying, wrapped2, tokenC], [buf2, pool2], [true, false]);

        // Odd swapAmount = 100_000001n:
        // - 50% checkpoint (mulDownFixed(0.5)) is 50_000000n, which is <= buf2's 50_000000n limit.
        // - In splitPaths, swapAmountUp = 50_000000n, and swapAmountDown = 100_000001n - 50_000000n = 50_000001n,
        //   which EXCEEDS buf2's 50_000000n limit (swapStepsExceedingBufferCapacity === 1)!
        const oddSwapAmount = TokenAmount.fromRawAmount(underlying, 100_000001n);
        const bestPaths = router.getBestPaths([path1, path2], SwapKind.GivenIn, oddSwapAmount);

        // Any returned path must NEVER have swapStepsExceedingBufferCapacity > 0
        if (bestPaths !== null) {
            for (const path of bestPaths) {
                expect(path.swapStepsExceedingBufferCapacity).toBe(0);
            }
        }
    });

    it('updates totalSupply/totalShares when mutating balances on BPT add/remove liquidity hops (Bug: BasePoolV3 BPT mutation)', () => {
        const pool = WeightedPoolV3.fromPrismaPool(
            prismaPoolFactory.build({
                id: '0x0000000000000000000000000000000000005001',
                address: '0x0000000000000000000000000000000000005001',
                chain: Chain.SEPOLIA,
                type: 'WEIGHTED',
                protocolVersion: 3,
                tokens: [
                    prismaPoolTokenFactory.build({
                        address: tokenA.address,
                        index: 0,
                        balance: '10000',
                        weight: '0.5',
                        priceRate: '1',
                        token: poolTokenFactory.build({ address: tokenA.address, decimals: 18 }),
                    }),
                    prismaPoolTokenFactory.build({
                        address: tokenB.address,
                        index: 1,
                        balance: '10000',
                        weight: '0.5',
                        priceRate: '1',
                        token: poolTokenFactory.build({ address: tokenB.address, decimals: 18 }),
                    }),
                ],
                dynamicData: prismaPoolDynamicDataFactory.build({
                    swapFee: '0.003',
                    aggregateSwapFee: '0',
                    totalShares: '10000',
                }),
                liquidityManagement: {
                    disableUnbalancedLiquidity: false,
                    enableAddLiquidityCustom: false,
                    enableDonation: false,
                    enableRemoveLiquidityCustom: false,
                },
            }),
        );

        const bpt = new Token(chainId, pool.id, 18, 'BPT');
        const initialSupply = pool.getPoolState().totalSupply;

        // Add liquidity (tokenA -> BPT) with mutateBalances = true: BPT totalSupply must increase by minted BPT
        const mintedBpt = pool.swapGivenIn(tokenA, bpt, TokenAmount.fromRawAmount(tokenA, parseEther('1000')), true);
        expect(mintedBpt.amount).toBeGreaterThan(0n);
        expect(pool.getPoolState().totalSupply).toBe(initialSupply + mintedBpt.amount);
    });

    it('never selects overlapping pools in a 50/50 split (quoted output must match sequential stateful execution)', () => {
        const router = new Router();
        // Two parallel pools for hop 1 (A -> B), but ONE shared pool for hop 2 (B -> C)
        const poolAB1 = createWeightedPairPool('0x0000000000000000000000000000000000002001', tokenA, tokenB);
        const poolAB2 = createWeightedPairPool('0x0000000000000000000000000000000000002002', tokenA, tokenB);
        const poolBCShared = createWeightedPairPool('0x0000000000000000000000000000000000002003', tokenB, tokenC);

        const candidatePaths = [
            new PathLocal([tokenA, tokenB, tokenC], [poolAB1, poolBCShared], [false, false]),
            new PathLocal([tokenA, tokenB, tokenC], [poolAB2, poolBCShared], [false, false]),
        ];

        const swapAmount = TokenAmount.fromRawAmount(tokenA, parseEther('1000'));
        const bestPaths = router.getBestPaths(candidatePaths, SwapKind.GivenIn, swapAmount);

        expect(bestPaths).not.toBeNull();

        // 1. Disjoint-pool invariant: no pool ID may appear in more than one split path
        const seenPools = new Set<string>();
        for (const path of bestPaths!) {
            for (const pool of path.pools) {
                expect(seenPools.has(pool.id)).toBe(false);
                seenPools.add(pool.id);
            }
        }

        // 2. Sequential execution invariant: executing the returned paths sequentially against
        // a shared stateful pool map (mutating balances after each path) must yield the exact
        // same total output as getOutputAmount(bestPaths).
        const livePools = new Map([
            [poolAB1.id, poolAB1.copy()],
            [poolAB2.id, poolAB2.copy()],
            [poolBCShared.id, poolBCShared.copy()],
        ]);

        let actualSequentialOutput = 0n;
        for (const path of bestPaths!) {
            const statefulPathPools = path.pools.map((p) => livePools.get(p.id)!);
            const executedPath = new PathWithAmount(
                path.tokens,
                statefulPathPools,
                path.isBuffer,
                path.inputAmount,
                true, // mutateBalances = true as the Vault does during a BatchRouter transaction
            );
            actualSequentialOutput += executedPath.outputAmount.amount;
        }

        expect(getOutputAmount(bestPaths!).amount).toBe(actualSequentialOutput);
    });
});

describe('SOR pool & routing mathematical property tests', () => {
    const chainId = 11155111;
    const token6 = new Token(chainId, '0x0000000000000000000000000000000000000066', 6, 'USDC');
    const token18 = new Token(chainId, '0x0000000000000000000000000000000000000018', 18, 'DAI');

    function buildWeightedPool(rate0 = '1', rate1 = '1.05'): WeightedPoolV3 {
        const pt0 = prismaPoolTokenFactory.build({
            address: token6.address,
            index: 0,
            balance: '500000',
            weight: '0.5',
            priceRate: rate0,
            token: poolTokenFactory.build({ address: token6.address, decimals: 6 }),
        });
        const pt1 = prismaPoolTokenFactory.build({
            address: token18.address,
            index: 1,
            balance: '500000',
            weight: '0.5',
            priceRate: rate1,
            token: poolTokenFactory.build({ address: token18.address, decimals: 18 }),
        });
        return WeightedPoolV3.fromPrismaPool(
            prismaPoolFactory.build({
                id: '0x0000000000000000000000000000000000003001',
                address: '0x0000000000000000000000000000000000003001',
                chain: Chain.SEPOLIA,
                type: 'WEIGHTED',
                protocolVersion: 3,
                tokens: [pt0, pt1],
                dynamicData: prismaPoolDynamicDataFactory.build({
                    swapFee: '0.003',
                    aggregateSwapFee: '0.5',
                    totalShares: '500000',
                }),
                liquidityManagement: {
                    disableUnbalancedLiquidity: false,
                    enableAddLiquidityCustom: false,
                    enableDonation: false,
                    enableRemoveLiquidityCustom: false,
                },
            }),
        );
    }

    function buildStablePool(rate0 = '1.02', rate1 = '1.08'): StablePoolV3 {
        const pt0 = prismaPoolTokenFactory.build({
            address: token6.address,
            index: 0,
            balance: '500000',
            priceRate: rate0,
            token: poolTokenFactory.build({ address: token6.address, decimals: 6 }),
        });
        const pt1 = prismaPoolTokenFactory.build({
            address: token18.address,
            index: 1,
            balance: '500000',
            priceRate: rate1,
            token: poolTokenFactory.build({ address: token18.address, decimals: 18 }),
        });
        return StablePoolV3.fromPrismaPool(
            prismaPoolFactory.build({
                id: '0x0000000000000000000000000000000000003002',
                address: '0x0000000000000000000000000000000000003002',
                chain: Chain.SEPOLIA,
                type: 'STABLE',
                protocolVersion: 3,
                typeData: { amp: '500' },
                tokens: [pt0, pt1],
                dynamicData: prismaPoolDynamicDataFactory.build({
                    swapFee: '0.0004',
                    aggregateSwapFee: '0.5',
                    totalShares: '1000000',
                }),
                liquidityManagement: {
                    disableUnbalancedLiquidity: false,
                    enableAddLiquidityCustom: false,
                    enableDonation: false,
                    enableRemoveLiquidityCustom: false,
                },
            }),
        );
    }

    it.each([
        ['WeightedPoolV3 (6 vs 18 decimals, non-unit rate)', () => buildWeightedPool()],
        ['StablePoolV3 (6 vs 18 decimals, non-unit rates)', () => buildStablePool()],
    ])('satisfies monotonicity and convex price impact for %s', (_label, createPool) => {
        const pool = createPool();
        const amountsIn = [100_000000n, 1_000_000000n, 10_000_000000n, 50_000_000000n];
        const outputs = amountsIn.map(
            (amt) => pool.swapGivenIn(token6, token18, TokenAmount.fromRawAmount(token6, amt)).amount,
        );

        for (let i = 1; i < outputs.length; i++) {
            // Strictly monotonic output
            expect(outputs[i]).toBeGreaterThan(outputs[i - 1]);
            // Convex slippage: output[i] / input[i] <= output[i-1] / input[i-1]
            expect(outputs[i] * amountsIn[i - 1]).toBeLessThanOrEqual(outputs[i - 1] * amountsIn[i]);
        }
    });

    it.each([
        ['WeightedPoolV3', () => buildWeightedPool()],
        ['StablePoolV3', () => buildStablePool()],
    ])('satisfies no-free-lunch round-trip invariant (A -> B -> A < A) for %s', (_label, createPool) => {
        const tradeSizes = [10_000000n, 500_000000n, 5_000_000000n, 25_000_000000n];

        for (const rawIn of tradeSizes) {
            const pool = createPool();
            const amountIn = TokenAmount.fromRawAmount(token6, rawIn);
            const outB = pool.swapGivenIn(token6, token18, amountIn, true);
            const roundTripA = pool.swapGivenIn(token18, token6, outB, true);

            // Round-trip must strictly lose value due to swap fees and upward rounding of fees
            expect(roundTripA.amount).toBeLessThan(rawIn);
        }
    });

    it.each([
        ['WeightedPoolV3', () => buildWeightedPool()],
        ['StablePoolV3', () => buildStablePool()],
    ])('satisfies ExactIn <-> ExactOut duality within rounding tolerance for %s', (_label, createPool) => {
        const pool = createPool();
        const tradeSizes = [50_000000n, 1_000_000000n, 15_000_000000n];

        for (const rawIn of tradeSizes) {
            const amountOut = pool.swapGivenIn(token6, token18, TokenAmount.fromRawAmount(token6, rawIn));
            const requiredIn = pool.swapGivenOut(token6, token18, amountOut);

            // Because token6 has 6 decimals (1 unit = 1e12 in scale18), requiredIn should be within 2 units of rawIn
            const diff = requiredIn.amount > rawIn ? requiredIn.amount - rawIn : rawIn - requiredIn.amount;
            expect(diff).toBeLessThanOrEqual(2n);
        }
    });
});
