import { Chain } from '@prisma/client';
import { SwapKind, Token, TokenAmount } from '@frontier-fi/maths';
import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import { PathWithAmount } from '../lib/path';
import { BufferPool } from '../lib/poolsV3/buffer/bufferPool';
import { WeightedPoolV3 } from '../lib/poolsV3/weighted/weightedPool';
import { Router } from '../lib/router';
import { BasePoolToken } from '../lib/utils';
import { mapRoutes, mapToSorSwapPaths } from './mapping';
import {
    poolTokenFactory,
    prismaPoolDynamicDataFactory,
    prismaPoolFactory,
    prismaPoolTokenFactory,
} from '../../../test/factories';

const tokenA = new Token(11155111, '0x000000000000000000000000000000000000000a', 6, 'USDC');
const tokenB = new Token(11155111, '0x000000000000000000000000000000000000000b', 18, 'WETH');

function createMockPath(inputRaw: bigint, outputRaw: bigint, poolId = '0x0000000000000000000000000000000000000001') {
    const pool = {
        id: poolId,
        address: poolId,
        poolType: 'Weighted',
        swapGivenIn: (_tIn: Token, _tOut: Token, amount: TokenAmount) =>
            TokenAmount.fromRawAmount(tokenB, (outputRaw * amount.amount) / inputRaw),
        swapGivenOut: (_tIn: Token, _tOut: Token, amount: TokenAmount) =>
            TokenAmount.fromRawAmount(tokenA, (inputRaw * amount.amount) / outputRaw),
    } as any;

    return new PathWithAmount([tokenA, tokenB], [pool], [false], TokenAmount.fromRawAmount(tokenA, inputRaw));
}

function createWeightedPool(id: `0x${string}`, balanceA = '100000', balanceB = '100000', swapFee = '0.003') {
    return WeightedPoolV3.fromPrismaPool(
        prismaPoolFactory.build({
            id,
            address: id,
            chain: Chain.SEPOLIA,
            type: 'WEIGHTED',
            protocolVersion: 3,
            tokens: [
                prismaPoolTokenFactory.build({
                    address: tokenA.address,
                    index: 0,
                    balance: balanceA,
                    weight: '0.5',
                    priceRate: '1',
                    token: poolTokenFactory.build({ address: tokenA.address, decimals: 6 }),
                }),
                prismaPoolTokenFactory.build({
                    address: tokenB.address,
                    index: 1,
                    balance: balanceB,
                    weight: '0.5',
                    priceRate: '1',
                    token: poolTokenFactory.build({ address: tokenB.address, decimals: 18 }),
                }),
            ],
            dynamicData: prismaPoolDynamicDataFactory.build({
                swapFee,
                aggregateSwapFee: '0.5',
                totalShares: balanceA,
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

describe('SOR mapping utils', () => {
    it('formats tokenInAmount and tokenOutAmount in human-readable form and maps single swap output', async () => {
        // 25 USDC (6 decimals) -> 0.01 WETH (18 decimals)
        const path = createMockPath(25_000_000n, 10_000_000_000_000_000n);

        const result = await mapToSorSwapPaths([path], 'EXACT_IN', 'SEPOLIA', 3);

        expect(result.tokenInAmount).toBe('25');
        expect(result.tokenOutAmount).toBe('0.01');
        expect(result.swapAmount).toBe('25');
        expect(result.returnAmount).toBe('0.01');
        expect(result.routes).toHaveLength(1);
        expect(result.routes[0].share).toBe(1);
        expect(result.routes[0].tokenInAmount).toBe('25');
        expect(result.routes[0].tokenOutAmount).toBe('0.01');
        expect(result.routes[0].hops[0].tokenOutAmount).toBe('0.01');
        expect(result.swaps).toEqual([
            {
                poolId: '0x0000000000000000000000000000000000000001',
                assetInIndex: 0,
                assetOutIndex: 1,
                amount: '25000000',
                userData: '0x',
            },
        ]);
    });

    it('calculates proportional route shares for split batch swaps', () => {
        const path75 = createMockPath(
            75_000_000n,
            30_000_000_000_000_000n,
            '0x0000000000000000000000000000000000000001',
        );
        const path25 = createMockPath(
            25_000_000n,
            10_000_000_000_000_000n,
            '0x0000000000000000000000000000000000000002',
        );

        const routes = mapRoutes([path75, path25]);

        expect(routes).toHaveLength(2);
        expect(routes[0].share).toBeCloseTo(0.75);
        expect(routes[1].share).toBeCloseTo(0.25);
        expect(routes[0].tokenOutAmount).toBe('0.03');
        expect(routes[1].tokenOutAmount).toBe('0.01');
    });

    it('populates step-accurate tokenInAmount and tokenOutAmount on route hops when path starts and ends with ERC-4626 buffers', () => {
        const wTokenA = new Token(11155111, '0x00000000000000000000000000000000000000aa', 6, 'wUSDC');
        const wTokenB = new Token(11155111, '0x00000000000000000000000000000000000000bb', 18, 'wWETH');

        const bufferIn = {
            id: wTokenA.address,
            address: wTokenA.address,
            poolType: 'Buffer',
            // 25 USDC wraps into 20 wUSDC (rate = 1.25)
            swapGivenIn: () => TokenAmount.fromRawAmount(wTokenA, 20_000_000n),
            swapGivenInGreaterThanBufferLimit: () => false,
            getLimitAmountSwap: () => 1_000_000_000_000n,
        } as any;
        const boostedPool = {
            id: '0x0000000000000000000000000000000000000099',
            address: '0x0000000000000000000000000000000000000099',
            poolType: 'Stable',
            // 20 wUSDC swaps into 0.008 wWETH
            swapGivenIn: () => TokenAmount.fromRawAmount(wTokenB, 8_000_000_000_000_000n),
        } as any;
        const bufferOut = {
            id: wTokenB.address,
            address: wTokenB.address,
            poolType: 'Buffer',
            // 0.008 wWETH unwraps into 0.01 WETH (rate = 1.25)
            swapGivenIn: () => TokenAmount.fromRawAmount(tokenB, 10_000_000_000_000_000n),
            swapGivenInGreaterThanBufferLimit: () => false,
            getLimitAmountSwap: () => 1_000_000_000_000_000_000_000n,
        } as any;

        const boostedPath = new PathWithAmount(
            [tokenA, wTokenA, wTokenB, tokenB],
            [bufferIn, boostedPool, bufferOut],
            [true, false, true],
            TokenAmount.fromRawAmount(tokenA, 25_000_000n),
        );

        const routes = mapRoutes([boostedPath]);

        expect(routes).toHaveLength(1);
        expect(routes[0].tokenIn).toBe(tokenA.address);
        expect(routes[0].tokenOut).toBe(tokenB.address);
        expect(routes[0].tokenInAmount).toBe('25');
        expect(routes[0].tokenOutAmount).toBe('0.01');
        expect(routes[0].hops).toHaveLength(1);
        expect(routes[0].hops[0].poolId).toBe(boostedPool.id);
        expect(routes[0].hops[0].tokenIn).toBe(wTokenA.address);
        expect(routes[0].hops[0].tokenOut).toBe(wTokenB.address);
        expect(routes[0].hops[0].tokenInAmount).toBe('20');
        expect(routes[0].hops[0].tokenOutAmount).toBe('0.008');
    });

    it('computes accurate curve priceImpact independent of static swap fees across EXACT_IN, EXACT_OUT, and split routes', async () => {
        // 1. Linear mock path has 0% curve slippage
        const linearPath = createMockPath(25_000_000n, 10_000_000_000_000_000n);
        const linearResult = await mapToSorSwapPaths([linearPath], 'EXACT_IN', 'SEPOLIA', 3);
        expect(linearResult.priceImpact.error).toBeUndefined();
        expect(linearResult.priceImpact.priceImpact).toBe('0.0000');

        // 2. 50/50 Weighted pool with 100,000 USDC and 100,000 WETH:
        //    Swapping 1,000 USDC (1% of reserve) has theoretical curve impact: 1 - 100,000 / 101,000 ≈ 0.0099 (0.99%)
        //    regardless of whether the pool charges a 0.30% or 1.00% static swap fee.
        const poolLowFee = createWeightedPool(
            '0x0000000000000000000000000000000000000101',
            '100000',
            '100000',
            '0.003',
        );
        const poolHighFee = createWeightedPool(
            '0x0000000000000000000000000000000000000102',
            '100000',
            '100000',
            '0.01',
        );

        const pathLowFeeIn = new PathWithAmount(
            [tokenA, tokenB],
            [poolLowFee],
            [false],
            TokenAmount.fromRawAmount(tokenA, 1_000_000_000n), // 1,000 USDC
        );
        const pathHighFeeIn = new PathWithAmount(
            [tokenA, tokenB],
            [poolHighFee],
            [false],
            TokenAmount.fromRawAmount(tokenA, 1_000_000_000n), // 1,000 USDC
        );

        const resLowFee = await mapToSorSwapPaths([pathLowFeeIn], 'EXACT_IN', 'SEPOLIA', 3);
        const resHighFee = await mapToSorSwapPaths([pathHighFeeIn], 'EXACT_IN', 'SEPOLIA', 3);

        expect(resLowFee.priceImpact.error).toBeUndefined();
        expect(resLowFee.priceImpact.priceImpact).toBe('0.0099');
        // Static swap fee cancels out, leaving pure curve impact (~0.99%)
        expect(resHighFee.priceImpact.priceImpact).toBe('0.0098');

        // 3. EXACT_IN <-> EXACT_OUT duality: quoting the exact same trade as EXACT_OUT yields the same priceImpact
        const pathLowFeeOut = new PathWithAmount([tokenA, tokenB], [poolLowFee], [false], pathLowFeeIn.outputAmount);
        const resExactOut = await mapToSorSwapPaths([pathLowFeeOut], 'EXACT_OUT', 'SEPOLIA', 3);
        expect(resExactOut.priceImpact.error).toBeUndefined();
        expect(resExactOut.priceImpact.priceImpact).toBe(resLowFee.priceImpact.priceImpact);

        // 4. Splitting 1,000 USDC 50/50 across two identical 100,000 USDC pools cuts priceImpact in half (~0.50%)
        const poolTwin = createWeightedPool('0x0000000000000000000000000000000000000103', '100000', '100000', '0.003');
        const router = new Router();
        const splitPaths = router.getBestPaths(
            [
                pathLowFeeIn,
                new PathWithAmount(
                    [tokenA, tokenB],
                    [poolTwin],
                    [false],
                    TokenAmount.fromRawAmount(tokenA, 1_000_000_000n),
                ),
            ],
            SwapKind.GivenIn,
            TokenAmount.fromRawAmount(tokenA, 1_000_000_000n),
        )!;
        expect(splitPaths).toHaveLength(2);
        const resSplit = await mapToSorSwapPaths(splitPaths, 'EXACT_IN', 'SEPOLIA', 3);
        expect(resSplit.priceImpact.error).toBeUndefined();
        expect(resSplit.priceImpact.priceImpact).toBe('0.0050');

        // 5. Small probe outputs (< 1,000 raw units) step up to a larger probe divisor to avoid quantization error,
        //    and dust swaps that cannot be probed populate priceImpact.error instead of returning '0.0000'
        const wbtc = new Token(11155111, '0x000000000000000000000000000000000000000c', 8, 'WBTC');
        const wbtcPool = {
            id: '0x0000000000000000000000000000000000000104',
            address: '0x0000000000000000000000000000000000000104',
            poolType: 'Weighted',
            // 10 USDC (10_000_000n) -> 10,900 satoshis (at divisor 1000n, integer division truncates 10.9 -> 10n;
            // at divisor 10n, 1_000_000n -> 1,090n satoshis >= 1,000n floor with zero truncation error)
            swapGivenIn: (_tIn: Token, _tOut: Token, amount: TokenAmount) =>
                TokenAmount.fromRawAmount(wbtc, (10_900n * amount.amount) / 10_000_000n),
        } as any;
        const smallWbtcPath = new PathWithAmount(
            [tokenA, wbtc],
            [wbtcPool],
            [false],
            TokenAmount.fromRawAmount(tokenA, 10_000_000n),
        );
        const resSmallWbtc = await mapToSorSwapPaths([smallWbtcPath], 'EXACT_IN', 'SEPOLIA', 3);
        expect(resSmallWbtc.priceImpact.error).toBeUndefined();
        expect(resSmallWbtc.priceImpact.priceImpact).toBe('0.0000');

        const dustPath = createMockPath(500n, 500n);
        const resDust = await mapToSorSwapPaths([dustPath], 'EXACT_IN', 'SEPOLIA', 3);
        expect(resDust.priceImpact.priceImpact).toBeUndefined();
        expect(resDust.priceImpact.error).toBeDefined();

        // 6. 2-decimal ERC4626 buffer routes (e.g. 200 EURS = 20,000 raw where 1/10 probe = 2,000 raw < minWrapAmount 10,000)
        //    compute clean priceImpact via skipMinWrapCheck, and pure-buffer wraps report 0.0000 impact
        const eurs = new Token(11155111, '0x00000000000000000000000000000000000000ee', 2, 'EURS');
        const stataEurs = new Token(11155111, '0x00000000000000000000000000000000000000ef', 2, 'stataEURS');
        const eursBuffer = new BufferPool(
            stataEurs.address as `0x${string}`,
            stataEurs.address as `0x${string}`,
            11155111,
            1_250_000_000_000_000_000n, // 1.25 EURS per stataEURS
            new BasePoolToken(stataEurs, 1_000_000n, 0),
            new BasePoolToken(eurs, 1_000_000n, 1),
            10_000_000n,
            10_000_000n,
            10_000n,
        );

        const pureWrapPath = new PathWithAmount(
            [eurs, stataEurs],
            [eursBuffer],
            [true],
            TokenAmount.fromRawAmount(eurs, 20_000n), // 200 EURS -> 160 stataEURS (16,000 raw)
        );
        const resPureWrap = await mapToSorSwapPaths([pureWrapPath], 'EXACT_IN', 'SEPOLIA', 3);
        expect(resPureWrap.priceImpact.error).toBeUndefined();
        expect(resPureWrap.priceImpact.priceImpact).toBe('0.0000');

        const boostedEursPool = WeightedPoolV3.fromPrismaPool(
            prismaPoolFactory.build({
                id: '0x0000000000000000000000000000000000000105',
                address: '0x0000000000000000000000000000000000000105',
                chain: Chain.SEPOLIA,
                type: 'WEIGHTED',
                protocolVersion: 3,
                tokens: [
                    prismaPoolTokenFactory.build({
                        address: stataEurs.address,
                        index: 0,
                        balance: '16000',
                        weight: '0.5',
                        priceRate: '1.25',
                        token: poolTokenFactory.build({ address: stataEurs.address, decimals: 2 }),
                    }),
                    prismaPoolTokenFactory.build({
                        address: wbtc.address,
                        index: 1,
                        balance: '0.2',
                        weight: '0.5',
                        priceRate: '1',
                        token: poolTokenFactory.build({ address: wbtc.address, decimals: 8 }),
                    }),
                ],
                dynamicData: prismaPoolDynamicDataFactory.build({
                    swapFee: '0.003',
                    aggregateSwapFee: '0.5',
                    totalShares: '100',
                }),
                liquidityManagement: {
                    disableUnbalancedLiquidity: false,
                    enableAddLiquidityCustom: false,
                    enableDonation: false,
                    enableRemoveLiquidityCustom: false,
                },
            }),
        );
        const boostedEursPath = new PathWithAmount(
            [eurs, stataEurs, wbtc],
            [eursBuffer, boostedEursPool],
            [true, false],
            TokenAmount.fromRawAmount(eurs, 20_000n), // 200 EURS (~1% of pool reserve -> ~0.99% curve impact)
        );
        const resBoostedEurs = await mapToSorSwapPaths([boostedEursPath], 'EXACT_IN', 'SEPOLIA', 3);
        expect(resBoostedEurs.priceImpact.error).toBeUndefined();
        // At 200 EURS (20,000 raw), divisor=10 probes 20 EURS (0.1% of reserve vs 1% full swap => ~0.89% relative slippage)
        expect(resBoostedEurs.priceImpact.priceImpact).toBe('0.0089');
    });
});
