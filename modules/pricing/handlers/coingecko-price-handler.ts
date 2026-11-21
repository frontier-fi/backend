import { Chain } from '@prisma/client';
import { PriceHandler, TokenPriceData, PriceItem } from '../types';
import { coingeckoDataService, normalizeCoingeckoLogoUri } from '../../token/lib/coingecko-data.service';
import _ from 'lodash';

interface CoingeckoConfig {
    excludedTokenAddresses: { address: string; chain: Chain }[];
    useCache?: boolean;
    cacheOnly?: boolean;
}

export class CoingeckoPriceHandler implements PriceHandler {
    public readonly exitIfFails = false;
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
            const ids = chunk.map((item) => item.coingeckoTokenId || '');
            const response =
                this.config.useCache || this.config.cacheOnly
                    ? await coingeckoDataService.getMarketDataForTokenIds(ids, {
                          useCache: this.config.useCache,
                          cacheOnly: this.config.cacheOnly,
                      })
                    : await coingeckoDataService.getMarketDataForTokenIds(ids);

            for (const item of response) {
                const tokensToUpdate = acceptedTokens.filter((token) => token.coingeckoTokenId === item.id);
                const logoURI = normalizeCoingeckoLogoUri(item.image);

                for (const tokenToUpdate of tokensToUpdate) {
                    if (item.current_price) {
                        priceItems.push({
                            address: tokenToUpdate.address,
                            chain: tokenToUpdate.chain,
                            price: Number(item.current_price),
                            updatedAt: new Date(item.last_updated),
                            updatedBy: this.id,
                            ...(logoURI && !tokenToUpdate.logoURI ? { logoURI } : {}),
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
                    (excluded) =>
                        excluded.address.toLowerCase() === token.address.toLowerCase() &&
                        excluded.chain === token.chain,
                ) &&
                !token.excludedFromCoingecko &&
                token.coingeckoTokenId,
        );
    }
}
