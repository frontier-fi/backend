import { Address } from 'viem';

// Interim local copy until @frontier-fi/maths@0.2.0 is published (frontier-fi/maths#10)
export type BigintIsh = bigint | string | number;

export class Token {
    public readonly chainId: number;
    public readonly address: Address;
    public readonly decimals: number;
    public readonly symbol?: string;
    public readonly name?: string;

    public constructor(chainId: number, address: Address, decimals: number, symbol?: string, name?: string) {
        this.chainId = chainId;
        this.address = address.toLowerCase() as Address;
        this.decimals = decimals;
        this.symbol = symbol;
        this.name = name;
    }

    public isEqual(token: Token) {
        return this.chainId === token.chainId && this.address === token.address;
    }

    public isSameAddress(address: Address) {
        return this.address === address.toLowerCase();
    }
}
