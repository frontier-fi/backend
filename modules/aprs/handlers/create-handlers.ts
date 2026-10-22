import { Chain } from '@prisma/client';
import { AprHandler } from '../types';
import * as handlers from '.';
import config from '../../../config';
import { chainToChainId } from '../../../config/chain-id-to-chain';

/**
 * Creates handler instances for a specific chain
 */
export function createHandlers(chain: Chain): AprHandler[] {
    const handlerList: AprHandler[] = [];

    // Default handlers for all of the chains
    handlerList.push(new handlers.SwapFeeAprHandler());
    handlerList.push(new handlers.MerklAprHandler());

    if (config[chain].aprHandlers.ybAprHandler) {
        handlerList.push(new handlers.YbTokensAprHandler());
    }

    if (config[chain].aprHandlers.morphoRewardsAprHandler) {
        handlerList.push(new handlers.MorphoRewardsAprHandler());
    }

    // Add Aave API handler if configured for this chain
    if (config[chain].aprHandlers.aaveRewardsAprHandler) {
        handlerList.push(new handlers.AaveApiAprHandler(chainToChainId[chain]));
    }

    return handlerList;
}
