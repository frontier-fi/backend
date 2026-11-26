import { afterEach, describe, expect, it, vi } from 'vitest';
import { tokenService } from '../../../../modules/token/token.service';
import resolvers from './token.resolvers';
import * as authContext from '../../../../modules/auth/auth-context';
import * as pricingModule from '../../../../modules/pricing';
import * as contentControllerModule from '../../../../modules/content/content-controller';
import * as tokenControllerModule from '../../../../modules/controllers/token-controller';

describe('token mutation cache invalidation', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('invalidates token caches after admin token mutations', async () => {
        vi.spyOn(authContext, 'isAdminRoute').mockImplementation(() => {});
        const invalidateSpy = vi.spyOn(tokenService, 'invalidateTokenCaches');
        const deleteSpy = vi.spyOn(tokenService, 'deleteTokenType').mockImplementation(async () => {
            tokenService.invalidateTokenCaches();
        });
        const updatePricesForChains = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(pricingModule, 'PricingService').mockImplementation(function () {
            return { updatePricesForChains } as any;
        } as any);
        const syncTokenContentData = vi.fn().mockResolvedValue(undefined);
        const reloadAllTokenTypes = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(contentControllerModule, 'ContentController').mockReturnValue({
            syncTokenContentData,
            reloadAllTokenTypes,
        } as any);
        const syncErc4626Tokens = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(tokenControllerModule, 'TokenController').mockReturnValue({
            syncErc4626Tokens,
        } as any);

        const ctx = { adminApiKey: 'test' } as any;

        await (resolvers.Mutation!.tokenReloadTokenPrices as any)({}, { chains: ['SEPOLIA'] }, ctx);
        await (resolvers.Mutation!.tokenSyncTokenDefinitions as any)({}, {}, ctx);
        await (resolvers.Mutation!.tokenDeleteTokenType as any)(
            {},
            { tokenAddress: '0x1', type: 'WHITE_LISTED', chain: 'SEPOLIA' },
            ctx,
        );
        await (resolvers.Mutation!.tokenReloadAllTokenTypes as any)({}, { chain: 'SEPOLIA' }, ctx);
        await (resolvers.Mutation!.tokenReloadErc4626Tokens as any)({}, { chains: ['SEPOLIA'] }, ctx);

        expect(deleteSpy).toHaveBeenCalledTimes(1);
        expect(invalidateSpy).toHaveBeenCalledTimes(5);
    });
});
