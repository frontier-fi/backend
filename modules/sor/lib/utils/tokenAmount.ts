import { parseUnits } from 'viem';
import { WAD } from './math';
import { BigintIsh, InputToken, Token } from './token';

export type InputAmount = InputToken & {
    rawAmount: bigint;
};

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
        const rawAmount = parseUnits(humanAmount, token.decimals);
        return new TokenAmount(token, rawAmount);
    }

    public static fromScale18Amount(token: Token, scale18Amount: BigintIsh, divUp?: boolean) {
        const scalar = DECIMAL_SCALES[18 - token.decimals];
        const rawAmount = divUp ? 1n + (BigInt(scale18Amount) - 1n) / scalar : BigInt(scale18Amount) / scalar;
        return new TokenAmount(token, rawAmount);
    }

    public static fromInputAmount(input: InputAmount, chainId: number): TokenAmount {
        const token = new Token(chainId, input.address, input.decimals);
        return new TokenAmount(token, input.rawAmount);
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

    public mulUpFixed(other: bigint): TokenAmount {
        const product = this.amount * other;
        const multiplied = (product - 1n) / WAD + 1n;
        return new TokenAmount(this.token, multiplied);
    }

    public mulDownFixed(other: bigint): TokenAmount {
        const multiplied = (this.amount * other) / WAD;
        return new TokenAmount(this.token, multiplied);
    }

    public divUpFixed(other: bigint): TokenAmount {
        const divided = (this.amount * WAD + other - 1n) / other;
        return new TokenAmount(this.token, divided);
    }

    public divDownFixed(other: bigint): TokenAmount {
        const divided = (this.amount * WAD) / other;
        return new TokenAmount(this.token, divided);
    }

    public toSignificant(significantDigits = 6): string {
        if (this.amount === 0n) return '0';

        const scaleFactor = 10n ** BigInt(significantDigits);
        const scaled = (this.amount * scaleFactor) / this.decimalScale;

        if (scaled === 0n) return '0';

        const scaledStr = scaled.toString();

        if (scaledStr.length <= significantDigits) {
            const padded = scaledStr.padStart(significantDigits, '0');
            let end = padded.length;
            while (end > 0 && padded[end - 1] === '0') end--;
            if (end === 0) return '0';
            return `0.${padded.slice(0, end)}`;
        }

        const intLen = scaledStr.length - significantDigits;
        const intPart = scaledStr.slice(0, intLen);
        const fracPart = scaledStr.slice(intLen);

        let end = fracPart.length;
        while (end > 0 && fracPart[end - 1] === '0') end--;

        if (end === 0) return intPart;
        return `${intPart}.${fracPart.slice(0, end)}`;
    }

    public toInputAmount(): InputAmount {
        return {
            address: this.token.address,
            decimals: this.token.decimals,
            rawAmount: this.amount,
        };
    }
}
