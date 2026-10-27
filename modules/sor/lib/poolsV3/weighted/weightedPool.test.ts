// yarn vitest poolsV3/weighted/weightedPool.test.ts

import { Token, TokenAmount } from '@balancer/sdk';
import { parseEther } from 'viem';

import { PrismaPoolAndHookWithDynamic } from '../../../../../prisma/prisma-types';
import { WAD } from '../../utils/math';
import { WeightedPoolV3 } from './weightedPool';
import { createRandomAddress } from '../../../../../test/utils';

// keep factories imports at the end - moving up will break the test
import {
    poolTokenFactory,
    prismaPoolDynamicDataFactory,
    prismaPoolFactory,
    prismaPoolTokenFactory,
} from '../../../../../test/factories';

describe('SOR V3 Weighted Pool Tests', () => {
    let scalingFactors: bigint[];
    let swapFee: string;
    let aggregateSwapFee: bigint;
    let tokenAddresses: string[];
    let tokenBalances: string[];
    let tokenDecimals: number[];
    let tokenWeights: string[];
    let totalShares: string;
    let weightedPool: WeightedPoolV3;
    let weightedPrismaPool: PrismaPoolAndHookWithDynamic;
    let poolAddress: string;

    beforeAll(() => {
        swapFee = '0.001';
        tokenBalances = ['52110', '51290'];
        tokenDecimals = [6, 18];
        tokenWeights = ['0.4', '0.6'];
        totalShares = '100000';
        scalingFactors = [10n ** 12n, 10n ** 0n];
        poolAddress = createRandomAddress();
        aggregateSwapFee = 0n;

        const poolToken1 = prismaPoolTokenFactory.build({
            token: poolTokenFactory.build({ decimals: tokenDecimals[0] }),
            balance: tokenBalances[0],
            weight: tokenWeights[0],
        });
        const poolToken2 = prismaPoolTokenFactory.build({
            token: poolTokenFactory.build({ decimals: tokenDecimals[1] }),
            balance: tokenBalances[1],
            weight: tokenWeights[1],
        });

        tokenAddresses = [poolToken1.address, poolToken2.address];

        weightedPrismaPool = prismaPoolFactory.build({
            type: 'WEIGHTED',
            address: poolAddress,
            protocolVersion: 3,
            tokens: [poolToken1, poolToken2],
            dynamicData: prismaPoolDynamicDataFactory.build({ swapFee, totalShares }),
            liquidityManagement: {
                disableUnbalancedLiquidity: true,
                enableAddLiquidityCustom: false,
                enableDonation: false,
                enableRemoveLiquidityCustom: false,
            },
        });
        weightedPool = WeightedPoolV3.fromPrismaPool(weightedPrismaPool);
    });

    test('Get Pool State', () => {
        const poolState = {
            poolType: 'WEIGHTED',
            poolAddress: poolAddress,
            swapFee: parseEther(swapFee),
            aggregateSwapFee: aggregateSwapFee,
            balancesLiveScaled18: tokenBalances.map((b) => parseEther(b)),
            tokenRates: Array(tokenBalances.length).fill(WAD),
            totalSupply: parseEther(totalShares),
            weights: tokenWeights.map((w) => parseEther(w)),
            tokens: tokenAddresses,
            scalingFactors,
            supportsUnbalancedLiquidity: false,
        };
        expect(poolState).toEqual(weightedPool.getPoolState());
    });

    test('swaps a small amount out and mutates balances only when asked', () => {
        const tokenIn = weightedPool.tokens[0].token;
        const tokenOut = weightedPool.tokens[1].token;
        const amountIn = TokenAmount.fromRawAmount(tokenIn, 1_000_000n);
        const first = weightedPool.swapGivenIn(tokenIn, tokenOut, amountIn);
        const second = weightedPool.swapGivenIn(tokenIn, tokenOut, amountIn);

        expect(first.amount).toBeGreaterThan(0n);
        expect(second.amount).toBe(first.amount);

        const mutated = weightedPool.swapGivenIn(tokenIn, tokenOut, amountIn, true);
        const after = weightedPool.swapGivenIn(tokenIn, tokenOut, amountIn);
        expect(mutated.amount).toBeGreaterThan(0n);
        expect(after.amount).toBeLessThan(mutated.amount);
    });

    test('returns zero when removing BPT and unbalanced liquidity is disabled', () => {
        const bpt = new Token(weightedPool.tokens[0].token.chainId, weightedPool.id, 18);
        const out = weightedPool.swapGivenIn(bpt, weightedPool.tokens[0].token, TokenAmount.fromRawAmount(bpt, 1000n));

        expect(out.amount).toBe(0n);
        expect(out.token.address).toBe(weightedPool.tokens[0].token.address);

        const inForRemove = weightedPool.swapGivenOut(
            bpt,
            weightedPool.tokens[0].token,
            TokenAmount.fromRawAmount(weightedPool.tokens[0].token, 1000n),
        );
        expect(inForRemove.amount).toBe(0n);
        expect(inForRemove.token.address).toBe(bpt.address);

        const inForAdd = weightedPool.swapGivenOut(
            weightedPool.tokens[0].token,
            bpt,
            TokenAmount.fromRawAmount(bpt, 1000n),
        );
        expect(inForAdd.amount).toBe(0n);
        expect(inForAdd.token.address).toBe(weightedPool.tokens[0].token.address);
    });

    test('copy() deep-clones tokens so mutating balances on a copy does not mutate the original pool', () => {
        const original = WeightedPoolV3.fromPrismaPool(weightedPrismaPool);
        const cloned = original.copy();

        const tokenIn = original.tokens[0].token;
        const tokenOut = original.tokens[1].token;
        const amountIn = TokenAmount.fromRawAmount(tokenIn, 1_000_000n);

        const originalBalance0Before = original.tokens[0].amount;
        const originalBalance1Before = original.tokens[1].amount;

        // Mutate balances on the cloned pool
        cloned.swapGivenIn(tokenIn, tokenOut, amountIn, true);

        expect(cloned.tokens[0].amount).toBeGreaterThan(originalBalance0Before);
        expect(cloned.tokens[1].amount).toBeLessThan(originalBalance1Before);

        // Original pool balances must remain untouched
        expect(original.tokens[0].amount).toBe(originalBalance0Before);
        expect(original.tokens[1].amount).toBe(originalBalance1Before);
    });
});
