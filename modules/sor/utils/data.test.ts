import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBasePoolsFromDb, getBufferPoolsFromDBPools, SORDbPool } from './data';
import { prisma } from '../../../prisma/prisma-client';
import { tokenService } from '../../token/token.service';

afterEach(() => vi.restoreAllMocks());

describe('routing safety', () => {
    it('rechecks provider verdicts even when candidate pools are cached', async () => {
        const wrapped = '0x0000000000000000000000000000000000000462';
        const underlying = '0x0000000000000000000000000000000000000a01';
        const provider = '0x0000000000000000000000000000000000000099';
        const pool = {
            id: 'safety-pool',
            address: 'safety-pool',
            protocolVersion: 3,
            hook: null,
            tokens: [
                {
                    address: wrapped,
                    priceRateProvider: provider,
                    token: {
                        address: wrapped,
                        decimals: 6,
                        underlyingTokenAddress: underlying,
                        isBufferAllowed: true,
                        bufferBalanceWrapped: '1000',
                        bufferBalanceUnderlying: '1000',
                        unwrapRate: '1',
                        maxDeposit: '1000',
                        maxWithdraw: '1000',
                    },
                },
            ],
        };
        const poolQuery = vi.spyOn(prisma.prismaPool, 'findMany').mockResolvedValue([pool] as any);
        vi.spyOn(prisma.prismaToken, 'findMany').mockResolvedValue([]);
        const providers = vi
            .spyOn(prisma.prismaPriceRateProviderData, 'findMany')
            .mockResolvedValue([{ rateProviderAddress: provider }] as any);
        vi.spyOn(tokenService, 'getTokens').mockResolvedValue([{ address: underlying, decimals: 6 }] as any);
        vi.spyOn(tokenService, 'getErc4626Data').mockResolvedValue({
            [wrapped]: {
                chain: 'SEPOLIA',
                erc4626Address: wrapped,
                assetAddress: underlying,
                canUseBufferForSwaps: true,
            },
        } as any);
        const load = () => getBasePoolsFromDb('SEPOLIA', 3, true, ['safety-pool']);
        expect((await load()).bufferPools).toHaveLength(1);
        expect(providers).toHaveBeenCalledWith(
            expect.objectContaining({ where: { chain: 'SEPOLIA', reviewed: true, summary: 'safe' } }),
        );
        providers.mockResolvedValue([]);
        expect((await load()).pools).toHaveLength(0);
        expect(poolQuery).toHaveBeenCalledTimes(1);
    });
});

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

        pools.forEach((pool) => {
            pool.tokens[0].token.isBufferAllowed = false;
        });
        expect(await getBufferPoolsFromDBPools(pools, 'SEPOLIA')).toEqual([]);

        vi.restoreAllMocks();
    });
});
