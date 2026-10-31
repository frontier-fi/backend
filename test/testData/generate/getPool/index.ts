import type { Address } from 'viem';
import { isAddressEqual, zeroAddress } from 'viem';
import VaultV3Abi from '../../../../modules/sources/contracts/abis/VaultV3';
import { getBatchedPublicClient, resolveVaultAddress } from '../getSwapPath';

import type { PoolBase, TestBase } from '../../types';
import { WeightedPool } from './weightedPool';
import { StablePool } from './stablePool';
import { BufferPool } from './buffer';
import { GyroECLPPool } from './gyroECLP';
export async function getPool(
    rpcUrl: string,
    chainId: number,
    blockNumber: bigint,
    poolType: string,
    poolAddress: Address,
): Promise<PoolBase & TestBase> {
    // Find onchain data fetching via pool type
    const poolData: Record<string, WeightedPool | StablePool | BufferPool | GyroECLPPool> = {
        WEIGHTED: new WeightedPool(rpcUrl, chainId),
        STABLE: new StablePool(rpcUrl, chainId),
        Buffer: new BufferPool(rpcUrl, chainId),
        GYROE: new GyroECLPPool(rpcUrl, chainId),
    };
    if (!poolData[poolType]) throw new Error(`getPool: Unsupported pool type: ${poolType}`);

    console.log('Fetching pool data...');
    const [immutable, mutable, hooksContract] = await Promise.all([
        poolData[poolType].fetchImmutableData(poolAddress, blockNumber),
        poolData[poolType].fetchMutableData(poolAddress, blockNumber),
        fetchHookAddress(poolType, rpcUrl, chainId, poolAddress, blockNumber),
    ]);

    console.log('Done');

    return {
        chainId,
        blockNumber,
        poolType,
        poolAddress,
        hook: hooksContract ? { address: hooksContract.toLowerCase() } : undefined,
        ...immutable,
        ...mutable,
    };
}

async function fetchHookAddress(
    poolType: string,
    rpcUrl: string,
    chainId: number,
    poolAddress: Address,
    blockNumber: bigint,
): Promise<Address | undefined> {
    let hooksContract: Address | undefined;

    if (poolType !== 'Buffer') {
        const publicClient = getBatchedPublicClient(rpcUrl, chainId);
        ({ hooksContract } = await publicClient.readContract({
            address: resolveVaultAddress(chainId),
            abi: VaultV3Abi,
            functionName: 'getHooksConfig',
            args: [poolAddress],
            blockNumber,
        }));
    }

    if (!hooksContract || isAddressEqual(hooksContract, zeroAddress) || isAddressEqual(hooksContract, poolAddress)) {
        return undefined;
    }

    return hooksContract;
}
