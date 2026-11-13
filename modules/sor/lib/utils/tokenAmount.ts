import { parseUnits } from 'viem';
import { WAD } from './math';
import { BigintIsh, Token } from './token';

// Interim local copy until @frontier-fi/maths@0.2.0 is published (frontier-fi/maths#10)
export const DECIMAL_SCALES: Record<number, bigint> = {
    0: 1n,
    1: 10n,
    2: 100n,
    3: 1000n,
    4: 10000n,
    5: 100000n,
    6: 1000000n,
    7: 10000000n,
    8: 100000000n,
    9: 1000000000n,
    10: 10000000000n,
    11: 100000000000n,
    12: 1000000000000n,
    13: 10000000000000n,
    14: 100000000000000n,
    15: 1000000000000000n,
    16: 10000000000000000n,
    17: 100000000000000000n,
    18: 1000000000000000000n,
};

export class TokenAmount {
    public readonly token: Token;
    public readonly scalar: bigint;
    public readonly decimalScale: bigint;
    public amount: bigint;
    public scale18: bigint;

    public static fromRawAmount(token: Token, rawAmount: BigintIsh) {
        return new TokenAmount(token, rawAmount);
    }

    public static fromHumanAmount(token: Token, humanAmount: `${number}`) {
        return new TokenAmount(token, parseUnits(humanAmount, token.decimals));
    }

    public static fromScale18Amount(token: Token, scale18Amount: BigintIsh, divUp?: boolean) {
        const scalar = DECIMAL_SCALES[18 - token.decimals];
        const rawAmount = divUp ? 1n + (BigInt(scale18Amount) - 1n) / scalar : BigInt(scale18Amount) / scalar;
        return new TokenAmount(token, rawAmount);
    }

    protected constructor(token: Token, amount: BigintIsh) {
        this.decimalScale = DECIMAL_SCALES[token.decimals];
        this.token = token;
        this.amount = BigInt(amount);
        this.scalar = DECIMAL_SCALES[18 - token.decimals];
        this.scale18 = this.amount * this.scalar;
    }

    public add(other: TokenAmount): TokenAmount {
        return new TokenAmount(this.token, this.amount + other.amount);
    }

    public sub(other: TokenAmount): TokenAmount {
        return new TokenAmount(this.token, this.amount - other.amount);
    }

    public mulDownFixed(other: bigint): TokenAmount {
        return new TokenAmount(this.token, (this.amount * other) / WAD);
    }

    public divDownFixed(other: bigint): TokenAmount {
        return new TokenAmount(this.token, (this.amount * WAD) / other);
    }
}
