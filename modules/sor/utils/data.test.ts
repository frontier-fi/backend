import { describe, expect, it, vi } from 'vitest';
import { getBufferPoolsFromDBPools, SORDbPool } from './data';
import { tokenService } from '../../token/token.service';

describe('getBufferPoolsFromDBPools', () => {
    it('deduplicates buffer pools when multiple v3 pools share the same ERC4626 token', async () => {
        const wrappedAddress = '0x0000000000000000000000000000000000000462';
        const underlyingAddress = '0x0000000000000000000000000000000000000a01';

        vi.spyOn(tokenService, 'getErc4626Data').mockResolvedValue({
            [wrappedAddress]: {
                chain: 'SEPOLIA',
                erc4626Address: wrappedAddress,
                assetAddress: underlyingAddress,
                canUseBufferForSwaps: true,
                useUnderlyingForAddRemove: true,
                useWrappedForAddRemove: true,
                summary: 'safe',
                warnings: [],
            } as any,
        });

        vi.spyOn(tokenService, 'getTokens').mockResolvedValue([
            {
                address: underlyingAddress,
                chain: 'SEPOLIA',
                decimals: 6,
                symbol: 'USDC',
                name: 'USD Coin',
            } as any,
        ]);

        const makePool = (id: string): SORDbPool =>
            ({
                id,
                address: id,
                chain: 'SEPOLIA',
                protocolVersion: 3,
                tokens: [
                    {
                        address: wrappedAddress,
                        token: {
                            address: wrappedAddress,
                            decimals: 6,
                            underlyingTokenAddress: underlyingAddress,
                            bufferBalanceWrapped: '1000',
                            bufferBalanceUnderlying: '1000',
                            unwrapRate: '1',
                            maxWithdraw: '5000',
                            maxDeposit: '5000',
                        },
                    },
                ],
            }) as unknown as SORDbPool;

        const pools = [
            makePool('0x0000000000000000000000000000000000000001'),
            makePool('0x0000000000000000000000000000000000000002'),
        ];

        const bufferPools = await getBufferPoolsFromDBPools(pools, 'SEPOLIA');

        expect(bufferPools).toHaveLength(1);
        expect(bufferPools[0].address).toBe(wrappedAddress);
        expect(bufferPools[0].underlyingToken.address).toBe(underlyingAddress);

        vi.restoreAllMocks();
    });
});
