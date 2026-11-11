import { SwapKind, Token, TokenAmount } from '@balancer/sdk';
import { maxUint256 } from 'viem';
import { BufferPool } from './bufferPool';
import { BufferPoolData } from '../../../utils/data';

const WAD = 10n ** 18n;
const MAIN = '0x1111111111111111111111111111111111111111' as const;
const UNDERLYING = '0x2222222222222222222222222222222222222222' as const;

function buffer(overrides: Partial<BufferPoolData> = {}): BufferPool {
    return BufferPool.fromBufferPoolData({
        // The buffer's address is the ERC4626 token. The vault treats that token as the share token.
        poolId: MAIN,
        address: MAIN,
        chainId: 11155111,
        poolType: 'Buffer',
        unwrapRate: WAD,
        maxDeposit: 1000n * WAD,
        maxWithdraw: 1000n * WAD,
        mainToken: { address: MAIN, decimals: 18, balance: 10n * WAD },
        underlyingToken: { address: UNDERLYING, decimals: 18, balance: 10n * WAD },
        ...overrides,
    });
}

describe('BufferPool', () => {
    test('wraps and unwraps 1:1 when the rate is 1 and decimals match', () => {
        const pool = buffer();
        const main = pool.tokens[0].token;
        const underlying = pool.tokens[1].token;
        const one = 1n * WAD;

        expect(pool.swapGivenIn(underlying, main, TokenAmount.fromRawAmount(underlying, one)).amount).toBe(one);
        expect(pool.swapGivenIn(main, underlying, TokenAmount.fromRawAmount(main, one)).amount).toBe(one);
        expect(pool.swapGivenOut(underlying, main, TokenAmount.fromRawAmount(main, one)).amount).toBe(one);
    });

    test('scales between 18 and 6 decimals', () => {
        const pool = buffer({
            mainToken: { address: MAIN, decimals: 18, balance: 10n * WAD },
            underlyingToken: { address: UNDERLYING, decimals: 6, balance: 10n * 10n ** 6n },
            maxDeposit: 1000n * 10n ** 6n,
            maxWithdraw: 1000n * 10n ** 6n,
        });
        const main = pool.tokens[0].token;
        const underlying = pool.tokens[1].token;

        expect(pool.swapGivenIn(underlying, main, TokenAmount.fromRawAmount(underlying, 1_000_000n)).amount).toBe(WAD);
        expect(pool.swapGivenIn(main, underlying, TokenAmount.fromRawAmount(main, WAD)).amount).toBe(1_000_000n);
    });

    test('unwrapRate is underlying received per main token', () => {
        const pool = buffer({ unwrapRate: 2n * WAD });
        const main = pool.tokens[0].token;
        const underlying = pool.tokens[1].token;

        expect(pool.swapGivenIn(main, underlying, TokenAmount.fromRawAmount(main, WAD)).amount).toBe(2n * WAD);
        expect(pool.swapGivenIn(underlying, main, TokenAmount.fromRawAmount(underlying, 2n * WAD)).amount).toBe(WAD);
    });

    test('computes single-step limit as max(internalBufferLimit, externalVaultLimit) across GivenIn and GivenOut', () => {
        // Small buffer (0.2 WAD / 0.2 WAD) with maxDeposit = 1 WAD caps at external maxDeposit (1 WAD)
        const smallBuffer = buffer({
            maxDeposit: WAD,
            mainToken: { address: MAIN, decimals: 18, balance: 2n * 10n ** 17n },
            underlyingToken: { address: UNDERLYING, decimals: 18, balance: 2n * 10n ** 17n },
        });
        expect(
            smallBuffer.getLimitAmountSwap(smallBuffer.tokens[1].token, smallBuffer.tokens[0].token, SwapKind.GivenIn),
        ).toBe(WAD);
        expect(
            smallBuffer.getLimitAmountSwap(smallBuffer.tokens[1].token, smallBuffer.tokens[0].token, SwapKind.GivenOut),
        ).toBe(WAD);

        // Deep buffer (10 WAD / 10 WAD) with maxDeposit = 1 WAD or 0n can still fulfill 10 WAD internally
        const deepBuffer = buffer({ maxDeposit: WAD });
        const underlying = deepBuffer.tokens[1].token;
        const main = deepBuffer.tokens[0].token;
        expect(deepBuffer.getLimitAmountSwap(underlying, main, SwapKind.GivenIn)).toBe(10n * WAD);
        expect(deepBuffer.getLimitAmountSwap(underlying, main, SwapKind.GivenOut)).toBe(10n * WAD);

        const pausedVault = buffer({ maxDeposit: 0n, maxWithdraw: 0n });
        expect(
            pausedVault.getLimitAmountSwap(pausedVault.tokens[1].token, pausedVault.tokens[0].token, SwapKind.GivenIn),
        ).toBe(10n * WAD);
        expect(
            pausedVault.getLimitAmountSwap(pausedVault.tokens[0].token, pausedVault.tokens[1].token, SwapKind.GivenIn),
        ).toBe(10n * WAD);

        // Imbalanced buffer (like Sepolia stataEthWBTC: 0.1666 wrapped, 0.0334 underlying, maxWithdraw = 0.4929)
        // bypasses the buffer and redeems up to the full 0.4929 maxWithdraw without rebalancing
        const imbalanced = buffer({
            maxWithdraw: 49_290_655n,
            mainToken: { address: MAIN, decimals: 8, balance: 16_657_946n },
            underlyingToken: { address: UNDERLYING, decimals: 8, balance: 3_339_432n },
        });
        expect(
            imbalanced.getLimitAmountSwap(imbalanced.tokens[0].token, imbalanced.tokens[1].token, SwapKind.GivenIn),
        ).toBe(49_290_655n);
        expect(
            imbalanced.getLimitAmountSwap(imbalanced.tokens[0].token, imbalanced.tokens[1].token, SwapKind.GivenOut),
        ).toBe(49_290_655n);
    });

    test('reports when a swap is larger than the buffer inventory', () => {
        const pool = buffer();
        const main = pool.tokens[0].token;
        const underlying = pool.tokens[1].token;

        expect(
            pool.swapGivenInGreaterThanBufferLimit(underlying, main, TokenAmount.fromRawAmount(underlying, 11n * WAD)),
        ).toBe(true);
        expect(
            pool.swapGivenInGreaterThanBufferLimit(underlying, main, TokenAmount.fromRawAmount(underlying, WAD)),
        ).toBe(false);
        expect(
            pool.swapGivenOutGreaterThanBufferLimit(main, underlying, TokenAmount.fromRawAmount(underlying, 11n * WAD)),
        ).toBe(true);
    });

    test('a copy quotes the same amount', () => {
        const pool = buffer();
        const copy = pool.copy();
        const amount = TokenAmount.fromRawAmount(pool.tokens[1].token, WAD);

        expect(copy.swapGivenIn(pool.tokens[1].token, pool.tokens[0].token, amount).amount).toBe(
            pool.swapGivenIn(pool.tokens[1].token, pool.tokens[0].token, amount).amount,
        );
        expect(pool.getNormalizedLiquidity(pool.tokens[0].token, pool.tokens[1].token)).toBe(maxUint256);
        expect(pool.getPoolState().poolType).toBe('Buffer');
    });

    test('rejects a token the buffer does not hold', () => {
        const pool = buffer();
        const stranger = new Token(11155111, '0x0000000000000000000000000000000000000004', 18);

        expect(() => pool.getPoolTokens(stranger, pool.tokens[0].token)).toThrow(/does not contain/);
    });

    test('decrements remaining GivenOut and GivenIn capacity when mutateBalances=true consumes external maxDeposit then internal buffer balance', () => {
        const pool = buffer({
            mainToken: { address: MAIN, decimals: 18, balance: 100n * WAD },
            underlyingToken: { address: UNDERLYING, decimals: 18, balance: 100n * WAD },
            maxDeposit: 400n * WAD,
            maxWithdraw: 400n * WAD,
        });
        const main = pool.tokens[0].token;
        const underlying = pool.tokens[1].token;

        // Single-step limit on a balanced 100/100 buffer with 400 maxDeposit is max(100, 400) = 400 WAD
        expect(pool.getLimitAmountSwap(underlying, main, SwapKind.GivenOut)).toBe(400n * WAD);
        expect(pool.getLimitAmountSwap(underlying, main, SwapKind.GivenIn)).toBe(400n * WAD);

        // Step 1: 350 WAD wrap (> 100 WAD buffer) routes through ERC4626, reducing maxDeposit to 50 WAD while keeping buffer 100/100
        pool.swapGivenOut(underlying, main, TokenAmount.fromRawAmount(main, 350n * WAD), true);
        expect(pool.maxDeposit).toBe(50n * WAD);
        expect(pool.getLimitAmountSwap(underlying, main, SwapKind.GivenOut)).toBe(100n * WAD);

        // Step 2: 60 WAD wrap (<= 100 WAD buffer) executes internally (main: 100 -> 40, maxDeposit stays 50 WAD),
        // so remaining single-step limit is max(40 WAD internal, 50 WAD external) = 50 WAD
        pool.swapGivenOut(underlying, main, TokenAmount.fromRawAmount(main, 60n * WAD), true);
        expect(pool.getLimitAmountSwap(underlying, main, SwapKind.GivenOut)).toBe(50n * WAD);

        // Step 3: 50 WAD wrap (> 40 WAD buffer) consumes the remaining 50 WAD of maxDeposit, leaving 40 WAD internal buffer
        pool.swapGivenOut(underlying, main, TokenAmount.fromRawAmount(main, 50n * WAD), true);
        expect(pool.maxDeposit).toBe(0n);
        expect(pool.getLimitAmountSwap(underlying, main, SwapKind.GivenOut)).toBe(40n * WAD);
        expect(pool.getLimitAmountSwap(underlying, main, SwapKind.GivenIn)).toBe(40n * WAD);
    });

    test('enforces minWrapAmount (10,000 raw) on both input and output raw amounts unless skipMinWrapCheck is true', () => {
        // Simulates Sepolia EURS / stataEthEURS (both 2 decimals, unwrapRate ≈ 1.251875 WAD)
        const eursBuffer = buffer({
            unwrapRate: 1_251_875_000_000_000_000n,
            mainToken: { address: MAIN, decimals: 2, balance: 100_000n },
            underlyingToken: { address: UNDERLYING, decimals: 2, balance: 100_000n },
            maxDeposit: 10_000_000n,
            maxWithdraw: 10_000_000n,
        });
        const stataEurs = eursBuffer.tokens[0].token;
        const eurs = eursBuffer.tokens[1].token;

        // 25 EURS (2,500 raw < 10,000) reverts on input
        expect(() => eursBuffer.swapGivenIn(eurs, stataEurs, TokenAmount.fromRawAmount(eurs, 2_500n))).toThrow(
            'wrapAmountTooSmall',
        );

        // 125 EURS (12,500 raw >= 10,000) yields 9,985 raw stataEthEURS (< 10,000) -> reverts on output!
        expect(() => eursBuffer.swapGivenIn(eurs, stataEurs, TokenAmount.fromRawAmount(eurs, 12_500n))).toThrow(
            'wrapAmountTooSmall',
        );

        // EXACT_OUT for 100 EURS (10,000 raw >= 10,000) burns 7,988 raw stataEthEURS (< 10,000) -> reverts on input!
        expect(() => eursBuffer.swapGivenOut(stataEurs, eurs, TokenAmount.fromRawAmount(eurs, 10_000n))).toThrow(
            'wrapAmountTooSmall',
        );

        // Read-only marginal spot probes (skipMinWrapCheck = true) bypass minWrapAmount
        expect(
            eursBuffer.swapGivenIn(eurs, stataEurs, TokenAmount.fromRawAmount(eurs, 2_000n), false, true).amount,
        ).toBe(1_597n);
        expect(
            eursBuffer.swapGivenOut(stataEurs, eurs, TokenAmount.fromRawAmount(eurs, 2_000n), false, true).amount,
        ).toBe(1_598n);

        // 130 EURS (13,000 raw -> 10,384 raw stataEthEURS) exceeds 10,000 raw on both sides and succeeds
        expect(eursBuffer.swapGivenIn(eurs, stataEurs, TokenAmount.fromRawAmount(eurs, 13_000n)).amount).toBe(10_384n);

        // Cross-decimal (18 main waUSDC, 6 underlying USDC, rate = 1.05):
        // - getPoolState() exposes mainDecimals=18 and underlyingDecimals=6 for upstream Vault.swap
        // - 0.01 USDC (10,000 raw) -> ~9.523e15 waUSDC (>= 10,000 raw in 18 decimals) succeeds
        // - unwrapping 9.5e15 waUSDC -> 9,975 raw USDC (< 10,000) reverts
        // - EXACT_OUT wrap for 9e15 waUSDC needing 9,450 raw USDC (< 10,000) reverts
        const crossDecimal = buffer({
            unwrapRate: 1_050_000_000_000_000_000n,
            mainToken: { address: MAIN, decimals: 18, balance: 10n * WAD },
            underlyingToken: { address: UNDERLYING, decimals: 6, balance: 10_000_000n },
            maxDeposit: 1_000_000_000n,
            maxWithdraw: 1_000_000_000n,
        });
        expect(crossDecimal.getPoolState()).toMatchObject({
            mainDecimals: 18,
            underlyingDecimals: 6,
        });
        const waUsdc = crossDecimal.tokens[0].token;
        const usdc = crossDecimal.tokens[1].token;
        expect(
            crossDecimal.swapGivenIn(usdc, waUsdc, TokenAmount.fromRawAmount(usdc, 10_000n)).amount,
        ).toBeGreaterThanOrEqual(10_000n);
        expect(() =>
            crossDecimal.swapGivenIn(waUsdc, usdc, TokenAmount.fromRawAmount(waUsdc, 9_500_000_000_000_000n)),
        ).toThrow('wrapAmountTooSmall');
        expect(() =>
            crossDecimal.swapGivenOut(usdc, waUsdc, TokenAmount.fromRawAmount(waUsdc, 9_000_000_000_000_000n)),
        ).toThrow('wrapAmountTooSmall');

        // Explicit minWrapAmount override is respected and preserved on copy()
        const customMin = buffer({ minWrapAmount: 50_000n }).copy();
        expect(customMin.minWrapAmount).toBe(50_000n);
        expect(() =>
            customMin.swapGivenIn(
                customMin.tokens[1].token,
                customMin.tokens[0].token,
                TokenAmount.fromRawAmount(customMin.tokens[1].token, 49_999n),
            ),
        ).toThrow('wrapAmountTooSmall');
    });
});
