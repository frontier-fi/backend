import { Chain, Prisma } from '@prisma/client';
import { prisma } from '../../../prisma/prisma-client';
import { logger } from '../../common/logger';

export const syncIncentivizedCategory = async (chain: Chain) => {
    const poolsWithReward = await prisma.prismaPoolAprItem.findMany({
        select: { poolId: true },
        where: {
            chain,
            type: {
                in: ['NATIVE_REWARD', 'MERKL'],
            },
            apr: {
                gt: 0,
            },
        },
    });

    const incentivizedPoolIds = await prisma.prismaPool.findMany({
        select: { id: true },
        where: {
            chain,
            categories: {
                has: 'INCENTIVIZED',
            },
        },
    });

    const incentivizedIds = incentivizedPoolIds.map(({ id }) => id);
    const rewardPoolIds = Array.from(new Set(poolsWithReward.map(({ poolId }) => poolId)));

    const idsToAdd = rewardPoolIds.filter((id) => !incentivizedIds.includes(id));
    const idsToRemove = incentivizedIds.filter((id) => !rewardPoolIds.includes(id));

    const queries = [];

    if (idsToRemove.length > 0) {
        logger.info('Removed incentivized category from pools', {
            chain,
            count: idsToRemove.length,
            poolIds: idsToRemove.slice(0, 10),
        });
        queries.push(
            prisma.$executeRaw`UPDATE "PrismaPool"
            SET categories = array_remove(categories, 'INCENTIVIZED')
            WHERE chain = ${chain}::"Chain" AND id IN (${Prisma.join(idsToRemove)});`,
        );
    }

    if (idsToAdd.length > 0) {
        logger.info('Added incentivized category to pools', {
            chain,
            count: idsToAdd.length,
            poolIds: idsToAdd.slice(0, 10),
        });
        queries.push(
            prisma.$executeRaw`UPDATE "PrismaPool"
            SET categories = array_append(categories, 'INCENTIVIZED')
            WHERE chain = ${chain}::"Chain" AND id IN (${Prisma.join(idsToAdd)});`,
        );
    }

    if (queries.length > 0) {
        await prisma.$transaction(queries);
    }
};
