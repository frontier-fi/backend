import { Chain } from '@prisma/client';
import { prisma } from '../../../prisma/prisma-client';

export const updateLifetimeValues = async (chain: Chain) => {
    const [lifetime, existingDynamicData] = await Promise.all([
        getSwapLifetimeValues(chain),
        prisma.prismaPoolDynamicData.findMany({
            where: { chain },
            select: {
                poolId: true,
                lifetimeSwapFees: true,
                lifetimeVolume: true,
                swapsCount: true,
            },
        }),
    ]);

    const existingByPoolId = new Map((existingDynamicData ?? []).map((row) => [row.poolId, row]));
    const allPoolIds = Array.from(new Set([...existingByPoolId.keys(), ...Object.keys(lifetime)]));

    const updates = allPoolIds.flatMap((poolId) => {
        const lifetimeSwapFees = lifetime[poolId]?.lifetimeSwapFees || 0;
        const lifetimeVolume = lifetime[poolId]?.lifetimeVolume || 0;
        const swapsCount = lifetime[poolId]?.swapsCount || 0;

        const existing = existingByPoolId.get(poolId);
        if (
            existing &&
            existing.lifetimeSwapFees === lifetimeSwapFees &&
            existing.lifetimeVolume === lifetimeVolume &&
            existing.swapsCount === swapsCount
        ) {
            return [];
        }

        return [
            prisma.prismaPoolDynamicData.update({
                where: {
                    poolId_chain: {
                        poolId,
                        chain,
                    },
                },
                data: {
                    lifetimeSwapFees,
                    lifetimeVolume,
                    swapsCount,
                },
            }),
        ];
    });

    if (updates.length === 0) {
        return [];
    }

    return prisma.$transaction(updates);
};

const getSwapLifetimeValues = async (chain: Chain) => {
    // Get latest snapshots for each pool
    const swapLifetimeValues = await prisma.prismaPoolSnapshot.groupBy({
        by: ['poolId', 'chain'],
        _sum: {
            fees24h: true,
            volume24h: true,
            swapsCount: true,
        },
        where: {
            chain,
        },
    });

    return swapLifetimeValues.reduce(
        (acc, { poolId, _sum }) => {
            if (!acc[poolId]) {
                acc[poolId] = { lifetimeSwapFees: 0, lifetimeVolume: 0, swapsCount: 0 };
            }
            acc[poolId].lifetimeSwapFees += _sum.fees24h || 0;
            acc[poolId].lifetimeVolume += _sum.volume24h || 0;
            acc[poolId].swapsCount += _sum.swapsCount || 0;
            return acc;
        },
        {} as Record<string, { lifetimeSwapFees: number; lifetimeVolume: number; swapsCount: number }>,
    );
};
