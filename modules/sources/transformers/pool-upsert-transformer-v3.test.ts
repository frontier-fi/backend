import { Chain, PrismaPoolType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PoolType } from '../subgraphs/balancer-v3-pools/generated/types';
import { V3JoinedSubgraphPool } from '../subgraphs';
import { poolUpsertTransformerV3 } from './pool-upsert-transformer-v3';

const pool = (factoryType: string, extra: Record<string, unknown> = {}) =>
    ({
        id: '0xABC',
        symbol: 'P',
        name: 'Pool',
        swapFeeManager: '0xfee',
        pauseManager: null,
        poolCreator: '0xcreator',
        blockTimestamp: '10',
        swapFee: '0.01',
        totalShares: '1',
        isPaused: false,
        isInRecoveryMode: false,
        liquidityManagement: {},
        hookConfig: null,
        factory: { type: factoryType, id: '0xFACTORY', version: 1 },
        tokens: [
            {
                address: '0xTOKEN',
                decimals: 18,
                symbol: 'T',
                name: 'Token',
                index: 0,
                balance: '1',
                paysYieldFees: true,
                scalingFactor: '1',
                nestedPool: null,
            },
        ],
        rateProviders: [{ address: '0xRATE' }],
        weightedParams: { weights: ['1'] },
        stableParams: { amp: '200' },
        gyroEParams: { alpha: '1', beta: '2' },
        ...extra,
    }) as unknown as V3JoinedSubgraphPool;

describe('poolUpsertTransformerV3', () => {
    it('maps weighted, stable, and gyroE pools', () => {
        const weighted = poolUpsertTransformerV3(pool(PoolType.Weighted), Chain.SEPOLIA, 5);
        const stable = poolUpsertTransformerV3(pool(PoolType.Stable), Chain.SEPOLIA, 5);
        const gyro = poolUpsertTransformerV3(pool(PoolType.GyroE), Chain.SEPOLIA, 5);

        expect(weighted?.pool.type).toBe(PrismaPoolType.WEIGHTED);
        expect(weighted?.pool.protocolVersion).toBe(3);
        expect(weighted?.pool.id).toBe('0xabc');
        expect(stable?.pool.type).toBe(PrismaPoolType.STABLE);
        expect(stable?.pool.typeData).toMatchObject({ amp: '200' });
        expect(gyro?.pool.type).toBe(PrismaPoolType.GYROE);
        expect(gyro?.pool.typeData).toMatchObject({ alpha: '1', beta: '2' });
    });

    it('returns null for a factory type other than weighted, stable, or gyroE', () => {
        expect(poolUpsertTransformerV3(pool('ReClamm'), Chain.SEPOLIA, 5)).toBeNull();
    });
});
