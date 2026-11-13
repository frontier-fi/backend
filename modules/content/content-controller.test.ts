import { describe, expect, it, vi } from 'vitest';

const { mockSyncCoingeckoIds, mockSyncTokenContentData } = vi.hoisted(() => ({
    mockSyncCoingeckoIds: vi.fn(),
    mockSyncTokenContentData: vi.fn(),
}));

vi.mock('../token/lib/coingecko-data.service', () => ({
    CoingeckoDataService: class {
        syncCoingeckoIds = mockSyncCoingeckoIds;
    },
}));

vi.mock('./lib/sync-token-data', () => ({
    syncTokenContentData: mockSyncTokenContentData,
}));

import { ContentController } from './content-controller';

describe('ContentController.syncTokenContentData', () => {
    it('still syncs the token list and blocklist when the CoinGecko id sync fails', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockSyncCoingeckoIds.mockRejectedValueOnce(new Error('429 Too Many Requests'));

        await ContentController().syncTokenContentData();

        expect(mockSyncTokenContentData).toHaveBeenCalledWith(expect.arrayContaining(['SEPOLIA', 'BASE']));
        expect(consoleError).toHaveBeenCalled();

        consoleError.mockRestore();
    });
});
