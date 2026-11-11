import { Address, Hex } from 'viem';
import { MAX_UINT256, SwapKind, Token, TokenAmount } from '@balancer/sdk';
import { BufferState, Vault } from '@balancer-labs/balancer-maths';

import config from '../../../../../config';
import { chainIdToChain } from '../../../../../config/chain-id-to-chain';
import { BasePoolMethodsV3 } from '../basePoolMethodsV3';
import { BasePoolToken } from '../../utils/basePoolToken';
import { BufferPoolData } from '../../../utils/data';
import { MathSol } from '../../utils';

export const DEFAULT_MINIMUM_WRAP_AMOUNT = 10_000n;

function resolveVaultParams(chainId: number) {
    const chain = chainIdToChain[String(chainId)];
    return chain ? config[chain]?.vaultParams : undefined;
}

export class BufferPool implements BasePoolMethodsV3 {
    public readonly chainId: number;
    public readonly id: Hex;
    public readonly address: Address;
    public readonly poolType = 'Buffer';
    public readonly swapFee = 0n;
    public readonly rate: bigint;
    public readonly tokens: BasePoolToken[];
    public readonly minWrapAmount: bigint;
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
            bufferPoolData.minWrapAmount,
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
        minWrapAmount?: bigint,
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

        const vaultParams = resolveVaultParams(chainId);
        this.minWrapAmount = minWrapAmount ?? vaultParams?.minWrapAmount ?? DEFAULT_MINIMUM_WRAP_AMOUNT;

        this.vault = new Vault({
            ...(vaultParams ?? {}),
            minWrapAmount: this.minWrapAmount,
        } as any);
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
        const { tIn } = this.getPoolTokens(tokenIn, tokenOut);

        const mainTokenAmount = this.tokens[0];
        const underlyingTokenAmount = this.tokens[1];

        if (swapKind === SwapKind.GivenIn) {
            if (underlyingTokenAmount.token.isSameAddress(tIn.token.address)) {
                // wrap - respective to amount in (underlying):
                // In Balancer v3 Vault, a buffer step either fulfills 100% from the internal Vault buffer
                // (`mainAsUnderlying`, without calling ERC4626) or bypasses the buffer and deposits directly
                // into the external ERC4626 vault (`maxDeposit`).
                const bufferWrapLimit = this.toUnderlyingDecimals(
                    MathSol.mulDownFixed(mainTokenAmount.amount, this.rate),
                );
                const externalWrapLimit = this.maxDeposit;
                return bufferWrapLimit > externalWrapLimit ? bufferWrapLimit : externalWrapLimit;
            } else {
                // unwrap - respective to amount in (main):
                // Either fulfilled 100% from internal underlying buffer balance (`underlyingAsMain`) or redeemed
                // directly from the external ERC4626 vault (`maxWithdrawAsMain`).
                const bufferUnwrapLimit = this.toMainDecimals(
                    MathSol.divDownFixed(underlyingTokenAmount.amount, this.rate),
                );
                const externalUnwrapLimit = this.toMainDecimals(MathSol.divDownFixed(this.maxWithdraw, this.rate));
                return bufferUnwrapLimit > externalUnwrapLimit ? bufferUnwrapLimit : externalUnwrapLimit;
            }
        } else {
            if (underlyingTokenAmount.token.isSameAddress(tIn.token.address)) {
                // wrap - respective to amount out (main)
                const bufferWrapLimit = mainTokenAmount.amount;
                const externalWrapLimit = this.toMainDecimals(MathSol.divDownFixed(this.maxDeposit, this.rate));
                return bufferWrapLimit > externalWrapLimit ? bufferWrapLimit : externalWrapLimit;
            } else {
                // unwrap - respective to amount out (underlying)
                const bufferUnwrapLimit = underlyingTokenAmount.amount;
                const externalUnwrapLimit = this.maxWithdraw;
                return bufferUnwrapLimit > externalUnwrapLimit ? bufferUnwrapLimit : externalUnwrapLimit;
            }
        }
    }

    public swapGivenIn(
        tokenIn: Token,
        tokenOut: Token,
        swapAmount: TokenAmount,
        mutateBalances?: boolean,
        skipMinWrapCheck = false,
    ): TokenAmount {
        const { tIn, tOut } = this.getPoolTokens(tokenIn, tokenOut);
        if (swapAmount.amount === 0n) {
            return TokenAmount.fromRawAmount(tOut.token, 0n);
        }

        if (!skipMinWrapCheck && swapAmount.amount < this.minWrapAmount) {
            throw new Error('wrapAmountTooSmall');
        }

        const isUnwrap = tIn.token.isSameAddress(this.tokens[0].token.address);
        const calculatedAmount = skipMinWrapCheck
            ? isUnwrap
                ? MathSol.mulDownFixed(swapAmount.amount, this.rate)
                : MathSol.divDownFixed(swapAmount.amount, this.rate)
            : this.vault.swap(
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
        const scaledAmount = isUnwrap
            ? this.toUnderlyingDecimals(calculatedAmount) // main→underlying
            : this.toMainDecimals(calculatedAmount); // underlying→main

        if (!skipMinWrapCheck && scaledAmount < this.minWrapAmount) {
            throw new Error('wrapAmountTooSmall');
        }

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
        skipMinWrapCheck = false,
    ): TokenAmount {
        const { tIn, tOut } = this.getPoolTokens(tokenIn, tokenOut);
        if (swapAmount.amount === 0n) {
            return TokenAmount.fromRawAmount(tIn.token, 0n);
        }

        if (!skipMinWrapCheck && swapAmount.amount < this.minWrapAmount) {
            throw new Error('wrapAmountTooSmall');
        }

        const isUnwrap = tIn.token.isSameAddress(this.tokens[0].token.address);
        const calculatedAmount = skipMinWrapCheck
            ? isUnwrap
                ? MathSol.divUpFixed(swapAmount.amount, this.rate)
                : MathSol.mulUpFixed(swapAmount.amount, this.rate)
            : this.vault.swap(
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
        const scaledAmount = isUnwrap
            ? this.toMainDecimals(calculatedAmount) // underlyingDec→mainDec
            : this.toUnderlyingDecimals(calculatedAmount); // mainDec→underlyingDec

        if (!skipMinWrapCheck && scaledAmount < this.minWrapAmount) {
            throw new Error('wrapAmountTooSmall');
        }

        const inputAmount = TokenAmount.fromRawAmount(tIn.token, scaledAmount);

        if (mutateBalances) {
            this.mutateBufferState(isUnwrap, inputAmount, swapAmount);
        }

        return inputAmount;
    }

    private mutateBufferState(isUnwrap: boolean, inputAmount: TokenAmount, outputAmount: TokenAmount): void {
        const mainTokenAmount = this.tokens[0];
        const underlyingTokenAmount = this.tokens[1];
        const mainAsUnderlying = this.toUnderlyingDecimals(MathSol.mulDownFixed(mainTokenAmount.amount, this.rate));

        if (!isUnwrap) {
            // wrap: inputAmount is underlying, outputAmount is main
            if (outputAmount.amount <= mainTokenAmount.amount && inputAmount.amount <= mainAsUnderlying) {
                // Fulfilled 100% from internal Vault buffer without calling ERC4626
                mainTokenAmount.amount -= outputAmount.amount;
                underlyingTokenAmount.amount += inputAmount.amount;
            } else {
                // Bypassed internal buffer and deposited directly into external ERC4626
                this.maxDeposit = this.maxDeposit > inputAmount.amount ? this.maxDeposit - inputAmount.amount : 0n;
            }
        } else {
            // unwrap: inputAmount is main, outputAmount is underlying
            const underlyingAsMain = this.toMainDecimals(MathSol.divDownFixed(underlyingTokenAmount.amount, this.rate));
            if (outputAmount.amount <= underlyingTokenAmount.amount && inputAmount.amount <= underlyingAsMain) {
                // Fulfilled 100% from internal Vault buffer without calling ERC4626
                underlyingTokenAmount.amount -= outputAmount.amount;
                mainTokenAmount.amount += inputAmount.amount;
            } else {
                // Bypassed internal buffer and redeemed directly from external ERC4626
                this.maxWithdraw = this.maxWithdraw > outputAmount.amount ? this.maxWithdraw - outputAmount.amount : 0n;
            }
        }
    }

    public getPoolState(): BufferState {
        return {
            poolType: 'Buffer',
            poolAddress: this.address,
            tokens: this.tokens.map((t) => t.token.address),
            rate: this.rate,
            mainDecimals: this.tokens[0].token.decimals,
            underlyingDecimals: this.tokens[1].token.decimals,
        } as BufferState;
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
            this.minWrapAmount,
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
