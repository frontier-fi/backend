import { Chain } from '@prisma/client';
import { PricingManager } from './pricing-manager';
import { PricingRepository } from './pricing-repository';
import { PriceHandler, PriceItem, TokenPriceData } from './types';
import { createCoingeckoHandler, createDownstreamHandlers } from './create-handlers';
import { eventsRepository } from '../repositories/events';
import { logger } from '../common/logger';

export class PricingService {
    private repository: PricingRepository;
    private coingeckoHandler: PriceHandler;
    private downstreamManager: PricingManager;
    private manager: PricingManager;

    constructor(chains: Chain[]) {
        this.repository = new PricingRepository(eventsRepository);
        this.coingeckoHandler = createCoingeckoHandler(chains);
        const downstreamHandlers = createDownstreamHandlers();
        this.downstreamManager = new PricingManager(downstreamHandlers);
        this.manager = new PricingManager([this.coingeckoHandler, ...downstreamHandlers]);
    }

    async updatePrices(
        chain: Chain,
        tokenAddresses?: string[],
        calculateOnly?: boolean,
    ): Promise<{
        updatedTokenAddresses: string[];
        priceItems: PriceItem[];
    }> {
        const tokens = await this.repository.getTokensForPricing(chain, tokenAddresses);

        if (tokens.length === 0) {
            return { updatedTokenAddresses: [], priceItems: [] };
        }

        const priceItems = await this.manager.calculatePricesForTokens(tokens);

        let updatedTokenAddresses: string[] = [];

        if (!calculateOnly && priceItems.length > 0) {
            updatedTokenAddresses = await this.repository.updatePrices(priceItems, tokens);
        }

        return {
            updatedTokenAddresses,
            priceItems,
        };
    }

    async updatePricesForChains(chains: Chain[]): Promise<void> {
        const tokensByChain = new Map<Chain, TokenPriceData[]>();
        const errors: Error[] = [];

        for (const chain of chains) {
            try {
                const tokens = await this.repository.getTokensForPricing(chain);
                if (tokens.length > 0) {
                    tokensByChain.set(chain, tokens);
                }
            } catch (error) {
                logger.error('Failed to load tokens for pricing', { chain, err: error });
                errors.push(error instanceof Error ? error : new Error(`Unknown error: ${error}`));
            }
        }

        const allTokens = Array.from(tokensByChain.values()).flat();
        if (allTokens.length > 0) {
            let coingeckoItems: PriceItem[] = [];
            try {
                coingeckoItems = await this.coingeckoHandler.calculatePricesForTokens(allTokens);
            } catch (error) {
                logger.error('Price handler failed', { handler: this.coingeckoHandler.id, err: error });
                if (this.coingeckoHandler.exitIfFails) {
                    throw error;
                }
            }

            const coingeckoItemsByChain = new Map<Chain, PriceItem[]>();
            for (const item of coingeckoItems) {
                const items = coingeckoItemsByChain.get(item.chain) ?? [];
                items.push(item);
                coingeckoItemsByChain.set(item.chain, items);
            }

            for (const [chain, chainTokens] of tokensByChain.entries()) {
                try {
                    const initialPriceItems = coingeckoItemsByChain.get(chain) ?? [];
                    const priceItems = await this.downstreamManager.calculatePricesForTokens(
                        chainTokens,
                        initialPriceItems,
                    );
                    if (priceItems.length > 0) {
                        await this.repository.updatePrices(priceItems, chainTokens);
                    }
                } catch (error) {
                    logger.error('Failed to update token prices for chain', { chain, err: error });
                    errors.push(error instanceof Error ? error : new Error(`Unknown error: ${error}`));
                }
            }
        }

        if (errors.length > 0) {
            throw new Error(errors.map((e) => e.message).join(', '));
        }
    }

    /**
     * Runs only downstream derived price handlers (ERC4626, BPT, swaps, fallback) against cached DB prices
     * so pool initialization can price new wrappers/BPTs immediately without spending CoinGecko credits.
     */
    async updateDerivedPrices(chain: Chain, tokenAddresses: string[]): Promise<string[]> {
        if (tokenAddresses.length === 0) {
            return [];
        }
        const tokens = await this.repository.getTokensForPricing(chain, tokenAddresses);
        if (tokens.length === 0) {
            return [];
        }
        const priceItems = await this.downstreamManager.calculatePricesForTokens(tokens);
        if (priceItems.length === 0) {
            return [];
        }
        return this.repository.updatePrices(priceItems, tokens);
    }

    async calculatePrices(
        chain: Chain,
        tokenAddresses?: string[],
    ): Promise<{
        updatedTokenAddresses: string[];
        priceItems: PriceItem[];
    }> {
        return this.updatePrices(chain, tokenAddresses, true);
    }
}
