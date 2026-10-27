import { Chain } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../prisma/prisma-client';
import * as contentControllerModule from '../../content/content-controller';
import { PoolGqlLoaderService } from './pool-gql-loader.service';

describe('PoolGqlLoaderService', () => {
    const loader = new PoolGqlLoaderService();

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('excludes BLACK_LISTED pools when where filters are provided unless explicitly requested', async () => {
        const findManySpy = vi.spyOn(prisma.prismaPool, 'findMany').mockResolvedValue([]);

        await loader.getPools({ where: { chainIn: [Chain.SEPOLIA] } });

        expect(findManySpy).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    NOT: { categories: { hasSome: ['BLACK_LISTED'] } },
                }),
            }),
        );

        findManySpy.mockClear();
        await loader.getPools({ where: { chainIn: [Chain.SEPOLIA], categoryIn: ['BLACK_LISTED'] } });

        const callWhere = findManySpy.mock.calls[0][0]?.where as Record<string, unknown>;
        expect(callWhere.categories).toEqual({ hasSome: ['BLACK_LISTED'] });
        expect(callWhere.NOT).toBeUndefined();
    });

    it('joins on poolId and chain in textSearch and does not double-apply pagination', async () => {
        const queryRawSpy = vi
            .spyOn(prisma, '$queryRaw')
            .mockResolvedValue([{ id: '0x0000000000000000000000000000000000000001' }]);
        const findManySpy = vi.spyOn(prisma.prismaPool, 'findMany').mockResolvedValue([]);

        await loader.getPools({
            textSearch: 'usdc',
            first: 10,
            skip: 5,
            where: { chainIn: [Chain.SEPOLIA] },
        });

        expect(queryRawSpy).toHaveBeenCalledTimes(1);
        const sqlArg = queryRawSpy.mock.calls[0][0] as { strings: string[]; values: unknown[] };
        const joinedSql = sqlArg.strings.join('?');
        expect(joinedSql).toContain('p.id = d."poolId" AND p.chain = d.chain');

        // Secondary findMany must not re-apply take/skip
        expect(findManySpy).toHaveBeenCalledWith(
            expect.objectContaining({
                take: undefined,
                skip: undefined,
                where: expect.objectContaining({
                    id: { in: ['0x0000000000000000000000000000000000000001'], notIn: undefined },
                }),
            }),
        );
    });

    it('returns empty array without querying findMany when textSearch matches no pools', async () => {
        vi.spyOn(prisma, '$queryRaw').mockResolvedValue([]);
        const findManySpy = vi.spyOn(prisma.prismaPool, 'findMany').mockResolvedValue([]);

        const result = await loader.getPools({ textSearch: 'nonexistent' });

        expect(result).toEqual([]);
        expect(findManySpy).not.toHaveBeenCalled();
    });

    it('skips missing featured pools instead of crashing getFeaturedPools', async () => {
        vi.spyOn(contentControllerModule, 'ContentController').mockReturnValue({
            getFeaturedPools: vi.fn().mockResolvedValue([
                { poolId: '0xmissing', chain: Chain.SEPOLIA, primary: true, description: 'Missing' },
                { poolId: '0xpresent', chain: Chain.SEPOLIA, primary: false, description: 'Present' },
            ]),
        } as any);

        vi.spyOn(loader, 'getPool').mockImplementation(async (_fields, id) => {
            if (id === '0xmissing') {
                throw new Error('Pool with id does not exist');
            }
            return { id: '0xpresent', chain: Chain.SEPOLIA } as any;
        });

        const featured = await loader.getFeaturedPools([Chain.SEPOLIA]);

        expect(featured).toHaveLength(1);
        expect(featured[0].poolId).toBe('0xpresent');
    });
});
