import { ViemClient } from '../viem-client';
import MinimalErc4626Abi from './abis/MinimalERC4626';
import { fetchErc20Headers } from '.';
import { multicallViem, ViemMulticallCall } from '../../web3/multicaller-viem';
import { addressesMatch, isNativeAssetAddress } from '../../web3/addresses';
import { Chain } from '@prisma/client';
import { zeroAddress } from 'viem';

interface Erc4626Data {
    asset?: string;
    convertToAssets?: string;
    convertToShares?: string;
    previewDeposit?: string;
    previewMint?: string;
    previewRedeem?: string;
    previewWithdraw?: string;
}

export async function fetchErc4626AndUnderlyingTokenData(
    tokens: { address: string; decimals: number; name: string; symbol: string; chain: Chain }[],
    viemClient: ViemClient,
): Promise<
    {
        address: string;
        decimals: number;
        name: string;
        symbol: string;
        chain: Chain;
        underlyingTokenAddress?: string;
    }[]
> {
    const tokenData: {
        [id: string]: {
            address: string;
            decimals: number;
            name: string;
            symbol: string;
            chain: Chain;
            underlyingTokenAddress?: string;
        };
    } = {};

    const calls: ViemMulticallCall[] = [];

    for (const token of tokens) {
        calls.push(
            {
                path: `${token.address}.asset`,
                address: token.address as `0x${string}`,
                abi: MinimalErc4626Abi,
                functionName: 'asset',
            },
            {
                path: `${token.address}.convertToAssets`,
                address: token.address as `0x${string}`,
                abi: MinimalErc4626Abi,
                functionName: 'convertToAssets',
                args: [1n],
            },
            {
                path: `${token.address}.convertToShares`,
                address: token.address as `0x${string}`,
                abi: MinimalErc4626Abi,
                functionName: 'convertToShares',
                args: [1n],
            },
            {
                path: `${token.address}.previewDeposit`,
                address: token.address as `0x${string}`,
                abi: MinimalErc4626Abi,
                functionName: 'previewDeposit',
                args: [1n],
            },
            {
                path: `${token.address}.previewMint`,
                address: token.address as `0x${string}`,
                abi: MinimalErc4626Abi,
                functionName: 'previewMint',
                args: [1n],
            },
            {
                path: `${token.address}.previewRedeem`,
                address: token.address as `0x${string}`,
                abi: MinimalErc4626Abi,
                functionName: 'previewRedeem',
                args: [1n],
            },
            {
                path: `${token.address}.previewWithdraw`,
                address: token.address as `0x${string}`,
                abi: MinimalErc4626Abi,
                functionName: 'previewWithdraw',
                args: [1n],
            },
        );
    }

    const results = await multicallViem<{ [tokenAddress: string]: Erc4626Data }>(viemClient, calls);
    const rejectedUnderlyings = new Set<string>();

    for (const token of tokens) {
        const result = results[token.address];
        let underlyingTokenAddress: string | undefined = undefined;

        if (
            result &&
            result.asset !== undefined &&
            result.convertToAssets !== undefined &&
            result.convertToShares !== undefined &&
            result.previewDeposit !== undefined &&
            result.previewMint !== undefined &&
            result.previewRedeem !== undefined &&
            result.previewWithdraw !== undefined &&
            !addressesMatch(result.asset, zeroAddress) &&
            !isNativeAssetAddress(result.asset, token.chain) &&
            !addressesMatch(result.asset, token.address)
        ) {
            const candidate = result.asset.toLowerCase();
            if (!rejectedUnderlyings.has(candidate)) {
                underlyingTokenAddress = candidate;
            }
        }

        tokenData[token.address] = {
            address: token.address,
            decimals: token.decimals,
            name: token.name,
            symbol: token.symbol,
            chain: token.chain,
            underlyingTokenAddress,
        };

        if (underlyingTokenAddress && !tokenData[underlyingTokenAddress]) {
            const underlyingTokenDetail = await fetchErc20Headers(
                [underlyingTokenAddress as `0x${string}`],
                viemClient,
            );
            const detail = underlyingTokenDetail[underlyingTokenAddress];

            if (!detail || !Number.isInteger(detail.decimals) || detail.decimals < 0) {
                rejectedUnderlyings.add(underlyingTokenAddress);
                tokenData[token.address].underlyingTokenAddress = undefined;
                continue;
            }

            tokenData[underlyingTokenAddress] = {
                address: underlyingTokenAddress,
                decimals: detail.decimals,
                name: detail.name,
                symbol: detail.symbol,
                chain: token.chain,
                underlyingTokenAddress: undefined,
            };
        }
    }

    return [...Object.values(tokenData)];
}
