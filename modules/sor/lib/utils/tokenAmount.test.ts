import { describe, expect, it } from 'vitest';
import { WAD } from './math';
import { Token } from './token';
import { TokenAmount } from './tokenAmount';

describe('Token and TokenAmount', () => {
    const usdc = new Token(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6, 'USDC', 'USD Coin');
    const weth = new Token(8453, '0x4200000000000000000000000000000000000006', 18, 'WETH', 'Wrapped Ether');

    it('lowercases token addresses and compares chainId + address', () => {
        expect(usdc.address).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
        expect(usdc.isSameAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(true);
        expect(usdc.isEqual(new Token(8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 6))).toBe(true);
        expect(usdc.isEqual(new Token(1, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 6))).toBe(false);
    });

    it('scales between raw, human, and scale18 amounts with rounding', () => {
        const human = TokenAmount.fromHumanAmount(usdc, '12.345678');
        expect(human.amount).toBe(12_345_678n);
        expect(human.scale18).toBe(12_345_678_000_000_000_000n);
        expect(human.toSignificant(6)).toBe('12.345678');

        const oddScale18 = 1_000_000_000_001n; // 1e-6 USDC + 1 wei in 18-decimal space
        expect(TokenAmount.fromScale18Amount(usdc, oddScale18, false).amount).toBe(1n);
        expect(TokenAmount.fromScale18Amount(usdc, oddScale18, true).amount).toBe(2n);
    });

    it('performs fixed-point arithmetic and formats edge cases', () => {
        const amt = TokenAmount.fromRawAmount(weth, 3n);
        expect(amt.mulDownFixed(WAD / 2n).amount).toBe(1n);
        expect(amt.mulUpFixed(WAD / 2n).amount).toBe(2n);
        expect(amt.divDownFixed(2n * WAD).amount).toBe(1n);
        expect(amt.divUpFixed(2n * WAD).amount).toBe(2n);
        expect(TokenAmount.fromRawAmount(usdc, 0n).toSignificant()).toBe('0');
        expect(TokenAmount.fromRawAmount(usdc, 50_000n).toSignificant(4)).toBe('0.05');
    });
});
