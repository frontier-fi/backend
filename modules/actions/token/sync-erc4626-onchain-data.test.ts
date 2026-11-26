import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chain } from '@prisma/client';

const {
    mockTokenFindMany,
    mockTokenUpdate,
    mockReviewFindMany,
    mockFetchMaxValues,
    mockFetchUnwrapRates,
    mockFetchBufferBalances,
    mockBulkExecute,
} = vi.hoisted(() => ({
    mockTokenFindMany: vi.fn(),
    mockTokenUpdate: vi.fn(),
    mockReviewFindMany: vi.fn(),
    mockFetchMaxValues: vi.fn(),
    mockFetchUnwrapRates: vi.fn(),
    mockFetchBufferBalances: vi.fn(),
    mockBulkExecute: vi.fn(),
}));

vi.mock('../../../prisma/prisma-client', () => ({
    prisma: {
        prismaToken: {
            findMany: mockTokenFindMany,
            update: mockTokenUpdate,
        },
        prismaTokenType: {
            upsert: vi.fn(),
        },
        prismaErc4626ReviewData: {
            findMany: mockReviewFindMany,
        },
    },
}));

vi.mock('../../../prisma/prisma-util', () => ({
    prismaBulkExecuteOperations: mockBulkExecute,
}));

vi.mock('./sync-erc4626-tokens', () => ({
    syncErc4626Tokens: vi.fn(),
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

import { syncErc4626OnchainData } from './sync-erc4626-onchain-data';

describe('syncErc4626OnchainData', () => {
    const viemClient = {} as any;
    const vaultAddress = '0xFF00009C1A83Ec25434522ef355b99e9a70000FF';

    beforeEach(() => {
        vi.clearAllMocks();
        mockReviewFindMany.mockResolvedValue([]);
        mockBulkExecute.mockResolvedValue(undefined);
    });

    it('persists fetched maxDeposit and maxWithdraw without hardcoded Morpho V2 maxUint256 overrides', async () => {
        const kpkUsdcPrimeV2 = '0x4ef53d2caa51c447fdfeeedee8f07fd1962c9ee6';
        const gauntletUsdcPrime = '0x8c106eedad96553e64287a5a6839c3cc78afa3d0';
        const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

        mockTokenFindMany.mockResolvedValueOnce([
            {
                address: kpkUsdcPrimeV2,
                chain: Chain.MAINNET,
                decimals: 18,
                underlyingTokenAddress: usdcAddress,
                maxDeposit: '100',
                maxWithdraw: '100',
                unwrapRate: '1',
                bufferBalanceUnderlying: '0',
                bufferBalanceWrapped: '0',
            },
            {
                address: gauntletUsdcPrime,
                chain: Chain.MAINNET,
                decimals: 18,
                underlyingTokenAddress: usdcAddress,
                maxDeposit: '100',
                maxWithdraw: '100',
                unwrapRate: '1',
                bufferBalanceUnderlying: '0',
                bufferBalanceWrapped: '0',
            },
        ]);

        mockTokenFindMany.mockResolvedValueOnce([
            {
                address: usdcAddress,
                chain: Chain.MAINNET,
                decimals: 6,
            },
        ]);

        mockFetchMaxValues.mockResolvedValueOnce({
            [kpkUsdcPrimeV2]: { maxDeposit: '0', maxWithdraw: '0' },
            [gauntletUsdcPrime]: { maxDeposit: '0', maxWithdraw: '0' },
        });
        mockFetchUnwrapRates.mockResolvedValueOnce({
            [kpkUsdcPrimeV2]: { unwrapRate: '1' },
            [gauntletUsdcPrime]: { unwrapRate: '1' },
        });
        mockFetchBufferBalances.mockResolvedValueOnce({});

        await syncErc4626OnchainData(vaultAddress, viemClient, Chain.MAINNET);

        expect(mockTokenUpdate).toHaveBeenCalledTimes(2);
        expect(mockTokenUpdate).toHaveBeenCalledWith({
            where: {
                address_chain: {
                    address: kpkUsdcPrimeV2,
                    chain: Chain.MAINNET,
                },
            },
            data: {
                maxDeposit: '0',
                maxWithdraw: '0',
            },
        });
        expect(mockTokenUpdate).toHaveBeenCalledWith({
            where: {
                address_chain: {
                    address: gauntletUsdcPrime,
                    chain: Chain.MAINNET,
                },
            },
            data: {
                maxDeposit: '0',
                maxWithdraw: '0',
            },
        });
    });
});
