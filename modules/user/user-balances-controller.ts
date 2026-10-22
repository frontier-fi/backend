import { Chain } from '@prisma/client';
import config from '../../config';
import { syncBptBalancesV3 } from './lib/bpt-balances/sync-bpt-balances-v3';

export function UserBalancesController() {
    return {
        async syncBalances(chain: Chain) {
            const {
                subgraphs: { balancerV3 },
            } = config[chain];

            if (balancerV3 && config[chain].balancer.v3.vaultAddress !== '') {
                await syncBptBalancesV3(chain, balancerV3);
            }

            return true;
        },
        async syncUserBalancesFromV3Subgraph(chain: Chain) {
            const {
                subgraphs: { balancerV3 },
            } = config[chain];

            // Guard against unconfigured chains
            if (!balancerV3) {
                return [];
            }

            const syncedBlocks = await syncBptBalancesV3(chain, balancerV3);
            return syncedBlocks;
        },
    };
}
