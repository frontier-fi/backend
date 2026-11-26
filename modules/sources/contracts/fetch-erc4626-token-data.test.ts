import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chain } from '@prisma/client';
import { zeroAddress } from 'viem';

const { mockMulticallViem, mockFetchErc20Headers } = vi.hoisted(() => ({
    mockMulticallViem: vi.fn(),
    mockFetchErc20Headers: vi.fn(),
}));

vi.mock('../../web3/multicaller-viem', () => ({
    multicallViem: mockMulticallViem,
}));

vi.mock('.', () => ({
    fetchErc20Headers: mockFetchErc20Headers,
}));

import { fetchErc4626AndUnderlyingTokenData } from './fetch-erc4626-token-data';

const makeValidProbeResult = (asset: string) => ({
    asset,
    convertToAssets: 1n,
    convertToShares: 1n,
    previewDeposit: 1n,
    previewMint: 1n,
    previewRedeem: 1n,
    previewWithdraw: 1n,
});

describe('fetchErc4626AndUnderlyingTokenData', () => {
    const viemClient = {} as any;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the ERC-4626 token with lowercased underlyingTokenAddress and fetched ERC-20 underlying', async () => {
        const waMonWstEth = '0x50591a9f86972c591b6fe858b465f5b65d5c24ee';
        const wstEthChecksummed = '0x10Aeaf63194db8d453d4D85a06E5eFE1dd0b5417';
        const wstEthLower = wstEthChecksummed.toLowerCase();

        mockMulticallViem.mockResolvedValueOnce({
            [waMonWstEth]: makeValidProbeResult(wstEthChecksummed),
        });
        mockFetchErc20Headers.mockResolvedValueOnce({
            [wstEthLower]: { name: 'Wrapped liquid staked Ether 2.0', symbol: 'wstETH', decimals: 18 },
        });

        const result = await fetchErc4626AndUnderlyingTokenData(
            [
                {
                    address: waMonWstEth,
                    decimals: 18,
                    name: 'Wrapped Aave Monad wstETH',
                    symbol: 'waMonwstETH',
                    chain: Chain.MONAD,
                },
            ],
            viemClient,
        );

        expect(mockFetchErc20Headers).toHaveBeenCalledTimes(1);
        expect(mockFetchErc20Headers).toHaveBeenCalledWith([wstEthLower], viemClient);
        expect(result).toEqual([
            {
                address: waMonWstEth,
                decimals: 18,
                name: 'Wrapped Aave Monad wstETH',
                symbol: 'waMonwstETH',
                chain: Chain.MONAD,
                underlyingTokenAddress: wstEthLower,
            },
            {
                address: wstEthLower,
                decimals: 18,
                name: 'Wrapped liquid staked Ether 2.0',
                symbol: 'wstETH',
                chain: Chain.MONAD,
                underlyingTokenAddress: undefined,
            },
        ]);
    });

    it('ignores native sentinel asset() on MONAD (shMON) without skipping subsequent ERC-4626 tokens', async () => {
        const shMon = '0x1b68626dca36c7fe922fd2d55e4f631d962de19c';
        const waMonWstEth = '0x50591a9f86972c591b6fe858b465f5b65d5c24ee';
        const wstEth = '0x10aeaf63194db8d453d4d85a06e5efe1dd0b5417';

        mockMulticallViem.mockResolvedValueOnce({
            [shMon]: makeValidProbeResult('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'),
            [waMonWstEth]: makeValidProbeResult(wstEth),
        });
        mockFetchErc20Headers.mockResolvedValueOnce({
            [wstEth]: { name: 'Wrapped liquid staked Ether 2.0', symbol: 'wstETH', decimals: 18 },
        });

        const result = await fetchErc4626AndUnderlyingTokenData(
            [
                {
                    address: shMon,
                    decimals: 18,
                    name: 'ShMonad',
                    symbol: 'shMON',
                    chain: Chain.MONAD,
                },
                {
                    address: waMonWstEth,
                    decimals: 18,
                    name: 'Wrapped Aave Monad wstETH',
                    symbol: 'waMonwstETH',
                    chain: Chain.MONAD,
                },
            ],
            viemClient,
        );

        expect(mockFetchErc20Headers).toHaveBeenCalledTimes(1);
        expect(mockFetchErc20Headers).toHaveBeenCalledWith([wstEth], viemClient);
        expect(result.find((t) => t.address === shMon)?.underlyingTokenAddress).toBeUndefined();
        expect(result.find((t) => t.address === waMonWstEth)?.underlyingTokenAddress).toBe(wstEth);
        expect(result.find((t) => t.address === wstEth)).toBeDefined();
        expect(result.some((t) => t.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')).toBe(
            false,
        );
    });

    it('rejects non-ERC20 underlyings returning NaN decimals and caches the rejection within the batch', async () => {
        const vaultA = '0x1111111111111111111111111111111111111111';
        const vaultB = '0x2222222222222222222222222222222222222222';
        const nonContractAsset = '0x9999999999999999999999999999999999999999';

        mockMulticallViem.mockResolvedValueOnce({
            [vaultA]: makeValidProbeResult(nonContractAsset),
            [vaultB]: makeValidProbeResult(nonContractAsset),
        });
        mockFetchErc20Headers.mockResolvedValueOnce({
            [nonContractAsset]: { name: 'undefined', symbol: 'undefined', decimals: Number.NaN },
        });

        const result = await fetchErc4626AndUnderlyingTokenData(
            [
                { address: vaultA, decimals: 18, name: 'Vault A', symbol: 'vA', chain: Chain.MONAD },
                { address: vaultB, decimals: 18, name: 'Vault B', symbol: 'vB', chain: Chain.MONAD },
            ],
            viemClient,
        );

        expect(mockFetchErc20Headers).toHaveBeenCalledTimes(1);
        expect(result).toEqual([
            {
                address: vaultA,
                decimals: 18,
                name: 'Vault A',
                symbol: 'vA',
                chain: Chain.MONAD,
                underlyingTokenAddress: undefined,
            },
            {
                address: vaultB,
                decimals: 18,
                name: 'Vault B',
                symbol: 'vB',
                chain: Chain.MONAD,
                underlyingTokenAddress: undefined,
            },
        ]);
    });

    it('ignores zeroAddress and self-referential asset() values', async () => {
        const zeroVault = '0x3333333333333333333333333333333333333333';
        const selfVault = '0x4444444444444444444444444444444444444444';

        mockMulticallViem.mockResolvedValueOnce({
            [zeroVault]: makeValidProbeResult(zeroAddress),
            [selfVault]: makeValidProbeResult(selfVault),
        });

        const result = await fetchErc4626AndUnderlyingTokenData(
            [
                { address: zeroVault, decimals: 18, name: 'Zero Vault', symbol: 'zV', chain: Chain.MONAD },
                { address: selfVault, decimals: 18, name: 'Self Vault', symbol: 'sV', chain: Chain.MONAD },
            ],
            viemClient,
        );

        expect(mockFetchErc20Headers).not.toHaveBeenCalled();
        expect(result.every((t) => t.underlyingTokenAddress === undefined)).toBe(true);
    });
});
