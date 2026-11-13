import { SwapKind } from '@frontier-fi/maths';
import { maxUint256 } from 'viem';
import { Token, TokenAmount } from '../../utils';
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
    test.each([
        [10_000n, 10_001n],
        [10_001n, 10_000n],
    ])('preserves odd balances when rebalancing %s wrapped and %s underlying', (mainBalance, underlyingBalance) => {
        for (const kind of [SwapKind.GivenIn, SwapKind.GivenOut]) {
            for (const isUnwrap of [false, true]) {
                const pool = buffer({
                    mainToken: { address: MAIN, decimals: 18, balance: mainBalance },
                    underlyingToken: { address: UNDERLYING, decimals: 18, balance: underlyingBalance },
                    maxDeposit: 20_000n,
                    maxWithdraw: 20_000n,
                });
                const input = pool.tokens[isUnwrap ? 0 : 1].token;
                const output = pool.tokens[isUnwrap ? 1 : 0].token;
                expect(pool.getLimitAmountSwap(input, output, kind)).toBe(20_000n);
                if (kind === SwapKind.GivenIn) {
                    pool.swapGivenIn(input, output, TokenAmount.fromRawAmount(input, 20_000n), true);
                } else {
                    pool.swapGivenOut(input, output, TokenAmount.fromRawAmount(output, 20_000n), true);
                }
                expect(pool.tokens.map((token) => token.amount)).toEqual([mainBalance, underlyingBalance]);
                expect(isUnwrap ? pool.maxWithdraw : pool.maxDeposit).toBe(0n);
            }
        }
    });

    test.each([
        {
            kind: SwapKind.GivenIn,
            isUnwrap: false,
            amount: 30_000n,
            limit: 54_997n,
            balances: [7_501n, 15_002n],
            remaining: 24_997n,
        },
        {
            kind: SwapKind.GivenOut,
            isUnwrap: false,
            amount: 15_000n,
            limit: 27_498n,
            balances: [7_502n, 15_001n],
            remaining: 24_996n,
        },
        {
            kind: SwapKind.GivenIn,
            isUnwrap: true,
            amount: 15_000n,
            limit: 22_502n,
            balances: [7_502n, 15_001n],
            remaining: 15_004n,
        },
        {
            kind: SwapKind.GivenOut,
            isUnwrap: true,
            amount: 30_000n,
            limit: 45_003n,
            balances: [7_501n, 15_002n],
            remaining: 15_003n,
        },
    ])(
        'uses the correct ERC4626 operation for kind=$kind, unwrap=$isUnwrap',
        ({ kind, isUnwrap, amount, limit, balances, remaining }) => {
            const pool = buffer({
                unwrapRate: 2n * WAD,
                mainToken: { address: MAIN, decimals: 18, balance: 10_000n },
                underlyingToken: { address: UNDERLYING, decimals: 18, balance: 10_005n },
                maxDeposit: 50_000n,
                maxWithdraw: 50_000n,
            });
            const input = pool.tokens[isUnwrap ? 0 : 1].token;
            const output = pool.tokens[isUnwrap ? 1 : 0].token;
            expect(pool.getLimitAmountSwap(input, output, kind)).toBe(limit);
            const atLimit = pool.copy();
            const overLimit = pool.copy();
            const execute = (target: BufferPool, raw: bigint) =>
                kind === SwapKind.GivenIn
                    ? target.swapGivenIn(input, output, TokenAmount.fromRawAmount(input, raw), true)
                    : target.swapGivenOut(input, output, TokenAmount.fromRawAmount(output, raw), true);
            execute(atLimit, limit);
            expect(isUnwrap ? atLimit.maxWithdraw : atLimit.maxDeposit).toBe(0n);
            expect(() => execute(overLimit, limit + 1n)).toThrow('capacity exceeded');
            expect(overLimit.tokens.map((token) => token.amount)).toEqual([10_000n, 10_005n]);
            expect(overLimit.maxDeposit).toBe(50_000n);
            expect(overLimit.maxWithdraw).toBe(50_000n);
            if (kind === SwapKind.GivenIn) {
                pool.swapGivenIn(input, output, TokenAmount.fromRawAmount(input, amount), true);
            } else {
                pool.swapGivenOut(input, output, TokenAmount.fromRawAmount(output, amount), true);
            }
            expect(pool.tokens.map((token) => token.amount)).toEqual(balances);
            expect(isUnwrap ? pool.maxWithdraw : pool.maxDeposit).toBe(remaining);
        },
    );

    test.each([false, true])(
        'uses output inventory to decide whether a rounded swap is internal (unwrap=%s)',
        (isUnwrap) => {
            const pool = buffer({
                unwrapRate: isUnwrap ? WAD / 2n : 2n * WAD,
                mainToken: { address: MAIN, decimals: 18, balance: 10_000n },
                underlyingToken: { address: UNDERLYING, decimals: 18, balance: 10_000n },
                maxDeposit: 0n,
                maxWithdraw: 0n,
            });
            const input = pool.tokens[isUnwrap ? 0 : 1].token;
            const output = pool.tokens[isUnwrap ? 1 : 0].token;
            const amount = TokenAmount.fromRawAmount(input, 20_001n);
            expect(pool.getLimitAmountSwap(input, output, SwapKind.GivenIn)).toBe(amount.amount);
            expect(pool.swapGivenInGreaterThanBufferLimit(input, output, amount)).toBe(false);
            expect(pool.swapGivenIn(input, output, amount, true).amount).toBe(10_000n);
            expect(pool.tokens[isUnwrap ? 1 : 0].amount).toBe(0n);
            expect(pool.tokens[isUnwrap ? 0 : 1].amount).toBe(30_001n);
            expect(pool.maxDeposit).toBe(0n);
            expect(pool.maxWithdraw).toBe(0n);
        },
    );

    test.each([
        {
            mainDecimals: 18,
            underlyingDecimals: 6,
            rate: 3n * WAD,
            assets: 10_000n,
            sharesDown: 3_333_333_333_333_333n,
            sharesUp: 3_333_333_333_333_334n,
        },
        {
            mainDecimals: 6,
            underlyingDecimals: 18,
            rate: WAD / 3n,
            assets: 1_000_000_000_000_000_000n,
            sharesDown: 3_000_000n,
            sharesUp: 3_000_001n,
        },
    ])(
        'rounds only after converting to raw units ($mainDecimals/$underlyingDecimals)',
        ({ mainDecimals, underlyingDecimals, rate, assets, sharesDown, sharesUp }) => {
            const pool = buffer({
                unwrapRate: rate,
                mainToken: { address: MAIN, decimals: mainDecimals, balance: 0n },
                underlyingToken: { address: UNDERLYING, decimals: underlyingDecimals, balance: 0n },
            });
            const main = pool.tokens[0].token;
            const underlying = pool.tokens[1].token;
            expect(pool.swapGivenIn(underlying, main, TokenAmount.fromRawAmount(underlying, assets)).amount).toBe(
                sharesDown,
            );
            expect(pool.swapGivenOut(main, underlying, TokenAmount.fromRawAmount(underlying, assets)).amount).toBe(
                sharesUp,
            );
        },
    );

    test('rounds previewMint and previewWithdraw up when calculating the imbalances', () => {
        const mint = buffer({
            unwrapRate: (3n * WAD) / 2n,
            mainToken: { address: MAIN, decimals: 18, balance: 10_001n },
            underlyingToken: { address: UNDERLYING, decimals: 18, balance: 15_003n },
            maxDeposit: 30_000n,
        });
        const withdraw = buffer({
            unwrapRate: 2n * WAD,
            mainToken: { address: MAIN, decimals: 18, balance: 10_001n },
            underlyingToken: { address: UNDERLYING, decimals: 18, balance: 20_005n },
            maxWithdraw: 40_000n,
        });
        expect(mint.getLimitAmountSwap(mint.tokens[1].token, mint.tokens[0].token, SwapKind.GivenIn)).toBe(30_000n);
        mint.swapGivenIn(
            mint.tokens[1].token,
            mint.tokens[0].token,
            TokenAmount.fromRawAmount(mint.tokens[1].token, 30_000n),
            true,
        );
        expect(mint.tokens.map((token) => token.amount)).toEqual([10_001n, 15_003n]);
        expect(withdraw.getLimitAmountSwap(withdraw.tokens[0].token, withdraw.tokens[1].token, SwapKind.GivenIn)).toBe(
            20_001n,
        );
        withdraw.swapGivenIn(
            withdraw.tokens[0].token,
            withdraw.tokens[1].token,
            TokenAmount.fromRawAmount(withdraw.tokens[0].token, 20_001n),
            true,
        );
        expect(withdraw.tokens.map((token) => token.amount)).toEqual([10_002n, 20_003n]);
    });

    test.each([18, 6])(
        'rounds underlying output down and underlying input up with %s wrapped decimals',
        (mainDecimals) => {
            const pool = buffer({
                unwrapRate: mainDecimals === 18 ? 3n * WAD : WAD / 3n,
                mainToken: { address: MAIN, decimals: mainDecimals, balance: 0n },
                underlyingToken: { address: UNDERLYING, decimals: mainDecimals === 18 ? 6 : 18, balance: 0n },
            });
            const main = pool.tokens[0].token;
            const underlying = pool.tokens[1].token;
            const shares = mainDecimals === 18 ? 3_333_333_333_333_334n : 3_000_001n;
            const assetsDown = mainDecimals === 18 ? 10_000n : 1_000_000_333_333_333_332n;
            expect(pool.swapGivenIn(main, underlying, TokenAmount.fromRawAmount(main, shares)).amount).toBe(assetsDown);
            expect(pool.swapGivenOut(underlying, main, TokenAmount.fromRawAmount(main, shares)).amount).toBe(
                assetsDown + 1n,
            );
        },
    );

    test.each([SwapKind.GivenIn, SwapKind.GivenOut])(
        'preserves unlimited capacity across repeated swaps (%s)',
        (kind) => {
            for (const isUnwrap of [false, true]) {
                const pool = buffer({ maxDeposit: maxUint256, maxWithdraw: maxUint256 });
                const input = pool.tokens[isUnwrap ? 0 : 1].token;
                const output = pool.tokens[isUnwrap ? 1 : 0].token;
                for (let i = 0; i < 3; i++) {
                    expect(pool.getLimitAmountSwap(input, output, kind)).toBe(maxUint256);
                    if (kind === SwapKind.GivenIn) {
                        pool.swapGivenIn(input, output, TokenAmount.fromRawAmount(input, 100n * WAD), true);
                    } else {
                        pool.swapGivenOut(input, output, TokenAmount.fromRawAmount(output, 100n * WAD), true);
                    }
                    expect(pool.maxDeposit).toBe(maxUint256);
                    expect(pool.maxWithdraw).toBe(maxUint256);
                    expect(pool.tokens.map((token) => token.amount)).toEqual([10n * WAD, 10n * WAD]);
                }
            }
        },
    );

    test.each([
        [18, 18],
        [18, 6],
        [6, 18],
    ])('keeps limits executable after sequential swaps with %s/%s decimals', (mainDecimals, underlyingDecimals) => {
        const mainUnit = 10n ** BigInt(mainDecimals);
        const underlyingUnit = 10n ** BigInt(underlyingDecimals);
        for (const rate of [WAD / 3n, (3n * WAD) / 2n, 3n * WAD]) {
            for (const capacity of [0n, 100n * underlyingUnit]) {
                const pool = buffer({
                    unwrapRate: rate,
                    mainToken: { address: MAIN, decimals: mainDecimals, balance: 10n * mainUnit + 1n },
                    underlyingToken: {
                        address: UNDERLYING,
                        decimals: underlyingDecimals,
                        balance: 15n * underlyingUnit + 1n,
                    },
                    maxDeposit: capacity,
                    maxWithdraw: capacity,
                    minWrapAmount: 0n,
                });
                for (const kind of [SwapKind.GivenIn, SwapKind.GivenOut, SwapKind.GivenIn]) {
                    for (const isUnwrap of [false, true]) {
                        const input = pool.tokens[isUnwrap ? 0 : 1].token;
                        const output = pool.tokens[isUnwrap ? 1 : 0].token;
                        const limit = pool.getLimitAmountSwap(input, output, kind);
                        expect(limit).toBeGreaterThanOrEqual(0n);
                        expect(limit).toBeLessThanOrEqual(maxUint256);
                        const depositBefore = pool.maxDeposit;
                        const withdrawBefore = pool.maxWithdraw;
                        if (kind === SwapKind.GivenIn) {
                            pool.swapGivenIn(input, output, TokenAmount.fromRawAmount(input, limit), true);
                        } else {
                            pool.swapGivenOut(input, output, TokenAmount.fromRawAmount(output, limit), true);
                        }
                        for (const token of pool.tokens) expect(token.amount).toBeGreaterThanOrEqual(0n);
                        expect(pool.maxDeposit).toBeGreaterThanOrEqual(0n);
                        expect(pool.maxWithdraw).toBeGreaterThanOrEqual(0n);
                        expect(pool.maxDeposit).toBeLessThanOrEqual(depositBefore);
                        expect(pool.maxWithdraw).toBeLessThanOrEqual(withdrawBefore);
                    }
                }
            }
        }
    });

    test.each([SwapKind.GivenIn, SwapKind.GivenOut])(
        'accounts for signed rebalancing in both directions (%s)',
        (kind) => {
            const wrap = buffer({
                mainToken: { address: MAIN, decimals: 18, balance: 100n * WAD },
                underlyingToken: { address: UNDERLYING, decimals: 18, balance: 1000n * WAD },
                maxDeposit: 400n * WAD,
            });
            expect(wrap.getLimitAmountSwap(wrap.tokens[1].token, wrap.tokens[0].token, kind)).toBe(100n * WAD);
            const unwrap = buffer({
                mainToken: { address: MAIN, decimals: 18, balance: 1000n * WAD },
                underlyingToken: { address: UNDERLYING, decimals: 18, balance: 100n * WAD },
                maxWithdraw: 400n * WAD,
            });
            expect(unwrap.getLimitAmountSwap(unwrap.tokens[0].token, unwrap.tokens[1].token, kind)).toBe(100n * WAD);
            wrap.maxDeposit = 1000n * WAD;
            unwrap.maxWithdraw = 1000n * WAD;
            for (const [pool, inputIndex, outputIndex] of [
                [wrap, 1, 0],
                [unwrap, 0, 1],
            ] as const) {
                const input = pool.tokens[inputIndex].token;
                const output = pool.tokens[outputIndex].token;
                const amount = TokenAmount.fromRawAmount(kind === SwapKind.GivenIn ? input : output, 200n * WAD);
                if (kind === SwapKind.GivenIn) pool.swapGivenIn(input, output, amount, true);
                else pool.swapGivenOut(input, output, amount, true);
                expect(pool.tokens.map((token) => token.amount)).toEqual([550n * WAD, 550n * WAD]);
            }
            expect(wrap.maxDeposit).toBe(350n * WAD);
            expect(unwrap.maxWithdraw).toBe(350n * WAD);
        },
    );
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

        const imbalanced = buffer({
            maxWithdraw: 49_290_655n,
            mainToken: { address: MAIN, decimals: 8, balance: 16_657_946n },
            underlyingToken: { address: UNDERLYING, decimals: 8, balance: 3_339_432n },
        });
        expect(
            imbalanced.getLimitAmountSwap(imbalanced.tokens[0].token, imbalanced.tokens[1].token, SwapKind.GivenIn),
        ).toBe(42_631_398n);
        expect(
            imbalanced.getLimitAmountSwap(imbalanced.tokens[0].token, imbalanced.tokens[1].token, SwapKind.GivenOut),
        ).toBe(42_631_398n);
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

        pool.swapGivenOut(underlying, main, TokenAmount.fromRawAmount(main, 60n * WAD), true);
        expect(pool.getLimitAmountSwap(underlying, main, SwapKind.GivenOut)).toBe(40n * WAD);
        expect(() => pool.swapGivenOut(underlying, main, TokenAmount.fromRawAmount(main, 50n * WAD), true)).toThrow(
            'capacity exceeded',
        );
        expect(pool.maxDeposit).toBe(50n * WAD);
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
