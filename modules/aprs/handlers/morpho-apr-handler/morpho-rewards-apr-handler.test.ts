import { describe, expect, it, vi } from 'vitest';
import { MorphoRewardsAprHandler } from './morpho-rewards-apr-handler';
import { PoolAPRData } from '../../types';

vi.mock('./morpho-api-client', () => ({
    morphoApiClient: {
        morphoApr: async () => ({
            'BASE-0xvault': { rewardApy: 0.04, chain: 'BASE' },
            'MONAD-0xvault': { rewardApy: 0.1, chain: 'MONAD' },
        }),
    },
}));

const pool = (chain: string, tokens: { address: string; balanceUSD: number }[]) =>
    ({ id: `${chain}-pool`, chain, tokens }) as unknown as PoolAPRData;

describe('MorphoRewardsAprHandler', () => {
    it('matches vaults on the pool chain only, even when addresses collide across chains', async () => {
        const items = await new MorphoRewardsAprHandler().calculateAprForPools([
            pool('MONAD', [
                { address: '0xvault', balanceUSD: 50 },
                { address: '0xother', balanceUSD: 50 },
            ]),
            pool('MAINNET', [{ address: '0xvault', balanceUSD: 100 }]),
        ]);

        expect(items).toEqual([expect.objectContaining({ poolId: 'MONAD-pool', chain: 'MONAD', apr: 0.05 })]);
    });
});
