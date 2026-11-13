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
        async updateLiquidityValuesForAllPools(chain: Chain) {
            await updateLiquidityValuesForPools(chain);
            return 'success';
        },
        async updateLifeTimeValues(chain: Chain) {
            const updates = await updateLifetimeValues(chain);
            return updates;
        },
        async addPoolsV3(chain: Chain, syncNewPoolsOnly = true) {
            const network = config[chain];
            if (!network?.subgraphs?.vault || !network.subgraphs.pools) {
                throw new Error(`Chain not configured: ${chain}`);
            }

            const {
                subgraphs: { vault, pools: poolsUrl },
                contracts: { Vault: vaultAddress },
            } = network;

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

            const lastSyncedBlock = await getLastSyncedBlock(chain, PrismaLastBlockSyncedCategory.ADD_POOLS_V3);

            let poolsToSync: V3JoinedSubgraphPool[] = [];
            if (syncNewPoolsOnly && lastSyncedBlock > 1) {
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

            // Skip the 7-call ERC4626 RPC probe only for tokens already classified as non-ERC4626 by the vault subgraph;
            // tokens with isErc4626: true (or unclassified) still run syncErc4626Tokens to verify the 7-method interface.
            const nonErc4626Addresses = new Set<string>();
            for (const pool of poolsToSync) {
                nonErc4626Addresses.add(pool.id.toLowerCase());
                for (const pt of pool.tokens) {
                    if (pt.token?.isErc4626 === false) {
                        nonErc4626Addresses.add(pt.address.toLowerCase());
                    }
                    if (pt.token?.underlyingToken?.address) {
                        nonErc4626Addresses.add(pt.token.underlyingToken.address.toLowerCase());
                    }
                }
            }
            const candidateErc4626Tokens = inserts
                .flatMap(({ tokens }) => tokens)
                .filter((t) => !nonErc4626Addresses.has(t.address.toLowerCase()));

            if (candidateErc4626Tokens.length > 0) {
                await syncErc4626Tokens(getViemClient(chain), chain, candidateErc4626Tokens);
            }

            await syncRateProviderReviews();

            await upsertLastSyncedBlock(chain, PrismaLastBlockSyncedCategory.ADD_POOLS_V3, latestBlock);

            return poolsToSync.map((pool) => pool.id);
        },
        /**
         * Syncs database pools state with the onchain state
         *
         * @param chainId
         */
        async syncPoolsV3(chain: Chain) {
            const network = config[chain];
            if (
                !network?.contracts?.Vault ||
                !network.contracts.Router ||
                !network.subgraphs?.vault ||
                !network.subgraphs.pools
            ) {
                throw new Error(`Chain not configured: ${chain}`);
            }

            const {
                subgraphs: { vault, pools },
                contracts: { Vault: vaultAddress, Router: routerAddress },
                acceptableSGLag,
            } = network;

            const viemClient = getViemClient(chain);
            const subgraphClient = getVaultSubgraphClient(vault, chain);
            const poolsSubgraphClient = getPoolsSubgraphClient(pools, chain);

            const fromBlock = await getLastSyncedBlock(chain, PrismaLastBlockSyncedCategory.POOLS_V3);
            const rpcLatestBlock = await viemClient.getBlockNumber().then(Number);
            const [vaultLastSyncedBlock, poolsLastSyncedBlock] = await Promise.all([
                subgraphClient.lastSyncedBlock(),
                poolsSubgraphClient.lastSyncedBlock(),
            ]);
            const sgLastSyncedBlock = Math.min(vaultLastSyncedBlock, poolsLastSyncedBlock);

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
            let hasBufferUpdates = false;
            if (useSubgraph) {
                const [vaultChangedIds, poolsChangedIds, bufferEvents] = await Promise.all([
                    subgraphClient.getChangedPools(fromBlock),
                    poolsSubgraphClient.getChangedPools(fromBlock),
                    subgraphClient.getBufferWrapUnwrapsFromBlock(fromBlock),
                ]);
                changedIds = Array.from(new Set([...vaultChangedIds, ...poolsChangedIds])).map((id) =>
                    id.toLowerCase(),
                );

                if (bufferEvents.length > 0) {
                    const latestByToken = new Map<
                        string,
                        { blockNumber: number; logIndex: number; wrappedBalance: string; underlyingBalance: string }
                    >();
                    for (const event of bufferEvents) {
                        const tokenAddress = event.wrappedToken.toLowerCase();
                        const blockNumber = Number(event.blockNumber);
                        const logIndex = Number(event.logIndex);
                        const existing = latestByToken.get(tokenAddress);
                        if (
                            !existing ||
                            blockNumber > existing.blockNumber ||
                            (blockNumber === existing.blockNumber && logIndex > existing.logIndex)
                        ) {
                            latestByToken.set(tokenAddress, {
                                blockNumber,
                                logIndex,
                                wrappedBalance: event.wrappedBalance,
                                underlyingBalance: event.underlyingBalance,
                            });
                        }
                    }
                    await Promise.all(
                        Array.from(latestByToken.entries()).map(([address, { wrappedBalance, underlyingBalance }]) =>
                            prisma.prismaToken.updateMany({
                                where: { address, chain },
                                data: {
                                    bufferBalanceWrapped: wrappedBalance,
                                    bufferBalanceUnderlying: underlyingBalance,
                                },
                            }),
                        ),
                    );
                    hasBufferUpdates = true;
                }
            } else if (fromBlock <= 1) {
                // No POOLS_V3 checkpoint: a fresh database or an admin reset. Resync every known pool
                // at latestBlock instead of scanning RPC logs from genesis.
                changedIds = (
                    await prisma.prismaPool.findMany({
                        where: { chain, protocolVersion: 3 },
                        select: { id: true },
                    })
                ).map(({ id }) => id.toLowerCase());
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

            // Include any V3 STABLE pool currently in the middle of an amp ramp so amp & tokenPair
            // data stay synced without requiring a subgraph polling blockHandler.
            const rampingStablePools = await prisma.prismaPool.findMany({
                where: {
                    chain,
                    protocolVersion: 3,
                    type: 'STABLE',
                    typeData: { path: ['ampIsUpdating'], equals: true },
                },
                select: { id: true },
            });
            if (rampingStablePools.length > 0) {
                changedIds = Array.from(new Set([...changedIds, ...rampingStablePools.map((p) => p.id.toLowerCase())]));
            }

            if (changedIds.length === 0) {
                if (hasBufferUpdates) {
                    await upsertLastSyncedBlock(chain, PrismaLastBlockSyncedCategory.POOLS_V3, latestBlock);
                }
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
