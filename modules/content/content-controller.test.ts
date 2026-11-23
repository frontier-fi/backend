import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockSyncCoingeckoIds,
    mockSyncTokenContentData,
    mockTokenTypeDeleteMany,
    mockSyncErc4626Tokens,
    mockViemClient,
} = vi.hoisted(() => ({
    mockSyncCoingeckoIds: vi.fn(),
    mockSyncTokenContentData: vi.fn(),
    mockTokenTypeDeleteMany: vi.fn(),
    mockSyncErc4626Tokens: vi.fn(),
    mockViemClient: {},
}));

vi.mock('../../prisma/prisma-client', () => ({
    prisma: {
        prismaTokenType: {
            deleteMany: mockTokenTypeDeleteMany,
        },
    },
}));

vi.mock('../token/lib/coingecko-data.service', () => ({
    coingeckoDataService: {
        syncCoingeckoIds: mockSyncCoingeckoIds,
    },
}));

vi.mock('./lib/sync-token-data', () => ({
    syncTokenContentData: mockSyncTokenContentData,
}));

vi.mock('../actions/token/sync-erc4626-tokens', () => ({
    syncErc4626Tokens: mockSyncErc4626Tokens,
}));

vi.mock('../sources/viem-client', () => ({
    getViemClient: () => mockViemClient,
}));

import { ContentController } from './content-controller';
import { logger } from '../common/logger';

describe('ContentController', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('syncs tokenlist before CoinGecko IDs and still succeeds when CoinGecko ID sync fails', async () => {
        const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
        mockSyncCoingeckoIds.mockRejectedValueOnce(new Error('429 Too Many Requests'));

        await ContentController().syncTokenContentData();

        expect(mockSyncTokenContentData).toHaveBeenCalledWith(
            expect.arrayContaining(['SEPOLIA', 'BASE', 'MAINNET', 'MONAD']),
        );
        expect(mockSyncTokenContentData.mock.invocationCallOrder[0]).toBeLessThan(
            mockSyncCoingeckoIds.mock.invocationCallOrder[0],
        );
        expect(errorSpy).toHaveBeenCalledWith('Failed to sync CoinGecko IDs', { err: expect.any(Error) });

        errorSpy.mockRestore();
    });

    it('preserves immutable BPT token types when reloading all token types for a chain', async () => {
        await ContentController().reloadAllTokenTypes('BASE');

        expect(mockTokenTypeDeleteMany).toHaveBeenCalledWith({
            where: {
                chain: 'BASE',
                type: { not: 'BPT' },
            },
        });
        expect(mockSyncTokenContentData).toHaveBeenCalledWith(['BASE']);
        expect(mockSyncErc4626Tokens).toHaveBeenCalledWith(mockViemClient, 'BASE');
    });
});
