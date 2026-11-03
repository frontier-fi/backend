import {
    type Address,
    type Hex,
    type PublicClient,
    createPublicClient,
    encodeFunctionData,
    http,
    maxUint256,
    parseAbi,
    zeroAddress,
} from 'viem';
import config from '../../../config';
import { chainIdToChain } from '../../../config/chain-id-to-chain';
import { PathWithAmount } from '../../../modules/sor/lib/path';
import { TransformBigintToString } from '../types';

export const batchRouterAbi = parseAbi([
    'struct SwapPathStep { address pool; address tokenOut; bool isBuffer; }',
    'struct SwapPathExactAmountIn { address tokenIn; SwapPathStep[] steps; uint256 exactAmountIn; uint256 minAmountOut; }',
    'struct SwapPathExactAmountOut { address tokenIn; SwapPathStep[] steps; uint256 maxAmountIn; uint256 exactAmountOut; }',
    'function querySwapExactIn(SwapPathExactAmountIn[] paths, address sender, bytes userData) external returns (uint256[] pathAmountsOut, address[] tokensOut, uint256[] amountsOut)',
    'function querySwapExactOut(SwapPathExactAmountOut[] paths, address sender, bytes userData) external returns (uint256[] pathAmountsIn, address[] tokensIn, uint256[] amountsIn)',
]);

export type BatchRouterStepArg = {
    pool: Address;
    tokenOut: Address;
    isBuffer: boolean;
};

export type BatchRouterExactInPathArg = {
    tokenIn: Address;
    steps: BatchRouterStepArg[];
    exactAmountIn: bigint;
    minAmountOut: bigint;
};

export type BatchRouterExactOutPathArg = {
    tokenIn: Address;
    steps: BatchRouterStepArg[];
    maxAmountIn: bigint;
    exactAmountOut: bigint;
};

export type Path = {
    pools: {
        poolAddress: Address;
        poolType: string;
    }[];
    tokens: Address[];
    amountRaw: bigint;
    calculatedAmountRaw: bigint;
};

export type SwapPathInput = {
    swapKind: number;
    paths: Path[];
};

export type SwapPathResult = Omit<SwapPathInput, 'paths'> & {
    paths: TransformBigintToString<Path>[];
};

export function resolveBatchRouterAddress(chainId: number): Address {
    const chain = chainIdToChain[String(chainId)];
    const configured = chain ? config[chain]?.contracts?.BatchRouter : undefined;
    if (!configured) {
        throw new Error(`No BatchRouter configured for chainId ${chainId}`);
    }
    return configured as Address;
}

export function resolveVaultAddress(chainId: number): Address {
    const chain = chainIdToChain[String(chainId)];
    const configured = chain ? config[chain]?.contracts?.Vault : undefined;
    if (!configured) {
        throw new Error(`No Vault configured for chainId ${chainId}`);
    }
    return configured as Address;
}

export function resolveMulticall3Address(chainId: number): Address {
    const chain = chainIdToChain[String(chainId)];
    const configured = chain ? config[chain]?.multicall3 : undefined;
    return (configured ?? '0xcA11bde05977b3631167028862bE2a173976CA11') as Address;
}

const clientCache = new Map<string, PublicClient>();

export function getBatchedPublicClient(rpcUrl: string, chainId: number): PublicClient {
    const key = `${chainId}:${rpcUrl}`;
    const existing = clientCache.get(key);
    if (existing) return existing;

    const multicallAddress = resolveMulticall3Address(chainId);
    const client = createPublicClient({
        chain: {
            id: chainId,
            name: `chain-${chainId}`,
            nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
            rpcUrls: { default: { http: [rpcUrl] } },
            contracts: { multicall3: { address: multicallAddress } },
        },
        transport: http(rpcUrl),
        batch: { multicall: true },
    });
    clientCache.set(key, client);
    return client;
}

export function fromSorPathsToSwapPathInput(swapKind: number, sorPaths: PathWithAmount[]): SwapPathInput {
    return {
        swapKind,
        paths: sorPaths.map((p) => ({
            pools: p.pools.map((pool, i) => ({
                poolAddress: pool.address as Address,
                poolType: p.isBuffer[i] ? 'Buffer' : pool.poolType,
            })),
            tokens: p.tokens.map((t) => t.address as Address),
            amountRaw: p.swapAmount.amount,
            calculatedAmountRaw: swapKind === 0 ? p.outputAmount.amount : p.inputAmount.amount,
        })),
    };
}

export function buildBatchRouterExactInArgs(paths: Path[]): BatchRouterExactInPathArg[] {
    return paths.map((path) => ({
        tokenIn: path.tokens[0],
        steps: path.pools.map((pool, i) => ({
            pool: pool.poolAddress,
            tokenOut: path.tokens[i + 1],
            isBuffer: pool.poolType === 'Buffer',
        })),
        exactAmountIn: path.amountRaw,
        minAmountOut: 0n,
    }));
}

export function buildBatchRouterExactOutArgs(paths: Path[]): BatchRouterExactOutPathArg[] {
    return paths.map((path) => ({
        tokenIn: path.tokens[0],
        steps: path.pools.map((pool, i) => ({
            pool: pool.poolAddress,
            tokenOut: path.tokens[i + 1],
            isBuffer: pool.poolType === 'Buffer',
        })),
        maxAmountIn: maxUint256,
        exactAmountOut: path.amountRaw,
    }));
}

export function encodeBatchRouterQueryCalldata(swapKind: number, paths: Path[], sender: Address = zeroAddress): Hex {
    if (swapKind === 0) {
        return encodeFunctionData({
            abi: batchRouterAbi,
            functionName: 'querySwapExactIn',
            args: [buildBatchRouterExactInArgs(paths), sender, '0x'],
        });
    }
    return encodeFunctionData({
        abi: batchRouterAbi,
        functionName: 'querySwapExactOut',
        args: [buildBatchRouterExactOutArgs(paths), sender, '0x'],
    });
}

export async function queryBatchRouterWithViem({
    client,
    batchRouterAddress,
    swapPathInput,
    blockNumber,
    sender = zeroAddress,
}: {
    client: PublicClient;
    batchRouterAddress: Address;
    swapPathInput: SwapPathInput;
    blockNumber?: bigint;
    sender?: Address;
}): Promise<{ pathAmounts: bigint[]; tokens: Address[]; totalAmounts: bigint[] }> {
    if (swapPathInput.swapKind === 0) {
        const { result } = await client.simulateContract({
            address: batchRouterAddress,
            abi: batchRouterAbi,
            functionName: 'querySwapExactIn',
            args: [buildBatchRouterExactInArgs(swapPathInput.paths), sender, '0x'],
            blockNumber,
        });
        return {
            pathAmounts: [...result[0]],
            tokens: [...result[1]],
            totalAmounts: [...result[2]],
        };
    }

    const { result } = await client.simulateContract({
        address: batchRouterAddress,
        abi: batchRouterAbi,
        functionName: 'querySwapExactOut',
        args: [buildBatchRouterExactOutArgs(swapPathInput.paths), sender, '0x'],
        blockNumber,
    });
    return {
        pathAmounts: [...result[0]],
        tokens: [...result[1]],
        totalAmounts: [...result[2]],
    };
}

async function querySwapPath(
    chainId: number,
    rpcUrl: string,
    swapPathInput: SwapPathInput,
    blockNumber: bigint,
): Promise<bigint[]> {
    const client = createPublicClient({
        transport: http(rpcUrl),
    });
    const batchRouterAddress = resolveBatchRouterAddress(chainId);
    const { pathAmounts } = await queryBatchRouterWithViem({
        client,
        batchRouterAddress,
        swapPathInput,
        blockNumber,
    });
    return pathAmounts;
}

export async function getSwapPath(
    swapPathInput: SwapPathInput,
    rpcUrl: string,
    chainId: number,
    blockNumber: bigint,
): Promise<SwapPathResult> {
    console.log('Querying swap paths...');
    const result = await querySwapPath(chainId, rpcUrl, swapPathInput, blockNumber);

    if (result.length !== swapPathInput.paths.length) {
        throw new Error(
            `Result length ${result.length} does not match swapPath.paths length ${swapPathInput.paths.length}`,
        );
    }

    console.log('Done');
    return {
        ...swapPathInput,
        paths: swapPathInput.paths.map((path, index) => ({
            ...path,
            amountRaw: path.amountRaw.toString(),
            calculatedAmountRaw: result[index].toString(),
        })),
    };
}
