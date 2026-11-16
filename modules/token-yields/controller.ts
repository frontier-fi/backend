import { Chain } from '@prisma/client';
import config from '../../config';
import { TokenYieldsService } from './service';
import { TokenYieldConfig } from './types';
import { logger } from '../common/logger';

const fetchAndStoreAllYields = async () => {
    const configs = Object.fromEntries(
        Object.keys(config)
            .map((chain) => [chain, config[chain].aprHandlers.ybAprHandler])
            .filter((c): c is [Chain, TokenYieldConfig] => !!c[1]),
    );

    const chains = Object.keys(configs) as Chain[];

    const s = new TokenYieldsService();

    for (const chain of chains) {
        try {
            await s.fetchAndStoreYields(configs[chain], chain);
        } catch (e: any) {
            logger.error('Failed to fetch and store token yields', { chain, err: e });
        }
    }
};

export const TokenYieldsController = () => ({
    fetchAndStoreAllYields,
});
