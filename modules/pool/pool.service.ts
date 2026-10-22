import { Chain } from '@prisma/client';
import {
    GqlChain,
    GqlPoolFeaturedPool,
    GqlPoolMinimal,
    GqlPoolSnapshotDataRange,
    GqlPoolUnion,
    QueryPoolGetPoolsArgs,
} from '../../apps/api/gql/generated-schema';
import { PoolGqlLoaderService } from './lib/pool-gql-loader.service';
import { PoolSnapshotService } from './lib/pool-snapshot.service';

export class PoolService {
    constructor(
        private readonly poolGqlLoaderService: PoolGqlLoaderService,
        private readonly poolSnapshotService: PoolSnapshotService,
    ) {}

    public async getGqlPool(fields: any, id: string, chain: GqlChain, userAddress?: string): Promise<GqlPoolUnion> {
        return this.poolGqlLoaderService.getPool(fields, id, chain, userAddress);
    }

    public async getGqlPools(args: QueryPoolGetPoolsArgs): Promise<GqlPoolMinimal[]> {
        return this.poolGqlLoaderService.getPools(args);
    }

    public async getPoolsCount(args: QueryPoolGetPoolsArgs): Promise<number> {
        return this.poolGqlLoaderService.getPoolsCount(args);
    }

    public async getFeaturedPools(chains: Chain[]): Promise<GqlPoolFeaturedPool[]> {
        return this.poolGqlLoaderService.getFeaturedPools(chains);
    }

    public async getSnapshotsForPool(poolId: string, chain: Chain, range: GqlPoolSnapshotDataRange) {
        return this.poolSnapshotService.getSnapshotsForPool(poolId, chain, range);
    }
}

export const poolService = new PoolService(new PoolGqlLoaderService(), new PoolSnapshotService());
