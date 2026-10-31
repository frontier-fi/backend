import { Chain } from '@prisma/client';
import { SwapKind, Token, TokenAmount } from '@balancer/sdk';
import { parseEther } from 'viem';

import { Router } from './router';
import { BasePool } from './basePool';
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

    it('splits a trade across two Boosted pools that share ERC-4626 BufferPools when buffer capacity is sufficient', () => {
        const router = new Router();
        const wTokenA = new Token(chainId, '0x0000000000000000000000000000000000000a01', 18, 'wTokenA');
        const wTokenC = new Token(chainId, '0x0000000000000000000000000000000000000c01', 18, 'wTokenC');

        const sharedBufferIn = new BufferPool(
            '0x000000000000000000000000000000000000b010',
            '0x000000000000000000000000000000000000b010',
            chainId,
            parseEther('1'),
            new BasePoolToken(wTokenA, 0n, 0),
            new BasePoolToken(tokenA, 0n, 1),
            parseEther('1000000'), // ample wrap capacity
            parseEther('1000000'),
        );

        const sharedBufferOut = new BufferPool(
            '0x000000000000000000000000000000000000b020',
            '0x000000000000000000000000000000000000b020',
            chainId,
            parseEther('1'),
            new BasePoolToken(wTokenC, 0n, 0),
            new BasePoolToken(tokenC, 0n, 1),
            parseEther('1000000'),
            parseEther('1000000'), // ample unwrap capacity
        );

        const boostedPool1 = createWeightedPairPool(
            '0x0000000000000000000000000000000000002011',
            wTokenA,
            wTokenC,
            '10000',
            '10000',
        );
        const boostedPool2 = createWeightedPairPool(
            '0x0000000000000000000000000000000000002012',
            wTokenA,
            wTokenC,
            '10000',
            '10000',
        );

        const boostedPath1 = new PathLocal(
            [tokenA, wTokenA, wTokenC, tokenC],
            [sharedBufferIn, boostedPool1, sharedBufferOut],
            [true, false, true],
        );
        const boostedPath2 = new PathLocal(
            [tokenA, wTokenA, wTokenC, tokenC],
            [sharedBufferIn, boostedPool2, sharedBufferOut],
            [true, false, true],
        );

        const swapAmount = TokenAmount.fromRawAmount(tokenA, parseEther('1000'));
        const singlePoolOutput = new PathWithAmount(
            boostedPath1.tokens,
            boostedPath1.pools,
            boostedPath1.isBuffer,
            swapAmount,
        ).outputAmount.amount;

        const bestPaths = router.getBestPaths([boostedPath1, boostedPath2], SwapKind.GivenIn, swapAmount);

        expect(bestPaths).not.toBeNull();
        // Should split 50/50 across the two independent Boosted pools despite sharing the linear BufferPools
        expect(bestPaths!).toHaveLength(2);
        expect(getOutputAmount(bestPaths!).amount).toBeGreaterThan(singlePoolOutput);
    });

    it('mutates BufferPool remaining capacity when mutateBalances=true and rejects split paths whose combined wrap exceeds shared buffer capacity', () => {
        const router = new Router();
        const wTokenA = new Token(chainId, '0x0000000000000000000000000000000000000a02', 18, 'wTokenA');
        const wTokenC = new Token(chainId, '0x0000000000000000000000000000000000000c02', 18, 'wTokenC');

        // Shared buffer only allows wrapping up to 1500 tokenA in total (0 internal buffer balance + 1500 maxDeposit)
        const constrainedSharedBufferIn = new BufferPool(
            '0x000000000000000000000000000000000000b030',
            '0x000000000000000000000000000000000000b030',
            chainId,
            parseEther('1'),
            new BasePoolToken(wTokenA, 0n, 0),
            new BasePoolToken(tokenA, 0n, 1),
            parseEther('1500'),
            parseEther('1500'),
        );

        // 1. Direct unit check: mutating a copy of BufferPool with a 1000 tokenA wrap must reduce remaining wrap limit to 500
        const bufferCopy: BasePool = constrainedSharedBufferIn.copy();
        expect(bufferCopy.getLimitAmountSwap(tokenA, wTokenA, SwapKind.GivenIn)).toBe(parseEther('1500'));
        bufferCopy.swapGivenIn(tokenA, wTokenA, TokenAmount.fromRawAmount(tokenA, parseEther('1000')), true);
        expect(bufferCopy.getLimitAmountSwap(tokenA, wTokenA, SwapKind.GivenIn)).toBe(parseEther('500'));

        // 2. End-to-end Router check: for a 2000 tokenA swap, each 50% leg (1000 tokenA) fits in 1500 individually,
        // but together (1000 + 1000 = 2000 > 1500) they exceed the shared buffer's capacity and must not be paired.
        const sharedBufferOut = new BufferPool(
            '0x000000000000000000000000000000000000b040',
            '0x000000000000000000000000000000000000b040',
            chainId,
            parseEther('1'),
            new BasePoolToken(wTokenC, 0n, 0),
            new BasePoolToken(tokenC, 0n, 1),
            parseEther('1000000'),
            parseEther('1000000'),
        );

        const boostedPool1 = createWeightedPairPool(
            '0x0000000000000000000000000000000000002021',
            wTokenA,
            wTokenC,
            '50000',
            '50000',
        );
        const boostedPool2 = createWeightedPairPool(
            '0x0000000000000000000000000000000000002022',
            wTokenA,
            wTokenC,
            '50000',
            '50000',
        );

        const boostedPath1 = new PathLocal(
            [tokenA, wTokenA, wTokenC, tokenC],
            [constrainedSharedBufferIn, boostedPool1, sharedBufferOut],
            [true, false, true],
        );
        const boostedPath2 = new PathLocal(
            [tokenA, wTokenA, wTokenC, tokenC],
            [constrainedSharedBufferIn, boostedPool2, sharedBufferOut],
            [true, false, true],
        );

        // Total swap = 2000 tokenA -> 100% (2000) exceeds 1500, 75% (1500) + 25% (500) = 2000 exceeds 1500,
        // and 50% (1000) + 50% (1000) = 2000 exceeds 1500. No valid route can use only constrainedSharedBufferIn.
        const swapAmount = TokenAmount.fromRawAmount(tokenA, parseEther('2000'));
        const bestPaths = router.getBestPaths([boostedPath1, boostedPath2], SwapKind.GivenIn, swapAmount);

        expect(bestPaths).toBeNull();
    });

    it('continues searching for a valid 50/50 split partner when the first candidate pair exceeds shared buffer capacity', () => {
        const router = new Router();
        const wTokenA = new Token(chainId, '0x0000000000000000000000000000000000000a03', 18, 'wTokenA');
        const wTokenC = new Token(chainId, '0x0000000000000000000000000000000000000c03', 18, 'wTokenC');

        // Shared buffer has capacity 1500: enough for ONE 50% leg (1000), but NOT two 50% legs (1000 + 1000 = 2000 > 1500)
        const constrainedSharedBufferIn = new BufferPool(
            '0x000000000000000000000000000000000000b050',
            '0x000000000000000000000000000000000000b050',
            chainId,
            parseEther('1'),
            new BasePoolToken(wTokenA, 0n, 0),
            new BasePoolToken(tokenA, 0n, 1),
            parseEther('1500'),
            parseEther('1500'),
        );
        const sharedBufferOut = new BufferPool(
            '0x000000000000000000000000000000000000b060',
            '0x000000000000000000000000000000000000b060',
            chainId,
            parseEther('1'),
            new BasePoolToken(wTokenC, 0n, 0),
            new BasePoolToken(tokenC, 0n, 1),
            parseEther('1000000'),
            parseEther('1000000'),
        );

        // Boosted pools 1 & 2 are the most liquid (so they rank #1 and #2 at 50%), but both share constrainedSharedBufferIn
        const boostedPool1 = createWeightedPairPool(
            '0x0000000000000000000000000000000000002031',
            wTokenA,
            wTokenC,
            '50000',
            '50000',
        );
        const boostedPool2 = createWeightedPairPool(
            '0x0000000000000000000000000000000000002032',
            wTokenA,
            wTokenC,
            '45000',
            '45000',
        );
        // Pool 3 is a direct non-buffer pool (tokenA -> tokenC) ranked #3 at 50%
        const directPool3 = createWeightedPairPool(
            '0x0000000000000000000000000000000000002033',
            tokenA,
            tokenC,
            '20000',
            '20000',
        );

        const boostedPath1 = new PathLocal(
            [tokenA, wTokenA, wTokenC, tokenC],
            [constrainedSharedBufferIn, boostedPool1, sharedBufferOut],
            [true, false, true],
        );
        const boostedPath2 = new PathLocal(
            [tokenA, wTokenA, wTokenC, tokenC],
            [constrainedSharedBufferIn, boostedPool2, sharedBufferOut],
            [true, false, true],
        );
        const directPath3 = new PathLocal([tokenA, tokenC], [directPool3], [false]);

        const swapAmount = TokenAmount.fromRawAmount(tokenA, parseEther('2000'));
        const singleDirectOutput = new PathWithAmount(
            directPath3.tokens,
            directPath3.pools,
            directPath3.isBuffer,
            swapAmount,
        ).outputAmount.amount;

        // Pairing boostedPath1 (#1) + boostedPath2 (#2) fails because 1000 + 1000 = 2000 > 1500 on constrainedSharedBufferIn.
        // Router must fall back to pairing boostedPath1 (#1, 1000 <= 1500) + directPath3 (#3, 1000), which beats 100% on directPath3!
        const bestPaths = router.getBestPaths([boostedPath1, boostedPath2, directPath3], SwapKind.GivenIn, swapAmount);

        expect(bestPaths).not.toBeNull();
        expect(bestPaths!).toHaveLength(2);
        expect(getOutputAmount(bestPaths!).amount).toBeGreaterThan(singleDirectOutput);
        for (const path of bestPaths!) {
            expect(path.swapStepsExceedingBufferCapacity).toBe(0);
        }
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

describe('SOR deterministic property & brute-force optimality fuzzing', () => {
    const chainId = 11155111;
    const tokenIn6 = new Token(chainId, '0x0000000000000000000000000000000000000f06', 6, 'USDC');
    const tokenMid18 = new Token(chainId, '0x0000000000000000000000000000000000000f12', 18, 'WETH');
    const tokenOut18 = new Token(chainId, '0x0000000000000000000000000000000000000f18', 18, 'DAI');
    const wTokenIn6 = new Token(chainId, '0x0000000000000000000000000000000000000f66', 6, 'stataUSDC');
    const wTokenOut18 = new Token(chainId, '0x0000000000000000000000000000000000000f88', 18, 'stataDAI');

    // Mulberry32 deterministic PRNG for reproducible fuzz trials
    function createRng(seed: number) {
        let state = seed >>> 0;
        return {
            nextFloat(): number {
                state = (state + 0x6d2b79f5) >>> 0;
                let t = Math.imul(state ^ (state >>> 15), 1 | state);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            },
            nextInt(min: number, max: number): number {
                return Math.floor(this.nextFloat() * (max - min + 1)) + min;
            },
        };
    }

    function buildRandomWeightedPool(
        id: `0x${string}`,
        t0: Token,
        t1: Token,
        bal0: string,
        bal1: string,
        fee: string,
        rate0 = '1',
        rate1 = '1',
    ): WeightedPoolV3 {
        return WeightedPoolV3.fromPrismaPool(
            prismaPoolFactory.build({
                id,
                address: id,
                chain: Chain.SEPOLIA,
                type: 'WEIGHTED',
                protocolVersion: 3,
                tokens: [
                    prismaPoolTokenFactory.build({
                        address: t0.address,
                        index: 0,
                        balance: bal0,
                        weight: '0.5',
                        priceRate: rate0,
                        token: poolTokenFactory.build({ address: t0.address, decimals: t0.decimals }),
                    }),
                    prismaPoolTokenFactory.build({
                        address: t1.address,
                        index: 1,
                        balance: bal1,
                        weight: '0.5',
                        priceRate: rate1,
                        token: poolTokenFactory.build({ address: t1.address, decimals: t1.decimals }),
                    }),
                ],
                dynamicData: prismaPoolDynamicDataFactory.build({
                    swapFee: fee,
                    aggregateSwapFee: '0.5',
                    totalShares: bal0,
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

    function canSplitOracle(pathA: PathLocal, pathB: PathLocal): boolean {
        return !pathA.pools.some((pool) => pool.poolType !== 'Buffer' && pathB.pools.some((p) => p.id === pool.id));
    }

    function simulateQuoteOracle(
        swapAmount: TokenAmount,
        pathA: PathLocal,
        ratioBps: bigint,
        pathB?: PathLocal,
    ): PathWithAmount[] | null {
        try {
            if (!pathB || ratioBps === 10_000n) {
                const single = new PathWithAmount(pathA.tokens, pathA.pools, pathA.isBuffer, swapAmount);
                if (single.swapStepsExceedingBufferCapacity > 0) return null;
                const calc = single.swapKind === SwapKind.GivenIn ? single.outputAmount : single.inputAmount;
                return calc.amount > 0n ? [single] : null;
            }

            if (!canSplitOracle(pathA, pathB)) return null;

            const amountUp = swapAmount.mulDownFixed((ratioBps * 10n ** 18n) / 10_000n);
            const amountDown = swapAmount.sub(amountUp);
            if (amountUp.amount <= 0n || amountDown.amount <= 0n) return null;

            // Check individual legs first just like quotePathsByRatio
            const quoteA = new PathWithAmount(pathA.tokens, pathA.pools, pathA.isBuffer, amountUp);
            const quoteB = new PathWithAmount(pathB.tokens, pathB.pools, pathB.isBuffer, amountDown);
            if (quoteA.swapStepsExceedingBufferCapacity > 0 || quoteB.swapStepsExceedingBufferCapacity > 0) return null;

            const uniquePools = [...new Set(pathA.pools.concat(pathB.pools))];
            const poolsCopy = uniquePools.map((p) => p.copy());
            const poolsA = pathA.pools.map((p) => poolsCopy.find((c) => c.id === p.id)!) as BasePool[];
            const poolsB = pathB.pools.map((p) => poolsCopy.find((c) => c.id === p.id)!) as BasePool[];

            const pathUp = new PathWithAmount(pathA.tokens, poolsA, pathA.isBuffer, amountUp, true);
            const pathDown = new PathWithAmount(pathB.tokens, poolsB, pathB.isBuffer, amountDown, true);
            if (pathUp.swapStepsExceedingBufferCapacity > 0 || pathDown.swapStepsExceedingBufferCapacity > 0) {
                return null;
            }
            return [pathUp, pathDown];
        } catch {
            return null;
        }
    }

    it('matches brute-force oracle optimality, wei conservation, and stateful Vault execution across 40 randomized multi-pool & Boosted topologies', () => {
        const rng = createRng(0xdecafbad);
        const router = new Router();

        for (let trial = 0; trial < 40; trial++) {
            const swapKind = trial % 2 === 0 ? SwapKind.GivenIn : SwapKind.GivenOut;

            // Randomly sized direct, 2-hop, and shared-buffer Boosted pools
            const balDirect1 = String(rng.nextInt(5_000, 80_000));
            const balDirect2 = String(rng.nextInt(5_000, 80_000));
            const balBoosted1 = String(rng.nextInt(10_000, 100_000));
            const balBoosted2 = String(rng.nextInt(10_000, 100_000));
            const balHop = String(rng.nextInt(15_000, 90_000));

            const fee1 = `0.00${rng.nextInt(1, 9)}`;
            const fee2 = `0.00${rng.nextInt(1, 9)}`;
            const rateIn = `1.0${rng.nextInt(0, 9)}`;
            const rateOut = `1.0${rng.nextInt(0, 9)}`;

            const directPool1 = buildRandomWeightedPool(
                '0x000000000000000000000000000000000000f001',
                tokenIn6,
                tokenOut18,
                balDirect1,
                balDirect1,
                fee1,
            );
            const directPool2 = buildRandomWeightedPool(
                '0x000000000000000000000000000000000000f002',
                tokenIn6,
                tokenOut18,
                balDirect2,
                balDirect2,
                fee2,
            );
            const hopPoolA = buildRandomWeightedPool(
                '0x000000000000000000000000000000000000f003',
                tokenIn6,
                tokenMid18,
                balHop,
                balHop,
                '0.002',
            );
            const hopPoolB = buildRandomWeightedPool(
                '0x000000000000000000000000000000000000f004',
                tokenMid18,
                tokenOut18,
                balHop,
                balHop,
                '0.002',
            );
            const boostedPool1 = buildRandomWeightedPool(
                '0x000000000000000000000000000000000000f005',
                wTokenIn6,
                wTokenOut18,
                balBoosted1,
                balBoosted1,
                '0.001',
                rateIn,
                rateOut,
            );
            const boostedPool2 = buildRandomWeightedPool(
                '0x000000000000000000000000000000000000f006',
                wTokenIn6,
                wTokenOut18,
                balBoosted2,
                balBoosted2,
                '0.0015',
                rateIn,
                rateOut,
            );

            // Vary buffer deposit/withdraw caps from tight (e.g. 1,200 USDC) to ample (200,000 USDC)
            const bufferCapIn = BigInt(rng.nextInt(1_200, 120_000)) * 10n ** 6n;
            const bufferCapOut = BigInt(rng.nextInt(1_200, 120_000)) * 10n ** 18n;

            const bufferIn = new BufferPool(
                wTokenIn6.address,
                wTokenIn6.address,
                chainId,
                parseEther(rateIn),
                new BasePoolToken(wTokenIn6, 0n, 0),
                new BasePoolToken(tokenIn6, 0n, 1),
                bufferCapIn,
                bufferCapIn,
            );
            const bufferOut = new BufferPool(
                wTokenOut18.address,
                wTokenOut18.address,
                chainId,
                parseEther(rateOut),
                new BasePoolToken(wTokenOut18, 0n, 0),
                new BasePoolToken(tokenOut18, 0n, 1),
                bufferCapOut,
                bufferCapOut,
            );

            const allPools: BasePool[] = [
                directPool1,
                directPool2,
                hopPoolA,
                hopPoolB,
                boostedPool1,
                boostedPool2,
                bufferIn,
                bufferOut,
            ];

            // Include odd-wei trade amounts to stress rounding conservation
            const rawTradeUnits = BigInt(rng.nextInt(200, 8_000));
            const rawAmount =
                swapKind === SwapKind.GivenIn
                    ? rawTradeUnits * 10n ** 6n + BigInt(rng.nextInt(0, 7))
                    : rawTradeUnits * 10n ** 18n + BigInt(rng.nextInt(0, 7));
            const amountToken = swapKind === SwapKind.GivenIn ? tokenIn6 : tokenOut18;
            const swapAmount = TokenAmount.fromRawAmount(amountToken, rawAmount);

            const candidatePaths = router.getCandidatePaths(
                tokenIn6,
                tokenOut18,
                allPools,
                swapAmount,
                swapKind,
                false,
                new Map(),
            );

            expect(candidatePaths.length).toBeGreaterThan(0);

            const bestPaths = router.getBestPaths(candidatePaths, swapKind, swapAmount);

            const isBetter = (candidate: bigint, current: bigint | null) =>
                current === null || (swapKind === SwapKind.GivenIn ? candidate > current : candidate < current);

            // 1. Brute-force reference oracle over all single paths (100%) and valid 50/50 & 25/75 splits
            let oracleGridBestScore: bigint | null = null;
            // 2. Continuous 10%-step brute-force oracle (10/90, 20/80, ..., 90/10) to bound discretization loss
            let continuous10PctBestScore: bigint | null = null;

            for (const pA of candidatePaths) {
                const single = simulateQuoteOracle(swapAmount, pA, 10_000n);
                if (single) {
                    const score =
                        swapKind === SwapKind.GivenIn ? getOutputAmount(single).amount : getInputAmount(single).amount;
                    if (isBetter(score, oracleGridBestScore)) {
                        oracleGridBestScore = score;
                    }
                    if (isBetter(score, continuous10PctBestScore)) {
                        continuous10PctBestScore = score;
                    }
                }
            }

            // Evaluate 2-path splits across candidate pairs for both the SOR grid (25/75, 50/50) and 10%-step continuous grid
            for (let i = 0; i < candidatePaths.length; i++) {
                for (let j = 0; j < candidatePaths.length; j++) {
                    if (i === j) continue;
                    const pA = candidatePaths[i];
                    const pB = candidatePaths[j];
                    if (!canSplitOracle(pA, pB)) continue;

                    for (const gridBps of [2_500n, 5_000n]) {
                        const split = simulateQuoteOracle(swapAmount, pA, gridBps, pB);
                        if (split) {
                            const score =
                                swapKind === SwapKind.GivenIn
                                    ? getOutputAmount(split).amount
                                    : getInputAmount(split).amount;
                            if (isBetter(score, oracleGridBestScore)) {
                                oracleGridBestScore = score;
                            }
                        }
                    }

                    for (const stepBps of [1_000n, 2_000n, 3_000n, 4_000n, 5_000n, 6_000n, 7_000n, 8_000n, 9_000n]) {
                        const split = simulateQuoteOracle(swapAmount, pA, stepBps, pB);
                        if (split) {
                            const score =
                                swapKind === SwapKind.GivenIn
                                    ? getOutputAmount(split).amount
                                    : getInputAmount(split).amount;
                            if (isBetter(score, continuous10PctBestScore)) {
                                continuous10PctBestScore = score;
                            }
                        }
                    }
                }
            }

            if (oracleGridBestScore !== null) {
                expect(bestPaths).not.toBeNull();

                // Invariant 1: Exact wei conservation
                if (swapKind === SwapKind.GivenIn) {
                    expect(getInputAmount(bestPaths!).amount).toBe(swapAmount.amount);
                } else {
                    expect(getOutputAmount(bestPaths!).amount).toBe(swapAmount.amount);
                }

                // Invariant 2: Zero buffer capacity violations & no duplicate non-buffer pools across split legs
                const seenNonBufferPools = new Set<string>();
                for (const p of bestPaths!) {
                    expect(p.swapStepsExceedingBufferCapacity).toBe(0);
                    for (const pool of p.pools) {
                        if (pool.poolType !== 'Buffer') {
                            expect(seenNonBufferPools.has(pool.id)).toBe(false);
                            seenNonBufferPools.add(pool.id);
                        }
                    }
                }

                const routerScore =
                    swapKind === SwapKind.GivenIn
                        ? getOutputAmount(bestPaths!).amount
                        : getInputAmount(bestPaths!).amount;

                // Invariant 3: Router must match the brute-force 25/50/75/100 grid optimum within 1 bp (99.99%)
                // and stay within 50 bps (99.5%) of the continuous 10%-step brute-force optimum
                if (swapKind === SwapKind.GivenIn) {
                    expect(routerScore * 10_000n).toBeGreaterThanOrEqual(oracleGridBestScore * 9_999n);
                    expect(routerScore * 10_000n).toBeGreaterThanOrEqual(continuous10PctBestScore! * 9_950n);
                } else {
                    expect(routerScore * 9_999n).toBeLessThanOrEqual(oracleGridBestScore * 10_000n);
                    expect(routerScore * 9_950n).toBeLessThanOrEqual(continuous10PctBestScore! * 10_000n);
                }

                // Invariant 4: Stateful sequential execution invariant (BatchRouter simulation with mutateBalances = true)
                const livePoolMap = new Map(allPools.map((p) => [p.id, p.copy()]));
                let sequentialTotal = 0n;
                for (const p of bestPaths!) {
                    const statefulPools = p.pools.map((pool) => livePoolMap.get(pool.id)!);
                    const executed = new PathWithAmount(p.tokens, statefulPools, p.isBuffer, p.swapAmount, true);
                    expect(executed.swapStepsExceedingBufferCapacity).toBe(0);
                    sequentialTotal +=
                        swapKind === SwapKind.GivenIn ? executed.outputAmount.amount : executed.inputAmount.amount;
                }
                expect(routerScore).toBe(sequentialTotal);
            }
        }
    });
});
