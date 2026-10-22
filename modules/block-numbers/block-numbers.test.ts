import { expect, test, describe, vi, beforeEach } from 'vitest';
import { blockNumbers } from './index';
import { Chain } from '@prisma/client';

describe('blockNumbers', () => {
    const mockEvents = {
        getLatestEvent: vi.fn(async (): Promise<{ blockNumber: number } | null> => null),
        getDailyBlockNumbers: vi.fn(async (): Promise<{ timestamp: number; number: number }[]> => []),
    };

    beforeEach(() => {
        mockEvents.getLatestEvent.mockReset();
        mockEvents.getDailyBlockNumbers.mockReset();
    });

    describe('getBlock', () => {
        test('should return block number for given timestamp', async () => {
            mockEvents.getLatestEvent.mockResolvedValue({ blockNumber: 12345 });

            const service = blockNumbers(mockEvents as any);
            const result = await service.getBlock(Chain.MAINNET, 1000);

            expect(result).toBe(12345);
        });

        test('should return undefined if no event found', async () => {
            mockEvents.getLatestEvent.mockResolvedValue(null);

            const service = blockNumbers(mockEvents as any);
            const result = await service.getBlock(Chain.MAINNET, 1000);

            expect(result).toBeUndefined();
        });
    });

    describe('getDailyBlocks', () => {
        test('should return daily block numbers', async () => {
            const mockBlocks = [
                { timestamp: 1000, number: 12345 },
                { timestamp: 2000, number: 12445 },
            ];
            mockEvents.getDailyBlockNumbers.mockResolvedValue(mockBlocks);

            const service = blockNumbers(mockEvents as any);
            const result = await service.getDailyBlocks(Chain.MAINNET, 2);

            expect(result).toEqual(mockBlocks);
        });
    });
});
