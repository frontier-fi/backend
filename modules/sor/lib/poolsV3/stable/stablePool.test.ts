// yarn vitest stablePool.test.ts

import { parseEther, parseUnits } from 'viem';

import { PrismaPoolAndHookWithDynamic } from '../../../../../prisma/prisma-types';
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
});
