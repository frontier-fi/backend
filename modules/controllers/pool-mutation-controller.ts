import config from '../../config';
import { syncSwaps } from '../actions/pool/v3/sync-swaps';
import { updateVolumeAndFees } from '../actions/pool/update-volume-and-fees';
import { getVaultSubgraphClient } from '../sources/subgraphs';
import { Chain } from '@prisma/client';

/**
 * Controller responsible for matching job requests to configured job handlers
 *
 * @param name - the name of the job
 * @param chain - the chain to run the job on
 * @returns a controller with configured job handlers
 */
export function PoolMutationController(tracer?: any) {
    // Setup tracing
    // ...
    return {
        async loadSwapsFeesVolumeForAllPoolsV3(chain: Chain) {
            const {
                subgraphs: { vault },
            } = config[chain];

            // Guard against unconfigured chains
            if (!vault) {
                throw new Error(`Chain not configured: ${chain}`);
            }

            const vaultSubgraphClient = getVaultSubgraphClient(vault, chain);

            const poolsWithNewSwaps = await syncSwaps(vaultSubgraphClient, chain);
            await updateVolumeAndFees(chain, poolsWithNewSwaps);
            return poolsWithNewSwaps;
        },
    };
}
