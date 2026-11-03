// yarn vitest stablePool.test.ts

import { parseEther, parseUnits } from 'viem';

import { PrismaPoolAndHookWithDynamic } from '../../../../../prisma/prisma-types';
import { resolveStableAmp } from '../../../../pool/subgraph-pool';
import { GyroECLPPool } from '../gyroECLP/gyroECLPPool';
import { WeightedPoolV3 } from '../weighted/weightedPool';
import { StablePoolV3 } from './stablePool';

// keep factories imports at the end - moving up will break the test
import {
    poolTokenFactory,
    prismaPoolDynamicDataFactory,
    prismaPoolFactory,
    prismaPoolTokenFactory,
} from '../../../../../test/factories';
import { createRandomAddress } from '../../../../../test/utils';

describe('SOR V3 Stable Pool Tests', () => {
    let amp: string;
    let scalingFactors: bigint[];
    let aggregateSwapFee: bigint;
    let stablePool: StablePoolV3;
    let stablePrismaPool: PrismaPoolAndHookWithDynamic;
    let swapFee: string;
    let tokenAddresses: string[];
    let tokenBalances: string[];
    let tokenDecimals: number[];
    let tokenRates: string[];
    let totalShares: string;
    let poolAddress: string;

    beforeAll(() => {
        swapFee = '0.001';
        tokenBalances = ['52110', '51290'];
        tokenDecimals = [6, 18];
        tokenRates = ['1', '1'];
        totalShares = '100000';
        amp = '1000';
        scalingFactors = [10n ** 12n, 10n ** 0n];
        aggregateSwapFee = 0n;
        poolAddress = createRandomAddress();

        const poolToken1 = prismaPoolTokenFactory.build({
            token: poolTokenFactory.build({ decimals: tokenDecimals[0] }),
            balance: tokenBalances[0],
            priceRate: tokenRates[0],
        });
        const poolToken2 = prismaPoolTokenFactory.build({
            token: poolTokenFactory.build({ decimals: tokenDecimals[1] }),
            balance: tokenBalances[1],
            priceRate: tokenRates[1],
        });

        tokenAddresses = [poolToken1.address, poolToken2.address];

        stablePrismaPool = prismaPoolFactory.build({
            address: poolAddress,
            type: 'STABLE',
            protocolVersion: 3,
            typeData: {
                amp,
            },
            tokens: [poolToken1, poolToken2],
            dynamicData: prismaPoolDynamicDataFactory.build({ swapFee, totalShares }),
            liquidityManagement: {
                disableUnbalancedLiquidity: true,
                enableAddLiquidityCustom: false,
                enableDonation: false,
                enableRemoveLiquidityCustom: false,
            },
        });
        stablePool = StablePoolV3.fromPrismaPool(stablePrismaPool);
    });

    test('Get Pool State', () => {
        const poolState = {
            poolType: 'STABLE',
            poolAddress: poolAddress,
            swapFee: parseEther(swapFee),
            balancesLiveScaled18: tokenBalances.map((b) => parseEther(b)),
            tokenRates: tokenRates.map((r) => parseEther(r)),
            totalSupply: parseEther(totalShares),
            amp: parseUnits(amp, 3),
            tokens: tokenAddresses,
            scalingFactors,
            aggregateSwapFee,
            supportsUnbalancedLiquidity: false,
        };
        expect(poolState).toEqual(stablePool.getPoolState());
    });

    test('zeroes out aggregateSwapFee in recovery mode across StablePoolV3, WeightedPoolV3, and GyroECLPPool', () => {
        const activeStable = StablePoolV3.fromPrismaPool({
            ...stablePrismaPool,
            dynamicData: {
                ...stablePrismaPool.dynamicData!,
                aggregateSwapFee: '0.5',
                isInRecoveryMode: false,
            },
        });
        const recoveryStable = StablePoolV3.fromPrismaPool({
            ...stablePrismaPool,
            dynamicData: {
                ...stablePrismaPool.dynamicData!,
                aggregateSwapFee: '0.5',
                isInRecoveryMode: true,
            },
        });
        expect(activeStable.getPoolState().aggregateSwapFee).toBe(parseEther('0.5'));
        expect(recoveryStable.getPoolState().aggregateSwapFee).toBe(0n);

        const weightedBase: PrismaPoolAndHookWithDynamic = {
            ...stablePrismaPool,
            type: 'WEIGHTED',
            tokens: stablePrismaPool.tokens.map((t) => ({ ...t, weight: '0.5' })),
        };
        const activeWeighted = WeightedPoolV3.fromPrismaPool({
            ...weightedBase,
            dynamicData: {
                ...weightedBase.dynamicData!,
                aggregateSwapFee: '0.5',
                isInRecoveryMode: false,
            },
        });
        const recoveryWeighted = WeightedPoolV3.fromPrismaPool({
            ...weightedBase,
            dynamicData: {
                ...weightedBase.dynamicData!,
                aggregateSwapFee: '0.5',
                isInRecoveryMode: true,
            },
        });
        expect(activeWeighted.getPoolState().aggregateSwapFee).toBe(parseEther('0.5'));
        expect(recoveryWeighted.getPoolState().aggregateSwapFee).toBe(0n);

        const eclpBase: PrismaPoolAndHookWithDynamic = {
            ...stablePrismaPool,
            type: 'ECLP',
            typeData: {
                alpha: '0.9',
                beta: '1.1',
                c: '0.707106781186547524',
                s: '0.707106781186547524',
                lambda: '4',
                tauAlphaX: '-0.1',
                tauAlphaY: '0.99',
                tauBetaX: '0.1',
                tauBetaY: '0.99',
                u: '0.1',
                v: '0.99',
                w: '0',
                z: '0',
                dSq: '1',
            },
        };
        const activeEclp = GyroECLPPool.fromPrismaPool({
            ...eclpBase,
            dynamicData: {
                ...eclpBase.dynamicData!,
                aggregateSwapFee: '0.5',
                isInRecoveryMode: false,
            },
        });
        const recoveryEclp = GyroECLPPool.fromPrismaPool({
            ...eclpBase,
            dynamicData: {
                ...eclpBase.dynamicData!,
                aggregateSwapFee: '0.5',
                isInRecoveryMode: true,
            },
        });
        expect(activeEclp.getPoolState().aggregateSwapFee).toBe(parseEther('0.5'));
        expect(recoveryEclp.getPoolState().aggregateSwapFee).toBe(0n);
    });

    test('interpolates current amp from ramp schedule without requiring subgraph block polling', () => {
        const rampingPool: PrismaPoolAndHookWithDynamic = {
            ...stablePrismaPool,
            typeData: {
                amp: '100',
                ampIsUpdating: true,
                ampStartValue: '100',
                ampEndValue: '500',
                ampStartTime: '1000',
                ampEndTime: '5000',
            },
        };

        // Before/at start: 100 * 1000 = 100_000n
        expect(StablePoolV3.fromPrismaPool(rampingPool, 900n).amp).toBe(100_000n);
        expect(StablePoolV3.fromPrismaPool(rampingPool, 1000n).amp).toBe(100_000n);

        // Mid-ramp (t = 2000, 25% elapsed): 100 + (400 * 1000 / 4000) = 200 -> 200_000n
        expect(StablePoolV3.fromPrismaPool(rampingPool, 2000n).amp).toBe(200_000n);
        expect(resolveStableAmp(rampingPool.typeData as any, 2000n)).toBe('200');

        // Natural completion (t >= 5000, even when ampIsUpdating is still true in subgraph): 500 -> 500_000n
        expect(StablePoolV3.fromPrismaPool(rampingPool, 5000n).amp).toBe(500_000n);
        expect(StablePoolV3.fromPrismaPool(rampingPool, 9000n).amp).toBe(500_000n);
        expect(resolveStableAmp(rampingPool.typeData as any, 9000n)).toBe('500');

        // Downward ramp (500 -> 100 over [1000, 5000] at t = 2000 -> 400)
        const downwardPool: PrismaPoolAndHookWithDynamic = {
            ...stablePrismaPool,
            typeData: {
                amp: '500',
                ampIsUpdating: true,
                ampStartValue: '500',
                ampEndValue: '100',
                ampStartTime: '1000',
                ampEndTime: '5000',
            },
        };
        expect(StablePoolV3.fromPrismaPool(downwardPool, 2000n).amp).toBe(400_000n);

        // Manually stopped mid-ramp (ampIsUpdating = false, amp = 250) stays at 250 both before and after ampEndTime
        const stoppedPool: PrismaPoolAndHookWithDynamic = {
            ...stablePrismaPool,
            typeData: {
                amp: '250',
                ampIsUpdating: false,
                ampStartValue: '100',
                ampEndValue: '500',
                ampStartTime: '1000',
                ampEndTime: '5000',
            },
        };
        expect(StablePoolV3.fromPrismaPool(stoppedPool, 2000n).amp).toBe(250_000n);
        expect(StablePoolV3.fromPrismaPool(stoppedPool, 5000n).amp).toBe(250_000n);
        expect(StablePoolV3.fromPrismaPool(stoppedPool, 9000n).amp).toBe(250_000n);

        // Null ramp fields in Prisma JSON fall back to amp without throwing
        const nullFieldsPool: PrismaPoolAndHookWithDynamic = {
            ...stablePrismaPool,
            typeData: {
                amp: '300',
                ampIsUpdating: null as any,
                ampStartValue: null as any,
                ampEndValue: null as any,
                ampStartTime: null as any,
                ampEndTime: null as any,
            },
        };
        expect(StablePoolV3.fromPrismaPool(nullFieldsPool, 2000n).amp).toBe(300_000n);

        // Fractional BigDecimal ampStartValue (e.g. 150.5 -> 150_500n after mid-ramp restart in subgraphs#13)
        const fractionalRampPool: PrismaPoolAndHookWithDynamic = {
            ...stablePrismaPool,
            typeData: {
                amp: '150',
                ampIsUpdating: true,
                ampStartValue: '150.5',
                ampEndValue: '250.5',
                ampStartTime: '1000',
                ampEndTime: '2000',
            },
        };
        expect(StablePoolV3.fromPrismaPool(fractionalRampPool, 1000n).amp).toBe(150_500n);
        expect(StablePoolV3.fromPrismaPool(fractionalRampPool, 1500n).amp).toBe(200_500n);
        expect(StablePoolV3.fromPrismaPool(fractionalRampPool, 2000n).amp).toBe(250_500n);
    });
});
