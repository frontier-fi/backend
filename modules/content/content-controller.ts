import { Chain } from '@prisma/client';
import config from '../../config';
import { CoingeckoDataService } from '../token/lib/coingecko-data.service';
import { syncBlockedBuffers } from './lib/sync-erc4626-blocked-buffers';
import { syncErc4626Reviews } from './lib/sync-erc4626-reviews';
import { syncRateProviderReviews } from './lib/sync-rate-provider-reviews';
import { syncTags } from './lib/sync-tags';
import { syncTokenContentData } from './lib/sync-token-data';
import { prisma } from '../../prisma/prisma-client';
import { getFeaturedPools } from './lib/get-featured-pools';
import { syncErc4626Tokens } from '../actions/token/sync-erc4626-tokens';
import { getViemClient } from '../sources/viem-client';

export function ContentController() {
    return {
        async syncRateProviderReviews() {
            return syncRateProviderReviews();
        },
        async syncErc4626Data() {
            await syncBlockedBuffers();
            return syncErc4626Reviews();
        },
        async syncCategories() {
            await syncTags();
            return 'OK';
        },
        async syncTokenContentData() {
            const chains = Object.keys(config) as Chain[];

            //sync coingecko Ids first, then override Ids from the content service
            await new CoingeckoDataService().syncCoingeckoIds();
            await syncTokenContentData(chains);
        },
        async reloadAllTokenTypes(chain: Chain) {
            await prisma.prismaTokenType.deleteMany({
                where: { chain },
            });

            await syncTokenContentData([chain]);
            await syncErc4626Tokens(getViemClient(chain), chain);
        },
        async getFeaturedPools(chains: Chain[]) {
            return getFeaturedPools(chains);
        },
    };
}
