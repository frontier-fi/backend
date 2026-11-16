import { Chain, Prisma, PrismaPoolType } from '@prisma/client';
import { HookData } from '../../../../prisma/prisma-types';
import { prisma } from '../../../../prisma/prisma-client';
import { enrichPoolUpsertsUsd } from '../../../sources/enrichers/pool-upserts-usd';
import _ from 'lodash';
import { fetchPoolSyncData } from '../../../sources/contracts/v3/fetch-pool-sync-data';
import { ViemClient } from '../../../sources/viem-client';
import { mergeArraysById } from '../../../helper/merge-arrays-by-id';
import { logger } from '../../../common/logger';

/**
 * Gets and syncs all the pools state with the database
 *
 * TODO: simplify the schema by merging the pool and poolDynamicData tables and the poolToken, expandedToken tables
 *
 * @param subgraphPools
 * @param vaultClient
 * @param chain
 * @param blockNumber
 * @returns the ids of the pools that were updated. Pools without on-chain token data or whose
 *     write failed are left out, so the caller can retry them.
 */
export const syncPools = async (
    dbPools: { id: string; type: PrismaPoolType; version: number; hook?: HookData; typeData: any }[],
    chain: Chain,
    vault: string,
    viemClient: ViemClient,
    blockNumber: number,
    alreadyPendingIds: ReadonlySet<string> = new Set(),
): Promise<string[]> => {
    const updatedIds: string[] = [];

    const onchainData = await fetchPoolSyncData(viemClient, vault, dbPools, BigInt(blockNumber));

    const skipped = dbPools.filter((pool) => !Array.isArray(onchainData[pool.id]?.poolToken));
    const newlySkipped = skipped.filter((pool) => !alreadyPendingIds.has(pool.id.toLowerCase()));
    if (newlySkipped.length > 0) {
        logger.warn('Skipped pools missing on-chain token data', {
            chain,
            skippedCount: newlySkipped.length,
            poolIds: newlySkipped.slice(0, 5).map((pool) => pool.id),
        });
    }

    const upserts = dbPools
        .filter((pool) => Array.isArray(onchainData[pool.id]?.poolToken))
        .map((pool) => _.mergeWith({ pool }, onchainData[pool.id], mergeArraysById));

    // USD Pricing
    const prices = await prisma.prismaTokenCurrentPrice
        .findMany({
            where: {
                chain: chain,
                tokenAddress: {
                    in: Object.values(onchainData)
                        .flatMap((item) => item?.poolToken ?? [])
                        .map((token) => token.address),
                },
            },
        })
        .then((priceData) => Object.fromEntries(priceData.map((price) => [price.tokenAddress, price.price])));

    // Organize the data into upserts
    const withUsd = upserts.map((item) => enrichPoolUpsertsUsd<typeof item>(item, prices));

    // Upsert pools to the database in batches
    for (const { pool, poolToken, poolDynamicData } of withUsd) {
        try {
            await prisma.$transaction([
                ...((pool && [
                    prisma.prismaPool.update({
                        where: { id_chain: { id: pool.id, chain } },
                        data: pool as Prisma.PrismaPoolUpdateInput,
                    }),
                ]) ||
                    []),
                ...((poolDynamicData && [
                    prisma.prismaPoolDynamicData.update({
                        where: { poolId_chain: { poolId: pool.id, chain } },
                        data: {
                            ...poolDynamicData,
                            protocolSwapFee: poolDynamicData.aggregateSwapFee,
                            protocolYieldFee: poolDynamicData.aggregateYieldFee,
                        },
                    }),
                ]) ||
                    []),
                ...((poolToken &&
                    poolToken.map((token) =>
                        prisma.prismaPoolToken.update({
                            where: { id_chain: { id: token.id, chain } },
                            data: token,
                        }),
                    )) ||
                    []),
            ]);
            updatedIds.push(pool.id);
        } catch (e) {
            if (!alreadyPendingIds.has(pool.id.toLowerCase())) {
                logger.error('Pool sync upsert failed', { chain, poolId: pool.id, err: e });
            }
        }
    }

    return updatedIds;
};
