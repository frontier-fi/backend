import { PoolForAPRs } from '../../prisma/prisma-types';

export interface PoolAprService {
    updateAprForPools(pools: PoolForAPRs[]): Promise<void>;
    getAprServiceName(): string;
}
