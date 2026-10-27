import { Chain } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../prisma/prisma-client';
import { eventsRepository } from './events-repository';

describe('eventsRepository.getTokenFlows', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('binds interval, tokenA, tokenB, chain, poolId, and optional from parameter without off-by-one shift', async () => {
        const queryRawSpy = vi.spyOn(prisma, '$queryRaw').mockResolvedValue([
            {
                timestamp: 3600,
                tokenAFlow: 100,
                tokenBFlow: -50,
                tokenABuy: 20,
                tokenASell: 120,
                swapCount: 2,
                volume: 500,
            },
        ]);

        const tokenA = '0x00000000000000000000000000000000000000aa';
        const tokenB = '0x00000000000000000000000000000000000000bb';
        const poolId = '0x0000000000000000000000000000000000000001';

        const withFrom = await eventsRepository.getTokenFlows(
            Chain.SEPOLIA,
            poolId,
            tokenA,
            tokenB,
            1800,
            1_700_000_000,
        );

        expect(withFrom).toEqual([
            {
                timestamp: 3600,
                [tokenA]: 100,
                [tokenB]: -50,
                swapCount: 2,
                volume: 500,
                buyVolume: 20,
                sellVolume: 120,
            },
        ]);

        const sqlObj = queryRawSpy.mock.calls[0][0] as { strings: string[]; values: unknown[] };
        expect(sqlObj.values).toContain(1800);
        expect(sqlObj.values).toContain(1_700_000_000);
        expect(sqlObj.values).toContain(tokenA.toLowerCase());
        expect(sqlObj.values).toContain(tokenB.toLowerCase());

        queryRawSpy.mockClear();
        await eventsRepository.getTokenFlows(Chain.SEPOLIA, poolId, tokenA, tokenB, 3600);
        const sqlWithoutFrom = queryRawSpy.mock.calls[0][0] as { strings: string[]; values: unknown[] };
        expect(sqlWithoutFrom.values).toContain(3600);
        expect(sqlWithoutFrom.values).not.toContain(1_700_000_000);
        expect(sqlWithoutFrom.values).toContain(tokenA.toLowerCase());
        expect(sqlWithoutFrom.values).toContain(tokenB.toLowerCase());
    });
});
