import { Chain } from '@prisma/client';
import { SwapKind, Token, TokenAmount } from '@balancer/sdk';
import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import { PathWithAmount } from '../lib/path';
import { WeightedPoolV3 } from '../lib/poolsV3/weighted/weightedPool';
import { Router } from '../lib/router';
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

    it('populates non-zero tokenInAmount and tokenOutAmount on route hops when path starts and ends with ERC-4626 buffers', () => {
        const wTokenA = new Token(11155111, '0x00000000000000000000000000000000000000aa', 6, 'wUSDC');
        const wTokenB = new Token(11155111, '0x00000000000000000000000000000000000000bb', 18, 'wWETH');

        const bufferIn = {
            id: wTokenA.address,
            address: wTokenA.address,
            poolType: 'Buffer',
            swapGivenIn: () => TokenAmount.fromRawAmount(wTokenA, 25_000_000n),
            swapGivenInGreaterThanBufferLimit: () => false,
            getLimitAmountSwap: () => 1_000_000_000_000n,
        } as any;
        const boostedPool = {
            id: '0x0000000000000000000000000000000000000099',
            address: '0x0000000000000000000000000000000000000099',
            poolType: 'Stable',
            swapGivenIn: () => TokenAmount.fromRawAmount(wTokenB, 10_000_000_000_000_000n),
        } as any;
        const bufferOut = {
            id: wTokenB.address,
            address: wTokenB.address,
            poolType: 'Buffer',
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
        expect(routes[0].hops).toHaveLength(1);
        expect(routes[0].hops[0].poolId).toBe(boostedPool.id);
        expect(routes[0].hops[0].tokenInAmount).toBe('25');
        expect(routes[0].hops[0].tokenOutAmount).toBe('0.01');
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
    });
});
