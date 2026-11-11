import { describe, expect, it, vi } from 'vitest';
import { parseEther } from 'viem';
import { fetchTokenPairData } from './fetch-tokenpair-data';
import * as multicallerModule from '../../../web3/multicaller-viem';

describe('fetchTokenPairData', () => {
    const routerAddress = '0x00000000000000000000000000000000000000aa';
    const tokenUsdc = '0x0000000000000000000000000000000000000001';
    const tokenWeth = '0x0000000000000000000000000000000000000002';

    it('probes $100 on deep pools and clamps to 10% of tokenA balance on skewed pools with proportional normalizedLiquidity scaling', async () => {
        const deepPoolId = '0x0000000000000000000000000000000000001001';
        const skewedPoolId = '0x0000000000000000000000000000000000001002';

        const recordedCalls: multicallerModule.ViemMulticallCall[][] = [];
        const multicallSpy = vi.spyOn(multicallerModule, 'multicallViem').mockImplementation(async (_client, calls) => {
            recordedCalls.push(calls);
            const results: Record<string, any> = {};
            for (const call of calls) {
                const [pairKey, field] = (call.path ?? '').split('.');
                results[pairKey] ??= {};
                if (call.functionName === 'querySwapSingleTokenExactIn') {
                    const amountIn = BigInt(call.args![3] as any);
                    if (field === 'effectivePriceAmountOut') {
                        // Simulate 10% price impact on the probe swap (effectivePrice = 1 / 0.9, spotPrice ≈ 1)
                        results[pairKey][field] = (amountIn * 9n) / 10n;
                    } else if (field === 'aToBAmountOut') {
                        // 1% spot-price leg (near 1:1)
                        results[pairKey][field] = (amountIn * 999n) / 1000n;
                    } else if (field === 'bToAAmountOut') {
                        results[pairKey][field] = (amountIn * 999n) / 1000n;
                    }
                } else {
                    results[pairKey][field] = 0n;
                }
            }
            return results;
        });

        try {
            const output = await fetchTokenPairData(
                routerAddress,
                [
                    {
                        id: deepPoolId,
                        address: deepPoolId,
                        protocolVersion: 3,
                        dynamicData: { totalLiquidity: 20_000, totalShares: '20000' },
                        tokens: [
                            {
                                address: tokenUsdc,
                                index: 0,
                                balance: '10000',
                                balanceUSD: 10_000,
                                token: { decimals: 6 },
                            },
                            {
                                address: tokenWeth,
                                index: 1,
                                balance: '10000',
                                balanceUSD: 10_000,
                                token: { decimals: 6 },
                            },
                        ],
                    },
                    {
                        // Asymmetric pool like Sepolia w5ec: $1,212 total TVL, but only $0.50 on the USDC side
                        id: skewedPoolId,
                        address: skewedPoolId,
                        protocolVersion: 3,
                        dynamicData: { totalLiquidity: 1_212, totalShares: '1212' },
                        tokens: [
                            {
                                address: tokenUsdc,
                                index: 0,
                                balance: '0.5',
                                balanceUSD: 0.5,
                                token: { decimals: 6 },
                            },
                            {
                                address: tokenWeth,
                                index: 1,
                                balance: '1211.5',
                                balanceUSD: 1_211.5,
                                token: { decimals: 6 },
                            },
                        ],
                    },
                ],
                {} as any,
            );

            // Inspect first multicall batch to verify effectivePriceAmountIn clamping
            const firstBatch = recordedCalls[0];
            const deepProbeCall = firstBatch.find(
                (c) => c.path === `${deepPoolId}-${tokenUsdc}-${tokenWeth}.effectivePriceAmountOut`,
            )!;
            const skewedProbeCall = firstBatch.find(
                (c) => c.path === `${skewedPoolId}-${tokenUsdc}-${tokenWeth}.effectivePriceAmountOut`,
            )!;

            // Deep pool ($10k balance) probes full $100 = 100_000_000n raw
            expect(deepProbeCall.args![3]).toBe(100_000_000n);
            // Skewed pool ($0.50 balance) clamps probe to 10% = $0.05 = 50_000n raw (never exceeding 30% max-in!)
            expect(skewedProbeCall.args![3]).toBe(50_000n);

            const deepPair = output[deepPoolId].tokenPairs.find(
                (p) => p.tokenA === tokenUsdc && p.tokenB === tokenWeth,
            )!;
            const skewedPair = output[skewedPoolId].tokenPairs.find(
                (p) => p.tokenA === tokenUsdc && p.tokenB === tokenWeth,
            )!;

            const deepNormLiq = BigInt(deepPair.normalizedLiquidity);
            const skewedNormLiq = BigInt(skewedPair.normalizedLiquidity);

            // At 10% probe impact, unscaled normalizedLiquidity = 1 / 0.1 = 10 WAD
            expect(deepNormLiq).toBeGreaterThan(parseEther('9.9'));
            expect(deepNormLiq).toBeLessThanOrEqual(parseEther('10.1'));

            // Skewed pool probed $0.05 (0.0005x of $100), so normalizedLiquidity scales by 0.0005 (~0.005 WAD > 0n)
            expect(skewedNormLiq).toBeGreaterThan(0n);
            expect(skewedNormLiq).toBeGreaterThan(parseEther('0.0049'));
            expect(skewedNormLiq).toBeLessThanOrEqual(parseEther('0.0051'));
        } finally {
            multicallSpy.mockRestore();
        }
    });
});
