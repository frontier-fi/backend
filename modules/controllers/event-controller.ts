import config from '../../config';

import { syncJoinExits as syncJoinExitsV3 } from '../actions/pool/v3/sync-join-exits';
import { syncSwaps as syncSwapsV3 } from '../actions/pool/v3/sync-swaps';
import { Chain } from '@prisma/client';
import { updateVolumeAndFees } from '../actions/pool/update-volume-and-fees';
import { getVaultSubgraphClient } from '../sources/subgraphs/vault';

export function EventController() {
    return {
        async syncJoinExitsV3(chain: Chain) {
            const {
                subgraphs: { vault },
            } = config[chain];

            if (!vault) {
                throw new Error(`Chain not configured: ${chain}`);
            }

            const vaultSubgraphClient = getVaultSubgraphClient(vault, chain);
            const entries = await syncJoinExitsV3(vaultSubgraphClient, chain);
            return entries;
        },
        async syncSwapsV3(chain: Chain) {
            const {
                subgraphs: { vault },
            } = config[chain];

            if (!vault) {
                throw new Error(`Chain not configured: ${chain}`);
            }

            const vaultSubgraphClient = getVaultSubgraphClient(vault, chain);
            const entries = await syncSwapsV3(vaultSubgraphClient, chain);
            return entries;
        },
        async syncSwapsUpdateVolumeAndFeesV3(chain: Chain) {
            const {
                subgraphs: { vault },
            } = config[chain];

            if (!vault) {
                throw new Error(`Chain not configured: ${chain}`);
            }

            const vaultSubgraphClient = getVaultSubgraphClient(vault, chain);

            const poolsWithNewSwaps = await syncSwapsV3(vaultSubgraphClient, chain);
            await updateVolumeAndFees(chain, poolsWithNewSwaps);
            return poolsWithNewSwaps;
        },
        async updateVolumeAndFees(chain: Chain) {
            return updateVolumeAndFees(chain);
        },
    };
}
