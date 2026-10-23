import { prisma } from '../../../../prisma/prisma-client';
import { Chain, PrismaPoolAprItem, PrismaPoolAprType } from '@prisma/client';
import { daysAgo } from '../../../common/time';
import { AprHandler, PoolAPRData } from '../../types';

type PoolSwapFeeData = {
    poolId: string;
    chain: Chain;
    dynamic_fees_24h: number;
    fees_24h: number;
    surplus_24h: number;
};

const query = (chain: Chain, timestamp: number) => `
    SELECT
        "poolId",
        chain,
        SUM((payload->'dynamicFee'->>'valueUSD')::numeric) AS dynamic_fees_24h,
        SUM((payload->'fee'->>'valueUSD')::numeric) AS fees_24h,
        SUM((payload->'surplus'->>'valueUSD')::numeric) AS surplus_24h
    FROM
        "PartitionedPoolEvent"
    WHERE
        "blockTimestamp" >= ${timestamp}
    AND chain = '${chain}'
    AND type = 'SWAP'
    GROUP BY
        1, 2
`;

const MAX_DB_INT = 0x1fff_ffff_fff_fff;

export class SwapFeeAprHandler implements AprHandler {
    public getAprServiceName(): string {
        return 'SwapFeeAprHandler';
    }

    public async calculateAprForPools(
        pools: PoolAPRData[],
    ): Promise<Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[]> {
        const chain = pools[0].chain;
        const yesterday = daysAgo(1);

        // Fetch the swap fees for the last 24 hours
        const swapFeeData = await prisma.$queryRawUnsafe<PoolSwapFeeData[]>(query(chain, yesterday));

        // Map the swap fee data to the pool id
        const swapFeeDataMap = swapFeeData.reduce((acc, data) => {
            acc[data.poolId] = data;
            return acc;
        }, {} as Record<string, PoolSwapFeeData>);

        const aprItems: Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[] = ([] = pools
            .flatMap((pool) => {
                if (!pool.dynamicData || !swapFeeDataMap[pool.id]) return null;

                let protocolFee = pool.dynamicData.protocolSwapFee;

                if (pool.type === 'ECLP') {
                    protocolFee = pool.dynamicData.protocolYieldFee || '0';
                }

                if (pool.version === 3) {
                    protocolFee = pool.dynamicData.aggregateSwapFee;
                }

                if (pool.dynamicData.isInRecoveryMode) {
                    protocolFee = '0';
                }

                const dynamicApr = swapFeeCalculation(
                    pool.dynamicData.totalLiquidity,
                    swapFeeDataMap[pool.id].dynamic_fees_24h,
                    parseFloat(protocolFee),
                );

                const swapApr = swapFeeCalculation(
                    pool.dynamicData.totalLiquidity,
                    swapFeeDataMap[pool.id].fees_24h,
                    parseFloat(protocolFee),
                );

                return [
                    {
                        id: `${pool.id}-dynamic-swap-apr-24h`,
                        chain,
                        poolId: pool.id,
                        title: 'Dynamic swap fees APR',
                        apr: dynamicApr,
                        type: PrismaPoolAprType.DYNAMIC_SWAP_FEE_24H,
                        rewardTokenAddress: null,
                        rewardTokenSymbol: null,
                    },
                    {
                        id: `${pool.id}-swap-apr-24h`,
                        chain: chain,
                        poolId: pool.id,
                        title: 'Swap fees APR (24h)',
                        apr: swapApr,
                        type: PrismaPoolAprType.SWAP_FEE_24H,
                        rewardTokenAddress: null,
                        rewardTokenSymbol: null,
                    },
                ];
            })
            .filter((entry): entry is NonNullable<typeof entry> => !!entry));

        return aprItems;
    }
}

const swapFeeCalculation = (totalLiquidity: number, swapFees: number, protocolFee: number) => {
    let apr_24h = 0;

    if (totalLiquidity > 0 && swapFees) {
        apr_24h = ((swapFees * 365) / totalLiquidity) * (1 - protocolFee);
    }

    if (apr_24h > MAX_DB_INT) {
        apr_24h = 0;
    }

    return apr_24h;
};
