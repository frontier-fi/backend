import { stableContractCalls } from '../pool-type-dynamic-data';
import { PrismaPoolType } from '@prisma/client';

export const poolTypeCalls = (pool: { id: string; type: PrismaPoolType; version: number }, _vault: string) => {
    switch (pool.type) {
        case PrismaPoolType.STABLE:
            return stableContractCalls(pool.id);
        default:
            return [];
    }
};
