import { type PublicClient, type Address, parseAbi } from 'viem';
import VaultV3Abi from '../../../../modules/sources/contracts/abis/VaultV3';
import { getBatchedPublicClient, resolveMulticall3Address, resolveVaultAddress } from '../getSwapPath';

import { TransformBigintToString } from '../../types';
import { vaultExplorerAbi } from '../abi/vaultExplorer';

export type WeightedImmutable = {
    tokens: bigint[];
    scalingFactors: bigint[];
    weights: bigint[];
};

type WeightedMutable = {
    swapFee: bigint;
    totalSupply: bigint;
    balancesLiveScaled18: bigint[];
    tokenRates: bigint[];
    aggregateSwapFee: bigint;
};

export class WeightedPool {
    client: PublicClient;
    vault: Address;
    multicallAddress: Address;

    constructor(
        public rpcUrl: string,
        public chainId: number,
    ) {
        this.client = getBatchedPublicClient(this.rpcUrl, this.chainId);
        this.vault = resolveVaultAddress(this.chainId);
        this.multicallAddress = resolveMulticall3Address(this.chainId);
    }

    async fetchImmutableData(
        address: Address,
        blockNumber: bigint,
    ): Promise<TransformBigintToString<WeightedImmutable>> {
        const poolTokensCall = {
            address: this.vault,
            abi: VaultV3Abi,
            functionName: 'getPoolTokenInfo',
            args: [address],
        } as const;
        const tokenRatesCall = {
            address: this.vault,
            abi: VaultV3Abi,
            functionName: 'getPoolTokenRates',
            args: [address],
        } as const;
        const tokenWeightsCall = {
            address,
            abi: parseAbi(['function getNormalizedWeights() external view returns (uint256[] memory)']),
            functionName: 'getNormalizedWeights',
        } as const;

        const multicallResult = await this.client.multicall({
            contracts: [poolTokensCall, tokenRatesCall, tokenWeightsCall],
            allowFailure: false,
            blockNumber,
            multicallAddress: this.multicallAddress,
        });
        return {
            tokens: multicallResult[0][0].map((token) => token),
            scalingFactors: multicallResult[1][0].map((sf) => sf.toString()),
            weights: multicallResult[2].map((w) => w.toString()),
        };
    }

    async fetchMutableData(address: Address, blockNumber: bigint): Promise<TransformBigintToString<WeightedMutable>> {
        const totalSupplyCall = {
            address: this.vault,
            abi: parseAbi(['function totalSupply(address token) external view returns (uint256)']),
            functionName: 'totalSupply',
            args: [address],
        } as const;
        const liveBalancesCall = {
            address: this.vault,
            abi: VaultV3Abi,
            functionName: 'getCurrentLiveBalances',
            args: [address],
        } as const;
        const tokenRatesCall = {
            address: this.vault,
            abi: VaultV3Abi,
            functionName: 'getPoolTokenRates',
            args: [address],
        } as const;
        const poolConfigCall = {
            address: this.vault,
            abi: vaultExplorerAbi,
            functionName: 'getPoolConfig',
            args: [address],
        } as const;

        const multicallResult = await this.client.multicall({
            contracts: [totalSupplyCall, liveBalancesCall, tokenRatesCall, poolConfigCall],
            allowFailure: false,
            blockNumber,
            multicallAddress: this.multicallAddress,
        });
        return {
            swapFee: multicallResult[3].staticSwapFeePercentage.toString(),
            totalSupply: multicallResult[0].toString(),
            balancesLiveScaled18: multicallResult[1].map((b) => b.toString()),
            tokenRates: multicallResult[2][1].map((b) => b.toString()),
            aggregateSwapFee: multicallResult[3].aggregateSwapFeePercentage.toString(),
        };
    }
}
