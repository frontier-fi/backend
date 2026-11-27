import { Chain } from '@prisma/client';
import { TokenYieldRepository } from './repository';
import { TokenYieldAprHandlers } from './handlers';
import { TokenYieldConfig, TokenApr } from './types';
import { logger } from '../common/logger';
import { twentyFourHoursInMs } from '../common/time';

export const STALE_TOKEN_YIELD_TTL_MS = twentyFourHoursInMs;

export class TokenYieldsService {
    constructor(private tokenYieldRepository = new TokenYieldRepository()) {}

    /**
     * Fetch yields from external sources and store them in the database
     */
    async fetchAndStoreYields(aprConfig: TokenYieldConfig, chain: Chain): Promise<void> {
        const tokenYieldAprHandlers = new TokenYieldAprHandlers(aprConfig, chain);

        try {
            // Fetch APRs/yield from all handlers
            const tokenAprs = await tokenYieldAprHandlers.fetchAprsFromAllHandlers();

            if (tokenAprs.length === 0) {
                return;
            }

            const validTokenAprs = tokenAprs.filter((t) => Number.isFinite(t.apr));
            const invalidAprs = tokenAprs.filter((t) => !Number.isFinite(t.apr));
            for (const invalidApr of invalidAprs) {
                logger.warn('Skipped non-finite token yield APR', {
                    chain,
                    tokenAddress: invalidApr.address,
                    apr: String(invalidApr.apr),
                });
            }

            if (validTokenAprs.length === 0) {
                return;
            }

            // Group by source (we'll need to track which handler provided which data)
            // For now, we'll store all as 'yb-handlers' source
            await this.tokenYieldRepository.storeTokenYields(chain, validTokenAprs);

            const staleBefore = new Date(Date.now() - STALE_TOKEN_YIELD_TTL_MS);
            const deletedCount = await this.tokenYieldRepository.deleteStaleTokenYields(chain, staleBefore);
            if (deletedCount > 0) {
                logger.info('Pruned stale token yields', { chain, deletedCount });
            }
        } catch (error) {
            throw new Error(
                `Failed to fetch and store yields for chain ${chain}: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
    }

    /**
     * Get stored token yields from database
     */
    async getTokenYields(chain: Chain): Promise<Map<string, TokenApr>> {
        const tokens = await this.tokenYieldRepository.getTokenYields(chain);

        return new Map<string, TokenApr>(
            tokens.filter((token) => !isNaN(token.apr)).map((token) => [token.address, token]),
        );
    }
}
