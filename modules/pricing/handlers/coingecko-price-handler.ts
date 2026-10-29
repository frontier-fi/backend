import { Chain } from '@prisma/client';
import { PriceHandler, TokenPriceData, PriceItem } from '../types';
import { coingeckoDataService } from '../../token/lib/coingecko-data.service';
import _ from 'lodash';

interface CoingeckoConfig {
    excludedTokenAddresses: { address: string; chain: Chain }[];
}

export class CoingeckoPriceHandler implements PriceHandler {
    public readonly exitIfFails = true;
    public readonly id = 'CoingeckoPriceHandlerService';

    constructor(private readonly config: CoingeckoConfig) {}

    async calculatePricesForTokens(tokens: TokenPriceData[]): Promise<PriceItem[]> {
        const acceptedTokens = this.getAcceptedTokens(tokens);

        if (acceptedTokens.length === 0) {
            return [];
        }

        const priceItems: PriceItem[] = [];
        const uniqueTokensWithIds = _.uniqBy(acceptedTokens, 'coingeckoTokenId');
        const chunks = _.chunk(uniqueTokensWithIds, 250); // max page size is 250

        for (const chunk of chunks) {
            const response = await coingeckoDataService.getMarketDataForTokenIds(
                chunk.map((item) => item.coingeckoTokenId || ''),
            );

            for (const item of response) {
                const tokensToUpdate = acceptedTokens.filter((token) => token.coingeckoTokenId === item.id);

                for (const tokenToUpdate of tokensToUpdate) {
                    if (item.current_price) {
                        const price = Number(item.current_price);
                        priceItems.push({
                            address: tokenToUpdate.address,
                            chain: tokenToUpdate.chain,
                            price,
                            updatedAt: new Date(item.last_updated),
                            updatedBy: this.id,
                            dynamicData: {
                                coingeckoId: item.id,
                                ath: item.ath || 0,
                                atl: item.atl || 0,
                                marketCap: item.market_cap ?? null,
                                fdv: item.fully_diluted_valuation ?? null,
                                high24h: item.high_24h || price,
                                low24h: item.low_24h || price,
                                priceChange24h: item.price_change_24h || 0,
                                priceChangePercent24h: item.price_change_percentage_24h || 0,
                                priceChangePercent7d: item.price_change_percentage_7d_in_currency ?? null,
                                priceChangePercent14d: item.price_change_percentage_14d_in_currency ?? null,
                                priceChangePercent30d: item.price_change_percentage_30d_in_currency ?? null,
                            },
                        });
                    }
                }
            }
        }

        return priceItems;
    }

    private getAcceptedTokens(tokens: TokenPriceData[]): TokenPriceData[] {
        return tokens.filter(
            (token) =>
                !this.config.excludedTokenAddresses.find(
                    (excluded) => excluded.address === token.address && excluded.chain === token.chain,
                ) &&
                !token.excludedFromCoingecko &&
                token.coingeckoTokenId,
        );
    }
}
