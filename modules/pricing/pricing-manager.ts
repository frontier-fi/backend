import { PriceHandler, PriceItem, TokenPriceData } from './types';
import { logger } from '../common/logger';

export class PricingManager {
    constructor(private readonly handlers: PriceHandler[]) {}

    async calculatePricesForTokens(
        tokens: TokenPriceData[],
        initialPriceItems: PriceItem[] = [],
    ): Promise<PriceItem[]> {
        if (tokens.length === 0) {
            return [];
        }

        // Build initial price map from tokens' currentPrice
        const allPrices = new Map<string, { price: number; updatedBy: string }>();
        tokens.forEach((token) => {
            if (typeof token.currentPrice === 'number' && Number.isFinite(token.currentPrice)) {
                allPrices.set(token.address, {
                    price: token.currentPrice,
                    updatedBy: token.pricedBy || '',
                });
            }
        });

        const allPriceItems: PriceItem[] = [...initialPriceItems];
        initialPriceItems.forEach((item) => {
            allPrices.set(item.address, { price: item.price, updatedBy: item.updatedBy });
        });

        const initiallyPricedAddresses = new Set(initialPriceItems.map((item) => item.address));
        let remainingTokens = tokens.filter((token) => !initiallyPricedAddresses.has(token.address));

        for (const handler of this.handlers) {
            if (remainingTokens.length === 0) {
                break;
            }

            try {
                const priceItems = await handler.calculatePricesForTokens(remainingTokens, allPrices);
                allPriceItems.push(...priceItems);

                // Update allPrices map with new prices from this handler
                priceItems.forEach((item) => {
                    allPrices.set(item.address, { price: item.price, updatedBy: item.updatedBy });
                });

                // Remove successfully priced tokens from remaining tokens
                const pricedAddresses = new Set(priceItems.map((item) => item.address));
                remainingTokens = remainingTokens.filter((token) => !pricedAddresses.has(token.address));
            } catch (error) {
                logger.error('Price handler failed', { handler: handler.id, err: error });

                if (handler.exitIfFails) {
                    throw error;
                }
            }
        }

        return allPriceItems;
    }
}
