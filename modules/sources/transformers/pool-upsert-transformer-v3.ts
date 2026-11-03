import { Chain, PrismaPoolType } from '@prisma/client';
import { PoolType } from '../subgraphs/pools/generated/types';
import { StableData } from '../../pool/subgraph-pool';
import { V3JoinedSubgraphPool } from '../subgraphs';
import { parseEther, zeroAddress } from 'viem';
import { PoolUpsertData } from '../../../prisma/prisma-types';
import { hookTransformer } from './hook-transformer';
import { normalizeAddress } from '../../web3/addresses';
import _ from 'lodash';

const resolvePriceRateProvider = (
    rateProviders: V3JoinedSubgraphPool['rateProviders'],
    token: V3JoinedSubgraphPool['tokens'][number],
    index: number,
): string => {
    if (token.rateProvider) {
        return normalizeAddress(token.rateProvider);
    }
    if (!rateProviders || rateProviders.length === 0) {
        return zeroAddress;
    }
    const normalizedToken = normalizeAddress(token.address);
    const byToken = rateProviders.find(
        (rp) => rp?.token?.address && normalizeAddress(rp.token.address) === normalizedToken,
    );
    if (byToken) {
        return normalizeAddress(byToken.address);
    }
    const positional = rateProviders[index];
    if (positional && !positional.token?.address && positional.address) {
        return normalizeAddress(positional.address);
    }
    return zeroAddress;
};

// Subgraph to DB format transformation
export const poolUpsertTransformerV3 = (
    poolData: V3JoinedSubgraphPool,
    chain: Chain,
    blockNumber: number,
): PoolUpsertData | null => {
    let type: PrismaPoolType;
    let typeData: StableData | Record<string, unknown> = {};

    // expand the nested and ERC-4626 underlying tokens
    const allTokens = _.uniqBy(
        _.flattenDeep(
            poolData.tokens.map((token) => [
                token,
                ...(token.nestedPool?.tokens || []).map((nestedToken) => ({
                    ...nestedToken,
                    nestedPoolId: token.nestedPool?.id || null,
                })),
                ...(token.token?.isErc4626 && token.token.underlyingToken
                    ? [
                          {
                              address: token.token.underlyingToken.address,
                              nestedPoolId: null,
                          },
                      ]
                    : []),
            ]),
        ),
        (token) => normalizeAddress(token.address),
    );

    const poolTokensWithUnderlying = _.uniqBy(
        [
            ...poolData.tokens.flatMap((token) => {
                const underlying =
                    token.token?.isErc4626 && token.token.underlyingToken ? token.token.underlyingToken : null;
                const wrappedEntry = {
                    address: normalizeAddress(token.address),
                    decimals: token.decimals,
                    symbol: token.symbol,
                    name: token.name,
                    chain,
                    ...(underlying ? { underlyingTokenAddress: normalizeAddress(underlying.address) } : {}),
                    ...(token.buffer
                        ? {
                              bufferBalanceWrapped: token.buffer.wrappedBalance,
                              bufferBalanceUnderlying: token.buffer.underlyingBalance,
                          }
                        : {}),
                };
                if (!underlying) {
                    return [wrappedEntry];
                }
                return [
                    wrappedEntry,
                    {
                        address: normalizeAddress(underlying.address),
                        decimals: underlying.decimals,
                        symbol: underlying.symbol,
                        name: underlying.name,
                        chain,
                    },
                ];
            }),
            {
                address: normalizeAddress(poolData.id),
                decimals: 18,
                symbol: poolData.symbol,
                name: poolData.name,
                chain,
            },
        ],
        (t) => t.address,
    );

    switch (poolData.factory.type) {
        case PoolType.Weighted:
            type = PrismaPoolType.WEIGHTED;
            break;
        case PoolType.Stable:
            type = PrismaPoolType.STABLE;
            typeData = {
                ..._.omit(poolData.stableParams, '__typename'),
                amp: poolData.stableParams!.amp,
            } as StableData;
            break;
        case PoolType.Eclp:
            type = PrismaPoolType.ECLP;
            typeData = {
                ...poolData.eclpParams,
            };
            break;
        default:
            return null;
    }

    return {
        pool: {
            id: normalizeAddress(poolData.id),
            chain: chain,
            protocolVersion: 3,
            address: normalizeAddress(poolData.id),
            decimals: 18,
            symbol: poolData.symbol,
            name: poolData.name,
            swapFeeManager: normalizeAddress(poolData.swapFeeManager),
            pauseManager: poolData.pauseManager ? normalizeAddress(poolData.pauseManager) : null,
            poolCreator: poolData.poolCreator ? normalizeAddress(poolData.poolCreator) : null,
            factory: normalizeAddress(poolData.factory.id),
            type: type,
            typeData: typeData,
            version: poolData.factory.version,
            createTime: Number(poolData.blockTimestamp),
            liquidityManagement: poolData.liquidityManagement,
            hook: hookTransformer(poolData, chain),
        },
        tokens: poolTokensWithUnderlying,
        poolDynamicData: {
            id: normalizeAddress(poolData.id),
            swapFee: String(poolData.swapFee),
            ...(poolData.aggregateSwapFee !== undefined ? { aggregateSwapFee: String(poolData.aggregateSwapFee) } : {}),
            ...(poolData.aggregateYieldFee !== undefined
                ? { aggregateYieldFee: String(poolData.aggregateYieldFee) }
                : {}),
            totalShares: String(parseEther(poolData.totalShares)),
            totalSharesNum: Number(poolData.totalShares),
            isPaused: poolData.isPaused,
            isInRecoveryMode: poolData.isInRecoveryMode,
            blockNumber,
        },
        poolToken: poolData.tokens.map((token, i) => ({
            id: `${normalizeAddress(poolData.id)}-${normalizeAddress(token.address)}`,
            poolId: normalizeAddress(poolData.id),
            chain: chain,
            address: normalizeAddress(token.address),
            index: token.index,
            nestedPoolId: token.nestedPool ? normalizeAddress(token.nestedPool.id) : null,
            priceRateProvider: resolvePriceRateProvider(poolData.rateProviders, token, i),
            exemptFromProtocolYieldFee: !token.paysYieldFees,
            scalingFactor: token.scalingFactor,
            balance: token.balance,
            weight: poolData.weightedParams ? (poolData.weightedParams.weights[token.index] ?? null) : null,
        })),
        poolExpandedTokens: allTokens.map((token) => ({
            poolId: normalizeAddress(poolData.id),
            chain,
            tokenAddress: normalizeAddress(token.address),
            nestedPoolId:
                'nestedPoolId' in token && token.nestedPoolId
                    ? normalizeAddress(token.nestedPoolId)
                    : token.nestedPool
                      ? normalizeAddress(token.nestedPool.id)
                      : null,
        })),
    };
};
