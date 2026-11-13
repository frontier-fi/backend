import {
    GqlSorSwapType,
    GqlSorPath,
    GqlSorSwapRoute,
    GqlSorSwapRouteHop,
    GqlSorGetSwapPaths,
    GqlSorCallData,
    QuerySorGetSwapPathsArgs,
    GqlSorSwap,
} from '../../../apps/api/gql/generated-schema';
import { aGqlPoolMinimal } from '../../../apps/api/gql/schema/__mocks__/graphql';
import { SwapKind } from '@frontier-fi/maths';
import { formatUnits } from 'viem';
import { PathWithAmount } from '../lib/path';
import { TokenAmount } from '../lib/utils';
import { Chain } from '@prisma/client';
import { addressesMatch, replaceZeroAddressWithEth } from '../../web3/addresses';
import { calculatePriceImpact, getInputAmount, getOutputAmount } from '../lib/utils/helpers';
import { GetSwapPathsInput } from '../types';
import { getTokenAmountHuman } from './helpers';
import config from '../../../config';

export async function mapToGetSwapPathsInput(
    args: QuerySorGetSwapPathsArgs,
): Promise<Omit<GetSwapPathsInput, 'protocolVersion'>> {
    const amountToken = args.swapType === 'EXACT_IN' ? args.tokenIn : args.tokenOut;
    const amount = await getTokenAmountHuman(amountToken, args.swapAmount, args.chain);
    const wethIsEth =
        addressesMatch(args.tokenIn, config[args.chain].eth.address) ||
        addressesMatch(args.tokenOut, config[args.chain].eth.address);

    return {
        chain: args.chain,
        swapAmount: amount,
        swapType: args.swapType,
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        queryBatchSwap: args.queryBatchSwap ?? false,
        callDataInput: args.callDataInput
            ? {
                  receiver: args.callDataInput.receiver,
                  sender: args.callDataInput.sender,
                  slippagePercentage: args.callDataInput.slippagePercentage,
                  deadline: args.callDataInput.deadline,
                  wethIsEth,
              }
            : undefined,
        considerPoolsWithHooks: args.considerPoolsWithHooks ?? true,
        poolIds: args.poolIds ?? undefined,
    };
}

export async function mapToSorSwapPaths(
    paths: PathWithAmount[],
    swapType: GqlSorSwapType,
    chain: Chain,
    protocolVersion: number,
): Promise<GqlSorGetSwapPaths> {
    const swapKind = mapSwapKind(swapType);

    let inputAmount = getInputAmount(paths);
    let outputAmount = getOutputAmount(paths);

    // TODO: remove this once we fully deprecate queryBatchSwap and callDataInput
    const callData: GqlSorCallData | undefined = undefined;
    let priceImpact: string | undefined;
    let priceImpactError: string | undefined;
    try {
        priceImpact = calculatePriceImpact(paths, swapKind);
    } catch {
        priceImpact = undefined;
        priceImpactError =
            'Price impact could not be calculated for this path. The swap path is still valid and can be executed.';
    }

    const sorPaths: GqlSorPath[] = paths.map((path) => ({
        protocolVersion,
        vaultVersion: protocolVersion,
        inputAmountRaw: path.inputAmount.amount.toString(),
        outputAmountRaw: path.outputAmount.amount.toString(),
        tokens: path.tokens.map((token) => ({
            address: token.address,
            decimals: token.decimals,
        })),
        pools: path.pools.map((pool) => pool.id),
        isBuffer: path.isBuffer,
    }));

    const returnAmount = swapKind === SwapKind.GivenIn ? outputAmount : inputAmount;
    const swapAmount = swapKind === SwapKind.GivenIn ? inputAmount : outputAmount;

    const effectivePrice = outputAmount.amount > 0 ? inputAmount.divDownFixed(outputAmount.scale18) : Infinity;
    const effectivePriceReversed = outputAmount.divDownFixed(inputAmount.scale18);

    return {
        protocolVersion,
        vaultVersion: protocolVersion,
        paths: sorPaths,
        swapType,
        swaps: mapSwaps(paths, swapKind),
        tokenAddresses: [...new Set(paths.flatMap((p) => p.tokens).map((t) => t.address))],
        tokenIn: replaceZeroAddressWithEth(inputAmount.token.address, chain),
        tokenOut: replaceZeroAddressWithEth(outputAmount.token.address, chain),
        tokenInAmount: formatUnits(inputAmount.amount, inputAmount.token.decimals),
        tokenOutAmount: formatUnits(outputAmount.amount, outputAmount.token.decimals),
        swapAmount: formatUnits(swapAmount.amount, swapAmount.token.decimals),
        swapAmountRaw: swapAmount.amount.toString(),
        returnAmount: formatUnits(returnAmount.amount, returnAmount.token.decimals),
        returnAmountRaw: returnAmount.amount.toString(),
        effectivePrice:
            effectivePrice === Infinity
                ? 'Infinity'
                : formatUnits((effectivePrice as TokenAmount).amount, (effectivePrice as TokenAmount).token.decimals),
        effectivePriceReversed: formatUnits(effectivePriceReversed.amount, effectivePriceReversed.token.decimals),
        routes: mapRoutes(paths),
        priceImpact: {
            priceImpact: priceImpact,
            error: priceImpactError,
        },
        callData,
    };
}

export function mapSwapKind(swapType: GqlSorSwapType): SwapKind {
    return swapType === 'EXACT_IN' ? SwapKind.GivenIn : SwapKind.GivenOut;
}

export function mapRoutes(paths: PathWithAmount[]): GqlSorSwapRoute[] {
    const isBatchSwap = paths.length > 1 || paths[0].pools.length > 1;

    if (!isBatchSwap) {
        return [mapSingleSwap(paths[0])];
    }
    const totalInput = paths.reduce((sum, path) => sum + path.inputAmount.amount, 0n);
    return paths.map((path) => {
        const share = totalInput > 0n ? Number(path.inputAmount.amount) / Number(totalInput) : 1 / paths.length;
        return mapBatchSwap(path, share);
    });
}

function mapBatchSwap(path: PathWithAmount, share: number): GqlSorSwapRoute {
    const tokenIn = path.tokens[0].address;
    const tokenOut = path.tokens[path.tokens.length - 1].address;
    const tokenInAmount = formatUnits(path.inputAmount.amount, path.tokens[0].decimals);
    const tokenOutAmount = formatUnits(path.outputAmount.amount, path.tokens[path.tokens.length - 1].decimals);

    const nonBufferStepIndices = path.pools
        .map((pool, index) => (pool.poolType !== 'Buffer' ? index : -1))
        .filter((index) => index !== -1);
    const stepIndicesToMap =
        nonBufferStepIndices.length > 0 ? nonBufferStepIndices : path.pools.map((_, index) => index);

    const hops = stepIndicesToMap.map((stepIndex) => {
        const pool = path.pools[stepIndex];
        return {
            tokenIn: `${path.tokens[stepIndex].address}`,
            tokenOut: `${path.tokens[stepIndex + 1].address}`,
            tokenInAmount: formatUnits(path.amounts[stepIndex].amount, path.tokens[stepIndex].decimals),
            tokenOutAmount: formatUnits(path.amounts[stepIndex + 1].amount, path.tokens[stepIndex + 1].decimals),
            poolId: pool.id,
            pool: aGqlPoolMinimal({
                symbol: '',
                address: pool.address,
                poolTokens: [],
            }),
        };
    });

    return {
        tokenIn,
        tokenOut,
        tokenInAmount,
        tokenOutAmount,
        share,
        hops,
    };
}

function mapSingleSwap(path: PathWithAmount): GqlSorSwapRoute {
    const tokenIn = path.tokens[0].address;
    const tokenInAmount = formatUnits(path.inputAmount.amount, path.tokens[0].decimals);
    const tokenOut = path.tokens[1].address;
    const tokenOutAmount = formatUnits(path.outputAmount.amount, path.tokens[1].decimals);

    const hop: GqlSorSwapRouteHop = {
        poolId: path.pools[0].id,
        tokenIn,
        tokenInAmount,
        tokenOut,
        tokenOutAmount,
        pool: aGqlPoolMinimal({
            symbol: '',
            address: path.pools[0].address,
            poolTokens: [],
        }),
    };

    return {
        share: 1,
        tokenIn,
        tokenOut,
        tokenInAmount,
        tokenOutAmount,
        hops: [hop],
    };
}

export function mapSwaps(paths: PathWithAmount[], swapKind: SwapKind): GqlSorSwap[] {
    const assets = [...new Set(paths.flatMap((p) => p.tokens).map((t) => t.address))];
    const swaps: GqlSorSwap[] = [];

    if (swapKind === SwapKind.GivenIn) {
        for (const p of paths) {
            p.pools.forEach((pool, i) => {
                swaps.push({
                    poolId: pool.id,
                    assetInIndex: assets.indexOf(p.tokens[i].address),
                    assetOutIndex: assets.indexOf(p.tokens[i + 1].address),
                    amount: (i === 0 ? p.inputAmount.amount : 0n).toString(),
                    userData: '0x',
                });
            });
        }
    } else {
        for (const p of paths) {
            // Vault expects given out swaps to be in reverse order
            const reversedPools = [...p.pools].reverse();
            const reversedTokens = [...p.tokens].reverse();
            reversedPools.forEach((pool, i) => {
                swaps.push({
                    poolId: pool.id,
                    assetInIndex: assets.indexOf(reversedTokens[i + 1].address),
                    assetOutIndex: assets.indexOf(reversedTokens[i].address),
                    amount: (i === 0 ? p.outputAmount.amount : 0n).toString(),
                    userData: '0x',
                });
            });
        }
    }

    return swaps;
}
