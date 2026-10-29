import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chain } from '@prisma/client';

const {
    mockTokenCurrentPriceFindMany,
    mockTokenPriceFindMany,
    mockTokenPriceUpsert,
    mockTokenCurrentPriceUpsert,
    mockTokenDynamicDataUpsert,
    mockTokenFindMany,
    mockTokenUpsert,
    mockPoolFindMany,
    mockPoolUpsert,
    mockPoolDynamicDataFindMany,
    mockPoolDynamicDataUpdate,
    mockPoolDynamicDataUpsert,
    mockPoolDynamicDataAggregate,
    mockPoolAprItemFindMany,
    mockPoolTokenUpdate,
    mockPoolTokenUpsert,
    mockPoolExpandedTokensUpsert,
    mockPoolSnapshotGroupBy,
    mockUserWalletBalanceGroupBy,
    mockTransaction,
    mockMulticallViem,
    mockGetBlock,
    mockFetchPoolSyncData,
    mockFetchErc20Headers,
} = vi.hoisted(() => ({
    mockTokenCurrentPriceFindMany: vi.fn(),
    mockTokenPriceFindMany: vi.fn(),
    mockTokenPriceUpsert: vi.fn((args: unknown) => Promise.resolve(args)),
    mockTokenCurrentPriceUpsert: vi.fn((args: unknown) => Promise.resolve(args)),
    mockTokenDynamicDataUpsert: vi.fn((args: unknown) => Promise.resolve(args)),
    mockTokenFindMany: vi.fn(),
    mockTokenUpsert: vi.fn((args: unknown) => Promise.resolve(args)),
    mockPoolFindMany: vi.fn(),
    mockPoolUpsert: vi.fn((args: unknown) => Promise.resolve(args)),
    mockPoolDynamicDataFindMany: vi.fn(),
    mockPoolDynamicDataUpdate: vi.fn((args: unknown) => Promise.resolve(args)),
    mockPoolDynamicDataUpsert: vi.fn((args: unknown) => Promise.resolve(args)),
    mockPoolDynamicDataAggregate: vi.fn(),
    mockPoolAprItemFindMany: vi.fn(),
    mockPoolTokenUpdate: vi.fn((args: unknown) => Promise.resolve(args)),
    mockPoolTokenUpsert: vi.fn((args: unknown) => Promise.resolve(args)),
    mockPoolExpandedTokensUpsert: vi.fn((args: unknown) => Promise.resolve(args)),
    mockPoolSnapshotGroupBy: vi.fn(),
    mockUserWalletBalanceGroupBy: vi.fn(),
    mockTransaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    mockMulticallViem: vi.fn(),
    mockGetBlock: vi.fn(),
    mockFetchPoolSyncData: vi.fn(),
    mockFetchErc20Headers: vi.fn(),
}));

vi.mock('../../../prisma/prisma-client', () => ({
    prisma: {
        prismaTokenCurrentPrice: {
            findMany: mockTokenCurrentPriceFindMany,
            upsert: mockTokenCurrentPriceUpsert,
        },
        prismaTokenPrice: {
            findMany: mockTokenPriceFindMany,
            upsert: mockTokenPriceUpsert,
        },
        prismaTokenDynamicData: {
            upsert: mockTokenDynamicDataUpsert,
        },
        prismaToken: {
            findMany: mockTokenFindMany,
            upsert: mockTokenUpsert,
        },
        prismaPool: {
            findMany: mockPoolFindMany,
            upsert: mockPoolUpsert,
        },
        prismaPoolDynamicData: {
            findMany: mockPoolDynamicDataFindMany,
            update: mockPoolDynamicDataUpdate,
            upsert: mockPoolDynamicDataUpsert,
            aggregate: mockPoolDynamicDataAggregate,
        },
        prismaPoolAprItem: {
            findMany: mockPoolAprItemFindMany,
        },
        prismaPoolToken: {
            update: mockPoolTokenUpdate,
            upsert: mockPoolTokenUpsert,
        },
        prismaPoolExpandedTokens: {
            upsert: mockPoolExpandedTokensUpsert,
        },
        prismaPoolSnapshot: {
            groupBy: mockPoolSnapshotGroupBy,
        },
        prismaUserWalletBalance: {
            groupBy: mockUserWalletBalanceGroupBy,
        },
        $transaction: mockTransaction,
    },
}));

vi.mock('../../web3/multicaller-viem', () => ({
    multicallViem: mockMulticallViem,
}));

vi.mock('../../block-numbers', () => ({
    blockNumbers: () => ({
        getBlock: mockGetBlock,
    }),
}));

vi.mock('../../sources/contracts/v3/fetch-pool-sync-data', () => ({
    fetchPoolSyncData: mockFetchPoolSyncData,
}));

vi.mock('../../sources/contracts/fetch-erc20-headers', () => ({
    fetchErc20Headers: mockFetchErc20Headers,
}));

vi.mock('../../../prisma/prisma-util', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../prisma/prisma-util')>();
    return {
        ...actual,
        prismaBulkExecuteOperations: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };
});

import { updateLiquidity24hAgo, updateLiquidityValuesForPools } from './update-liquidity';
import { updateVolumeAndFees } from './update-volume-and-fees';
import { updateLifetimeValues } from './update-liftetime-values';
import { addPools } from './v3/add-pools';
import { ProtocolService } from '../../protocol/protocol.service';
import { PricingRepository } from '../../pricing/pricing-repository';
import { swapsUsd } from '../../sources/enrichers/swaps-usd';
import { joinExitsUsd } from '../../sources/enrichers/join-exits-usd';
import { PoolType } from '../../sources/subgraphs/pools/generated/types';

describe('updateLiquidityValuesForPools', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('updates balanceUSD and totalLiquidity when transitioning from 0 to a sub-$1 positive value and back to 0', async () => {
        const tokenAddress = '0xde46e43f46ff74a23a65ebb0580cbe3dfe684a17';
        mockTokenCurrentPriceFindMany.mockResolvedValue([
            {
                tokenAddress,
                chain: Chain.SEPOLIA,
                price: 1.05,
            },
        ]);
        mockPoolDynamicDataFindMany.mockResolvedValue([
            {
                id: '0xpool1',
                poolId: '0xpool1',
                chain: Chain.SEPOLIA,
                totalLiquidity: 0,
                pool: {
                    id: '0xpool1',
                    name: 'Test Pool',
                    address: '0xpool1',
                    chain: Chain.SEPOLIA,
                    tokens: [
                        {
                            id: '0xpool1-0xde46',
                            address: tokenAddress,
                            balance: '0.2',
                            balanceUSD: 0,
                        },
                    ],
                },
            },
        ]);

        await updateLiquidityValuesForPools(Chain.SEPOLIA, ['0xpool1']);

        expect(mockPoolTokenUpdate).toHaveBeenCalledWith({
            where: { id_chain: { id: '0xpool1-0xde46', chain: Chain.SEPOLIA } },
            data: { balanceUSD: expect.closeTo(0.21, 5) },
        });
        expect(mockPoolDynamicDataUpdate).toHaveBeenCalledWith({
            where: { id_chain: { id: '0xpool1', chain: Chain.SEPOLIA } },
            data: { totalLiquidity: expect.closeTo(0.21, 5) },
        });

        vi.clearAllMocks();
        mockTokenCurrentPriceFindMany.mockResolvedValue([{ tokenAddress, chain: Chain.SEPOLIA, price: 1.05 }]);
        mockPoolDynamicDataFindMany.mockResolvedValue([
            {
                id: '0xpool1',
                poolId: '0xpool1',
                chain: Chain.SEPOLIA,
                totalLiquidity: 0.21,
                pool: {
                    id: '0xpool1',
                    name: 'Test Pool',
                    address: '0xpool1',
                    chain: Chain.SEPOLIA,
                    tokens: [
                        {
                            id: '0xpool1-0xde46',
                            address: tokenAddress,
                            balance: '0',
                            balanceUSD: 0.21,
                        },
                    ],
                },
            },
        ]);

        await updateLiquidityValuesForPools(Chain.SEPOLIA, ['0xpool1']);
        expect(mockPoolTokenUpdate).toHaveBeenCalledWith({
            where: { id_chain: { id: '0xpool1-0xde46', chain: Chain.SEPOLIA } },
            data: { balanceUSD: 0 },
        });
        expect(mockPoolDynamicDataUpdate).toHaveBeenCalledWith({
            where: { id_chain: { id: '0xpool1', chain: Chain.SEPOLIA } },
            data: { totalLiquidity: 0 },
        });
    });

    it('falls back to PrismaTokenCurrentPrice in updateLiquidity24hAgo when exact hourly PrismaTokenPrice row is missing', async () => {
        const tokenAddress = '0xde46e43f46ff74a23a65ebb0580cbe3dfe684a17';
        mockGetBlock.mockResolvedValue(123456);
        mockMulticallViem.mockResolvedValue({
            '0xpool1': {
                poolTokens: new Map([[tokenAddress, 200000000000000000n]]), // 0.2 tokens (18 decimals)
            },
        });
        mockTokenPriceFindMany.mockResolvedValue([]); // missing historical hourly price
        mockTokenCurrentPriceFindMany.mockResolvedValue([{ tokenAddress, chain: Chain.SEPOLIA, price: 1.5 }]);
        mockTokenFindMany.mockResolvedValue([{ address: tokenAddress, decimals: 18 }]);

        const updated = await updateLiquidity24hAgo(['0xpool1'], Chain.SEPOLIA, {} as any);

        expect(updated).toEqual(['0xpool1']);
        expect(mockPoolDynamicDataUpdate).toHaveBeenCalledWith({
            where: { poolId_chain: { poolId: '0xpool1', chain: Chain.SEPOLIA } },
            data: {
                totalLiquidity24hAgo: expect.closeTo(0.3, 5),
                totalShares24hAgo: '0',
            },
        });
    });
});

describe('updateVolumeAndFees, updateLifetimeValues, ProtocolService, and USD enrichers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns early from updateVolumeAndFees without DB queries when poolIds is empty', async () => {
        const getSwapStats = vi.fn();
        await updateVolumeAndFees(Chain.SEPOLIA, [], { getSwapStats });

        expect(mockPoolFindMany).not.toHaveBeenCalled();
        expect(getSwapStats).not.toHaveBeenCalled();
    });

    it('updates sub-$1 fees and volume transitions in updateVolumeAndFees', async () => {
        mockPoolFindMany.mockResolvedValue([{ id: '0xpool1', chain: Chain.SEPOLIA, protocolVersion: 3 }]);
        mockPoolDynamicDataFindMany.mockResolvedValue([
            {
                id: '0xpool1',
                poolId: '0xpool1',
                chain: Chain.SEPOLIA,
                volume24h: 0,
                fees24h: 0,
                surplus24h: 0,
                volume48h: 0,
                fees48h: 0,
                surplus48h: 0,
                protocolFees24h: 0,
                protocolFees48h: 0,
                yieldCapture24h: 0,
                yieldCapture48h: 0,
                protocolYieldCapture24h: 0,
                protocolYieldCapture48h: 0,
                protocolYieldFee: '0',
                protocolSwapFee: '0',
                isInRecoveryMode: false,
                totalLiquidity: 100,
                totalLiquidity24hAgo: 100,
            },
        ]);
        mockPoolAprItemFindMany.mockResolvedValue([]);
        const getSwapStats = vi
            .fn()
            .mockResolvedValueOnce([{ poolId: '0xpool1', volume: 0.5, fees: 0.005, surplus: 0 }])
            .mockResolvedValueOnce([{ poolId: '0xpool1', volume: 0.5, fees: 0.005, surplus: 0 }]);

        await updateVolumeAndFees(Chain.SEPOLIA, ['0xpool1'], { getSwapStats });

        expect(mockPoolDynamicDataUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id_chain: { id: '0xpool1', chain: Chain.SEPOLIA } },
                data: expect.objectContaining({
                    volume24h: 0.5,
                    fees24h: 0.005,
                }),
            }),
        );

        // Also updates when sub-$1 volume/fees age out and drop back to 0
        mockPoolDynamicDataUpdate.mockClear();
        mockPoolFindMany.mockResolvedValue([{ id: '0xpool1', chain: Chain.SEPOLIA, protocolVersion: 3 }]);
        mockPoolDynamicDataFindMany.mockResolvedValue([
            {
                id: '0xpool1',
                poolId: '0xpool1',
                chain: Chain.SEPOLIA,
                volume24h: 0.5,
                fees24h: 0.005,
                surplus24h: 0,
                volume48h: 0.5,
                fees48h: 0.005,
                surplus48h: 0,
                protocolFees24h: 0,
                protocolFees48h: 0,
                yieldCapture24h: 0,
                yieldCapture48h: 0,
                protocolYieldCapture24h: 0,
                protocolYieldCapture48h: 0,
                protocolYieldFee: '0',
                protocolSwapFee: '0',
                isInRecoveryMode: false,
                totalLiquidity: 100,
                totalLiquidity24hAgo: 100,
            },
        ]);
        mockPoolAprItemFindMany.mockResolvedValue([]);
        getSwapStats.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

        await updateVolumeAndFees(Chain.SEPOLIA, ['0xpool1'], { getSwapStats });

        expect(mockPoolDynamicDataUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id_chain: { id: '0xpool1', chain: Chain.SEPOLIA } },
                data: expect.objectContaining({
                    volume24h: 0,
                    fees24h: 0,
                }),
            }),
        );
    });

    it('aggregates swapsCount alongside lifetimeSwapFees and lifetimeVolume in updateLifetimeValues and ProtocolService', async () => {
        mockUserWalletBalanceGroupBy.mockResolvedValue([
            { poolId: '0xpool1', chain: Chain.SEPOLIA, _count: { userAddress: 2 } },
        ]);
        mockPoolSnapshotGroupBy.mockResolvedValue([
            {
                poolId: '0xpool1',
                chain: Chain.SEPOLIA,
                _sum: { fees24h: 0.02, volume24h: 3.05, swapsCount: 3 },
            },
        ]);

        await updateLifetimeValues(Chain.SEPOLIA);

        expect(mockPoolDynamicDataUpdate).toHaveBeenCalledWith({
            where: { poolId_chain: { poolId: '0xpool1', chain: Chain.SEPOLIA } },
            data: {
                holdersCount: 2,
                lifetimeSwapFees: 0.02,
                lifetimeVolume: 3.05,
                swapsCount: 3,
            },
        });

        mockPoolFindMany.mockResolvedValue([{ id: '0xpool1', chain: Chain.SEPOLIA }]);
        mockPoolDynamicDataFindMany.mockResolvedValue([
            {
                id: '0xpool1',
                totalLiquidity: 100,
                lifetimeSwapFees: 0.02,
                lifetimeVolume: 3.05,
                volume24h: 1.0,
                fees24h: 0.005,
                yieldCapture24h: 0,
                surplus24h: 0,
                protocolFees24h: 0,
                protocolYieldCapture24h: 0,
            },
        ]);
        mockPoolDynamicDataAggregate.mockResolvedValue({ _sum: { holdersCount: 2 } });

        const metrics = await new ProtocolService().cacheProtocolMetrics(Chain.SEPOLIA);
        expect(metrics.totalSwapFee).toBe('0.02');
        expect(metrics.totalSwapVolume).toBe('3.05');
    });

    it('aligns PrismaTokenPrice timestamps to roundToHour(now) in PricingRepository.updatePrices and falls back to PrismaTokenCurrentPrice in swapsUsd/joinExitsUsd', async () => {
        const repo = new PricingRepository({ getSwapsForPricing: vi.fn().mockResolvedValue([]) });
        await repo.updatePrices(
            [
                {
                    address: '0xtoken1',
                    chain: Chain.SEPOLIA,
                    price: 2500,
                    updatedAt: new Date('2026-10-29T09:00:00Z'),
                    updatedBy: 'CoingeckoPriceHandlerService',
                },
            ],
            [],
        );

        const expectedFloorHour = Math.floor(Math.floor(Date.now() / 1000) / 3600) * 3600;
        expect(mockTokenPriceUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    tokenAddress_timestamp_chain: {
                        tokenAddress: '0xtoken1',
                        timestamp: expectedFloorHour,
                        chain: Chain.SEPOLIA,
                    },
                },
            }),
        );

        // When PrismaTokenPrice is empty for the event hour, swapsUsd and joinExitsUsd fall back to PrismaTokenCurrentPrice
        mockTokenPriceFindMany.mockResolvedValue([]);
        mockTokenCurrentPriceFindMany.mockResolvedValue([
            { tokenAddress: '0xtoken1', chain: Chain.SEPOLIA, price: 2.5 },
        ]);

        const enrichedSwaps = await swapsUsd(
            [
                {
                    id: 'swap-1',
                    tx: '0xtx',
                    type: 'SWAP',
                    chain: Chain.SEPOLIA,
                    poolId: '0xpool1',
                    userAddress: '0xuser',
                    blockNumber: 100,
                    blockTimestamp: Math.floor(Date.now() / 1000),
                    logIndex: 0,
                    valueUSD: 0,
                    payload: {
                        fee: { address: '0xtoken1', amount: '0.1', valueUSD: '0' },
                        tokenIn: { address: '0xtoken1', amount: '2' },
                        tokenOut: { address: '0xtoken2', amount: '5' },
                    },
                } as any,
            ],
            Chain.SEPOLIA,
        );
        expect(enrichedSwaps[0].valueUSD).toBe(5);
        expect(enrichedSwaps[0].payload.fee.valueUSD).toBe('0.25');

        const enrichedJoins = await joinExitsUsd(
            [
                {
                    id: 'join-1',
                    tx: '0xtx',
                    type: 'JOIN',
                    chain: Chain.SEPOLIA,
                    poolId: '0xpool1',
                    userAddress: '0xuser',
                    blockNumber: 100,
                    blockTimestamp: Math.floor(Date.now() / 1000),
                    logIndex: 0,
                    valueUSD: 0,
                    payload: {
                        tokens: [{ address: '0xtoken1', amount: '4', valueUSD: 0 }],
                    },
                } as any,
            ],
            Chain.SEPOLIA,
        );
        expect(enrichedJoins[0].valueUSD).toBe(10);
    });

    it('backfills empty subgraph token headers via fetchErc20Headers and preserves existing ERC20 metadata in addPools', async () => {
        const poolAddress = '0x0000000000000000000000000000000000000011';
        const tokenAddress = '0x0000000000000000000000000000000000000022';

        mockFetchPoolSyncData.mockResolvedValue({
            [poolAddress]: {},
        });
        mockFetchErc20Headers.mockResolvedValue({
            [tokenAddress]: {
                name: 'Onchain Token Name',
                symbol: 'OTN',
                decimals: 18,
            },
        });
        mockTokenCurrentPriceFindMany.mockResolvedValue([]);

        await addPools(
            [
                {
                    id: poolAddress,
                    name: 'Test Pool',
                    symbol: 'BPT-TEST',
                    swapFee: '0.003',
                    totalShares: '100',
                    isPaused: false,
                    isInRecoveryMode: false,
                    blockTimestamp: '1700000000',
                    swapFeeManager: '0x0000000000000000000000000000000000000000',
                    pauseManager: '0x0000000000000000000000000000000000000000',
                    poolCreator: '0x0000000000000000000000000000000000000000',
                    factory: {
                        id: '0x0000000000000000000000000000000000000033',
                        type: PoolType.Weighted,
                        version: 1,
                    },
                    weightedParams: { weights: ['1'] },
                    rateProviders: [{ address: '0x0000000000000000000000000000000000000000' }],
                    tokens: [
                        {
                            address: tokenAddress,
                            name: '',
                            symbol: '',
                            decimals: 18,
                            index: 0,
                            balance: '10',
                            paysYieldFees: false,
                            scalingFactor: '1',
                            nestedPool: null,
                        },
                    ],
                } as any,
            ],
            {} as any,
            '0x00000000000000000000000000000000000000ff',
            Chain.SEPOLIA,
            123456,
        );

        expect(mockFetchErc20Headers).toHaveBeenCalledWith([tokenAddress], expect.anything());
        // Underlying ERC20 token uses update: {} so curated metadata is not overwritten, while create uses backfilled headers
        expect(mockTokenUpsert).toHaveBeenCalledWith({
            where: { address_chain: { address: tokenAddress, chain: Chain.SEPOLIA } },
            create: {
                address: tokenAddress,
                name: 'Onchain Token Name',
                symbol: 'OTN',
                decimals: 18,
                chain: Chain.SEPOLIA,
            },
            update: {},
        });
        // BPT token itself uses update: token
        expect(mockTokenUpsert).toHaveBeenCalledWith({
            where: { address_chain: { address: poolAddress, chain: Chain.SEPOLIA } },
            create: {
                address: poolAddress,
                name: 'Test Pool',
                symbol: 'BPT-TEST',
                decimals: 18,
                chain: Chain.SEPOLIA,
            },
            update: {
                address: poolAddress,
                name: 'Test Pool',
                symbol: 'BPT-TEST',
                decimals: 18,
                chain: Chain.SEPOLIA,
            },
        });
    });
});
