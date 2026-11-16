import { Chain } from '@prisma/client';
import { TokenYieldRepository } from './repository';
import { TokenYieldAprHandlers } from './handlers';
import { TokenYieldConfig, TokenApr } from './types';

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
                console.warn(`Invalid APR for token ${invalidApr.address} on chain ${chain}: ${invalidApr.apr}`);
            }

            // Group by source (we'll need to track which handler provided which data)
            // For now, we'll store all as 'yb-handlers' source
            await this.tokenYieldRepository.storeTokenYields(chain, validTokenAprs);
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
