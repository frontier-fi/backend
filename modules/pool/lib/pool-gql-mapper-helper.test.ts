import { Chain, PrismaPoolAprType } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { enrichWithErc4626Data, mapAprItems, mapPoolToken } from './pool-gql-mapper-helper';
import { PrismaPoolMinimal, PrismaPoolTokenWithExpandedNesting } from '../../../prisma/prisma-types';
import { prisma } from '../../../prisma/prisma-client';

const apr = (type: PrismaPoolAprType | null, value = 0.1) => ({
    id: `apr-${type ?? 'null'}`,
    chain: Chain.SEPOLIA,
    poolId: 'pool',
    title: String(type),
    apr: value,
    type,
    rewardTokenAddress: null,
    rewardTokenSymbol: null,
    createdAt: new Date(),
    updatedAt: new Date(),
});

describe('mapAprItems', () => {
    it('skips null types and native rewards, and passes calculated types through', () => {
        const items = mapAprItems({
            aprItems: [
                apr(null),
                apr(PrismaPoolAprType.NATIVE_REWARD),
                apr(PrismaPoolAprType.SWAP_FEE_24H, 0.2),
                apr(PrismaPoolAprType.MERKL, 0.3),
                apr(PrismaPoolAprType.IB_YIELD, 0.4),
            ],
        } as Pick<PrismaPoolMinimal, 'aprItems'>);

        expect(items.map((item) => item.type)).toEqual(['SWAP_FEE_24H', 'MERKL', 'IB_YIELD']);
        expect(items.map((item) => item.apr)).toEqual([0.2, 0.3, 0.4]);
    });
});

describe('mapPoolToken', () => {
    const token = (types: string[]) =>
        ({
            id: 'pool-token',
            poolId: 'pool',
            chain: Chain.SEPOLIA,
            index: 0,
            balance: '1',
            balanceUSD: 1,
            weight: null,
            priceRate: '1',
            priceRateProvider: null,
            exemptFromProtocolYieldFee: false,
            scalingFactor: '1',
            nestedPool: null,
            token: {
                address: '0xtoken',
                name: 'Token',
                symbol: 'T',
                decimals: 18,
                chain: Chain.SEPOLIA,
                maxDeposit: '0',
                maxWithdraw: '0',
                types: types.map((type) => ({ type })),
            },
        }) as unknown as PrismaPoolTokenWithExpandedNesting;

    it('marks blocked tokens as not allowed, BPT as not tradable, and ERC4626 tokens', () => {
        const blocked = mapPoolToken(token(['BLOCKED_V3']), 3);
        const bpt = mapPoolToken(token(['BPT']), 3);
        const erc4626 = mapPoolToken(token(['ERC4626']), 3);

        expect(blocked.isAllowed).toBe(false);
        expect(bpt.tradable).toBe(false);
        expect(erc4626.isErc4626).toBe(true);
        expect(erc4626.isAllowed).toBe(true);
        expect(erc4626.tradable).toBe(true);
    });

    it('maps useUnderlyingForAddRemove and useWrappedForAddRemove independently in enrichWithErc4626Data', async () => {
        vi.spyOn(prisma.prismaToken, 'findUnique').mockResolvedValue(null);
        vi.spyOn(prisma.prismaErc4626ReviewData, 'findUnique').mockResolvedValue({
            chain: Chain.SEPOLIA,
            erc4626Address: '0xtoken',
            assetAddress: '0xasset',
            useUnderlyingForAddRemove: true,
            useWrappedForAddRemove: false,
            canUseBufferForSwaps: true,
            warnings: 'warn1,warn2',
        } as any);

        const erc4626Token = mapPoolToken(token(['ERC4626']), 3);
        await enrichWithErc4626Data([erc4626Token], Chain.SEPOLIA);

        expect(erc4626Token.useUnderlyingForAddRemove).toBe(true);
        expect(erc4626Token.useWrappedForAddRemove).toBe(false);
        expect(erc4626Token.canUseBufferForSwaps).toBe(true);

        vi.restoreAllMocks();
    });
});
