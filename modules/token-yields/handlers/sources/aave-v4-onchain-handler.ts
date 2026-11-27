import { Chain } from '@prisma/client';
import { Hex, parseAbi } from 'viem';
import { AaveV4AddressBookEntry, TokenApr, TokenYieldHandler } from '../../types';
import { getViemClient } from '../../../sources/viem-client';
import config from '../../../../config';
import { chainIdToChain } from '../../../../config/chain-id-to-chain';

const RAY = 1e27;
const BPS = 10_000;

export const aaveV4HubAbi = parseAbi([
    'function getAssetCount() view returns (uint256)',
    'function getAsset(uint256 assetId) view returns ((uint120 liquidity, uint120 realizedFees, uint8 decimals, uint120 addedShares, uint120 swept, int200 premiumOffsetRay, uint120 drawnShares, uint120 premiumShares, uint16 liquidityFee, uint120 drawnIndex, uint96 drawnRate, uint40 lastUpdateTimestamp, address underlying, address irStrategy, address reinvestmentController, address feeReceiver, uint200 deficitRay))',
    'function getAssetDrawnRate(uint256 assetId) view returns (uint256)',
    'function getAssetDrawnIndex(uint256 assetId) view returns (uint256)',
    'function getAddedAssets(uint256 assetId) view returns (uint256)',
    'function getSpokeCount(uint256 assetId) view returns (uint256)',
    'function getSpokeAddress(uint256 assetId, uint256 index) view returns (address)',
]);

export const aaveV4TokenizationSpokeAbi = parseAbi([
    'function hub() view returns (address)',
    'function assetId() view returns (uint256)',
    'function asset() view returns (address)',
]);

/**
 * Computes instantaneous annual supply APR (as a decimal fraction, e.g. 0.04 = 4%)
 * for an Aave V4 Hub asset, matching Hub AssetLogic interest accrual:
 * annual gross debt growth is drawnRate * (drawnShares + premiumShares) * drawnIndex,
 * of which (1 - liquidityFee / 10_000) accrues to totalAddedAssets.
 */
export function calculateAaveV4SupplyApr(params: {
    drawnRate: bigint;
    drawnIndex: bigint;
    drawnShares: bigint;
    premiumShares: bigint;
    liquidityFee: number | bigint;
    addedAssets: bigint;
}): number {
    const { drawnRate, drawnIndex, drawnShares, premiumShares, liquidityFee, addedAssets } = params;
    if (addedAssets <= 0n || drawnRate <= 0n) {
        return 0;
    }

    const interestBearingShares = drawnShares + premiumShares;
    if (interestBearingShares <= 0n) {
        return 0;
    }

    const feeBps = Number(liquidityFee);
    if (!Number.isFinite(feeBps) || feeBps >= BPS) {
        return 0;
    }

    const drawnRateFloat = Number(drawnRate) / RAY;
    const drawnIndexFloat = Number(drawnIndex) / RAY;
    const utilization = (Number(interestBearingShares) * drawnIndexFloat) / Number(addedAssets);
    const supplyApr = drawnRateFloat * utilization * (1 - feeBps / BPS);

    return Number.isFinite(supplyApr) && supplyApr > 0 ? supplyApr : 0;
}

export const aaveV4OnchainHandler: TokenYieldHandler = async ({ markets }: { markets: AaveV4AddressBookEntry[] }) => {
    const tokenAprs: TokenApr[] = [];

    try {
        const hubsByChain = new Map<Chain, Set<Hex>>();
        for (const market of markets) {
            const chain = chainIdToChain[market.CHAIN_ID];
            if (!chain || !market?.HUBS) {
                continue;
            }
            let chainHubs = hubsByChain.get(chain);
            if (!chainHubs) {
                chainHubs = new Set<Hex>();
                hubsByChain.set(chain, chainHubs);
            }
            for (const hubAddress of Object.values(market.HUBS)) {
                chainHubs.add(hubAddress.toLowerCase() as Hex);
            }
        }

        for (const [chain, hubSet] of hubsByChain) {
            const hubs = Array.from(hubSet);
            if (hubs.length === 0) {
                continue;
            }

            const client = getViemClient(chain);
            const multicallAddress = config[chain]?.multicall3 as Hex | undefined;
            const multicallOptions = multicallAddress ? { multicallAddress } : {};

            // 1. Discover how many assets each configured Hub currently holds on-chain.
            const assetCountResults = await client.multicall({
                contracts: hubs.map((hub) => ({
                    address: hub,
                    abi: aaveV4HubAbi,
                    functionName: 'getAssetCount' as const,
                })),
                allowFailure: true,
                ...multicallOptions,
            });

            if (assetCountResults.every((result) => result.status === 'failure')) {
                const firstFailure = assetCountResults[0];
                throw firstFailure.status === 'failure'
                    ? firstFailure.error
                    : new Error('All getAssetCount calls failed');
            }

            const hubAssets: { hub: Hex; assetId: bigint }[] = [];
            hubs.forEach((hub, index) => {
                const countResult = assetCountResults[index];
                if (countResult.status !== 'success') {
                    return;
                }
                const count = Number(countResult.result);
                for (let id = 0; id < count; id++) {
                    hubAssets.push({ hub, assetId: BigInt(id) });
                }
            });

            if (hubAssets.length === 0) {
                continue;
            }

            // 2. Fetch live rate state and spoke counts for every (hub, assetId).
            const assetStateCalls = hubAssets.flatMap(({ hub, assetId }) => [
                { address: hub, abi: aaveV4HubAbi, functionName: 'getAsset' as const, args: [assetId] as const },
                {
                    address: hub,
                    abi: aaveV4HubAbi,
                    functionName: 'getAssetDrawnRate' as const,
                    args: [assetId] as const,
                },
                {
                    address: hub,
                    abi: aaveV4HubAbi,
                    functionName: 'getAssetDrawnIndex' as const,
                    args: [assetId] as const,
                },
                { address: hub, abi: aaveV4HubAbi, functionName: 'getAddedAssets' as const, args: [assetId] as const },
                { address: hub, abi: aaveV4HubAbi, functionName: 'getSpokeCount' as const, args: [assetId] as const },
            ]);

            const assetStateResults = await client.multicall({
                contracts: assetStateCalls,
                allowFailure: true,
                ...multicallOptions,
            });

            const assetInfoByKey = new Map<string, { underlying: string; apr: number }>();
            const spokeLookupSpecs: { hub: Hex; assetId: bigint; index: bigint; key: string }[] = [];

            for (let i = 0; i < hubAssets.length; i++) {
                const { hub, assetId } = hubAssets[i];
                const baseIdx = i * 5;
                const assetRes = assetStateResults[baseIdx];
                const drawnRateRes = assetStateResults[baseIdx + 1];
                const drawnIndexRes = assetStateResults[baseIdx + 2];
                const addedAssetsRes = assetStateResults[baseIdx + 3];
                const spokeCountRes = assetStateResults[baseIdx + 4];

                if (
                    assetRes.status !== 'success' ||
                    drawnRateRes.status !== 'success' ||
                    drawnIndexRes.status !== 'success' ||
                    addedAssetsRes.status !== 'success' ||
                    spokeCountRes.status !== 'success'
                ) {
                    continue;
                }

                const asset = assetRes.result as {
                    drawnShares: bigint;
                    premiumShares: bigint;
                    liquidityFee: number;
                    underlying: string;
                };
                const key = `${hub}:${assetId.toString()}`;
                const apr = calculateAaveV4SupplyApr({
                    drawnRate: drawnRateRes.result as bigint,
                    drawnIndex: drawnIndexRes.result as bigint,
                    drawnShares: asset.drawnShares,
                    premiumShares: asset.premiumShares,
                    liquidityFee: asset.liquidityFee,
                    addedAssets: addedAssetsRes.result as bigint,
                });

                assetInfoByKey.set(key, { underlying: asset.underlying.toLowerCase(), apr });

                const spokeCount = Number(spokeCountRes.result);
                for (let j = 0; j < spokeCount; j++) {
                    spokeLookupSpecs.push({ hub, assetId, index: BigInt(j), key });
                }
            }

            if (spokeLookupSpecs.length === 0) {
                continue;
            }

            // 3. Enumerate every spoke registered on each (hub, assetId).
            const spokeAddressResults = await client.multicall({
                contracts: spokeLookupSpecs.map(({ hub, assetId, index }) => ({
                    address: hub,
                    abi: aaveV4HubAbi,
                    functionName: 'getSpokeAddress' as const,
                    args: [assetId, index] as const,
                })),
                allowFailure: true,
                ...multicallOptions,
            });

            const spokeToAssetKeys = new Map<Hex, Set<string>>();
            spokeLookupSpecs.forEach((spec, idx) => {
                const res = spokeAddressResults[idx];
                if (res.status !== 'success') {
                    return;
                }
                const spokeAddress = (res.result as string).toLowerCase() as Hex;
                let keys = spokeToAssetKeys.get(spokeAddress);
                if (!keys) {
                    keys = new Set<string>();
                    spokeToAssetKeys.set(spokeAddress, keys);
                }
                keys.add(spec.key);
            });

            const uniqueSpokes = Array.from(spokeToAssetKeys.keys());
            if (uniqueSpokes.length === 0) {
                continue;
            }

            // 4. Identify ERC-4626 TokenizationSpokes (regular borrowing Spokes revert on hub()/assetId()/asset()).
            const spokeProbeResults = await client.multicall({
                contracts: uniqueSpokes.flatMap((spoke) => [
                    { address: spoke, abi: aaveV4TokenizationSpokeAbi, functionName: 'hub' as const },
                    { address: spoke, abi: aaveV4TokenizationSpokeAbi, functionName: 'assetId' as const },
                    { address: spoke, abi: aaveV4TokenizationSpokeAbi, functionName: 'asset' as const },
                ]),
                allowFailure: true,
                ...multicallOptions,
            });

            for (let i = 0; i < uniqueSpokes.length; i++) {
                const spoke = uniqueSpokes[i];
                const baseIdx = i * 3;
                const hubRes = spokeProbeResults[baseIdx];
                const assetIdRes = spokeProbeResults[baseIdx + 1];
                const assetRes = spokeProbeResults[baseIdx + 2];

                if (hubRes.status !== 'success' || assetIdRes.status !== 'success' || assetRes.status !== 'success') {
                    continue;
                }

                const key = `${(hubRes.result as string).toLowerCase()}:${(assetIdRes.result as bigint).toString()}`;
                if (!spokeToAssetKeys.get(spoke)?.has(key)) {
                    continue;
                }

                const assetInfo = assetInfoByKey.get(key);
                if (!assetInfo || assetInfo.underlying !== (assetRes.result as string).toLowerCase()) {
                    continue;
                }

                tokenAprs.push({
                    address: spoke,
                    apr: assetInfo.apr,
                });
            }
        }
    } catch (e) {
        throw Error(`Failed to fetch Aave V4 onchain APR: ${(e as Error).message}`);
    }

    return tokenAprs;
};
