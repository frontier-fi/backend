import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chain } from '@prisma/client';

const {
    mockTokenFindMany,
    mockTokenUpsert,
    mockTokenUpdate,
    mockTokenTypeUpsert,
    mockReviewFindMany,
    mockFetchErc4626,
    mockFetchMaxValues,
    mockFetchUnwrapRates,
    mockFetchBufferBalances,
} = vi.hoisted(() => ({
    mockTokenFindMany: vi.fn(),
    mockTokenUpsert: vi.fn(),
    mockTokenUpdate: vi.fn(),
    mockTokenTypeUpsert: vi.fn(),
    mockReviewFindMany: vi.fn(),
    mockFetchErc4626: vi.fn(),
    mockFetchMaxValues: vi.fn(),
    mockFetchUnwrapRates: vi.fn(),
    mockFetchBufferBalances: vi.fn(),
}));

vi.mock('../../../prisma/prisma-client', () => ({
    prisma: {
        prismaToken: {
            findMany: mockTokenFindMany,
            upsert: mockTokenUpsert,
            update: mockTokenUpdate,
        },
        prismaTokenType: {
            upsert: mockTokenTypeUpsert,
        },
        prismaErc4626ReviewData: {
            findMany: mockReviewFindMany,
        },
    },
}));

vi.mock('../../../prisma/prisma-util', () => ({
    prismaBulkExecuteOperations: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
}));

vi.mock('../../sources/contracts/fetch-erc4626-token-data', () => ({
    fetchErc4626AndUnderlyingTokenData: mockFetchErc4626,
}));

vi.mock('../../sources/contracts/v3/fetch-erc4626-max-values', () => ({
    fetchMaxValues: mockFetchMaxValues,
}));

vi.mock('../../sources/contracts/v3/fetch-unwrap-rates', () => ({
    fetchUnwrapRates: mockFetchUnwrapRates,
}));

vi.mock('../../sources/contracts/v3/fetch-buffer-balances', () => ({
    fetchBufferBalances: mockFetchBufferBalances,
}));

import { syncErc4626Tokens } from './sync-erc4626-tokens';
import { clearNonErc4626ReviewedCache, syncErc4626OnchainData } from './sync-erc4626-onchain-data';

describe('syncErc4626Tokens', () => {
    const viemClient = {} as any;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns early without RPC or DB calls when passed an empty token list', async () => {
        await syncErc4626Tokens(viemClient, Chain.SEPOLIA, []);

        expect(mockFetchErc4626).not.toHaveBeenCalled();
        expect(mockTokenUpsert).not.toHaveBeenCalled();
        expect(mockTokenTypeUpsert).not.toHaveBeenCalled();
    });

    it('only upserts detected ERC4626 tokens and their underlying tokens, skipping plain ERC20s', async () => {
        const plainToken = {
            address: '0x1111111111111111111111111111111111111111',
            decimals: 18,
            name: 'Plain Token',
            symbol: 'PLAIN',
            chain: Chain.SEPOLIA,
        };
        const erc4626Token = {
            address: '0xde46e43f46ff74a23a65ebb0580cbe3dfe684a17',
            decimals: 18,
            name: 'Static Aave Ethereum DAI',
            symbol: 'stataEthDAI',
            chain: Chain.SEPOLIA,
        };
        const underlyingAddress = '0xff34b3d4aee8ddcd6f9afffb6fe49bd371b8a357';

        mockFetchErc4626.mockResolvedValueOnce([
            { ...plainToken, underlyingTokenAddress: undefined },
            { ...erc4626Token, underlyingTokenAddress: underlyingAddress },
            {
                address: underlyingAddress,
                decimals: 18,
                name: 'DAI',
                symbol: 'DAI',
                chain: Chain.SEPOLIA,
                underlyingTokenAddress: undefined,
            },
        ]);

        await syncErc4626Tokens(viemClient, Chain.SEPOLIA, [plainToken, erc4626Token]);

        expect(mockTokenUpsert).toHaveBeenCalledTimes(2);
        expect(mockTokenUpsert).toHaveBeenCalledWith({
            where: {
                address_chain: {
                    address: erc4626Token.address,
                    chain: Chain.SEPOLIA,
                },
            },
            create: {
                ...erc4626Token,
                underlyingTokenAddress: underlyingAddress,
                chain: Chain.SEPOLIA,
            },
            update: {
                ...erc4626Token,
                underlyingTokenAddress: underlyingAddress,
            },
        });
        expect(mockTokenUpsert).toHaveBeenCalledWith({
            where: {
                address_chain: {
                    address: underlyingAddress,
                    chain: Chain.SEPOLIA,
                },
            },
            create: {
                address: underlyingAddress,
                decimals: 18,
                name: 'DAI',
                symbol: 'DAI',
                chain: Chain.SEPOLIA,
                underlyingTokenAddress: undefined,
            },
            update: {},
        });
        expect(mockTokenTypeUpsert).toHaveBeenCalledTimes(1);
        expect(mockTokenTypeUpsert).toHaveBeenCalledWith({
            where: {
                id_chain: {
                    id: `${erc4626Token.address}-erc4626`,
                    chain: Chain.SEPOLIA,
                },
            },
            create: {
                id: `${erc4626Token.address}-erc4626`,
                chain: Chain.SEPOLIA,
                tokenAddress: erc4626Token.address,
                type: 'ERC4626',
            },
            update: {
                id: `${erc4626Token.address}-erc4626`,
                chain: Chain.SEPOLIA,
                tokenAddress: erc4626Token.address,
                type: 'ERC4626',
            },
        });
    });
});

describe('syncErc4626OnchainData', () => {
    const viemClient = {} as any;
    const vaultAddress = '0xFF00009C1A83Ec25434522ef355b99e9a70000FF';

    beforeEach(() => {
        vi.clearAllMocks();
        clearNonErc4626ReviewedCache();
    });

    it('self-heals reviewed ERC4626 tokens that are missing type or underlyingTokenAddress', async () => {
        const untypedToken = {
            address: '0xde46e43f46ff74a23a65ebb0580cbe3dfe684a17',
            decimals: 18,
            name: 'Static Aave Ethereum DAI',
            symbol: 'stataEthDAI',
            chain: Chain.SEPOLIA,
            underlyingTokenAddress: null,
        };
        const underlyingAddress = '0xff34b3d4aee8ddcd6f9afffb6fe49bd371b8a357';

        mockReviewFindMany.mockResolvedValueOnce([
            { erc4626Address: untypedToken.address, assetAddress: underlyingAddress },
        ]);
        // 1st findMany: untypedReviewedTokens
        mockTokenFindMany.mockResolvedValueOnce([untypedToken]);
        // fetchErc4626 inside syncErc4626Tokens
        mockFetchErc4626.mockResolvedValueOnce([{ ...untypedToken, underlyingTokenAddress: underlyingAddress }]);
        // 2nd findMany: erc4626Tokens after self-heal (empty to finish test quickly)
        mockTokenFindMany.mockResolvedValueOnce([]);

        await syncErc4626OnchainData(vaultAddress, viemClient, Chain.SEPOLIA);

        expect(mockFetchErc4626).toHaveBeenCalledTimes(1);
        expect(mockFetchErc4626).toHaveBeenCalledWith([untypedToken], viemClient);
        expect(mockTokenTypeUpsert).toHaveBeenCalledTimes(1);
    });

    it('caches non-ERC4626 reviewed tokens after first probe so subsequent runs skip RPC multicalls', async () => {
        const nonErc4626Token = {
            address: '0x94a9d9ac8a22534e3faca9f4e7f2e2cf85d5e4c8',
            decimals: 6,
            name: 'USDC (Aave)',
            symbol: 'usdc-aave',
            chain: Chain.SEPOLIA,
            underlyingTokenAddress: null,
        };

        // 1st run: reviewed list contains non-ERC4626 token
        mockReviewFindMany.mockResolvedValueOnce([
            { erc4626Address: nonErc4626Token.address, assetAddress: '0xother' },
        ]);
        mockTokenFindMany.mockResolvedValueOnce([nonErc4626Token]);
        mockFetchErc4626.mockResolvedValueOnce([{ ...nonErc4626Token, underlyingTokenAddress: undefined }]);
        mockTokenFindMany.mockResolvedValueOnce([]);

        await syncErc4626OnchainData(vaultAddress, viemClient, Chain.SEPOLIA);
        expect(mockFetchErc4626).toHaveBeenCalledTimes(1);

        // 2nd run: cached as non-ERC4626 so untypedReviewedTokens query & RPC multicall are skipped
        mockReviewFindMany.mockResolvedValueOnce([
            { erc4626Address: nonErc4626Token.address, assetAddress: '0xother' },
        ]);
        mockTokenFindMany.mockResolvedValueOnce([]);

        await syncErc4626OnchainData(vaultAddress, viemClient, Chain.SEPOLIA);
        expect(mockFetchErc4626).toHaveBeenCalledTimes(1);
    });

    it('does not call syncErc4626Tokens when all reviewed ERC4626 tokens are already typed', async () => {
        mockReviewFindMany.mockResolvedValueOnce([{ erc4626Address: '0xde46e43f46ff74a23a65ebb0580cbe3dfe684a17' }]);
        // 1st findMany: untypedReviewedTokens is empty
        mockTokenFindMany.mockResolvedValueOnce([]);
        // 2nd findMany: erc4626Tokens
        mockTokenFindMany.mockResolvedValueOnce([]);

        await syncErc4626OnchainData(vaultAddress, viemClient, Chain.SEPOLIA);

        expect(mockFetchErc4626).not.toHaveBeenCalled();
    });
});
