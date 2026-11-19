import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chain, Prisma } from '@prisma/client';

const {
    mockUserCreateMany,
    mockWalletBalanceUpsert,
    mockWalletBalanceDeleteMany,
    mockLastBlockSyncedUpsert,
    mockExecuteRaw,
    mockTransaction,
    mockGetLastSyncedBlock,
    mockGetBlockNumber,
    mockGetEvents,
    mockMulticallViem,
} = vi.hoisted(() => {
    const mockUserCreateMany = vi.fn((args: unknown) => Promise.resolve({ op: 'user.createMany', args }));
    const mockWalletBalanceUpsert = vi.fn((args: unknown) => Promise.resolve({ op: 'walletBalance.upsert', args }));
    const mockWalletBalanceDeleteMany = vi.fn((args: unknown) =>
        Promise.resolve({ op: 'walletBalance.deleteMany', args }),
    );
    const mockLastBlockSyncedUpsert = vi.fn((args: unknown) => Promise.resolve({ op: 'lastBlockSynced.upsert', args }));
    const mockExecuteRaw = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
        Promise.resolve({ op: 'executeRaw', sql: strings.join('?'), values }),
    );

    return {
        mockUserCreateMany,
        mockWalletBalanceUpsert,
        mockWalletBalanceDeleteMany,
        mockLastBlockSyncedUpsert,
        mockExecuteRaw,
        mockTransaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
        mockGetLastSyncedBlock: vi.fn(),
        mockGetBlockNumber: vi.fn(),
        mockGetEvents: vi.fn(),
        mockMulticallViem: vi.fn(),
    };
});

vi.mock('../../../../../prisma/prisma-client', () => ({
    prisma: {
        prismaUser: { createMany: mockUserCreateMany },
        prismaUserWalletBalance: {
            upsert: mockWalletBalanceUpsert,
            deleteMany: mockWalletBalanceDeleteMany,
        },
        prismaLastBlockSynced: { upsert: mockLastBlockSyncedUpsert },
        $executeRaw: mockExecuteRaw,
        $transaction: mockTransaction,
    },
}));

vi.mock('../../../../actions/last-synced-block', () => ({
    getLastSyncedBlock: mockGetLastSyncedBlock,
}));

vi.mock('../../../../sources/viem-client', () => ({
    getViemClient: () => ({
        getBlockNumber: mockGetBlockNumber,
    }),
}));

vi.mock('../../../../web3/events', () => ({
    getEvents: mockGetEvents,
}));

vi.mock('../../../../web3/multicaller-viem', () => ({
    multicallViem: mockMulticallViem,
}));

import { balancesToDb } from './balances-to-db';
import { syncBptBalancesFromSubgraph } from './sync-bpt-balances-from-subgraph';
import { syncBptBalancesFromRpc } from './sync-bpt-balances-from-rpc';

describe('balancesToDb & syncBptBalancesFromSubgraph', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('atomically recomputes holdersCount inside the transaction after balance upserts and deletes', async () => {
        const balances = [
            {
                id: '0xpool1-0xuser1',
                poolId: '0xpool1',
                chain: Chain.BASE,
                tokenAddress: '0xpool1',
                userAddress: '0xuser1',
                balance: '10',
                balanceNum: 10,
            },
            {
                id: '0xpool1-0xuser2',
                poolId: '0xpool1',
                chain: Chain.BASE,
                tokenAddress: '0xpool1',
                userAddress: '0xuser2',
                balance: '0',
                balanceNum: 0,
            },
            {
                id: '0xpool2-0xuser1',
                poolId: '0xpool2',
                chain: Chain.BASE,
                tokenAddress: '0xpool2',
                userAddress: '0xuser1',
                balance: '5',
                balanceNum: 5,
            },
        ];

        const operations = balancesToDb(balances, Chain.BASE, 1000, 'BPT_BALANCES_V3');
        const results = (await Promise.all(operations)) as unknown as {
            op: string;
            args?: unknown;
            sql?: string;
            values?: unknown[];
        }[];

        expect(results.map((r) => r.op)).toEqual([
            'user.createMany',
            'walletBalance.upsert',
            'walletBalance.upsert',
            'walletBalance.deleteMany',
            'executeRaw',
            'lastBlockSynced.upsert',
        ]);

        expect(mockUserCreateMany).toHaveBeenCalledWith({
            data: [{ address: '0xuser1' }, { address: '0xuser2' }],
            skipDuplicates: true,
        });
        expect(mockWalletBalanceDeleteMany).toHaveBeenCalledWith({
            where: { id: { in: ['0xpool1-0xuser2'] }, chain: Chain.BASE },
        });

        expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
        const rawResult = results[4];
        expect(rawResult.sql).toContain('UPDATE "PrismaPoolDynamicData"');
        expect(rawResult.sql).toContain('SET "holdersCount" = sub.holders_count');
        expect(rawResult.sql).toContain('FROM "PrismaUserWalletBalance"');
        expect(rawResult.sql).toContain('dyn."holdersCount" <> sub.holders_count');
        expect(rawResult.values?.[0]).toBe(Chain.BASE);
        expect((rawResult.values?.[1] as Prisma.Sql).values).toEqual(['0xpool1', '0xpool2']);
    });

    it('emits no user createMany or holdersCount SQL when balances are empty', () => {
        expect(balancesToDb([], Chain.BASE, 1000)).toEqual([]);

        const checkpointOnly = balancesToDb([], Chain.BASE, 1000, 'BPT_BALANCES_V3');
        expect(checkpointOnly).toHaveLength(1);
        expect(mockUserCreateMany).not.toHaveBeenCalled();
        expect(mockExecuteRaw).not.toHaveBeenCalled();
        expect(mockLastBlockSyncedUpsert).toHaveBeenCalledTimes(1);
    });

    it('throws when balances span multiple chains or mismatch target chain', () => {
        expect(() =>
            balancesToDb(
                [
                    {
                        id: '0xpool1-0xuser1',
                        poolId: '0xpool1',
                        chain: Chain.SEPOLIA,
                        tokenAddress: '0xpool1',
                        userAddress: '0xuser1',
                        balance: '1',
                        balanceNum: 1,
                    },
                ],
                Chain.BASE,
                1000,
            ),
        ).toThrow('Balances should be from the same chain');
    });

    it('throws on >60 block subgraph lag only when syncCategory is provided, allowing initial pool backfill on lag', async () => {
        const subgraphClient = {
            lastSyncedBlock: vi.fn().mockResolvedValue(100),
            getAllPoolSharesWithBalance: vi.fn().mockResolvedValue([
                {
                    id: '0xpool1-0xuser1',
                    poolId: '0xpool1',
                    chain: Chain.BASE,
                    tokenAddress: '0xpool1',
                    userAddress: '0xuser1',
                    balance: '10',
                    balanceNum: 10,
                },
            ]),
        };

        mockGetBlockNumber.mockResolvedValue(200n);
        await expect(
            syncBptBalancesFromSubgraph(['0xpool1'], subgraphClient, Chain.BASE, 'BPT_BALANCES_V3'),
        ).rejects.toThrow('subgraph lagging behind by 100 blocks');
        expect(subgraphClient.getAllPoolSharesWithBalance).not.toHaveBeenCalled();

        // When syncCategory is undefined (initial backfill from addPoolsV3), lag must not abort backfill
        mockGetBlockNumber.mockClear();
        const synced = await syncBptBalancesFromSubgraph(['0xpool1'], subgraphClient, Chain.BASE);
        expect(synced).toBe(100);
        expect(mockGetBlockNumber).not.toHaveBeenCalled();
        expect(subgraphClient.getAllPoolSharesWithBalance).toHaveBeenCalledWith(['0xpool1'], [expect.any(String)], 1);
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    });

    it('syncBptBalancesFromRpc scans fromBlockOverride and updates balances and holdersCount without mutating BPT_BALANCES_V3 checkpoint when syncCategory is omitted', async () => {
        const poolId = '0x0000000000000000000000000000000000000001';
        const userAddress = '0x0000000000000000000000000000000000000002';
        const viemClient = { getBlockNumber: vi.fn().mockResolvedValue(1000n) };

        mockGetEvents.mockResolvedValue([
            {
                address: poolId,
                args: {
                    from: '0x0000000000000000000000000000000000000000',
                    to: userAddress,
                },
            },
        ]);
        mockMulticallViem.mockResolvedValue({
            [`${poolId}-${userAddress}`]: 2_000_000_000_000_000_000n,
        });

        const synced = await syncBptBalancesFromRpc([poolId], viemClient as any, Chain.BASE, undefined, 990);

        expect(synced).toBe(10);
        expect(mockGetLastSyncedBlock).not.toHaveBeenCalled();
        expect(mockGetEvents).toHaveBeenCalledWith(
            990,
            1000,
            [poolId],
            ['Transfer'],
            expect.any(String),
            expect.any(Number),
            expect.any(Array),
        );
        expect(mockWalletBalanceUpsert).toHaveBeenCalledTimes(1);
        expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
        expect(mockLastBlockSyncedUpsert).not.toHaveBeenCalled();
        expect(mockTransaction).toHaveBeenCalledTimes(1);
    });
});
