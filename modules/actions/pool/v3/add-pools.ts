import { Chain } from '@prisma/client';
import { V3JoinedSubgraphPool, ViemClient } from '../../../sources/types';
import { poolUpsertTransformerV3 } from '../../../sources/transformers/pool-upsert-transformer-v3';
import { prisma } from '../../../../prisma/prisma-client';
import { enrichPoolUpsertsUsd } from '../../../sources/enrichers';
import _ from 'lodash';
import { fetchPoolSyncData } from '../../../sources/contracts/v3/fetch-pool-sync-data';
import { fetchErc20Headers } from '../../../sources/contracts/fetch-erc20-headers';
import { mergeArraysById } from '../../../helper/merge-arrays-by-id';

export const addPools = async (
    subgraphPools: V3JoinedSubgraphPool[],
    viemClient: ViemClient,
    vault: string,
    chain: Chain,
    blockNumber: number,
) => {
    const data = subgraphPools
        .map((fragment) => poolUpsertTransformerV3(fragment, chain, blockNumber))
        .filter((item): item is NonNullable<typeof item> => item !== null);

    if (data.length === 0) {
        return [];
    }

    // Add onchain data to subgraph data
    const onchainData = await fetchPoolSyncData(
        viemClient,
        vault,
        data.map(({ pool: { id, type, version, hook } }) => ({ id, type, version: version ?? 1, hook })),
        BigInt(blockNumber),
    );

    const inserts = data.map((item) => _.mergeWith(item, onchainData[item.pool.id], mergeArraysById));

    // Backfill ERC20 headers from on-chain when subgraph name or symbol are empty
    const missingHeaderAddresses = _.uniq(
        inserts
            .flatMap((item) => item.tokens || [])
            .filter((token) => !token.name || !token.symbol)
            .map((token) => token.address as `0x${string}`),
    );
    if (missingHeaderAddresses.length > 0) {
        const headers = await fetchErc20Headers(missingHeaderAddresses, viemClient);
        for (const item of inserts) {
            for (const token of item.tokens || []) {
                const header = headers[token.address as `0x${string}`];
                if (header) {
                    if (!token.name && header.name && header.name !== 'undefined') {
                        token.name = header.name;
                    }
                    if (!token.symbol && header.symbol && header.symbol !== 'undefined') {
                        token.symbol = header.symbol;
                    }
                }
            }
        }
    }

    // USD Pricing
    const prices = await prisma.prismaTokenCurrentPrice
        .findMany({
            where: {
                chain: chain,
                tokenAddress: { in: inserts.flatMap((item) => item.tokens).map((token) => token.address) },
            },
        })
        .then((priceData) => Object.fromEntries(priceData.map((price) => [price.tokenAddress, price.price])));

    const withUsd = inserts.map((item) => enrichPoolUpsertsUsd<typeof item>(item, prices));

    // Upsert pools to the database
    for (const { pool, tokens, poolToken, poolDynamicData, poolExpandedTokens } of withUsd) {
        try {
            await prisma.$transaction([
                prisma.prismaPool.upsert({
                    where: { id_chain: { id: pool.id, chain: pool.chain } },
                    create: pool,
                    update: pool,
                }),
                ...((poolDynamicData && [
                    prisma.prismaPoolDynamicData.upsert({
                        where: { poolId_chain: { poolId: pool.id, chain: pool.chain } },
                        create: {
                            ...poolDynamicData,
                            id: pool.id,
                            pool: {
                                connect: {
                                    id_chain: {
                                        id: pool.id,
                                        chain: pool.chain,
                                    },
                                },
                            },
                        },
                        update: poolDynamicData,
                    }),
                ]) ||
                    []),
                ...((tokens &&
                    tokens.map((token) =>
                        prisma.prismaToken.upsert({
                            where: { address_chain: { address: token.address, chain } },
                            create: {
                                ...token,
                                chain,
                            },
                            update: token.address === pool.id ? token : {},
                        }),
                    )) ||
                    []),
                ...((poolToken &&
                    poolToken.map((token) =>
                        prisma.prismaPoolToken.upsert({
                            where: { id_chain: { id: token.id, chain } },
                            create: {
                                ...token,
                                poolId: pool.id,
                                chain,
                            },
                            update: token,
                        }),
                    )) ||
                    []),
                ...((poolExpandedTokens &&
                    poolExpandedTokens.map((token) =>
                        prisma.prismaPoolExpandedTokens.upsert({
                            where: {
                                tokenAddress_poolId_chain: {
                                    tokenAddress: token.tokenAddress,
                                    poolId: pool.id,
                                    chain,
                                },
                            },
                            create: token,
                            update: token,
                        }),
                    )) ||
                    []),
            ]);
        } catch (e) {
            console.error('Error upserting pool', e);
        }
    }

    return withUsd;
};
