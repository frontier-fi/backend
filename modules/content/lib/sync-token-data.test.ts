import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chain } from '@prisma/client';

const {
    mockTokenFindMany,
    mockTokenUpsert,
    mockTokenTypeFindMany,
    mockTokenTypeCreateMany,
    mockTokenTypeDeleteMany,
    mockPoolFindMany,
    mockTransaction,
    mockSyncErc4626Tokens,
    mockGetViemClient,
} = vi.hoisted(() => ({
    mockTokenFindMany: vi.fn(),
    mockTokenUpsert: vi.fn((args: unknown) => args),
    mockTokenTypeFindMany: vi.fn(),
    mockTokenTypeCreateMany: vi.fn(),
    mockTokenTypeDeleteMany: vi.fn(),
    mockPoolFindMany: vi.fn(),
    mockTransaction: vi.fn(),
    mockSyncErc4626Tokens: vi.fn(),
    mockGetViemClient: vi.fn(() => ({})),
}));

vi.mock('../../../prisma/prisma-client', () => ({
    prisma: {
        prismaToken: {
            findMany: mockTokenFindMany,
            upsert: mockTokenUpsert,
        },
        prismaTokenType: {
            findMany: mockTokenTypeFindMany,
            createMany: mockTokenTypeCreateMany,
            deleteMany: mockTokenTypeDeleteMany,
        },
        prismaPool: {
            findMany: mockPoolFindMany,
        },
        $transaction: mockTransaction,
    },
}));

vi.mock('../../actions/token/sync-erc4626-tokens', () => ({
    syncErc4626Tokens: mockSyncErc4626Tokens,
}));

vi.mock('../../sources/viem-client', () => ({
    getViemClient: mockGetViemClient,
}));

import { syncTokenContentData } from './sync-token-data';

describe('syncTokenContentData', () => {
    const existingAddress = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
    const newAddress = '0xde46e43f46ff74a23a65ebb0580cbe3dfe684a17';

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (url.includes('tokenlist')) {
                    return {
                        ok: true,
                        json: async () => ({
                            name: 'Test List',
                            timestamp: '2026-10-28T00:00:00Z',
                            tokens: [
                                {
                                    chainId: 11155111,
                                    address: existingAddress,
                                    name: 'USDC',
                                    symbol: 'USDC',
                                    decimals: 6,
                                    logoURI: '',
                                },
                                {
                                    chainId: 11155111,
                                    address: newAddress,
                                    name: 'Static Aave Ethereum DAI',
                                    symbol: 'stataEthDAI',
                                    decimals: 18,
                                    logoURI: '',
                                },
                            ],
                        }),
                    };
                }
                return {
                    ok: true,
                    text: async () => '',
                };
            }),
        );
        mockTokenTypeFindMany.mockResolvedValue([]);
        mockPoolFindMany.mockResolvedValue([]);
        mockTransaction.mockResolvedValue([]);
    });

    it('calls syncErc4626Tokens only for tokens not already in PrismaToken', async () => {
        // 1st findMany: existing tokens in DB before upsert
        mockTokenFindMany.mockResolvedValueOnce([{ address: existingAddress, chain: Chain.SEPOLIA }]);
        // 2nd findMany: inside syncBlockedTokens
        mockTokenFindMany.mockResolvedValueOnce([]);

        await syncTokenContentData([Chain.SEPOLIA]);

        expect(mockSyncErc4626Tokens).toHaveBeenCalledTimes(1);
        expect(mockSyncErc4626Tokens).toHaveBeenCalledWith(expect.anything(), Chain.SEPOLIA, [
            {
                address: newAddress,
                decimals: 18,
                name: 'Static Aave Ethereum DAI',
                symbol: 'stataEthDAI',
                chain: Chain.SEPOLIA,
            },
        ]);
    });

    it('skips syncErc4626Tokens when all tokenlist tokens already exist in PrismaToken', async () => {
        mockTokenFindMany.mockResolvedValueOnce([
            { address: existingAddress, chain: Chain.SEPOLIA },
            { address: newAddress, chain: Chain.SEPOLIA },
        ]);
        mockTokenFindMany.mockResolvedValueOnce([]);

        await syncTokenContentData([Chain.SEPOLIA]);

        expect(mockSyncErc4626Tokens).not.toHaveBeenCalled();
    });

    it('falls back to nativeAssetId for configured WETH when tokenlist omits coingeckoId', async () => {
        const configuredSepoliaWeth = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (url.includes('tokenlist')) {
                    return {
                        ok: true,
                        json: async () => ({
                            name: 'Test List',
                            timestamp: '2026-10-28T00:00:00Z',
                            tokens: [
                                {
                                    chainId: 11155111,
                                    address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
                                    name: 'Wrapped Ether',
                                    symbol: 'WETH',
                                    decimals: 18,
                                    logoURI: '',
                                },
                            ],
                        }),
                    };
                }
                return {
                    ok: true,
                    text: async () => '',
                };
            }),
        );
        mockTokenFindMany.mockResolvedValueOnce([{ address: configuredSepoliaWeth, chain: Chain.SEPOLIA }]);
        mockTokenFindMany.mockResolvedValueOnce([]);

        await syncTokenContentData([Chain.SEPOLIA]);

        expect(mockTokenUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    address: configuredSepoliaWeth,
                    coingeckoTokenId: 'ethereum',
                }),
            }),
        );
    });
});
