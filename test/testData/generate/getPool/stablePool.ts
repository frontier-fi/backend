import { type PublicClient, type Address, parseAbi } from 'viem';
import VaultV3Abi from '../../../../modules/sources/contracts/abis/VaultV3';
import { getBatchedPublicClient, resolveMulticall3Address, resolveVaultAddress } from '../getSwapPath';

import { TransformBigintToString } from '../../types';
import { vaultExplorerAbi } from '../abi/vaultExplorer';

type StableMutable = {
    amp: bigint;
    swapFee: bigint;
    totalSupply: bigint;
    balancesLiveScaled18: bigint[];
    tokenRates: bigint[];
    aggregateSwapFee: bigint;
};

type StableImmutable = {
    tokens: bigint[];
    scalingFactors: bigint[];
};

export class StablePool {
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

    async fetchImmutableData(address: Address, blockNumber: bigint): Promise<TransformBigintToString<StableImmutable>> {
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
        const multicallResult = await this.client.multicall({
            contracts: [poolTokensCall, tokenRatesCall],
            allowFailure: false,
            blockNumber,
            multicallAddress: this.multicallAddress,
        });
        return {
            tokens: multicallResult[0][0].map((token) => token),
            scalingFactors: multicallResult[1][0].map((sf) => sf.toString()),
        };
    }

    async fetchMutableData(address: Address, blockNumber: bigint): Promise<TransformBigintToString<StableMutable>> {
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
        const amplificationParameterCall = {
            address,
            abi: parseAbi([
                'function getAmplificationParameter() external view returns (uint256 value, bool isUpdating, uint256 precision)',
            ]),
            functionName: 'getAmplificationParameter',
        } as const;
        const poolConfigCall = {
            address: this.vault,
            abi: vaultExplorerAbi,
            functionName: 'getPoolConfig',
            args: [address],
        } as const;

        const multicallResult = await this.client.multicall({
            contracts: [totalSupplyCall, liveBalancesCall, tokenRatesCall, amplificationParameterCall, poolConfigCall],
            allowFailure: false,
            blockNumber,
            multicallAddress: this.multicallAddress,
        });
        return {
            swapFee: multicallResult[4].staticSwapFeePercentage.toString(),
            totalSupply: multicallResult[0].toString(),
            balancesLiveScaled18: multicallResult[1].map((b) => b.toString()),
            tokenRates: multicallResult[2][1].map((b) => b.toString()),
            amp: multicallResult[3][0].toString(),
            aggregateSwapFee: multicallResult[4].aggregateSwapFeePercentage.toString(),
        };
    }
}
