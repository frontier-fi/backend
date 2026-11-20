import { Chain } from '@prisma/client';
import { PriceHandler } from './types';
import {
    ERC4626PriceHandler,
    CoingeckoPriceHandler,
    SwapsPriceHandler,
    BptPriceHandler,
    FallbackPriceHandler,
} from './handlers';
import { prisma } from '../../prisma/prisma-client';
import config from '../../config';

export function createCoingeckoHandler(
    chains: Chain[],
    options?: { useCache?: boolean; cacheOnly?: boolean },
): PriceHandler {
    return new CoingeckoPriceHandler({ ...getCoingeckoConfigForChains(chains), ...options });
}

export function createDownstreamHandlers(): PriceHandler[] {
    return [
        new ERC4626PriceHandler(),
        new BptPriceHandler({
            prismaPool: prisma.prismaPool,
        }),
        new SwapsPriceHandler(),
        new FallbackPriceHandler(),
    ];
}

export function createPoolInitDownstreamHandlers(): PriceHandler[] {
    return [
        new ERC4626PriceHandler(),
        new BptPriceHandler({
            prismaPool: prisma.prismaPool,
        }),
        new SwapsPriceHandler(),
    ];
}

export function createHandlers(chains: Chain[]): PriceHandler[] {
    return [createCoingeckoHandler(chains), ...createDownstreamHandlers()];
}

function getCoingeckoConfigForChains(chains: Chain[]) {
    const excludedTokenAddresses: { address: string; chain: Chain }[] = [];

    for (const chain of chains) {
        const chainConfig = Object.values(config).find((c) => c.chain.prismaId === chain);
        if (chainConfig) {
            chainConfig.coingecko.excludedTokenAddresses.forEach((address) =>
                excludedTokenAddresses.push({ address, chain }),
            );
        }
    }

    return { excludedTokenAddresses };
}
