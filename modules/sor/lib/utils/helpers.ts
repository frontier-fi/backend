import { BigintIsh, SwapKind, Token, TokenAmount, WAD } from '@balancer/sdk';
import { formatUnits } from 'viem';
import { PathWithAmount } from '../path';

import { HookState } from '@balancer-labs/balancer-maths';
import { LiquidityManagement } from '../../types';

import { PrismaPoolAndHookWithDynamic, HookData } from '../../../../prisma/prisma-types';

export function checkInputs(
    tokenIn: Token,
    tokenOut: Token,
    swapKind: SwapKind,
    swapAmount: BigintIsh | TokenAmount,
): TokenAmount {
    let amount: TokenAmount;

    if (swapAmount instanceof TokenAmount) {
        amount = swapAmount;
    } else {
        amount = TokenAmount.fromRawAmount(swapKind === SwapKind.GivenIn ? tokenIn : tokenOut, swapAmount);
    }

    if (
        (swapKind === SwapKind.GivenIn && !tokenIn.isEqual(amount.token)) ||
        (swapKind === SwapKind.GivenOut && !tokenOut.isEqual(amount.token))
    ) {
        throw new Error('Swap amount token does not match input token');
    }

    return amount;
}

export function getInputAmount(paths: PathWithAmount[]): TokenAmount {
    if (!paths.every((p) => p.inputAmount.token.isEqual(paths[0].inputAmount.token))) {
        throw new Error('Input amount can only be calculated if all paths have the same input token');
    }
    const amounts = paths.map((path) => path.inputAmount);
    return amounts.reduce((a, b) => a.add(b));
}

export function getOutputAmount(paths: PathWithAmount[]): TokenAmount {
    if (!paths.every((p) => p.outputAmount.token.isEqual(paths[0].outputAmount.token))) {
        throw new Error('Output amount can only be calculated if all paths have the same output token');
    }
    const amounts = paths.map((path) => path.outputAmount);
    return amounts.reduce((a, b) => a.add(b));
}

/**
 * Computes pure curve/hook price impact in the forward swap direction using a small reference probe
 * (10 bps = 1/1000 of each path's swap amount, with fallback divisors for small raw amounts).
 * Static percentage swap fees cancel out between the probe benchmark and actual execution quote,
 * while dynamic hook fees (e.g. StableSurge) and curve slippage are captured.
 *
 * Returns a human-readable decimal string (e.g. "0.0100" for 1% price impact).
 */
export function calculatePriceImpact(paths: PathWithAmount[], swapKind: SwapKind): string {
    if (paths.length === 0) {
        throw new Error('Cannot calculate price impact for empty paths');
    }

    let totalBenchmark = 0n;
    for (const path of paths) {
        const fullSwapRaw = path.swapAmount.amount;
        if (fullSwapRaw <= 0n) {
            throw new Error('Swap amount must be positive');
        }

        const minRawFloor = path.isBuffer.some(Boolean) ? 10_000n : 100n;
        let pathBenchmark: bigint | null = null;

        for (const divisor of [1000n, 100n, 10n]) {
            const probeRaw = fullSwapRaw / divisor;
            if (probeRaw < minRawFloor) {
                continue;
            }
            try {
                const probePath = new PathWithAmount(
                    path.tokens,
                    path.pools,
                    path.isBuffer,
                    TokenAmount.fromRawAmount(path.swapAmount.token, probeRaw),
                    false,
                );
                const probeCalculated =
                    swapKind === SwapKind.GivenIn ? probePath.outputAmount.amount : probePath.inputAmount.amount;
                if (probeCalculated > 0n) {
                    pathBenchmark = (probeCalculated * fullSwapRaw) / probeRaw;
                    break;
                }
            } catch {
                continue;
            }
        }

        if (pathBenchmark === null) {
            pathBenchmark = swapKind === SwapKind.GivenIn ? path.outputAmount.amount : path.inputAmount.amount;
        }
        totalBenchmark += pathBenchmark;
    }

    let impactWad: bigint;
    if (swapKind === SwapKind.GivenIn) {
        const totalActual = getOutputAmount(paths).amount;
        if (totalBenchmark <= 0n) {
            throw new Error('Zero benchmark output amount');
        }
        impactWad = ((totalBenchmark - totalActual) * WAD) / totalBenchmark;
    } else {
        const totalActual = getInputAmount(paths).amount;
        if (totalActual <= 0n || totalBenchmark <= 0n) {
            throw new Error('Zero input amount');
        }
        impactWad = ((totalActual - totalBenchmark) * WAD) / totalActual;
    }

    const decimalValue = Number(formatUnits(impactWad, 18));
    const normalized = Math.abs(decimalValue) < 0.00005 ? 0 : decimalValue;
    return normalized.toFixed(4);
}

export function getHookState(pool: PrismaPoolAndHookWithDynamic): HookState | undefined {
    if (!pool.hook) {
        return undefined;
    }

    const hookData = pool.hook as HookData;

    switch (hookData.type) {
        case 'UNKNOWN':
        default:
            return undefined;
    }
}

export function isLiquidityManagement(value: any): value is LiquidityManagement {
    return (
        value &&
        typeof value.disableUnbalancedLiquidity === 'boolean' &&
        typeof value.enableAddLiquidityCustom === 'boolean' &&
        typeof value.enableDonation === 'boolean' &&
        typeof value.enableRemoveLiquidityCustom === 'boolean'
    );
}
