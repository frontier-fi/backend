import { BigintIsh, SwapKind, Token, TokenAmount } from '@balancer/sdk';
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
