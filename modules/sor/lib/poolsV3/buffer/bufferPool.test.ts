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

    test('caps a balanced wrap at maxDeposit and falls back to the buffer when rebalancing exceeds it', () => {
        const balanced = buffer({ maxDeposit: WAD });
        const underlying = balanced.tokens[1].token;
        const main = balanced.tokens[0].token;

        expect(balanced.getLimitAmountSwap(underlying, main, SwapKind.GivenIn)).toBe(WAD);

        const emptyUnderlying = buffer({
            maxDeposit: WAD,
            underlyingToken: { address: UNDERLYING, decimals: 18, balance: 0n },
        });
        expect(
            emptyUnderlying.getLimitAmountSwap(emptyUnderlying.tokens[1].token, emptyUnderlying.tokens[0].token, SwapKind.GivenIn),
        ).toBe(10n * WAD);
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
        expect(pool.swapGivenOutGreaterThanBufferLimit(main, underlying, TokenAmount.fromRawAmount(underlying, 11n * WAD))).toBe(
            true,
        );
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
});
