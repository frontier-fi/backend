import { addPools } from './add-pools';
import { syncPools } from './sync-pools';
import config from '../../../../config';
import { getV3JoinedSubgraphClient } from '../../../sources/subgraphs/joined-client';
import { getViemClient } from '../../../sources/viem-client';
import { getPoolsSubgraphClient, getVaultSubgraphClient } from '../../../sources/subgraphs';
import { prisma } from '../../../../prisma/prisma-client';
import { PoolWithMappedJsonFields } from '../../../../prisma/prisma-types';

describe('sync pools debug', () => {
    it('sync pool', async () => {
        const chain = 'SEPOLIA';

        const ids = ['0x64bb1613459c6790cd6c94272dc9d09384d955c9', '0x7a7e80a5d622e1065f98dcd873f8c0c3d429aeba'];

        const {
            subgraphs: { vault, pools: poolsUrl },
            contracts: { Vault: vaultAddress },
        } = config[chain];

        // Guard against unconfigured chains
        if (!vault || !poolsUrl || !vaultAddress) {
            throw new Error(`Chain not configured: ${chain}`);
        }

        const vaultSubgraphClient = getVaultSubgraphClient(vault, chain);
        const poolsSubgraphClient = getPoolsSubgraphClient(poolsUrl, chain);
        const client = getV3JoinedSubgraphClient(vaultSubgraphClient, poolsSubgraphClient);
        const pools = await client.getAllInitializedPools({
            id_in: ids,
        });

        const viemClient = getViemClient(chain);
        const latestBlock = await viemClient.getBlockNumber().then(Number);

        const inserts = await addPools(pools, viemClient, vaultAddress, chain, latestBlock);
        await syncPools(
            inserts.map(({ pool }) => ({
                ...pool,
                version: pool.version ?? 1,
                typeData: pool.typeData ?? {},
            })),
            chain,
            vaultAddress,
            viemClient,
            latestBlock,
        );

        const dbPools = (await prisma.prismaPool.findMany({
            where: {
                id: {
                    in: ids,
                },
                chain,
            },
        })) as PoolWithMappedJsonFields[];

        expect(dbPools).toHaveLength(2);

        expect(dbPools[0].hook?.type).toBe('STABLE_SURGE');
    }, 5000000);
});
