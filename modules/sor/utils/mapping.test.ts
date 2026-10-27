import { Token, TokenAmount } from '@balancer/sdk';
import { describe, expect, it } from 'vitest';
import { PathWithAmount } from '../lib/path';
import { mapRoutes, mapToSorSwapPaths } from './mapping';

const tokenA = new Token(11155111, '0x000000000000000000000000000000000000000a', 6, 'USDC');
const tokenB = new Token(11155111, '0x000000000000000000000000000000000000000b', 18, 'WETH');

function createMockPath(inputRaw: bigint, outputRaw: bigint, poolId = '0x0000000000000000000000000000000000000001') {
    const pool = {
        id: poolId,
        address: poolId,
        poolType: 'Weighted',
        swapGivenIn: () => TokenAmount.fromRawAmount(tokenB, outputRaw),
        swapGivenOut: () => TokenAmount.fromRawAmount(tokenA, inputRaw),
    } as any;

    return new PathWithAmount([tokenA, tokenB], [pool], [false], TokenAmount.fromRawAmount(tokenA, inputRaw));
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
});
