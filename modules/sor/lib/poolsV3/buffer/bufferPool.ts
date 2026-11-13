import { Address, Hex, maxUint256 } from 'viem';
import {
    BufferState,
    DEFAULT_MINIMUM_WRAP_AMOUNT,
    MathSol,
    SwapKind,
    Token,
    TokenAmount,
    WAD,
} from '@frontier-fi/maths';

import config from '../../../../../config';
import { chainIdToChain } from '../../../../../config/chain-id-to-chain';
import { BasePoolMethodsV3 } from '../basePoolMethodsV3';
import { BasePoolToken } from '../../utils/basePoolToken';
import { BufferPoolData } from '../../../utils/data';

export { DEFAULT_MINIMUM_WRAP_AMOUNT };

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
    private readonly rateNumerator: bigint;
    private readonly rateDenominator: bigint;

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
        const decimalDiff = mainToken.token.decimals - underlyingToken.token.decimals;
        this.rateNumerator = rate * 10n ** BigInt(Math.max(-decimalDiff, 0));
        this.rateDenominator = WAD * 10n ** BigInt(Math.max(decimalDiff, 0));

        const vaultParams = resolveVaultParams(chainId);
        this.minWrapAmount = minWrapAmount ?? vaultParams?.minWrapAmount ?? DEFAULT_MINIMUM_WRAP_AMOUNT;
    }

    private toUnderlying(amount: bigint, roundUp = false): bigint {
        const numerator = amount * this.rateNumerator;
        return roundUp ? MathSol.divUp(numerator, this.rateDenominator) : numerator / this.rateDenominator;
    }

    private toMain(amount: bigint, roundUp = false): bigint {
        const numerator = amount * this.rateDenominator;
        return roundUp ? MathSol.divUp(numerator, this.rateNumerator) : numerator / this.rateNumerator;
    }

    private getUnderlyingImbalance(): bigint {
        return (this.tokens[1].amount - this.toUnderlying(this.tokens[0].amount, true)) / 2n;
    }

    private getMainImbalance(): bigint {
        return (this.tokens[0].amount - this.toMain(this.tokens[1].amount, true)) / 2n;
    }

    public getNormalizedLiquidity(tokenIn: Token, tokenOut: Token): bigint {
        return maxUint256;
    }

    public getLimitAmountSwap(tokenIn: Token, tokenOut: Token, swapKind: SwapKind): bigint {
        const { tIn } = this.getPoolTokens(tokenIn, tokenOut);

        const mainTokenAmount = this.tokens[0];
        const underlyingTokenAmount = this.tokens[1];
        const isWrap = underlyingTokenAmount.token.isSameAddress(tIn.token.address);

        let bufferLimit: bigint;
        let externalLimit: bigint;
        if (swapKind === SwapKind.GivenIn) {
            if (isWrap) {
                bufferLimit = this.toUnderlying(mainTokenAmount.amount + 1n, true) - 1n;
                externalLimit = this.maxDeposit > 0n ? this.maxDeposit - this.getUnderlyingImbalance() : 0n;
            } else {
                bufferLimit = this.toMain(underlyingTokenAmount.amount + 1n, true) - 1n;
                externalLimit = this.maxWithdraw > 0n ? this.toMain(this.maxWithdraw) - this.getMainImbalance() : 0n;
            }
        } else {
            if (isWrap) {
                bufferLimit = mainTokenAmount.amount;
                externalLimit = this.maxDeposit > 0n ? this.toMain(this.maxDeposit) + this.getMainImbalance() : 0n;
            } else {
                bufferLimit = underlyingTokenAmount.amount;
                externalLimit = this.maxWithdraw > 0n ? this.maxWithdraw + this.getUnderlyingImbalance() : 0n;
            }
        }

        return MathSol.min(MathSol.max(bufferLimit, externalLimit), maxUint256);
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

        const isUnwrap = tIn.token.isSameAddress(this.tokens[0].token.address);
        const calculatedAmount = isUnwrap ? this.toUnderlying(swapAmount.amount) : this.toMain(swapAmount.amount);
        if (!skipMinWrapCheck && (swapAmount.amount < this.minWrapAmount || calculatedAmount < this.minWrapAmount)) {
            throw new Error('wrapAmountTooSmall');
        }
        const outputAmount = TokenAmount.fromRawAmount(tOut.token, calculatedAmount);

        if (mutateBalances) {
            this.mutateBufferState(isUnwrap, SwapKind.GivenIn, swapAmount, outputAmount);
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

        const isUnwrap = tIn.token.isSameAddress(this.tokens[0].token.address);
        const calculatedAmount = isUnwrap
            ? this.toMain(swapAmount.amount, true)
            : this.toUnderlying(swapAmount.amount, true);
        if (!skipMinWrapCheck && (swapAmount.amount < this.minWrapAmount || calculatedAmount < this.minWrapAmount)) {
            throw new Error('wrapAmountTooSmall');
        }
        const inputAmount = TokenAmount.fromRawAmount(tIn.token, calculatedAmount);

        if (mutateBalances) {
            this.mutateBufferState(isUnwrap, SwapKind.GivenOut, inputAmount, swapAmount);
        }

        return inputAmount;
    }

    private mutateBufferState(
        isUnwrap: boolean,
        swapKind: SwapKind,
        inputAmount: TokenAmount,
        outputAmount: TokenAmount,
    ): void {
        const mainTokenAmount = this.tokens[0];
        const underlyingTokenAmount = this.tokens[1];

        if (!isUnwrap) {
            // wrap: inputAmount is underlying, outputAmount is main
            if (outputAmount.amount <= mainTokenAmount.amount) {
                // Fulfilled 100% from internal Vault buffer without calling ERC4626
                mainTokenAmount.amount -= outputAmount.amount;
                underlyingTokenAmount.amount += inputAmount.amount;
            } else {
                let deposit: bigint;
                let minted: bigint;
                if (swapKind === SwapKind.GivenIn) {
                    deposit = inputAmount.amount + this.getUnderlyingImbalance();
                    minted = this.toMain(deposit);
                } else {
                    minted = outputAmount.amount - this.getMainImbalance();
                    deposit = this.toUnderlying(minted, true);
                }
                if (deposit < 0n || deposit > this.maxDeposit) {
                    throw new Error('Buffer deposit capacity exceeded');
                }
                if (this.maxDeposit < maxUint256) {
                    this.maxDeposit -= deposit;
                }
                underlyingTokenAmount.amount += inputAmount.amount - deposit;
                mainTokenAmount.amount += minted - outputAmount.amount;
            }
        } else {
            // unwrap: inputAmount is main, outputAmount is underlying
            if (outputAmount.amount <= underlyingTokenAmount.amount) {
                // Fulfilled 100% from internal Vault buffer without calling ERC4626
                underlyingTokenAmount.amount -= outputAmount.amount;
                mainTokenAmount.amount += inputAmount.amount;
            } else {
                let withdrawal: bigint;
                let burned: bigint;
                if (swapKind === SwapKind.GivenIn) {
                    burned = inputAmount.amount + this.getMainImbalance();
                    withdrawal = this.toUnderlying(burned);
                } else {
                    withdrawal = outputAmount.amount - this.getUnderlyingImbalance();
                    burned = this.toMain(withdrawal, true);
                }
                if (withdrawal < 0n || withdrawal > this.maxWithdraw) {
                    throw new Error('Buffer withdrawal capacity exceeded');
                }
                if (this.maxWithdraw < maxUint256) {
                    this.maxWithdraw -= withdrawal;
                }
                underlyingTokenAmount.amount += withdrawal - outputAmount.amount;
                mainTokenAmount.amount += inputAmount.amount - burned;
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
            this.minWrapAmount,
        );
    }

    public swapGivenInGreaterThanBufferLimit(tokenIn: Token, tokenOut: Token, swapAmount: TokenAmount): boolean {
        const { tIn, tOut } = this.getPoolTokens(tokenIn, tokenOut);
        const isUnwrap = tIn.token.isSameAddress(this.tokens[0].token.address);
        const outputAmount = isUnwrap ? this.toUnderlying(swapAmount.amount) : this.toMain(swapAmount.amount);
        return outputAmount > tOut.amount;
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
