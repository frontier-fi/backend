import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chain } from '@prisma/client';

const { mockPoolFindMany, mockPoolUpdate, mockAprItemFindMany, mockTransaction } = vi.hoisted(() => ({
    mockPoolFindMany: vi.fn(),
    mockPoolUpdate: vi.fn((args: unknown) => args),
    mockAprItemFindMany: vi.fn(),
    mockTransaction: vi.fn(),
}));

vi.mock('../../../prisma/prisma-client', () => ({
    prisma: {
        prismaPool: {
            findMany: mockPoolFindMany,
            update: mockPoolUpdate,
        },
        prismaPoolAprItem: {
            findMany: mockAprItemFindMany,
        },
        $transaction: mockTransaction,
    },
}));

import { syncTags } from './sync-tags';

describe('syncTags', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockAprItemFindMany.mockResolvedValue([]);
        mockPoolFindMany.mockResolvedValue([]);
        mockTransaction.mockResolvedValue([]);
    });

    it('skips unconfigured chainIds instead of querying prismaPool with chain: undefined', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (url.includes('pools/tags')) {
                    return {
                        ok: true,
                        json: async () => [
                            {
                                id: 'test_tag',
                                pools: [],
                                tokens: {
                                    '1': ['0x1111111111111111111111111111111111111111'],
                                    '11155111': ['0x2222222222222222222222222222222222222222'],
                                },
                            },
                        ],
                    };
                }
                if (url.includes('erc4626')) {
                    return {
                        ok: true,
                        json: async () => [
                            {
                                id: 'erc4626_aave',
                                addresses: {
                                    '1': ['0x3333333333333333333333333333333333333333'],
                                    '11155111': ['0xde46e43f46ff74a23a65ebb0580cbe3dfe684a17'],
                                },
                            },
                        ],
                    };
                }
                return {
                    ok: true,
                    json: async () => [
                        {
                            id: 'hooks_stablesurge',
                            addresses: {
                                '1': ['0x4444444444444444444444444444444444444444'],
                                '11155111': ['0x5555555555555555555555555555555555555555'],
                            },
                        },
                    ],
                };
            }),
        );

        await syncTags();

        const findManyCallsWithChain = mockPoolFindMany.mock.calls
            .map(([arg]) => arg?.where)
            .filter((where) => where && 'chain' in where);

        expect(findManyCallsWithChain).toHaveLength(2);
        for (const where of findManyCallsWithChain) {
            expect(where.chain).toBe(Chain.SEPOLIA);
        }
    });
});
