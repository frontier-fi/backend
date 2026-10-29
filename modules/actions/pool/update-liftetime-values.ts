import { Chain, PrismaPoolType } from '@prisma/client';
import { prisma } from '../../../prisma/prisma-client';

export const updateLifetimeValues = async (chain: Chain) => {
    const holders = await getHoldersCount(chain);
    const lifetime = await getSwapLifetimeValues(chain);

    // Merge all keys into an unique list
    const allKeys = [...Object.keys(holders), ...Object.keys(lifetime)].reduce((acc, key) => {
        if (!acc.includes(key)) acc.push(key);
        return acc;
    }, [] as string[]);

    const data = allKeys.map((key) => {
        const [poolId, chain] = key.split('-');
        const holdersCount = holders[key] || 0;
        const lifetimeSwapFees = lifetime[key]?.lifetimeSwapFees || 0;
        const lifetimeVolume = lifetime[key]?.lifetimeVolume || 0;
        const swapsCount = lifetime[key]?.swapsCount || 0;

        return {
            where: {
                poolId_chain: {
                    poolId,
                    chain: chain as Chain,
                },
            },
            data: {
                holdersCount,
                lifetimeSwapFees,
                lifetimeVolume,
                swapsCount,
            },
        };
    });

    const updates = data.map((record) => {
        const { where, data } = record;

        return prisma.prismaPoolDynamicData.update({
            where,
            data,
        });
    });

    return prisma.$transaction(updates);
};

const getHoldersCount = async (chain: Chain) => {
    const holders = await prisma.prismaUserWalletBalance.groupBy({
        by: ['poolId', 'chain'],
        _count: { userAddress: true },
        where: {
            chain,
            balanceNum: { gt: 0 },
        },
    });

    const pools = holders.reduce(
        (acc, item) => {
            const { poolId, chain } = item;
            if (!poolId) return acc;
            acc[`${poolId}-${chain}`] ||= 0;
            acc[`${poolId}-${chain}`] += item._count.userAddress;
            return acc;
        },
        {} as Record<string, number>,
    );

    return pools;
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

    const lifetimeValues = swapLifetimeValues.reduce(
        (acc, { poolId, chain, _sum }) => {
            const key = `${poolId}-${chain}`;
            if (!acc[key]) {
                acc[key] = { lifetimeSwapFees: 0, lifetimeVolume: 0, swapsCount: 0 };
            }
            acc[key].lifetimeSwapFees += _sum.fees24h || 0;
            acc[key].lifetimeVolume += _sum.volume24h || 0;
            acc[key].swapsCount += _sum.swapsCount || 0;
            return acc;
        },
        {} as Record<string, { lifetimeSwapFees: number; lifetimeVolume: number; swapsCount: number }>,
    );

    return lifetimeValues;
};
