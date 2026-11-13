// bun run vitest sor/sor.integration.test.ts

import { SwapKind, Token, TokenAmount } from '@frontier-fi/maths';
import { Chain } from '@prisma/client';
import {
    type Address,
    type Hex,
    decodeFunctionData,
    decodeFunctionResult,
    encodeFunctionResult,
    formatUnits,
    parseEther,
} from 'viem';

import config from '../../config';
import { KNOWN_POOLS } from '../../test/e2e/config';
import {
    poolTokenFactory,
    prismaPoolDynamicDataFactory,
    prismaPoolFactory,
    prismaPoolTokenFactory,
} from '../../test/factories';
import {
    batchRouterAbi,
    encodeBatchRouterQueryCalldata,
    fromSorPathsToSwapPathInput,
    getBatchedPublicClient,
    queryBatchRouterWithViem,
} from '../../test/testData/generate/getSwapPath';
import { getPool as fetchOnChainPool } from '../../test/testData/generate/getPool';
import { mapBufferPools, mapPools, readTestData } from '../../test/testData/read/readTestData';
import { getTokensFromPrismaPools } from '../../test/utils';
import { PrismaPoolAndHookWithDynamic } from '../../prisma/prisma-types';
import { BasePool } from './lib/basePool';
import { PathWithAmount } from './lib/path';
import { BufferPool, GyroECLPPool, StablePoolV3, WeightedPoolV3 } from './lib/poolsV3';
import { SOR } from './lib/sor';
import { getInputAmount, getOutputAmount } from './lib/utils/helpers';
import { BufferPoolData } from './utils/data';

// This test will run against all files added to test/testData/read
// In order to add new scenarios, please add them to test/testData/config.json

// Note: these tests are only available for Balancer V3
const protocolVersion = 3;
const DEBUG = false;

describe('SOR V3 Swap Paths Integration Tests', () => {
    // read all test files in test/testData/read
    const testData = readTestData(DEBUG);
    test.each(testData.swapPaths)('$test $swapKind $amount', async (swapPath) => {
        const { paths: queryPaths, swapKind, currentTimestamp, chainId } = swapPath;

        const index = testData.swapPaths.indexOf(swapPath);
        const prismaPools: PrismaPoolAndHookWithDynamic[] = testData.swapPathPools[index];
        const bufferPools: BufferPoolData[] = testData.bufferPools[index];
        const { tokenIn, tokenOut } = getTokensFromPrismaPools(
            Number(chainId),
            prismaPools,
            queryPaths[0].tokens,
            bufferPools,
        );

        const amountRawSum = queryPaths.reduce((acc, path) => acc + path.amountRaw, 0n);

        // A flat price gives every token a USD limit. The recorded amounts come from pool
        // math, and looking prices up would require the database.
        const tokenPrices = new Map<string, number>();
        for (const pool of prismaPools) {
            for (const poolToken of pool.tokens) {
                tokenPrices.set(poolToken.address.toLowerCase(), 1);
            }
        }
        for (const bufferPool of bufferPools) {
            tokenPrices.set(bufferPool.mainToken.address.toLowerCase(), 1);
            tokenPrices.set(bufferPool.underlyingToken.address.toLowerCase(), 1);
        }

        const sorPaths = (await SOR.getPathsWithPools(
            tokenIn,
            tokenOut,
            swapKind,
            amountRawSum,
            prismaPools,
            bufferPools,
            protocolVersion,
            tokenPrices,
            {
                currentTimestamp,
            },
        )) as PathWithAmount[];

        // make sure path found is the same as the onde described in the test
        expect(sorPaths.map((path) => path.pools.map((pool) => pool.address.toLowerCase()))).toEqual(
            queryPaths.map((path) => path.pools.map((pool) => pool.poolAddress.toLowerCase())),
        );

        const calculatedAmountRawSum = queryPaths.reduce((acc, path) => acc + path.calculatedAmountRaw, 0n);

        const calculatedAmountQuery = TokenAmount.fromRawAmount(
            swapKind === SwapKind.GivenIn ? tokenOut : tokenIn,
            calculatedAmountRawSum,
        );
        const calculatedAmountSOR =
            swapKind === SwapKind.GivenIn ? getOutputAmount(sorPaths) : getInputAmount(sorPaths);

        const isSwapPathWithBufferPools = bufferPools.length > 0;
        if (isSwapPathWithBufferPools) {
            const calculatedAmountQueryFloat = parseFloat(
                formatUnits(calculatedAmountQuery.amount, calculatedAmountQuery.token.decimals),
            );
            const calculatedAmountSORFloat = parseFloat(
                formatUnits(calculatedAmountSOR.amount, calculatedAmountSOR.token.decimals),
            );
            const ratio = calculatedAmountQueryFloat / calculatedAmountSORFloat;
            expect(ratio).toBeCloseTo(1, 3); // 5 bp tolerance
        } else {
            expect(calculatedAmountQuery.amount).toBe(calculatedAmountSOR.amount);
        }

        // Verify pure-viem BatchRouter calldata encoding & stateful Vault execution parity for every fixture
        const swapPathInput = fromSorPathsToSwapPathInput(swapKind, sorPaths);
        const calldata = encodeBatchRouterQueryCalldata(swapKind, swapPathInput.paths);
        const vaultResult = simulateBatchRouterCalldataOnVault(calldata, prismaPools, bufferPools, Number(chainId));

        expect(vaultResult.pathAmounts).toEqual(
            sorPaths.map((p) => (swapKind === SwapKind.GivenIn ? p.outputAmount.amount : p.inputAmount.amount)),
        );
        expect(vaultResult.totalAmounts[0]).toBe(calculatedAmountSOR.amount);
    });
});

/**
 * Pure-viem Solidity BatchRouter.querySwapExactIn / querySwapExactOut simulator.
 * Decodes actual BatchRouter ABI calldata, executes each path & step against a single shared
 * stateful Vault pool/buffer map (mutating balances after every hop just like the V3 Vault),
 * and round-trips the return values through viem's encodeFunctionResult / decodeFunctionResult.
 */
function simulateBatchRouterCalldataOnVault(
    calldata: Hex,
    prismaPools: PrismaPoolAndHookWithDynamic[],
    bufferPools: BufferPoolData[],
    chainId: number,
): { pathAmounts: bigint[]; tokens: Address[]; totalAmounts: bigint[] } {
    const livePools = new Map<string, BasePool>();
    const tokenLookup = new Map<string, Token>();

    for (const prismaPool of prismaPools) {
        let pool: BasePool;
        if (prismaPool.type === 'WEIGHTED') {
            pool = WeightedPoolV3.fromPrismaPool(prismaPool);
        } else if (prismaPool.type === 'STABLE') {
            pool = StablePoolV3.fromPrismaPool(prismaPool);
        } else if (prismaPool.type === 'ECLP') {
            pool = GyroECLPPool.fromPrismaPool(prismaPool);
        } else {
            continue;
        }
        livePools.set(pool.address.toLowerCase(), pool);
        for (const t of pool.tokens) {
            tokenLookup.set(t.token.address.toLowerCase(), t.token);
        }
        // Register pool BPT token for add/remove liquidity steps
        const bptToken = new Token(chainId, pool.address.toLowerCase() as Address, 18, 'BPT');
        tokenLookup.set(bptToken.address.toLowerCase(), bptToken);
    }

    for (const buf of bufferPools) {
        const pool = BufferPool.fromBufferPoolData(buf);
        livePools.set(pool.address.toLowerCase(), pool);
        for (const t of pool.tokens) {
            tokenLookup.set(t.token.address.toLowerCase(), t.token);
        }
    }

    const decoded = decodeFunctionData({
        abi: batchRouterAbi,
        data: calldata,
    });

    if (decoded.functionName === 'querySwapExactIn') {
        const [paths] = decoded.args;
        const pathAmountsOut: bigint[] = [];
        const tokensOut: Address[] = [];
        const amountsOut: bigint[] = [];

        for (const path of paths) {
            let currentToken = tokenLookup.get(path.tokenIn.toLowerCase());
            if (!currentToken) throw new Error(`Unknown tokenIn ${path.tokenIn}`);
            let currentAmount = TokenAmount.fromRawAmount(currentToken, path.exactAmountIn);

            for (const step of path.steps) {
                const pool = livePools.get(step.pool.toLowerCase());
                if (!pool) throw new Error(`Unknown pool ${step.pool}`);
                const nextToken = tokenLookup.get(step.tokenOut.toLowerCase());
                if (!nextToken) throw new Error(`Unknown tokenOut ${step.tokenOut}`);

                expect(pool.poolType === 'Buffer').toBe(step.isBuffer);

                if (step.isBuffer) {
                    const maxCap = pool.getLimitAmountSwap(currentToken, nextToken, SwapKind.GivenIn);
                    expect(currentAmount.amount).toBeLessThanOrEqual(maxCap);
                }

                currentAmount = pool.swapGivenIn(currentToken, nextToken, currentAmount, true);
                currentToken = nextToken;
            }

            expect(currentAmount.amount).toBeGreaterThanOrEqual(path.minAmountOut);
            pathAmountsOut.push(currentAmount.amount);

            const finalTokenAddr = currentToken.address as Address;
            const existingIdx = tokensOut.findIndex((t) => t.toLowerCase() === finalTokenAddr.toLowerCase());
            if (existingIdx === -1) {
                tokensOut.push(finalTokenAddr);
                amountsOut.push(currentAmount.amount);
            } else {
                amountsOut[existingIdx] += currentAmount.amount;
            }
        }

        const encodedResult = encodeFunctionResult({
            abi: batchRouterAbi,
            functionName: 'querySwapExactIn',
            result: [pathAmountsOut, tokensOut, amountsOut],
        });
        const [decodedPathAmounts, decodedTokens, decodedTotals] = decodeFunctionResult({
            abi: batchRouterAbi,
            functionName: 'querySwapExactIn',
            data: encodedResult,
        });
        return {
            pathAmounts: [...decodedPathAmounts],
            tokens: [...decodedTokens],
            totalAmounts: [...decodedTotals],
        };
    }

    const [paths] = decoded.args;
    const pathAmountsIn: bigint[] = [];
    const tokensIn: Address[] = [];
    const amountsIn: bigint[] = [];

    for (const path of paths) {
        const pathTokenAddresses: Address[] = [path.tokenIn, ...path.steps.map((s) => s.tokenOut)];
        const lastToken = tokenLookup.get(pathTokenAddresses[pathTokenAddresses.length - 1].toLowerCase());
        if (!lastToken) throw new Error('Unknown last token');
        let currentAmount = TokenAmount.fromRawAmount(lastToken, path.exactAmountOut);

        // Solidity BatchRouter._querySwapExactOut iterates backwards from the last step to step 0
        for (let i = path.steps.length - 1; i >= 0; i--) {
            const step = path.steps[i];
            const pool = livePools.get(step.pool.toLowerCase());
            if (!pool) throw new Error(`Unknown pool ${step.pool}`);
            const stepTokenIn = tokenLookup.get(pathTokenAddresses[i].toLowerCase());
            const stepTokenOut = tokenLookup.get(pathTokenAddresses[i + 1].toLowerCase());
            if (!stepTokenIn || !stepTokenOut) throw new Error('Unknown step token');

            expect(pool.poolType === 'Buffer').toBe(step.isBuffer);

            if (step.isBuffer) {
                const maxCap = pool.getLimitAmountSwap(stepTokenIn, stepTokenOut, SwapKind.GivenOut);
                expect(currentAmount.amount).toBeLessThanOrEqual(maxCap);
            }

            currentAmount = pool.swapGivenOut(stepTokenIn, stepTokenOut, currentAmount, true);
        }

        expect(currentAmount.amount).toBeLessThanOrEqual(path.maxAmountIn);
        pathAmountsIn.push(currentAmount.amount);

        const entryTokenAddr = path.tokenIn;
        const existingIdx = tokensIn.findIndex((t) => t.toLowerCase() === entryTokenAddr.toLowerCase());
        if (existingIdx === -1) {
            tokensIn.push(entryTokenAddr);
            amountsIn.push(currentAmount.amount);
        } else {
            amountsIn[existingIdx] += currentAmount.amount;
        }
    }

    const encodedResult = encodeFunctionResult({
        abi: batchRouterAbi,
        functionName: 'querySwapExactOut',
        result: [pathAmountsIn, tokensIn, amountsIn],
    });
    const [decodedPathAmounts, decodedTokens, decodedTotals] = decodeFunctionResult({
        abi: batchRouterAbi,
        functionName: 'querySwapExactOut',
        data: encodedResult,
    });
    return {
        pathAmounts: [...decodedPathAmounts],
        tokens: [...decodedTokens],
        totalAmounts: [...decodedTotals],
    };
}

describe('BatchRouter (pure viem, zero @balancer/sdk Swap) Differential Verification', () => {
    const chainId = 11155111;
    const tokenIn = new Token(chainId, '0x00000000000000000000000000000000000000a1', 6, 'USDC');
    const tokenOut = new Token(chainId, '0x00000000000000000000000000000000000000b1', 18, 'DAI');
    const wTokenIn = new Token(chainId, '0x0000000000000000000000000000000000000a11', 6, 'stataUSDC');
    const wTokenOut = new Token(chainId, '0x0000000000000000000000000000000000000b11', 18, 'stataDAI');

    function buildWeightedPrismaPool(
        id: Address,
        t0: Token,
        t1: Token,
        bal0: string,
        bal1: string,
        fee = '0.003',
    ): PrismaPoolAndHookWithDynamic {
        return prismaPoolFactory.build({
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
                    priceRate: '1',
                    token: poolTokenFactory.build({
                        address: t0.address,
                        decimals: t0.decimals,
                    }),
                }),
                prismaPoolTokenFactory.build({
                    address: t1.address,
                    index: 1,
                    balance: bal1,
                    weight: '0.5',
                    priceRate: '1',
                    token: poolTokenFactory.build({
                        address: t1.address,
                        decimals: t1.decimals,
                    }),
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
        });
    }

    test.each([
        ['GivenIn (querySwapExactIn)', SwapKind.GivenIn, 1_000n * 10n ** 6n],
        ['GivenOut (querySwapExactOut)', SwapKind.GivenOut, 1_000n * 10n ** 18n],
    ])(
        'matches BatchRouter calldata execution with 0-wei drift across asymmetric splits, shared-buffer Boosted splits, and buffer-clamped splits (%s)',
        async (_label, swapKind, rawSwapAmount) => {
            // 1. Direct asymmetric pools (40k and 60k)
            const directPool40 = buildWeightedPrismaPool(
                '0x0000000000000000000000000000000000009001',
                tokenIn,
                tokenOut,
                '40000',
                '40000',
                '0.003',
            );
            const directPool60 = buildWeightedPrismaPool(
                '0x0000000000000000000000000000000000009002',
                tokenIn,
                tokenOut,
                '60000',
                '60000',
                '0.003',
            );

            // 2. Deep low-fee Boosted pool whose ERC-4626 buffers cap out at 600 units (60% of 1,000 swap:
            // passes PathGraph's 50% minSwapAmountRatio, then clamped by Router.getBufferConstrainedMaxSwapAmount)
            const boostedPool = buildWeightedPrismaPool(
                '0x0000000000000000000000000000000000009003',
                wTokenIn,
                wTokenOut,
                '200000',
                '200000',
                '0.0002',
            );
            const bufferPools: BufferPoolData[] = [
                {
                    poolId: wTokenIn.address,
                    address: wTokenIn.address as Address,
                    chainId,
                    mainToken: { address: wTokenIn.address as Address, decimals: 6, balance: 0n },
                    underlyingToken: { address: tokenIn.address as Address, decimals: 6, balance: 0n },
                    poolType: 'Buffer',
                    unwrapRate: parseEther('1'),
                    maxDeposit: 600n * 10n ** 6n,
                    maxWithdraw: 500_000n * 10n ** 6n,
                },
                {
                    poolId: wTokenOut.address,
                    address: wTokenOut.address as Address,
                    chainId,
                    mainToken: { address: wTokenOut.address as Address, decimals: 18, balance: 0n },
                    underlyingToken: { address: tokenOut.address as Address, decimals: 18, balance: 0n },
                    poolType: 'Buffer',
                    unwrapRate: parseEther('1'),
                    maxDeposit: 500_000n * 10n ** 18n,
                    maxWithdraw: 600n * 10n ** 18n,
                },
            ];

            const prismaPools = [directPool40, directPool60, boostedPool];
            const sorPaths = await SOR.getPathsWithPools(
                tokenIn,
                tokenOut,
                swapKind,
                rawSwapAmount,
                prismaPools,
                bufferPools,
                3,
                new Map(),
            );

            expect(sorPaths).not.toBeNull();
            expect(sorPaths!.length).toBe(2);

            const swapPathInput = fromSorPathsToSwapPathInput(swapKind, sorPaths!);
            const calldata = encodeBatchRouterQueryCalldata(swapKind, swapPathInput.paths);
            const batchRouterResult = simulateBatchRouterCalldataOnVault(calldata, prismaPools, bufferPools, chainId);

            const expectedLegAmounts = sorPaths!.map((p) =>
                swapKind === SwapKind.GivenIn ? p.outputAmount.amount : p.inputAmount.amount,
            );
            const expectedTotal =
                swapKind === SwapKind.GivenIn ? getOutputAmount(sorPaths!).amount : getInputAmount(sorPaths!).amount;

            expect(batchRouterResult.pathAmounts).toEqual(expectedLegAmounts);
            expect(batchRouterResult.totalAmounts).toEqual([expectedTotal]);

            // Verify buffer-clamped split where the clamped Boosted path (max 200 USDC) + directPool60 (remainder) is selected
            const clampedPrismaPools = [directPool60, boostedPool];
            const clampedSorPaths = await SOR.getPathsWithPools(
                tokenIn,
                tokenOut,
                swapKind,
                rawSwapAmount,
                clampedPrismaPools,
                bufferPools,
                3,
                new Map(),
            );
            expect(clampedSorPaths).not.toBeNull();
            expect(clampedSorPaths!.length).toBe(2);
            expect(clampedSorPaths!.some((p) => p.isBuffer.includes(true))).toBe(true);

            const clampedSwapPathInput = fromSorPathsToSwapPathInput(swapKind, clampedSorPaths!);
            const clampedCalldata = encodeBatchRouterQueryCalldata(swapKind, clampedSwapPathInput.paths);
            const clampedBatchRouterResult = simulateBatchRouterCalldataOnVault(
                clampedCalldata,
                clampedPrismaPools,
                bufferPools,
                chainId,
            );
            const clampedExpectedLegAmounts = clampedSorPaths!.map((p) =>
                swapKind === SwapKind.GivenIn ? p.outputAmount.amount : p.inputAmount.amount,
            );
            const clampedExpectedTotal =
                swapKind === SwapKind.GivenIn
                    ? getOutputAmount(clampedSorPaths!).amount
                    : getInputAmount(clampedSorPaths!).amount;

            expect(clampedBatchRouterResult.pathAmounts).toEqual(clampedExpectedLegAmounts);
            expect(clampedBatchRouterResult.totalAmounts).toEqual([clampedExpectedTotal]);
        },
    );

    test.each([
        ['GivenIn (querySwapExactIn)', SwapKind.GivenIn, 500n * 10n ** 6n],
        ['GivenOut (querySwapExactOut)', SwapKind.GivenOut, 500n * 10n ** 18n],
    ])(
        'matches BatchRouter calldata execution with 0-wei drift across 3-hop heterogeneous routes (WEIGHTED -> ECLP -> STABLE) (%s)',
        async (_label, swapKind, rawSwapAmount) => {
            const hopToken1 = new Token(chainId, '0x00000000000000000000000000000000000000c1', 18, 'HOP1');
            const hopToken2 = new Token(chainId, '0x00000000000000000000000000000000000000c2', 18, 'HOP2');

            // Hop 1: WEIGHTED (tokenIn -> hopToken1)
            const weightedHop = buildWeightedPrismaPool(
                '0x0000000000000000000000000000000000009101',
                tokenIn,
                hopToken1,
                '500000',
                '500000',
                '0.001',
            );

            // Hop 2: ECLP (hopToken1 -> hopToken2) cloned from recorded GyroECLP fixture parameters
            const eclpTemplate = readTestData(false)
                .swapPathPools.flat()
                .find((p) => p.type === 'ECLP')!;
            const eclpHop: PrismaPoolAndHookWithDynamic = {
                ...eclpTemplate,
                id: '0x0000000000000000000000000000000000009102',
                address: '0x0000000000000000000000000000000000009102',
                tokens: [
                    prismaPoolTokenFactory.build({
                        address: hopToken1.address,
                        index: 0,
                        balance: '500000',
                        priceRate: '1',
                        token: poolTokenFactory.build({ address: hopToken1.address, decimals: hopToken1.decimals }),
                    }),
                    prismaPoolTokenFactory.build({
                        address: hopToken2.address,
                        index: 1,
                        balance: '500000',
                        priceRate: '1',
                        token: poolTokenFactory.build({ address: hopToken2.address, decimals: hopToken2.decimals }),
                    }),
                ],
            };

            // Hop 3: STABLE (hopToken2 -> tokenOut)
            const stableHop = prismaPoolFactory.stable('1000').build({
                id: '0x0000000000000000000000000000000000009103',
                address: '0x0000000000000000000000000000000000009103',
                chain: Chain.SEPOLIA,
                protocolVersion: 3,
                tokens: [
                    prismaPoolTokenFactory.build({
                        address: hopToken2.address,
                        index: 0,
                        balance: '500000',
                        priceRate: '1',
                        token: poolTokenFactory.build({ address: hopToken2.address, decimals: hopToken2.decimals }),
                    }),
                    prismaPoolTokenFactory.build({
                        address: tokenOut.address,
                        index: 1,
                        balance: '500000',
                        priceRate: '1',
                        token: poolTokenFactory.build({ address: tokenOut.address, decimals: tokenOut.decimals }),
                    }),
                ],
                dynamicData: prismaPoolDynamicDataFactory.build({
                    swapFee: '0.0005',
                    aggregateSwapFee: '0.5',
                    totalShares: '1000000',
                }),
            });

            const prismaPools = [weightedHop, eclpHop, stableHop];
            const sorPaths = await SOR.getPathsWithPools(
                tokenIn,
                tokenOut,
                swapKind,
                rawSwapAmount,
                prismaPools,
                [],
                3,
                new Map(),
            );

            expect(sorPaths).not.toBeNull();
            expect(sorPaths).toHaveLength(1);
            expect(sorPaths![0].pools).toHaveLength(3);

            const swapPathInput = fromSorPathsToSwapPathInput(swapKind, sorPaths!);
            const calldata = encodeBatchRouterQueryCalldata(swapKind, swapPathInput.paths);
            const batchRouterResult = simulateBatchRouterCalldataOnVault(calldata, prismaPools, [], chainId);

            const expectedTotal =
                swapKind === SwapKind.GivenIn ? getOutputAmount(sorPaths!).amount : getInputAmount(sorPaths!).amount;
            expect(batchRouterResult.pathAmounts).toEqual([expectedTotal]);
            expect(batchRouterResult.totalAmounts).toEqual([expectedTotal]);
        },
    );

    test.each([
        ['GivenIn (querySwapExactIn)', SwapKind.GivenIn],
        ['GivenOut (querySwapExactOut)', SwapKind.GivenOut],
    ])(
        'matches BatchRouter calldata execution with 0-wei drift on single-token Add Liquidity (token -> BPT), Remove Liquidity (BPT -> token), and 2-hop BPT bridge (tokenA -> BPT -> tokenB) (%s)',
        async (_label, swapKind) => {
            const poolAddr = '0x0000000000000000000000000000000000009201' as Address;
            const bptToken = new Token(chainId, poolAddr, 18, 'BPT');
            const bridgedToken = new Token(chainId, '0x00000000000000000000000000000000000000d1', 18, 'BRIDGED');

            const mainPool = buildWeightedPrismaPool(poolAddr, tokenIn, tokenOut, '100000', '100000', '0.003');
            // Second pool trades mainPool's BPT against bridgedToken
            const bptBridgePool = buildWeightedPrismaPool(
                '0x0000000000000000000000000000000000009202',
                bptToken,
                bridgedToken,
                '50000',
                '50000',
                '0.002',
            );

            // 1. Single-token Add Liquidity: tokenIn -> bptToken
            const addAmount = swapKind === SwapKind.GivenIn ? 100n * 10n ** 6n : 100n * 10n ** 18n;
            const addPaths = await SOR.getPathsWithPools(
                tokenIn,
                bptToken,
                swapKind,
                addAmount,
                [mainPool],
                [],
                3,
                new Map(),
            );
            expect(addPaths).not.toBeNull();
            const addCalldata = encodeBatchRouterQueryCalldata(
                swapKind,
                fromSorPathsToSwapPathInput(swapKind, addPaths!).paths,
            );
            const addVaultRes = simulateBatchRouterCalldataOnVault(addCalldata, [mainPool], [], chainId);
            expect(addVaultRes.totalAmounts[0]).toBe(
                swapKind === SwapKind.GivenIn ? getOutputAmount(addPaths!).amount : getInputAmount(addPaths!).amount,
            );

            // 2. Single-token Remove Liquidity: bptToken -> tokenOut
            const remAmount = 100n * 10n ** 18n;
            const remPaths = await SOR.getPathsWithPools(
                bptToken,
                tokenOut,
                swapKind,
                remAmount,
                [mainPool],
                [],
                3,
                new Map(),
            );
            expect(remPaths).not.toBeNull();
            const remCalldata = encodeBatchRouterQueryCalldata(
                swapKind,
                fromSorPathsToSwapPathInput(swapKind, remPaths!).paths,
            );
            const remVaultRes = simulateBatchRouterCalldataOnVault(remCalldata, [mainPool], [], chainId);
            expect(remVaultRes.totalAmounts[0]).toBe(
                swapKind === SwapKind.GivenIn ? getOutputAmount(remPaths!).amount : getInputAmount(remPaths!).amount,
            );

            // 3. 2-hop BPT bridge: tokenIn -> bptToken (AddLiquidity) -> bridgedToken (Swap)
            const bridgeAmount = swapKind === SwapKind.GivenIn ? 100n * 10n ** 6n : 50n * 10n ** 18n;
            const bridgePaths = await SOR.getPathsWithPools(
                tokenIn,
                bridgedToken,
                swapKind,
                bridgeAmount,
                [mainPool, bptBridgePool],
                [],
                3,
                new Map(),
            );
            expect(bridgePaths).not.toBeNull();
            expect(bridgePaths![0].pools).toHaveLength(2);
            const bridgeCalldata = encodeBatchRouterQueryCalldata(
                swapKind,
                fromSorPathsToSwapPathInput(swapKind, bridgePaths!).paths,
            );
            const bridgeVaultRes = simulateBatchRouterCalldataOnVault(
                bridgeCalldata,
                [mainPool, bptBridgePool],
                [],
                chainId,
            );
            expect(bridgeVaultRes.totalAmounts[0]).toBe(
                swapKind === SwapKind.GivenIn
                    ? getOutputAmount(bridgePaths!).amount
                    : getInputAmount(bridgePaths!).amount,
            );
        },
    );

    test.each([
        ['GivenIn (querySwapExactIn)', SwapKind.GivenIn, 1_000n * 10n ** 6n],
        ['GivenOut (querySwapExactOut)', SwapKind.GivenOut, 1_000n * 10n ** 18n],
    ])(
        'matches BatchRouter calldata execution with 0-wei drift when two Boosted split paths share the same entry and exit ERC-4626 buffers (%s)',
        async (_label, swapKind, rawSwapAmount) => {
            const boostedPoolA = buildWeightedPrismaPool(
                '0x0000000000000000000000000000000000009301',
                wTokenIn,
                wTokenOut,
                '2500',
                '2500',
                '0.001',
            );
            const boostedPoolB = buildWeightedPrismaPool(
                '0x0000000000000000000000000000000000009302',
                wTokenIn,
                wTokenOut,
                '2500',
                '2500',
                '0.001',
            );
            const sharedBuffers: BufferPoolData[] = [
                {
                    poolId: wTokenIn.address,
                    address: wTokenIn.address as Address,
                    chainId,
                    mainToken: { address: wTokenIn.address as Address, decimals: 6, balance: 800n * 10n ** 6n },
                    underlyingToken: { address: tokenIn.address as Address, decimals: 6, balance: 800n * 10n ** 6n },
                    poolType: 'Buffer',
                    unwrapRate: parseEther('1'),
                    maxDeposit: 5_000n * 10n ** 6n,
                    maxWithdraw: 5_000n * 10n ** 6n,
                },
                {
                    poolId: wTokenOut.address,
                    address: wTokenOut.address as Address,
                    chainId,
                    mainToken: { address: wTokenOut.address as Address, decimals: 18, balance: 800n * 10n ** 18n },
                    underlyingToken: {
                        address: tokenOut.address as Address,
                        decimals: 18,
                        balance: 800n * 10n ** 18n,
                    },
                    poolType: 'Buffer',
                    unwrapRate: parseEther('1'),
                    maxDeposit: 5_000n * 10n ** 18n,
                    maxWithdraw: 5_000n * 10n ** 18n,
                },
            ];

            const prismaPools = [boostedPoolA, boostedPoolB];
            const sorPaths = await SOR.getPathsWithPools(
                tokenIn,
                tokenOut,
                swapKind,
                rawSwapAmount,
                prismaPools,
                sharedBuffers,
                3,
                new Map(),
            );

            // Single Weighted pool maxSwapAmount at 2500 balance is 750 (< 1000), so SOR MUST split across both
            expect(sorPaths).not.toBeNull();
            expect(sorPaths).toHaveLength(2);

            const swapPathInput = fromSorPathsToSwapPathInput(swapKind, sorPaths!);
            const calldata = encodeBatchRouterQueryCalldata(swapKind, swapPathInput.paths);
            const batchRouterResult = simulateBatchRouterCalldataOnVault(calldata, prismaPools, sharedBuffers, chainId);

            const expectedLegs = sorPaths!.map((p) =>
                swapKind === SwapKind.GivenIn ? p.outputAmount.amount : p.inputAmount.amount,
            );
            const expectedTotal =
                swapKind === SwapKind.GivenIn ? getOutputAmount(sorPaths!).amount : getInputAmount(sorPaths!).amount;

            expect(batchRouterResult.pathAmounts).toEqual(expectedLegs);
            expect(batchRouterResult.totalAmounts).toEqual([expectedTotal]);
        },
    );
});

describe.skipIf(!process.env.TEST_LIVE_RPC)(
    'Live Sepolia BatchRouter (0x7D08bc34e444848983227E266F61146A7e935A94) Fork Verification',
    () => {
        const sepoliaCfg = config[Chain.SEPOLIA];
        const rpcUrl = sepoliaCfg.rpcUrl;
        const chainId = sepoliaCfg.chain.id;
        const batchRouterAddress = sepoliaCfg.contracts.BatchRouter as Address;
        const client = getBatchedPublicClient(rpcUrl, chainId);

        let blockNumber: bigint;
        let knownPrismaPools: PrismaPoolAndHookWithDynamic[];
        let clusterPrismaPools: PrismaPoolAndHookWithDynamic[];
        let manifestPrismaPools: PrismaPoolAndHookWithDynamic[];
        let boostedPrismaPool: PrismaPoolAndHookWithDynamic;
        let manifestBoostedPrismaPool: PrismaPoolAndHookWithDynamic;
        let boostedBufferPools: BufferPoolData[];

        const T0 = new Token(chainId, '0x04d41887928367030259cd4bd9e75cce2bd682b4', 18);
        const T1 = new Token(chainId, '0x186bcb14f4ac06ed3a6aba412e1b3c971ae34218', 18);
        const T7 = new Token(chainId, '0xe9c74a99accbb33bba6be58b400b3319798050c8', 18);

        beforeAll(async () => {
            blockNumber = await client.getBlockNumber();

            const clusterSpecs = [
                { id: '0x69c4eeada34abfe84fc5e86ce1839358bb2ae335', type: 'WEIGHTED' }, // T0-T1
                { id: '0xa5bfaf67b334ef03b6c032421a2ad6ce2628ecae', type: 'WEIGHTED' }, // T0-T1
                { id: '0x0e72517e9f11f62f846381d3478e20c04f9307cf', type: 'GYROE' }, // T0-T2
                { id: '0x16338e097e4d0dcd8c7a2bc7fa68d64438fdd09d', type: 'STABLE' }, // T2-T7
            ] as const;

            const manifestSpecs = [
                { id: '0x4898409f170de235844822a9545a54dbe637c049', type: 'STABLE' }, // 3-token USDC-USDT-DAI
                { id: '0x38b18996af15a435083b02055f6ba54350394743', type: 'WEIGHTED' }, // 20/80 WBTC-USDC
                { id: '0xfd6bb4aa6d62147bdbe1c8666f4f84863c597798', type: 'GYROE' }, // WETH-USDC ECLP
                { id: '0x1a9f43c8feb989e4d08adfd03084bc9c1edbb7c6', type: 'WEIGHTED' }, // 50/50 T1-USDC
                { id: '0x310ae5f8d67fac313f5a47ac0dfff7df216c8e79', type: 'WEIGHTED' }, // 50/50 WBTC-AAVE
            ] as const;

            const boostedSpecs = [
                { id: '0xd0d0f7908328d5de430e741f5376db1aae7b60b3', type: 'WEIGHTED' }, // stataEthWBTC-stataEthAAVE (v1)
                { id: '0x8e06ef1a2e854feaee0a83510acd05f8e443fa4f', type: 'WEIGHTED' }, // stataEthWBTC-stataEthAAVE (manifest)
                { id: '0x131a121bda71ed810bcaf2ac9079214925e59c18', type: 'Buffer' }, // stataEthWBTC
                { id: '0x56771cef0cb422e125564cccc98bb05fdc718e77', type: 'Buffer' }, // stataEthAAVE
            ] as const;

            const [rawKnown, rawCluster, rawManifest, rawBoosted] = await Promise.all([
                Promise.all(
                    KNOWN_POOLS.map((p) =>
                        fetchOnChainPool(
                            rpcUrl,
                            chainId,
                            blockNumber,
                            p.type === 'ECLP' ? 'GYROE' : p.type,
                            p.id as Address,
                        ),
                    ),
                ),
                Promise.all(
                    clusterSpecs.map((p) => fetchOnChainPool(rpcUrl, chainId, blockNumber, p.type, p.id as Address)),
                ),
                Promise.all(
                    manifestSpecs.map((p) => fetchOnChainPool(rpcUrl, chainId, blockNumber, p.type, p.id as Address)),
                ),
                Promise.all(
                    boostedSpecs.map((p) => fetchOnChainPool(rpcUrl, chainId, blockNumber, p.type, p.id as Address)),
                ),
            ]);

            knownPrismaPools = mapPools(rawKnown as any);
            clusterPrismaPools = mapPools(rawCluster as any);
            manifestPrismaPools = mapPools(rawManifest as any);
            const mappedBoostedPools = mapPools(rawBoosted as any);
            boostedPrismaPool = mappedBoostedPools[0];
            manifestBoostedPrismaPool = mappedBoostedPools[1];
            boostedBufferPools = mapBufferPools(rawBoosted as any);
        }, 60_000);

        test('matches live BatchRouter with 0-wei drift on single-hop GivenIn and GivenOut across KNOWN_POOLS (WEIGHTED, STABLE, ECLP)', async () => {
            for (const prismaPool of knownPrismaPools) {
                const t0 = new Token(
                    chainId,
                    prismaPool.tokens[0].address as Address,
                    prismaPool.tokens[0].token.decimals,
                );
                const t1 = new Token(
                    chainId,
                    prismaPool.tokens[1].address as Address,
                    prismaPool.tokens[1].token.decimals,
                );
                const amountInRaw = 10n ** BigInt(Math.max(1, t0.decimals - 2)); // 0.01 tokenIn

                const sorPathsIn = await SOR.getPathsWithPools(
                    t0,
                    t1,
                    SwapKind.GivenIn,
                    amountInRaw,
                    [prismaPool],
                    [],
                    3,
                    new Map(),
                );
                expect(sorPathsIn).not.toBeNull();

                const onChainExactIn = await queryBatchRouterWithViem({
                    client,
                    batchRouterAddress,
                    swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenIn, sorPathsIn!),
                    blockNumber,
                });
                expect(onChainExactIn.totalAmounts[0]).toBe(getOutputAmount(sorPathsIn!).amount);

                const targetOutRaw = getOutputAmount(sorPathsIn!).amount;
                const sorPathsOut = await SOR.getPathsWithPools(
                    t0,
                    t1,
                    SwapKind.GivenOut,
                    targetOutRaw,
                    [prismaPool],
                    [],
                    3,
                    new Map(),
                );
                expect(sorPathsOut).not.toBeNull();

                const onChainExactOut = await queryBatchRouterWithViem({
                    client,
                    batchRouterAddress,
                    swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenOut, sorPathsOut!),
                    blockNumber,
                });
                expect(onChainExactOut.totalAmounts[0]).toBe(getInputAmount(sorPathsOut!).amount);
            }
        }, 60_000);

        test('matches live BatchRouter with 0-wei drift on 2-path refined split swaps (GivenIn & GivenOut) across parallel Sepolia pools', async () => {
            const parallelWeightedPools = clusterPrismaPools.slice(0, 2);

            // GivenIn: 400 T0 exceeds single pool 30% limit (~270), triggering a 2-path refined split
            const sorSplitIn = await SOR.getPathsWithPools(
                T0,
                T1,
                SwapKind.GivenIn,
                parseEther('400'),
                parallelWeightedPools,
                [],
                3,
                new Map(),
            );
            expect(sorSplitIn).not.toBeNull();
            expect(sorSplitIn).toHaveLength(2);

            const onChainSplitIn = await queryBatchRouterWithViem({
                client,
                batchRouterAddress,
                swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenIn, sorSplitIn!),
                blockNumber,
            });
            expect(onChainSplitIn.pathAmounts).toEqual(sorSplitIn!.map((p) => p.outputAmount.amount));
            expect(onChainSplitIn.totalAmounts[0]).toBe(getOutputAmount(sorSplitIn!).amount);

            // GivenOut: 300 T1 exceeds single pool 30% limit, triggering a 2-path refined split
            const sorSplitOut = await SOR.getPathsWithPools(
                T0,
                T1,
                SwapKind.GivenOut,
                parseEther('300'),
                parallelWeightedPools,
                [],
                3,
                new Map(),
            );
            expect(sorSplitOut).not.toBeNull();
            expect(sorSplitOut).toHaveLength(2);

            const onChainSplitOut = await queryBatchRouterWithViem({
                client,
                batchRouterAddress,
                swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenOut, sorSplitOut!),
                blockNumber,
            });
            expect(onChainSplitOut.pathAmounts).toEqual(sorSplitOut!.map((p) => p.inputAmount.amount));
            expect(onChainSplitOut.totalAmounts[0]).toBe(getInputAmount(sorSplitOut!).amount);
        }, 60_000);

        test('matches live BatchRouter with 0-wei drift on 3-hop heterogeneous routes (WEIGHTED -> ECLP -> STABLE) for GivenIn and GivenOut', async () => {
            // T1 -> T0 (WEIGHTED) -> T2 (ECLP) -> T7 (STABLE)
            const sorMultiHopIn = await SOR.getPathsWithPools(
                T1,
                T7,
                SwapKind.GivenIn,
                parseEther('50'),
                clusterPrismaPools,
                [],
                3,
                new Map(),
            );
            expect(sorMultiHopIn).not.toBeNull();
            expect(sorMultiHopIn![0].pools).toHaveLength(3);

            const onChainMultiHopIn = await queryBatchRouterWithViem({
                client,
                batchRouterAddress,
                swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenIn, sorMultiHopIn!),
                blockNumber,
            });
            expect(onChainMultiHopIn.pathAmounts).toEqual(sorMultiHopIn!.map((p) => p.outputAmount.amount));
            expect(onChainMultiHopIn.totalAmounts[0]).toBe(getOutputAmount(sorMultiHopIn!).amount);

            const sorMultiHopOut = await SOR.getPathsWithPools(
                T1,
                T7,
                SwapKind.GivenOut,
                parseEther('50'),
                clusterPrismaPools,
                [],
                3,
                new Map(),
            );
            expect(sorMultiHopOut).not.toBeNull();
            expect(sorMultiHopOut![0].pools).toHaveLength(3);

            const onChainMultiHopOut = await queryBatchRouterWithViem({
                client,
                batchRouterAddress,
                swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenOut, sorMultiHopOut!),
                blockNumber,
            });
            expect(onChainMultiHopOut.pathAmounts).toEqual(sorMultiHopOut!.map((p) => p.inputAmount.amount));
            expect(onChainMultiHopOut.totalAmounts[0]).toBe(getInputAmount(sorMultiHopOut!).amount);
        }, 60_000);

        test('matches live BatchRouter with 0-wei drift on single-token Add Liquidity (token -> BPT) and Remove Liquidity (BPT -> token) for GivenIn and GivenOut', async () => {
            const targetPool = clusterPrismaPools[1]; // 0xa5bfaf67b334ef03b6c032421a2ad6ce2628ecae
            const bptToken = new Token(chainId, targetPool.address as Address, 18, 'BPT');

            for (const [tokenIn, tokenOut] of [
                [T0, bptToken], // Add Liquidity
                [bptToken, T1], // Remove Liquidity
            ] as const) {
                for (const swapKind of [SwapKind.GivenIn, SwapKind.GivenOut]) {
                    const sorPaths = await SOR.getPathsWithPools(
                        tokenIn,
                        tokenOut,
                        swapKind,
                        parseEther('1'),
                        [targetPool],
                        [],
                        3,
                        new Map(),
                    );
                    expect(sorPaths).not.toBeNull();

                    const onChainRes = await queryBatchRouterWithViem({
                        client,
                        batchRouterAddress,
                        swapPathInput: fromSorPathsToSwapPathInput(swapKind, sorPaths!),
                        blockNumber,
                    });
                    const expected =
                        swapKind === SwapKind.GivenIn
                            ? getOutputAmount(sorPaths!).amount
                            : getInputAmount(sorPaths!).amount;
                    expect(onChainRes.totalAmounts[0]).toBe(expected);
                }
            }
        }, 60_000);

        test('matches live BatchRouter on 3-step Boosted ERC-4626 swaps (WBTC -> stataEthWBTC -> stataEthAAVE -> AAVE) for GivenIn and GivenOut', async () => {
            const wbtcUnderlying = boostedBufferPools[0].underlyingToken;
            const aaveUnderlying = boostedBufferPools[1].underlyingToken;
            const WBTC = new Token(chainId, wbtcUnderlying.address, wbtcUnderlying.decimals, 'WBTC');
            const AAVE = new Token(chainId, aaveUnderlying.address, aaveUnderlying.decimals, 'AAVE');

            // GivenIn: 0.001 WBTC (100,000 sats) -> AAVE
            const sorBoostedIn = await SOR.getPathsWithPools(
                WBTC,
                AAVE,
                SwapKind.GivenIn,
                100_000n,
                [boostedPrismaPool],
                boostedBufferPools,
                3,
                new Map(),
            );
            expect(sorBoostedIn).not.toBeNull();
            expect(sorBoostedIn![0].isBuffer).toEqual([true, false, true]);

            const onChainBoostedIn = await queryBatchRouterWithViem({
                client,
                batchRouterAddress,
                swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenIn, sorBoostedIn!),
                blockNumber,
            });
            const sorAmountOut = Number(formatUnits(getOutputAmount(sorBoostedIn!).amount, AAVE.decimals));
            const onChainAmountOut = Number(formatUnits(onChainBoostedIn.totalAmounts[0], AAVE.decimals));
            expect(onChainAmountOut / sorAmountOut).toBeCloseTo(1, 3); // sub-bps ERC-4626 previewDeposit/previewRedeem parity

            // GivenOut: WBTC -> 0.1 AAVE
            const sorBoostedOut = await SOR.getPathsWithPools(
                WBTC,
                AAVE,
                SwapKind.GivenOut,
                100_000_000_000_000_000n,
                [boostedPrismaPool],
                boostedBufferPools,
                3,
                new Map(),
            );
            expect(sorBoostedOut).not.toBeNull();
            expect(sorBoostedOut![0].isBuffer).toEqual([true, false, true]);

            const onChainBoostedOut = await queryBatchRouterWithViem({
                client,
                batchRouterAddress,
                swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenOut, sorBoostedOut!),
                blockNumber,
            });
            const sorAmountIn = Number(formatUnits(getInputAmount(sorBoostedOut!).amount, WBTC.decimals));
            const onChainAmountIn = Number(formatUnits(onChainBoostedOut.totalAmounts[0], WBTC.decimals));
            expect(onChainAmountIn / sorAmountIn).toBeCloseTo(1, 3);
        }, 60_000);

        test('matches live BatchRouter with 0-wei drift across all 3 pairs of the 3-token StablePool (USDC/USDT/DAI, 6/6/18 decimals) for GivenIn and GivenOut', async () => {
            const stable3Pool = manifestPrismaPools[0]; // 0x4898409f170de235844822a9545a54dbe637c049
            expect(stable3Pool.tokens).toHaveLength(3);

            const poolTokens = stable3Pool.tokens.map(
                (pt) => new Token(chainId, pt.address as Address, pt.token.decimals),
            );
            const pairs = [
                [poolTokens[0], poolTokens[1]],
                [poolTokens[0], poolTokens[2]],
                [poolTokens[1], poolTokens[2]],
            ] as const;

            for (const [tokenIn, tokenOut] of pairs) {
                const amountInRaw = 100n * 10n ** BigInt(tokenIn.decimals); // 100 units

                const sorPathsIn = await SOR.getPathsWithPools(
                    tokenIn,
                    tokenOut,
                    SwapKind.GivenIn,
                    amountInRaw,
                    [stable3Pool],
                    [],
                    3,
                    new Map(),
                );
                expect(sorPathsIn).not.toBeNull();

                const onChainExactIn = await queryBatchRouterWithViem({
                    client,
                    batchRouterAddress,
                    swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenIn, sorPathsIn!),
                    blockNumber,
                });
                expect(onChainExactIn.totalAmounts[0]).toBe(getOutputAmount(sorPathsIn!).amount);

                const targetOutRaw = getOutputAmount(sorPathsIn!).amount;
                const sorPathsOut = await SOR.getPathsWithPools(
                    tokenIn,
                    tokenOut,
                    SwapKind.GivenOut,
                    targetOutRaw,
                    [stable3Pool],
                    [],
                    3,
                    new Map(),
                );
                expect(sorPathsOut).not.toBeNull();

                const onChainExactOut = await queryBatchRouterWithViem({
                    client,
                    batchRouterAddress,
                    swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenOut, sorPathsOut!),
                    blockNumber,
                });
                expect(onChainExactOut.totalAmounts[0]).toBe(getInputAmount(sorPathsOut!).amount);
            }
        }, 60_000);

        test('matches live BatchRouter with 0-wei drift on manifest 20/80 WEIGHTED (WBTC/USDC), WETH/USDC ECLP, T1/USDC, and WBTC/AAVE pools for GivenIn and GivenOut', async () => {
            for (const prismaPool of manifestPrismaPools.slice(1)) {
                const t0 = new Token(
                    chainId,
                    prismaPool.tokens[0].address as Address,
                    prismaPool.tokens[0].token.decimals,
                );
                const t1 = new Token(
                    chainId,
                    prismaPool.tokens[1].address as Address,
                    prismaPool.tokens[1].token.decimals,
                );
                const amountInRaw = 10n ** BigInt(Math.max(1, t0.decimals - 3)); // 0.001 tokenIn

                const sorPathsIn = await SOR.getPathsWithPools(
                    t0,
                    t1,
                    SwapKind.GivenIn,
                    amountInRaw,
                    [prismaPool],
                    [],
                    3,
                    new Map(),
                );
                expect(sorPathsIn).not.toBeNull();

                const onChainExactIn = await queryBatchRouterWithViem({
                    client,
                    batchRouterAddress,
                    swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenIn, sorPathsIn!),
                    blockNumber,
                });
                expect(onChainExactIn.totalAmounts[0]).toBe(getOutputAmount(sorPathsIn!).amount);

                const targetOutRaw = getOutputAmount(sorPathsIn!).amount;
                const sorPathsOut = await SOR.getPathsWithPools(
                    t0,
                    t1,
                    SwapKind.GivenOut,
                    targetOutRaw,
                    [prismaPool],
                    [],
                    3,
                    new Map(),
                );
                expect(sorPathsOut).not.toBeNull();

                const onChainExactOut = await queryBatchRouterWithViem({
                    client,
                    batchRouterAddress,
                    swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenOut, sorPathsOut!),
                    blockNumber,
                });
                expect(onChainExactOut.totalAmounts[0]).toBe(getInputAmount(sorPathsOut!).amount);
            }
        }, 60_000);

        test('matches live BatchRouter with 0-wei drift on cross-decimal multi-hop (WBTC 8 dec -> USDC 6 dec -> T1 18 dec) for GivenIn and GivenOut', async () => {
            const wbtcUsdcPool = manifestPrismaPools[1]; // 0x38b18996af15a435083b02055f6ba54350394743
            const t1UsdcPool = manifestPrismaPools[3]; // 0x1a9f43c8feb989e4d08adfd03084bc9c1edbb7c6
            const WBTC = new Token(chainId, '0x29f2d40b0605204364af54ec677bd022da425d03', 8, 'WBTC');

            const sorMultiHopIn = await SOR.getPathsWithPools(
                WBTC,
                T1,
                SwapKind.GivenIn,
                100_000n, // 0.001 WBTC
                [wbtcUsdcPool, t1UsdcPool],
                [],
                3,
                new Map(),
            );
            expect(sorMultiHopIn).not.toBeNull();
            expect(sorMultiHopIn![0].pools).toHaveLength(2);

            const onChainMultiHopIn = await queryBatchRouterWithViem({
                client,
                batchRouterAddress,
                swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenIn, sorMultiHopIn!),
                blockNumber,
            });
            expect(onChainMultiHopIn.pathAmounts).toEqual(sorMultiHopIn!.map((p) => p.outputAmount.amount));
            expect(onChainMultiHopIn.totalAmounts[0]).toBe(getOutputAmount(sorMultiHopIn!).amount);

            const targetOutRaw = getOutputAmount(sorMultiHopIn!).amount;
            const sorMultiHopOut = await SOR.getPathsWithPools(
                WBTC,
                T1,
                SwapKind.GivenOut,
                targetOutRaw,
                [wbtcUsdcPool, t1UsdcPool],
                [],
                3,
                new Map(),
            );
            expect(sorMultiHopOut).not.toBeNull();
            expect(sorMultiHopOut![0].pools).toHaveLength(2);

            const onChainMultiHopOut = await queryBatchRouterWithViem({
                client,
                batchRouterAddress,
                swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenOut, sorMultiHopOut!),
                blockNumber,
            });
            expect(onChainMultiHopOut.pathAmounts).toEqual(sorMultiHopOut!.map((p) => p.inputAmount.amount));
            expect(onChainMultiHopOut.totalAmounts[0]).toBe(getInputAmount(sorMultiHopOut!).amount);
        }, 60_000);

        test('matches live BatchRouter on manifest 80/20 Boosted pool (0x8e06... with custom rateProviders) for GivenIn and GivenOut', async () => {
            const wbtcUnderlying = boostedBufferPools[0].underlyingToken;
            const aaveUnderlying = boostedBufferPools[1].underlyingToken;
            const WBTC = new Token(chainId, wbtcUnderlying.address, wbtcUnderlying.decimals, 'WBTC');
            const AAVE = new Token(chainId, aaveUnderlying.address, aaveUnderlying.decimals, 'AAVE');

            // GivenIn: 0.001 WBTC -> stataEthWBTC -> 0x8e06... -> stataEthAAVE -> AAVE
            const sorBoostedIn = await SOR.getPathsWithPools(
                WBTC,
                AAVE,
                SwapKind.GivenIn,
                100_000n,
                [manifestBoostedPrismaPool],
                boostedBufferPools,
                3,
                new Map(),
            );
            expect(sorBoostedIn).not.toBeNull();
            expect(sorBoostedIn![0].isBuffer).toEqual([true, false, true]);
            expect(sorBoostedIn![0].pools[1].address.toLowerCase()).toBe('0x8e06ef1a2e854feaee0a83510acd05f8e443fa4f');

            const onChainBoostedIn = await queryBatchRouterWithViem({
                client,
                batchRouterAddress,
                swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenIn, sorBoostedIn!),
                blockNumber,
            });
            const sorAmountOut = Number(formatUnits(getOutputAmount(sorBoostedIn!).amount, AAVE.decimals));
            const onChainAmountOut = Number(formatUnits(onChainBoostedIn.totalAmounts[0], AAVE.decimals));
            expect(onChainAmountOut / sorAmountOut).toBeCloseTo(1, 3);

            // GivenOut: WBTC -> 0.1 AAVE
            const sorBoostedOut = await SOR.getPathsWithPools(
                WBTC,
                AAVE,
                SwapKind.GivenOut,
                100_000_000_000_000_000n,
                [manifestBoostedPrismaPool],
                boostedBufferPools,
                3,
                new Map(),
            );
            expect(sorBoostedOut).not.toBeNull();
            expect(sorBoostedOut![0].isBuffer).toEqual([true, false, true]);

            const onChainBoostedOut = await queryBatchRouterWithViem({
                client,
                batchRouterAddress,
                swapPathInput: fromSorPathsToSwapPathInput(SwapKind.GivenOut, sorBoostedOut!),
                blockNumber,
            });
            const sorAmountIn = Number(formatUnits(getInputAmount(sorBoostedOut!).amount, WBTC.decimals));
            const onChainAmountIn = Number(formatUnits(onChainBoostedOut.totalAmounts[0], WBTC.decimals));
            expect(onChainAmountIn / sorAmountIn).toBeCloseTo(1, 3);
        }, 60_000);
    },
);
