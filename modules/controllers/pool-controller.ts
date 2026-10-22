import config from '../../config';
import { addPools as addPoolsV3 } from '../actions/pool/v3/add-pools';
import { getViemClient } from '../sources/viem-client';
import {
    getPoolsSubgraphClient,
    getV3JoinedSubgraphClient,
    getVaultSubgraphClient,
    V3JoinedSubgraphPool,
} from '../sources/subgraphs';
import { prisma } from '../../prisma/prisma-client';
import { updateLiquidity24hAgo, updateLiquidityValuesForPools } from '../actions/pool/update-liquidity';
import { Chain, PrismaLastBlockSyncedCategory } from '@prisma/client';
import { syncPools as syncPoolsV3 } from '../actions/pool/v3/sync-pools';
import { syncTokenPairs } from '../actions/pool/v3/sync-tokenpairs';
import { syncHookData } from '../actions/pool/v3/sync-hook-data';
import { getLastSyncedBlock, upsertLastSyncedBlock } from '../actions/last-synced-block';
import { getChangedPoolsV3 } from '../sources/logs';
import { syncBptBalancesFromSubgraph } from '../user/lib/bpt-balances/helpers/sync-bpt-balances-from-subgraph';
import { syncHookReviews } from '../content/lib/sync-hook-reviews';
import { syncErc4626Tokens } from '../actions/token/sync-erc4626-tokens';
import { syncRateProviderReviews } from '../content/lib/sync-rate-provider-reviews';
import { PoolWithMappedJsonFields } from '../../prisma/prisma-types';
import { updateLifetimeValues } from '../actions/pool/update-liftetime-values';

export function PoolController(tracer?: any) {
    return {
        async updateLiquidityValuesForInactivePools(chain: Chain) {
            const poolTokens = await prisma.prismaPoolToken.findMany({
                where: {
                    chain,
                    updatedAt: {
                        // Do the update only when the pool wasn't synced in the last 10 minutes
                        lt: new Date(Date.now() - 60 * 10 * 1000),
                    },
                },
            });

            const ids = [...new Set(poolTokens.map((pt) => pt.poolId))];

            await updateLiquidityValuesForPools(chain, ids);

            return ids;
        },
        async updateLifeTimeValues(chain: Chain) {
            const updates = await updateLifetimeValues(chain);
            return updates;
        },
        async addPoolsV3(chain: Chain, syncNewPoolsOnly = true) {
            const {
                subgraphs: { vault, pools: poolsUrl },
                contracts: { Vault: vaultAddress },
                hooks,
            } = config[chain];

            // Guard against unconfigured chains
            if (!vault || !poolsUrl) {
                throw new Error(`Chain not configured: ${chain}`);
            }

            const viemClient = getViemClient(chain);

            const vaultSubgraphClient = getVaultSubgraphClient(vault, chain);
            const poolsSubgraphClient = getPoolsSubgraphClient(poolsUrl, chain);
            const subgraphClient = getV3JoinedSubgraphClient(vaultSubgraphClient, poolsSubgraphClient);

            const latestBlock = Number(await viemClient.getBlockNumber());
            const pools = await subgraphClient.getAllInitializedPools();

            if (pools.length === 0) {
                return [];
            }

            const dbIds = (
                await prisma.prismaPool.findMany({
                    where: { chain, protocolVersion: 3 },
                    select: { id: true },
                })
            ).map(({ id }) => id);

            let poolsToSync: V3JoinedSubgraphPool[] = [];
            if (syncNewPoolsOnly) {
                poolsToSync = pools.filter((pool) => !dbIds.includes(pool.id));
            } else {
                poolsToSync = pools;
            }

            if (poolsToSync.length === 0) {
                return [];
            }

            const inserts = await addPoolsV3(poolsToSync, viemClient, vaultAddress, chain, latestBlock);
            await syncBptBalancesFromSubgraph(
                poolsToSync.map((pool) => pool.id),
                vaultSubgraphClient,
                chain,
            );

            // Sync token flags for the new tokens
            await syncErc4626Tokens(
                getViemClient(chain),
                chain,
                inserts.flatMap(({ tokens }) => tokens),
            );

            await syncRateProviderReviews();

            if (hooks) {
                await syncHookReviews();
            }

            await upsertLastSyncedBlock(chain, PrismaLastBlockSyncedCategory.ADD_POOLS_V3, latestBlock);

            return poolsToSync.map((pool) => pool.id);
        },
        /**
         * Syncs database pools state with the onchain state
         *
         * @param chainId
         */
        async syncPoolsV3(chain: Chain) {
            const {
                subgraphs: { vault, pools },
                contracts: { Vault: vaultAddress, Router: routerAddress },
                acceptableSGLag,
            } = config[chain];

            // Guard against unconfigured chains
            if (!vaultAddress || !routerAddress || !vault || !pools) {
                throw new Error(`Chain not configured: ${chain}`);
            }

            const viemClient = getViemClient(chain);
            const subgraphClient = getVaultSubgraphClient(vault, chain);
            const poolsSubgraphClient = getPoolsSubgraphClient(pools, chain);

            const fromBlock = await getLastSyncedBlock(chain, PrismaLastBlockSyncedCategory.POOLS_V3);
            const rpcLatestBlock = await viemClient.getBlockNumber().then(Number);
            const sgLastSyncedBlock = await subgraphClient.lastSyncedBlock();

            // Guard against subgraph lag
            let useSubgraph = true;
            if (rpcLatestBlock - sgLastSyncedBlock > acceptableSGLag) {
                useSubgraph = false;
            }

            const latestBlock = useSubgraph ? sgLastSyncedBlock : rpcLatestBlock;

            if (fromBlock === undefined || fromBlock > latestBlock) {
                return [];
            }

            // Sepolia vault deployment block (2026-10-18), uncomment to test from the beginning
            // const fromBlock = 11940608n;

            let changedIds: string[] = [];
            if (useSubgraph) {
                changedIds = await subgraphClient.getChangedPools(fromBlock);
                const poolsChangedIds = await poolsSubgraphClient.getChangedPools(fromBlock);
                changedIds = Array.from(new Set([...changedIds, ...poolsChangedIds])).map((id) => id.toLowerCase());
            } else {
                const rpcMaxBlockRange = config[chain].rpcMaxBlockRange;
                const range = Number(latestBlock) - fromBlock;
                const numBatches = Math.ceil(range / rpcMaxBlockRange);

                const allChangedPools = new Set<string>();

                for (let i = 0; i < numBatches; i++) {
                    const from = fromBlock + (i > 0 ? 1 : 0) + i * rpcMaxBlockRange;
                    const to = Math.min(fromBlock + (i + 1) * rpcMaxBlockRange, Number(latestBlock));

                    const changedPools = await getChangedPoolsV3(vaultAddress, viemClient, BigInt(from), BigInt(to));
                    changedPools.forEach((pool) => allChangedPools.add(pool));
                }

                changedIds = Array.from(allChangedPools).map((pool) => pool.toLowerCase());
            }

            if (changedIds.length === 0) {
                return [];
            }

            const dbPools = (await prisma.prismaPool.findMany({
                where: { chain, protocolVersion: 3, id: { in: changedIds } },
                select: { id: true, type: true, version: true, hook: true, typeData: true },
            })) as PoolWithMappedJsonFields[];

            const ids = await syncPoolsV3(dbPools, chain, vaultAddress, viemClient, latestBlock);
            await syncTokenPairs(ids, viemClient, routerAddress, chain);
            await upsertLastSyncedBlock(chain, PrismaLastBlockSyncedCategory.POOLS_V3, latestBlock);

            return ids;
        },
        async updateLiquidity24hAgoV3(chain: Chain) {
            const client = getViemClient(chain);

            const poolIds = await prisma.prismaPool
                .findMany({
                    where: { chain, protocolVersion: 3 },
                    select: { id: true },
                })
                .then((results) => results.map((r) => r.id));

            const updates = await updateLiquidity24hAgo(poolIds, chain, client);

            return updates;
        },
        async syncHookData(chain: Chain) {
            const { hooks } = config[chain];

            // Guard against unconfigured chains
            if (!hooks) {
                // Chain doesn't have hooks
                return;
            }

            // Get hook addresses from the database
            const poolsWithHooks = await prisma.prismaPool.findMany({
                where: { chain, hook: { path: ['address'], string_starts_with: '0x' } },
            });

            const viemClient = getViemClient(chain);

            const ids = await syncHookData(poolsWithHooks, viemClient);

            return ids;
        },
    };
}
