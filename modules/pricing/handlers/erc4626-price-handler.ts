import { PriceHandler, TokenPriceData, PriceItem } from '../types';
import _ from 'lodash';

export class ERC4626PriceHandler implements PriceHandler {
    public readonly exitIfFails = false;
    public readonly id = 'ERC4626PriceHandlerService';

    async calculatePricesForTokens(
        tokens: TokenPriceData[],
        allPrices?: Map<string, { price: number; updatedBy: string }>,
    ): Promise<PriceItem[]> {
        const acceptedTokens = this.getAcceptedTokens(tokens);

        if (acceptedTokens.length === 0) {
            return [];
        }

        const priceItems: PriceItem[] = [];

        // Group tokens by chain
        const tokensByChain = _.groupBy(acceptedTokens, 'chain');

        for (const chain in tokensByChain) {
            const erc4626TokensForChain = tokensByChain[chain];
            if (!erc4626TokensForChain.length) {
                continue;
            }

            for (const erc4626Token of erc4626TokensForChain) {
                const underlying = erc4626Token.underlyingTokenAddress;
                if (!underlying) {
                    // Missing underlying token address
                    continue;
                }

                const underlyingPrice =
                    allPrices?.get(underlying.toLowerCase())?.price ??
                    allPrices?.get(underlying)?.price ??
                    erc4626Token.underlyingTokenPrice;

                if (!underlyingPrice) {
                    // Missing underlying price, skip
                    continue;
                }

                try {
                    const unwrapRate = Number(erc4626Token.unwrapRate || '1');
                    const price = Number((unwrapRate * underlyingPrice).toFixed(10));

                    if (erc4626Token.currentPrice && price > 10 * erc4626Token.currentPrice) {
                        throw new Error(
                            `over 10x price spike. Current price ${erc4626Token.currentPrice}, unwrap rate ${erc4626Token.unwrapRate}, underlying price ${underlyingPrice}. New price ${price}`,
                        );
                    }

                    priceItems.push({
                        address: erc4626Token.address,
                        chain: erc4626Token.chain,
                        price,
                        updatedAt: new Date(),
                        updatedBy: this.id,
                    });
                } catch (e: any) {
                    console.error('ERC4626 price failed for', erc4626Token.address, chain, e.message);
                }
            }
        }

        return priceItems;
    }

    private getAcceptedTokens(tokens: TokenPriceData[]): TokenPriceData[] {
        return tokens.filter((token) => token.types.includes('ERC4626'));
    }
}
