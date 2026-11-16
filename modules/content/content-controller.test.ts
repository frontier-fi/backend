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
import { logger } from '../common/logger';

describe('ContentController.syncTokenContentData', () => {
    it('still syncs the token list and blocklist when the CoinGecko id sync fails', async () => {
        const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
        mockSyncCoingeckoIds.mockRejectedValueOnce(new Error('429 Too Many Requests'));

        await ContentController().syncTokenContentData();

        expect(mockSyncTokenContentData).toHaveBeenCalledWith(expect.arrayContaining(['SEPOLIA', 'BASE']));
        expect(errorSpy).toHaveBeenCalledWith('Failed to sync CoinGecko IDs', { err: expect.any(Error) });

        errorSpy.mockRestore();
    });
});
