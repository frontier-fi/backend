import { Chain, Prisma, PrismaLastBlockSyncedCategory } from '@prisma/client';
import { prisma } from '../../../../../prisma/prisma-client';
import _ from 'lodash';

export const balancesToDb = (
    balances: Prisma.PrismaUserWalletBalanceCreateManyInput[],
    chain: Chain,
    endBlock: number,
    syncType?: PrismaLastBlockSyncedCategory,
) => {
    // Make sure we have all the balances from the same chain
    if (balances.some((balance) => balance.chain !== chain)) {
        throw new Error('Balances should be from the same chain');
    }

    const obsoleteIDs = balances.filter((balance) => balance.balanceNum === 0).map(({ id }) => id);
    const changedPoolIds = _.uniq(
        balances.map(({ poolId }) => poolId).filter((poolId): poolId is string => Boolean(poolId)),
    );

    return [
        // Wallet balances are related to users table, so we need to create all users records first
        ...(balances.length > 0
            ? [
                  prisma.prismaUser.createMany({
                      data: _.uniq(balances.map(({ userAddress }) => userAddress)).map((address) => ({ address })),
                      skipDuplicates: true,
                  }),
              ]
            : []),

        // Create or update the balances
        ...balances
            .filter((share) => share.balanceNum > 0)
            .map((dbEntry) => {
                const { id, chain, ...data } = dbEntry;

                return prisma.prismaUserWalletBalance.upsert({
                    where: {
                        id_chain: {
                            id,
                            chain,
                        },
                    },
                    update: data,
                    create: dbEntry,
                });
            }),

        // Max 32767 IDs per deleteMany call that DB can handle
        ..._.chunk(obsoleteIDs, 32000).map((ids) =>
            prisma.prismaUserWalletBalance.deleteMany({
                where: {
                    id: { in: ids },
                    chain,
                },
            }),
        ),

        // Recompute holdersCount atomically inside the same transaction for touched pools only
        ..._.chunk(changedPoolIds, 32000).map(
            (poolIds) => prisma.$executeRaw`
                UPDATE "PrismaPoolDynamicData" AS dyn
                SET "holdersCount" = sub.holders_count,
                    "updatedAt" = NOW()
                FROM (
                    SELECT
                        d."poolId",
                        d."chain",
                        (
                            SELECT COUNT(*)::int
                            FROM "PrismaUserWalletBalance" AS b
                            WHERE b."poolId" = d."poolId"
                              AND b."chain" = d."chain"
                              AND b."balanceNum" > 0
                        ) AS holders_count
                    FROM "PrismaPoolDynamicData" AS d
                    WHERE d."chain" = ${chain}::"Chain"
                      AND d."poolId" IN (${Prisma.join(poolIds)})
                ) AS sub
                WHERE dyn."poolId" = sub."poolId"
                  AND dyn."chain" = sub."chain"
                  AND dyn."holdersCount" <> sub.holders_count;
            `,
        ),

        // Update the synced block number when provided
        ...(syncType
            ? [
                  prisma.prismaLastBlockSynced.upsert({
                      where: {
                          category_chain: {
                              category: syncType,
                              chain,
                          },
                      },
                      create: {
                          chain,
                          category: syncType,
                          blockNumber: endBlock,
                      },
                      update: {
                          blockNumber: endBlock,
                      },
                  }),
              ]
            : []),
    ];
};
