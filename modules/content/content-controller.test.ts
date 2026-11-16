import { describe, expect, it, vi } from 'vitest';

const { mockSyncCoingeckoIds, mockSyncTokenContentData } = vi.hoisted(() => ({
    mockSyncCoingeckoIds: vi.fn(),
    mockSyncTokenContentData: vi.fn(),
}));

vi.mock('../token/lib/coingecko-data.service', () => ({
    coingeckoDataService: {
        syncCoingeckoIds: mockSyncCoingeckoIds,
    },
}));

vi.mock('./lib/sync-token-data', () => ({
    syncTokenContentData: mockSyncTokenContentData,
}));

import { ContentController } from './content-controller';

describe('ContentController.syncTokenContentData', () => {
    it('syncs tokenlist before CoinGecko IDs and still succeeds when CoinGecko ID sync fails', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockSyncCoingeckoIds.mockRejectedValueOnce(new Error('429 Too Many Requests'));

        await ContentController().syncTokenContentData();

        expect(mockSyncTokenContentData).toHaveBeenCalledWith(expect.arrayContaining(['SEPOLIA', 'BASE']));
        expect(mockSyncTokenContentData.mock.invocationCallOrder[0]).toBeLessThan(
            mockSyncCoingeckoIds.mock.invocationCallOrder[0],
        );
        expect(consoleError).toHaveBeenCalled();

        consoleError.mockRestore();
    });
});
