import { type PublicClient, type Address, erc4626Abi, erc20Abi } from 'viem';
import VaultExplorerAbi from '../../../../modules/sources/contracts/abis/VaultExplorer';
import { getBatchedPublicClient, resolveVaultAddress } from '../getSwapPath';

import { TransformBigintToString } from '../../types';

export type BufferImmutable = {
    tokens: Address[];
    decimals: number[]; // this is an addition required to scale the rate and transform from/to fixedPoint/floatPoint
};

type BufferMutable = {
    rate: bigint;
    mainTokenBalance: bigint;
    underlyingTokenBalance: bigint;
};

export class BufferPool {
    client: PublicClient;
    vault: Address;

    constructor(
        public rpcUrl: string,
        public chainId: number,
    ) {
        this.client = getBatchedPublicClient(this.rpcUrl, this.chainId);
        this.vault = resolveVaultAddress(this.chainId);
    }

    async fetchImmutableData(address: Address, blockNumber: bigint): Promise<TransformBigintToString<BufferImmutable>> {
        const [asset, mainTokenDecimals] = await Promise.all([
            this.client.readContract({
                address,
                abi: erc4626Abi,
                functionName: 'asset',
                blockNumber,
            }),
            this.client.readContract({
                address,
                abi: erc20Abi,
                functionName: 'decimals',
                blockNumber,
            }),
        ]);

        const underlyingTokenDecimals = await this.client.readContract({
            address: asset,
            abi: erc20Abi,
            functionName: 'decimals',
            blockNumber,
        });

        return {
            tokens: [address, asset],
            decimals: [mainTokenDecimals, underlyingTokenDecimals],
        };
    }

    async fetchMutableData(address: Address, blockNumber: bigint): Promise<TransformBigintToString<BufferMutable>> {
        const [rate, bufferBalance] = await Promise.all([
            this.client.readContract({
                address,
                abi: erc4626Abi,
                functionName: 'convertToAssets',
                args: [1000000000000000000n],
                blockNumber,
            }),
            this.client.readContract({
                address: this.vault,
                abi: VaultExplorerAbi,
                functionName: 'getBufferBalance',
                args: [address],
                blockNumber,
            }),
        ]);
        return {
            rate: rate.toString(),
            underlyingTokenBalance: bufferBalance[0].toString(),
            mainTokenBalance: bufferBalance[1].toString(),
        };
    }
}
