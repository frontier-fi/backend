import { Address, Hex } from 'viem';
import { MAX_UINT256, SwapKind, Token, TokenAmount } from '@balancer/sdk';
import { BufferState, Vault } from '@balancer-labs/balancer-maths';

import { BasePoolMethodsV3 } from '../basePoolMethodsV3';
import { BasePoolToken } from '../../utils/basePoolToken';
import { BufferPoolData } from '../../../utils/data';
import { MathSol } from '../../utils';

export class BufferPool implements BasePoolMethodsV3 {
    public readonly chainId: number;
    public readonly id: Hex;
    public readonly address: Address;
    public readonly poolType = 'Buffer';
    public readonly swapFee = 0n;
    public readonly rate: bigint;
    public readonly tokens: BasePoolToken[];
    public maxDeposit: bigint;
    public maxWithdraw: bigint;

    private readonly tokenMap: Map<string, BasePoolToken>;
    private readonly decimalDiff: number; // mainDecimals - underlyingDecimals

    private vault: Vault;
    private poolState: BufferState;

    /**
     * Instantiates a buffer pool from buffer pool data built from erc4626 tokens
     *
     * For context: buffer pool within the SOR is an abstraction that works like
     * a pool where users can trade yield bearing tokens with their underlying token.
     * @param bufferPoolData
     * @returns Buffer pool
     */
    static fromBufferPoolData(bufferPoolData: BufferPoolData): BufferPool {
        return new BufferPool(
            bufferPoolData.address,
            bufferPoolData.address,
            bufferPoolData.chainId,
            bufferPoolData.unwrapRate,
            new BasePoolToken(
                new Token(bufferPoolData.chainId, bufferPoolData.mainToken.address, bufferPoolData.mainToken.decimals),
                bufferPoolData.mainToken.balance,
                0,
            ),
            new BasePoolToken(
                new Token(
                    bufferPoolData.chainId,
                    bufferPoolData.underlyingToken.address,
                    bufferPoolData.underlyingToken.decimals,
                ),
                bufferPoolData.underlyingToken.balance,
                1,
            ),
            bufferPoolData.maxDeposit,
            bufferPoolData.maxWithdraw,
        );
    }

    constructor(
        id: Hex,
        address: Address,
        chainId: number,
        rate: bigint,
        mainToken: BasePoolToken,
        underlyingToken: BasePoolToken,
        maxDeposit: bigint,
        maxWithdraw: bigint,
    ) {
        this.chainId = chainId;
        this.id = id;
        this.address = address;
        this.rate = rate;
        this.maxDeposit = maxDeposit;
        this.maxWithdraw = maxWithdraw;
        this.tokens = [mainToken, underlyingToken];
        this.tokenMap = new Map(this.tokens.map((token) => [token.token.address, token]));
        this.decimalDiff = mainToken.token.decimals - underlyingToken.token.decimals;

        this.vault = new Vault();
        this.poolState = this.getPoolState();
    }

    /**
     * Scales an amount from main token decimals to underlying token decimals.
     * Used after rate multiplication (mulDownFixed) which preserves the input's decimal scale.
     */
    private toUnderlyingDecimals(amount: bigint): bigint {
        if (this.decimalDiff > 0) return amount / 10n ** BigInt(this.decimalDiff);
        if (this.decimalDiff < 0) return amount * 10n ** BigInt(-this.decimalDiff);
        return amount;
    }

    /**
     * Scales an amount from underlying token decimals to main token decimals.
     * Used after rate division (divDownFixed) which preserves the input's decimal scale.
     */
    private toMainDecimals(amount: bigint): bigint {
        if (this.decimalDiff > 0) return amount * 10n ** BigInt(this.decimalDiff);
        if (this.decimalDiff < 0) return amount / 10n ** BigInt(-this.decimalDiff);
        return amount;
    }

    public getNormalizedLiquidity(tokenIn: Token, tokenOut: Token): bigint {
        return MAX_UINT256;
    }

    public getLimitAmountSwap(tokenIn: Token, tokenOut: Token, swapKind: SwapKind): bigint {
        const { tIn, tOut } = this.getPoolTokens(tokenIn, tokenOut);

        const mainTokenAmount = this.tokens[0];
        const underlyingTokenAmount = this.tokens[1];

        if (swapKind === SwapKind.GivenIn) {
            // givenIn
            if (underlyingTokenAmount.token.isSameAddress(tIn.token.address)) {
                // wrap - respective to amount in, which is underlying
                const mainAsUnderlying = this.toUnderlyingDecimals(
                    MathSol.mulDownFixed(mainTokenAmount.amount, this.rate),
                );
                const bufferWrapLimit = mainAsUnderlying; // in terms of underlying
                const lendingProtocolWrapLimit = this.maxDeposit;
                const rawWrapRequiredToRebalance =
                    (mainAsUnderlying + underlyingTokenAmount.amount) / 2n - underlyingTokenAmount.amount; // in terms of underlying
                const wrapRequiredToRebalance = rawWrapRequiredToRebalance > 0n ? rawWrapRequiredToRebalance : 0n;
                const wrapLimit =
                    wrapRequiredToRebalance > lendingProtocolWrapLimit
                        ? bufferWrapLimit
                        : lendingProtocolWrapLimit - wrapRequiredToRebalance;
                return wrapLimit;
            } else {
                // unwrap - respective to amount in, which is main
                const underlyingAsMain = this.toMainDecimals(
                    MathSol.divDownFixed(underlyingTokenAmount.amount, this.rate),
                );
                const bufferUnwrapLimit = underlyingAsMain; // in terms of main
                const maxWithdrawAsMain = this.toMainDecimals(MathSol.divDownFixed(this.maxWithdraw, this.rate));
                const lendingProtocolUnwrapLimit = maxWithdrawAsMain; // in terms of main
                const rawUnwrapRequiredToRebalance =
                    (underlyingAsMain + mainTokenAmount.amount) / 2n - mainTokenAmount.amount; // in terms of main
                const unwrapRequiredToRebalance = rawUnwrapRequiredToRebalance > 0n ? rawUnwrapRequiredToRebalance : 0n;
                const unwrapLimit =
                    unwrapRequiredToRebalance > lendingProtocolUnwrapLimit
                        ? bufferUnwrapLimit
                        : lendingProtocolUnwrapLimit - unwrapRequiredToRebalance;
                return unwrapLimit;
            }
        } else {
            // givenOut
            if (underlyingTokenAmount.token.isSameAddress(tIn.token.address)) {
                // wrap - respective to amount out, which is main
                const underlyingAsMain = this.toMainDecimals(
                    MathSol.divDownFixed(underlyingTokenAmount.amount, this.rate),
                );
                const bufferWrapLimit = mainTokenAmount.amount; // in terms of main
                const maxDepositAsMain = this.toMainDecimals(MathSol.divDownFixed(this.maxDeposit, this.rate));
                const lendingProtocolWrapLimit = maxDepositAsMain; // in terms of main
                const rawWrapRequiredToRebalance =
                    mainTokenAmount.amount - (underlyingAsMain + mainTokenAmount.amount) / 2n; // in terms of main
                const wrapRequiredToRebalance = rawWrapRequiredToRebalance > 0n ? rawWrapRequiredToRebalance : 0n;
                const wrapLimit =
                    wrapRequiredToRebalance > lendingProtocolWrapLimit
                        ? bufferWrapLimit
                        : bufferWrapLimit + lendingProtocolWrapLimit - wrapRequiredToRebalance;
                return wrapLimit;
            } else {
                // unwrap - respective to amount out, which is underlying
                const mainAsUnderlying = this.toUnderlyingDecimals(
                    MathSol.mulDownFixed(mainTokenAmount.amount, this.rate),
                );
                const bufferUnwrapLimit = underlyingTokenAmount.amount; // in terms of underlying
                const lendingProtocolUnwrapLimit = this.maxWithdraw;
                const rawUnwrapRequiredToRebalance =
                    underlyingTokenAmount.amount - (underlyingTokenAmount.amount + mainAsUnderlying) / 2n; // in terms of underlying
                const unwrapRequiredToRebalance = rawUnwrapRequiredToRebalance > 0n ? rawUnwrapRequiredToRebalance : 0n;
                const unwrapLimit =
                    unwrapRequiredToRebalance > lendingProtocolUnwrapLimit
                        ? bufferUnwrapLimit
                        : bufferUnwrapLimit + lendingProtocolUnwrapLimit - unwrapRequiredToRebalance;
                return unwrapLimit;
            }
        }
    }

    public swapGivenIn(
        tokenIn: Token,
        tokenOut: Token,
        swapAmount: TokenAmount,
        mutateBalances?: boolean,
    ): TokenAmount {
        const { tIn, tOut } = this.getPoolTokens(tokenIn, tokenOut);

        const calculatedAmount = this.vault.swap(
            {
                amountRaw: swapAmount.amount,
                tokenIn: tIn.token.address,
                tokenOut: tOut.token.address,
                swapKind: SwapKind.GivenIn,
            },
            this.poolState,
        );

        // Vault rate math preserves input decimal scale, so we need to scale the result
        // to the output token's decimals
        const isUnwrap = tIn.token.isSameAddress(this.tokens[0].token.address);
        const scaledAmount = isUnwrap
            ? this.toUnderlyingDecimals(calculatedAmount) // main→underlying
            : this.toMainDecimals(calculatedAmount); // underlying→main

        const outputAmount = TokenAmount.fromRawAmount(tOut.token, scaledAmount);

        if (mutateBalances) {
            this.mutateBufferState(isUnwrap, swapAmount, outputAmount);
        }

        return outputAmount;
    }

    public swapGivenOut(
        tokenIn: Token,
        tokenOut: Token,
        swapAmount: TokenAmount,
        mutateBalances?: boolean,
    ): TokenAmount {
        const { tIn, tOut } = this.getPoolTokens(tokenIn, tokenOut);

        const calculatedAmount = this.vault.swap(
            {
                amountRaw: swapAmount.amount,
                tokenIn: tIn.token.address,
                tokenOut: tOut.token.address,
                swapKind: SwapKind.GivenOut,
            },
            this.poolState,
        );

        // Vault rate math preserves input (amountOut) decimal scale, so we need to
        // scale the result to the input token's decimals
        const isUnwrap = tIn.token.isSameAddress(this.tokens[0].token.address);
        const scaledAmount = isUnwrap
            ? this.toMainDecimals(calculatedAmount) // underlyingDec→mainDec
            : this.toUnderlyingDecimals(calculatedAmount); // mainDec→underlyingDec

        const inputAmount = TokenAmount.fromRawAmount(tIn.token, scaledAmount);

        if (mutateBalances) {
            this.mutateBufferState(isUnwrap, inputAmount, swapAmount);
        }

        return inputAmount;
    }

    private mutateBufferState(isUnwrap: boolean, inputAmount: TokenAmount, outputAmount: TokenAmount): void {
        const mainTokenAmount = this.tokens[0];
        const underlyingTokenAmount = this.tokens[1];

        if (!isUnwrap) {
            // wrap: inputAmount is underlying, outputAmount is main
            const mainAsUnderlying = this.toUnderlyingDecimals(MathSol.mulDownFixed(mainTokenAmount.amount, this.rate));
            const rawWrapRequiredToRebalance =
                (mainAsUnderlying + underlyingTokenAmount.amount) / 2n - underlyingTokenAmount.amount;
            const wrapRequiredToRebalance = rawWrapRequiredToRebalance > 0n ? rawWrapRequiredToRebalance : 0n;

            if (wrapRequiredToRebalance > this.maxDeposit) {
                mainTokenAmount.amount =
                    mainTokenAmount.amount > outputAmount.amount ? mainTokenAmount.amount - outputAmount.amount : 0n;
                underlyingTokenAmount.amount = 0n;
                this.maxDeposit = 0n;
            } else {
                const availableLending = this.maxDeposit - wrapRequiredToRebalance;
                if (inputAmount.amount <= availableLending) {
                    this.maxDeposit -= inputAmount.amount;
                } else {
                    const excessUnderlying = inputAmount.amount - availableLending;
                    const excessMain = this.toMainDecimals(MathSol.divDownFixed(excessUnderlying, this.rate));
                    this.maxDeposit = 0n;
                    mainTokenAmount.amount =
                        mainTokenAmount.amount > excessMain ? mainTokenAmount.amount - excessMain : 0n;
                    underlyingTokenAmount.amount =
                        mainTokenAmount.amount > 0n
                            ? this.toUnderlyingDecimals(MathSol.mulDownFixed(mainTokenAmount.amount, this.rate))
                            : 0n;
                }
            }
        } else {
            // unwrap: inputAmount is main, outputAmount is underlying
            const underlyingAsMain = this.toMainDecimals(MathSol.divDownFixed(underlyingTokenAmount.amount, this.rate));
            const maxWithdrawAsMain = this.toMainDecimals(MathSol.divDownFixed(this.maxWithdraw, this.rate));
            const rawUnwrapRequiredToRebalance =
                (underlyingAsMain + mainTokenAmount.amount) / 2n - mainTokenAmount.amount;
            const unwrapRequiredToRebalance = rawUnwrapRequiredToRebalance > 0n ? rawUnwrapRequiredToRebalance : 0n;

            if (unwrapRequiredToRebalance > maxWithdrawAsMain) {
                underlyingTokenAmount.amount =
                    underlyingTokenAmount.amount > outputAmount.amount
                        ? underlyingTokenAmount.amount - outputAmount.amount
                        : 0n;
                mainTokenAmount.amount = 0n;
                this.maxWithdraw = 0n;
            } else {
                const mainAsUnderlying = this.toUnderlyingDecimals(
                    MathSol.mulDownFixed(mainTokenAmount.amount, this.rate),
                );
                const rawUnwrapRequiredUnderlying =
                    underlyingTokenAmount.amount - (underlyingTokenAmount.amount + mainAsUnderlying) / 2n;
                const unwrapRequiredUnderlying =
                    rawUnwrapRequiredUnderlying > 0n ? rawUnwrapRequiredUnderlying : 0n;
                const availableLending =
                    this.maxWithdraw > unwrapRequiredUnderlying ? this.maxWithdraw - unwrapRequiredUnderlying : 0n;
                if (outputAmount.amount <= availableLending) {
                    this.maxWithdraw -= outputAmount.amount;
                } else {
                    const excessUnderlying = outputAmount.amount - availableLending;
                    this.maxWithdraw = 0n;
                    underlyingTokenAmount.amount =
                        underlyingTokenAmount.amount > excessUnderlying
                            ? underlyingTokenAmount.amount - excessUnderlying
                            : 0n;
                    mainTokenAmount.amount =
                        underlyingTokenAmount.amount > 0n
                            ? this.toMainDecimals(MathSol.divDownFixed(underlyingTokenAmount.amount, this.rate))
                            : 0n;
                }
            }
        }
    }

    public getPoolState(): BufferState {
        return {
            poolType: 'Buffer',
            poolAddress: this.address,
            tokens: this.tokens.map((t) => t.token.address),
            rate: this.rate,
        };
    }

    // Helper methods

    public getPoolTokens(tokenIn: Token, tokenOut: Token): { tIn: BasePoolToken; tOut: BasePoolToken } {
        const tIn = this.tokenMap.get(tokenIn.address);
        const tOut = this.tokenMap.get(tokenOut.address);

        if (!tIn || !tOut) {
            throw new Error('Pool does not contain the tokens provided');
        }

        return { tIn, tOut };
    }

    public copy(): BufferPool {
        return new BufferPool(
            this.id,
            this.address,
            this.chainId,
            this.rate,
            this.tokens[0].copy(),
            this.tokens[1].copy(),
            this.maxDeposit,
            this.maxWithdraw,
        );
    }

    public swapGivenInGreaterThanBufferLimit(tokenIn: Token, tokenOut: Token, swapAmount: TokenAmount): boolean {
        const { tIn, tOut } = this.getPoolTokens(tokenIn, tokenOut);
        const mainTokenAmount = this.tokens[0];
        const underlyingTokenAmount = this.tokens[1];

        if (tIn.token.isSameAddress(underlyingTokenAmount.token.address)) {
            // wrap: swapAmount is in underlying decimals, so convert limit to underlying decimals
            const bufferWrapLimit = this.toUnderlyingDecimals(MathSol.mulDownFixed(mainTokenAmount.amount, this.rate));
            return swapAmount.amount > bufferWrapLimit;
        } else {
            // unwrap: swapAmount is in main decimals, so convert limit to main decimals
            const bufferUnwrapLimit = this.toMainDecimals(
                MathSol.divDownFixed(underlyingTokenAmount.amount, this.rate),
            );
            return swapAmount.amount > bufferUnwrapLimit;
        }
    }

    public swapGivenOutGreaterThanBufferLimit(tokenIn: Token, tokenOut: Token, swapAmount: TokenAmount): boolean {
        const { tIn, tOut } = this.getPoolTokens(tokenIn, tokenOut);
        const mainTokenAmount = this.tokens[0];
        const underlyingTokenAmount = this.tokens[1];

        if (tIn.token.isSameAddress(underlyingTokenAmount.token.address)) {
            const bufferWrapLimit = mainTokenAmount.amount;
            return swapAmount.amount > bufferWrapLimit;
        } else {
            const bufferUnwrapLimit = underlyingTokenAmount.amount;
            return swapAmount.amount > bufferUnwrapLimit;
        }
    }
}
