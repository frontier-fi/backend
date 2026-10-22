import { ZERO_ADDRESS } from '@balancer/sdk';
import { PrismaPoolDynamicData, PrismaPoolToken, PrismaPoolType } from '@prisma/client';

type PoolWithTypeAndFactory = {
    address: string;
    type: PrismaPoolType;
    factory?: string | null;
    dynamicData?: PrismaPoolDynamicData | null;
    version: number;
    protocolVersion: number;
};

export function isStablePool(poolType: PrismaPoolType) {
    return poolType === 'STABLE';
}

export function isWeightedPoolV2(pool: PoolWithTypeAndFactory) {
    return pool.type === 'WEIGHTED' && pool.version >= 2;
}

export function isComposableStablePool(_pool: PoolWithTypeAndFactory) {
    return false;
}

export function collectsYieldFee(pool: PoolWithTypeAndFactory) {
    return capturesYield(pool) && !pool.dynamicData?.isInRecoveryMode;
}

export function tokenCollectsYieldFee(token: PrismaPoolToken) {
    return !token.exemptFromProtocolYieldFee && token.priceRateProvider && token.priceRateProvider !== ZERO_ADDRESS;
}

export function capturesYield(pool: PoolWithTypeAndFactory) {
    return (
        isWeightedPoolV2(pool) ||
        isGyroEV2(pool) ||
        pool.protocolVersion === 3
    );
}

export function isGyroPool(pool: PoolWithTypeAndFactory) {
    return pool.type.includes('GYRO');
}

export function isGyroEV2(pool: PoolWithTypeAndFactory) {
    return pool.type === 'GYROE' && pool.version === 2;
}
