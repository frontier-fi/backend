import { chainIdToChain } from '../../../config/chain-id-to-chain';
import { Chain } from '@prisma/client';
import { GqlChain } from '../../../apps/api/gql/generated-schema';
import { contentSources } from '../../../config/content-sources';

interface FeaturedPoolMetadata {
    id: string;
    imageUrl: string;
    primary: boolean;
    chainId: number;
    description: string;
}

export interface FeaturedPool {
    poolId: string;
    primary: boolean;
    chain: GqlChain;
    description: string;
}

export async function getFeaturedPools(chains: Chain[]): Promise<FeaturedPool[]> {
    const response = await fetch(contentSources.featuredPools);
    if (!response.ok) {
        throw new Error(`Failed to fetch featured pools: ${response.statusText}`);
    }
    const data = (await response.json()) as FeaturedPoolMetadata[];
    const pools = data.filter((pool) => chains.includes(chainIdToChain[pool.chainId]));
    return pools.map(({ id, primary, chainId, description }) => ({
        poolId: id,
        chain: chainIdToChain[chainId],
        primary: Boolean(primary),
        description: description,
    })) as FeaturedPool[];
}
