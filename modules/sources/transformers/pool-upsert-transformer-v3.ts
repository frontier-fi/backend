import { Chain, PrismaPoolType } from '@prisma/client';
import { PoolType } from '../subgraphs/pools/generated/types';
import { StableData } from '../../pool/subgraph-pool';
import { V3JoinedSubgraphPool } from '../subgraphs';
import { parseEther } from 'viem';
import { PoolUpsertData } from '../../../prisma/prisma-types';
import { hookTransformer } from './hook-transformer';
import { normalizeAddress } from '../../web3/addresses';
import _ from 'lodash';

// Subgraph to DB format transformation
export const poolUpsertTransformerV3 = (
    poolData: V3JoinedSubgraphPool,
    chain: Chain,
    blockNumber: number,
): PoolUpsertData | null => {
    let type: PrismaPoolType;
    let typeData: StableData | Record<string, unknown> = {};

    // expand the nested tokens
    const allTokens = _.flattenDeep(
        poolData.tokens.map((token) => [
            token,
            ...(token.nestedPool?.tokens || []).map((nestedToken) => ({
                ...nestedToken,
                nestedPoolId: token.nestedPool?.id || null,
            })),
        ]),
    );

    switch (poolData.factory.type) {
        case PoolType.Weighted:
            type = PrismaPoolType.WEIGHTED;
            break;
        case PoolType.Stable:
            type = PrismaPoolType.STABLE;
            typeData = {
                amp: poolData.stableParams!.amp,
            } as StableData;
            break;
        case PoolType.GyroE:
            type = PrismaPoolType.GYROE;
            typeData = {
                ...poolData.gyroEParams,
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
        tokens: [
            ...poolData.tokens.map((token) => ({
                address: normalizeAddress(token.address),
                decimals: token.decimals,
                symbol: token.symbol,
                name: token.name,
                chain,
            })),
            {
                address: normalizeAddress(poolData.id),
                decimals: 18,
                symbol: poolData.symbol,
                name: poolData.name,
                chain,
            },
        ],
        poolDynamicData: {
            id: normalizeAddress(poolData.id),
            swapFee: String(poolData.swapFee),
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
            priceRateProvider: normalizeAddress(poolData.rateProviders![i].address),
            exemptFromProtocolYieldFee: !token.paysYieldFees,
            scalingFactor: token.scalingFactor,
            balance: token.balance,
            weight: poolData.weightedParams ? poolData.weightedParams.weights[token.index] ?? null : null,
        })),
        poolExpandedTokens: allTokens.map((token) => ({
            poolId: normalizeAddress(poolData.id),
            chain,
            tokenAddress: normalizeAddress(token.address),
            nestedPoolId: token.nestedPool ? normalizeAddress(token.nestedPool.id) : null,
        })),
    };
};
