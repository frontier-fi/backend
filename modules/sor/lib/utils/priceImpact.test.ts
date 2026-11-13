import { SwapKind, Token, TokenAmount, WAD } from '@frontier-fi/maths';
import { describe, expect, it } from 'vitest';
import { PathWithAmount } from '../path';
import { BufferPool } from '../poolsV3/buffer/bufferPool';
import { StablePoolV3 } from '../poolsV3/stable/stablePool';
import { WeightedPoolV3 } from '../poolsV3/weighted/weightedPool';
import { WeightedPoolTokenWithRate } from '../poolsV3/weighted/weightedPoolTokenWithRate';
import { mapToSorSwapPaths } from '../../utils/mapping';
import { BasePoolToken } from './basePoolToken';
import { PoolTokenWithRate } from './poolTokenWithRate';

const tokenIn = new Token(11155111, '0x000000000000000000000000000000000000000a', 18);
const tokenOut = new Token(11155111, '0x000000000000000000000000000000000000000b', 18);
const balance = 1_000_000_000n;
const swapFee = 3_000_000_000_000_000n;
const liquidityManagement = {
    disableUnbalancedLiquidity: false,
    enableAddLiquidityCustom: false,
    enableDonation: false,
    enableRemoveLiquidityCustom: false,
};

function createPool(type: 'weighted' | 'stable') {
    const address = '0x0000000000000000000000000000000000000010';
    if (type === 'weighted') {
        return new WeightedPoolV3(
            address,
            address,
            'SEPOLIA',
            swapFee,
            0n,
            2n * balance,
            [tokenIn, tokenOut].map(
                (token, index) => new WeightedPoolTokenWithRate(token, balance, index, WAD, WAD / 2n),
            ),
            [],
            liquidityManagement,
        );
    }
    return new StablePoolV3(
        address,
        address,
        'SEPOLIA',
        100_000n,
        swapFee,
        0n,
        [tokenIn, tokenOut].map((token, index) => new PoolTokenWithRate(token, balance, index, WAD)),
        2n * balance,
        [],
        liquidityManagement,
    );
}

describe('price impact below the Vault minimum trade amount', () => {
    it.each([
        { type: 'weighted' as const, kind: SwapKind.GivenIn },
        { type: 'weighted' as const, kind: SwapKind.GivenOut },
        { type: 'stable' as const, kind: SwapKind.GivenIn },
        { type: 'stable' as const, kind: SwapKind.GivenOut },
    ])('calculates $type price impact for kind=$kind without changing executable quotes', async ({ type, kind }) => {
        const pool = createPool(type);
        const amountToken = kind === SwapKind.GivenIn ? tokenIn : tokenOut;
        const fullAmount = TokenAmount.fromRawAmount(amountToken, 9_000_000n);
        const probeAmount = TokenAmount.fromRawAmount(amountToken, 900_000n);
        const quote = (amount: TokenAmount) =>
            kind === SwapKind.GivenIn
                ? pool.swapGivenIn(tokenIn, tokenOut, amount)
                : pool.swapGivenOut(tokenIn, tokenOut, amount);
        const path = new PathWithAmount([tokenIn, tokenOut], [pool], [false], fullAmount);
        const before = pool.getPoolState();
        const fullQuote = quote(fullAmount).amount;

        expect(() => quote(probeAmount)).toThrow('TradeAmountTooSmall');
        const result = await mapToSorSwapPaths(
            [path],
            kind === SwapKind.GivenIn ? 'EXACT_IN' : 'EXACT_OUT',
            'SEPOLIA',
            3,
        );
        expect(result.priceImpact.error).toBeUndefined();
        const impact = Number(result.priceImpact.priceImpact);
        expect(Number.isFinite(impact)).toBe(true);
        const feeMultiplier = Number(WAD - swapFee) / Number(WAD);
        const expected =
            kind === SwapKind.GivenIn
                ? 1 - Number(path.outputAmount.amount) / (Number(fullAmount.amount) * feeMultiplier)
                : 1 - Number(fullAmount.amount) / (Number(path.inputAmount.amount) * feeMultiplier);
        expect(impact).toBeCloseTo(expected, 3);
        expect(pool.getPoolState()).toEqual(before);
        expect(pool.tokens.map((token) => token.amount)).toEqual([balance, balance]);
        expect(quote(fullAmount).amount).toBe(fullQuote);
        expect(() => quote(probeAmount)).toThrow('TradeAmountTooSmall');
    });

    it.each([SwapKind.GivenIn, SwapKind.GivenOut])('handles split routes containing buffers (%s)', async (kind) => {
        const underlying = new Token(11155111, '0x000000000000000000000000000000000000000c', 18);
        const buffer = new BufferPool(
            tokenIn.address,
            tokenIn.address,
            11155111,
            WAD,
            new BasePoolToken(tokenIn, balance, 0),
            new BasePoolToken(underlying, balance, 1),
            balance,
            balance,
        );
        const pool = createPool('weighted');
        const tokens = [underlying, tokenIn, tokenOut];
        const amountToken = kind === SwapKind.GivenIn ? underlying : tokenOut;
        const paths = [4_000_000n, 5_000_000n].map(
            (amount) =>
                new PathWithAmount(
                    tokens,
                    [buffer, pool],
                    [true, false],
                    TokenAmount.fromRawAmount(amountToken, amount),
                ),
        );
        const result = await mapToSorSwapPaths(
            paths,
            kind === SwapKind.GivenIn ? 'EXACT_IN' : 'EXACT_OUT',
            'SEPOLIA',
            3,
        );
        expect(result.priceImpact.error).toBeUndefined();
        expect(Number.isFinite(Number(result.priceImpact.priceImpact))).toBe(true);
        expect(Number(result.priceImpact.priceImpact)).toBeGreaterThan(0);
        expect(pool.tokens.map((token) => token.amount)).toEqual([balance, balance]);
        expect(buffer.tokens.map((token) => token.amount)).toEqual([balance, balance]);
        expect(buffer.maxDeposit).toBe(balance);
        expect(buffer.maxWithdraw).toBe(balance);
        expect(() => buffer.swapGivenIn(underlying, tokenIn, TokenAmount.fromRawAmount(underlying, 9_000n))).toThrow(
            'wrapAmountTooSmall',
        );
        expect(() => pool.swapGivenIn(tokenIn, tokenOut, TokenAmount.fromRawAmount(tokenIn, 900_000n))).toThrow(
            'TradeAmountTooSmall',
        );
    });
});
