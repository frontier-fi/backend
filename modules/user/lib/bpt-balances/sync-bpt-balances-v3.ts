import { Chain } from '@prisma/client';
import { getVaultSubgraphClient } from '../../../sources/subgraphs';
import { getViemClient } from '../../../sources/viem-client';
import { prisma } from '../../../../prisma/prisma-client';
import { syncBptBalancesFromSubgraph } from './helpers/sync-bpt-balances-from-subgraph';
import { syncBptBalancesFromRpc } from './helpers/sync-bpt-balances-from-rpc';
import { logger } from '../../../common/logger';

const balanceSyncSources = new Map<Chain, 'subgraph' | 'rpc'>();

/**
 * BPT balance sync prefers the subgraph and falls back to RPC while it lags > 60 blocks.
 * Logs only on transitions per chain so persistent lag does not spam every 20s run.
 */
export function logBalanceSyncSourceChange(chain: Chain, source: 'subgraph' | 'rpc', err?: unknown): void {
    if (balanceSyncSources.get(chain) === source) {
        return;
    }
    balanceSyncSources.set(chain, source);
    if (source === 'rpc') {
        logger.warn('BPT balance sync switched to RPC fallback', {
            event: 'bpt-balance-sync-source',
            chain,
            source,
            syncCategory: 'BPT_BALANCES_V3',
            err,
        });
    } else {
        logger.info('BPT balance sync using subgraph', {
            event: 'bpt-balance-sync-source',
            chain,
            source,
            syncCategory: 'BPT_BALANCES_V3',
        });
    }
}

export const syncBptBalancesV3 = async (chain: Chain, subgraphUrl?: string) => {
    if (!subgraphUrl) {
        return;
    }

    const subgraphClient = getVaultSubgraphClient(subgraphUrl, chain);
    const viemClient = getViemClient(chain);

    const poolIds = await prisma.prismaPool
        .findMany({
            where: {
                chain,
                protocolVersion: 3,
            },
            select: {
                id: true,
            },
        })
        .then((pools) => pools.map((pool) => pool.id));

    if (poolIds.length === 0) {
        return 0;
    }

    let syncedRange = 0;
    try {
        syncedRange = await syncBptBalancesFromSubgraph(poolIds, subgraphClient, chain, 'BPT_BALANCES_V3');
        logBalanceSyncSourceChange(chain, 'subgraph');
    } catch (e: any) {
        logBalanceSyncSourceChange(chain, 'rpc', e);
        syncedRange = await syncBptBalancesFromRpc(poolIds, viemClient, chain, 'BPT_BALANCES_V3');
    }

    return syncedRange;
};
