import { Chain } from '@prisma/client';
import config from '../../config';
import { syncBptBalancesV3 } from './lib/bpt-balances/sync-bpt-balances-v3';

export function UserBalancesController() {
    return {
        async syncBalances(chain: Chain) {
            const {
                subgraphs: { vault },
            } = config[chain];

            if (vault && config[chain].contracts.Vault) {
                await syncBptBalancesV3(chain, vault);
            }

            return true;
        },
        async syncUserBalancesFromV3Subgraph(chain: Chain) {
            const {
                subgraphs: { vault },
            } = config[chain];

            // Guard against unconfigured chains
            if (!vault) {
                return [];
            }

            const syncedBlocks = await syncBptBalancesV3(chain, vault);
            return syncedBlocks;
        },
    };
}
