import { GqlChain, GqlHistoricalTokenPrice, Resolvers } from '../generated-schema';
import _ from 'lodash';
import { isAdminRoute } from '../../../../modules/auth/auth-context';
import { tokenService } from '../../../../modules/token/token.service';
import moment from 'moment';
import { TokenController } from '../../../../modules/controllers/token-controller';
import { PricingService } from '../../../../modules/pricing';
import { ContentController } from '../../../../modules/content/content-controller';

const resolvers: Resolvers = {
    Query: {
        tokenGetTokens: async (_parent, args, context) => {
            return tokenService.getTokenDefinitions(args);
        },
        tokenGetCurrentPrices: async (_parent, { chains }, context) => {
            const prices = await tokenService.getCurrentTokenPrices(chains);

            return prices.map((price) => ({
                address: price.tokenAddress,
                price: price.price,
                chain: price.chain,
                updatedAt: moment(price.updatedAt).unix(),
                updatedBy: price.updatedBy,
            }));
        },
        tokenGetHistoricalPrices: async (_parent, { addresses, chain, range }, context) => {
            const data = await tokenService.getTokenPricesForRange(addresses, range, chain);

            const grouped = _.groupBy(data, 'tokenAddress');

            const result: GqlHistoricalTokenPrice[] = [];
            for (const address in grouped) {
                result.push({
                    address: address,
                    chain: grouped[address][0].chain,
                    prices: grouped[address].map((entry) => ({
                        timestamp: `${entry.timestamp}`,
                        price: entry.price,
                        updatedAt: moment(entry.updatedAt).unix(),
                        updatedBy: entry.updatedBy,
                    })),
                });
            }
            return result;
        },
        tokenGetTokenDynamicData: async (_parent, { address, chain }, context) => {
            const data = await tokenService.getTokenDynamicData(address, chain);

            return data
                ? {
                      ...data,
                      id: data.coingeckoId,
                      fdv: data.fdv ? `${data.fdv}` : null,
                      marketCap: data.marketCap ? `${data.marketCap}` : null,
                      updatedAt: data.updatedAt.toUTCString(),
                  }
                : null;
        },
        tokenGetTokensDynamicData: async (_parent, { addresses, chain }, context) => {
            const items = await tokenService.getTokensDynamicData(addresses, chain);

            return items.map((item) => ({
                ...item,
                id: item.coingeckoId,
                fdv: item.fdv ? `${item.fdv}` : null,
                marketCap: item.marketCap ? `${item.marketCap}` : null,
                updatedAt: item.updatedAt.toUTCString(),
            }));
        },
        tokenGetRelativePriceChartData: async (_parent, { tokenIn, tokenOut, range, chain }, context) => {
            const data = await tokenService.getRelativeDataForRange(tokenIn, tokenOut, range, chain);

            return data.map((item) => ({
                id: `${tokenIn}-${tokenOut}-${item.timestamp}`,
                timestamp: item.timestamp,
                price: `${item.price}`,
            }));
        },
    },
    Mutation: {
        tokenReloadTokenPrices: async (_parent, { chains }, context) => {
            isAdminRoute(context);

            const service = new PricingService(chains);
            for (const chain of chains) {
                await service.updatePrices(chain);
            }

            return true;
        },
        tokenSyncTokenDefinitions: async (_parent, {}, context) => {
            isAdminRoute(context);

            await ContentController().syncTokenContentData();

            return 'success';
        },
        tokenDeleteTokenType: async (_parent, args, context) => {
            isAdminRoute(context);

            await tokenService.deleteTokenType(args, args.chain);

            return 'success';
        },
        tokenReloadAllTokenTypes: async (_parent, { chain }, context) => {
            isAdminRoute(context);

            await ContentController().reloadAllTokenTypes(chain);

            return 'success';
        },
        tokenReloadErc4626Tokens: async (_parent, { chains }, context) => {
            isAdminRoute(context);

            const result: { type: string; chain: GqlChain; success: boolean; error: string | undefined }[] = [];

            for (const chain of chains) {
                try {
                    await TokenController().syncErc4626Tokens(chain);
                    result.push({ type: 'v3', chain, success: true, error: undefined });
                } catch (e) {
                    result.push({ type: 'v3', chain, success: false, error: `${e}` });
                    console.log(`Could not reload v3 pools for chain ${chain}: ${e}`);
                }
            }

            return result;
        },
    },
};

export default resolvers;
