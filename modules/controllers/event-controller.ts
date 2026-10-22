import config from '../../config';

import { syncJoinExits as syncJoinExitsV3 } from '../actions/pool/v3/sync-join-exits';
import { syncSwaps as syncSwapsV3 } from '../actions/pool/v3/sync-swaps';
import { Chain } from '@prisma/client';
import { updateVolumeAndFees } from '../actions/pool/update-volume-and-fees';
import { getVaultSubgraphClient } from '../sources/subgraphs/balancer-v3-vault';
import { syncLastSwaps } from '../actions/pool/v3/sync-last-swaps';

export function EventController() {
    return {
        async syncJoinExitsV3(chain: Chain) {
            const {
                subgraphs: { balancerV3 },
            } = config[chain];

            if (!balancerV3) {
                throw new Error(`Chain not configured: ${chain}`);
            }

            const vaultSubgraphClient = getVaultSubgraphClient(balancerV3, chain);
            const entries = await syncJoinExitsV3(vaultSubgraphClient, chain);
            return entries;
        },
        async syncSwapsV3(chain: Chain) {
            const {
                subgraphs: { balancerV3 },
            } = config[chain];

            if (!balancerV3) {
                throw new Error(`Chain not configured: ${chain}`);
            }

            const vaultSubgraphClient = getVaultSubgraphClient(balancerV3, chain);
            const entries = await syncSwapsV3(vaultSubgraphClient, chain);
            return entries;
        },
        async syncLastSwaps(chain: Chain) {
            const {
                subgraphs: { balancerV3 },
            } = config[chain];

            if (!balancerV3) {
                throw new Error(`Chain not configured: ${chain}`);
            }

            const vaultSubgraphClient = getVaultSubgraphClient(balancerV3, chain);
            const entries = await syncLastSwaps(vaultSubgraphClient, chain);
            return entries;
        },
        async syncSwapsUpdateVolumeAndFeesV3(chain: Chain) {
            const {
                subgraphs: { balancerV3 },
            } = config[chain];

            if (!balancerV3) {
                throw new Error(`Chain not configured: ${chain}`);
            }

            const vaultSubgraphClient = getVaultSubgraphClient(balancerV3, chain);

            const poolsWithNewSwaps = await syncSwapsV3(vaultSubgraphClient, chain);
            await updateVolumeAndFees(chain, poolsWithNewSwaps);
            return poolsWithNewSwaps;
        },
        async updateVolumeAndFees(chain: Chain) {
            return updateVolumeAndFees(chain);
        },
    };
}
