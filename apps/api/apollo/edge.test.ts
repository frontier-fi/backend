import { ApolloServer, HeaderMap } from '@apollo/server';
import { buildSchema, GraphQLEnumType } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import config from '../../../config';
import { schema } from '../gql/generated-schema-ast';
import { ResolverContext } from '../gql/resolver-context';
import { apolloEdgePlugin, CACHE_RULES, EdgePluginOptions, RATE_LIMIT_WINDOW_MS } from './edge';

const QUOTE_ARGS = 'chain: SEPOLIA, tokenIn: "0x1", tokenOut: "0x2", swapType: EXACT_IN, swapAmount: "1"';

describe('apolloEdgePlugin', () => {
    it('gives every query in the schema exactly one cache rule', () => {
        const queries = Object.keys(buildSchema(schema).getQueryType()!.getFields()).sort();
        const cached = CACHE_RULES.flatMap((rule) => rule.queries);

        expect([...cached].sort()).toEqual(queries);
    });

    it('only exposes configured chains in the GqlChain enum', () => {
        const gqlChainEnum = buildSchema(schema).getType('GqlChain') as GraphQLEnumType;
        const enumValues = gqlChainEnum
            .getValues()
            .map((v) => v.name)
            .sort();
        const configuredChains = Object.keys(config).sort();

        expect(enumValues).toEqual(configuredChains);
    });

    it('is off on the SOR instance', () => {
        expect(apolloEdgePlugin({ SOR_INSTANCE: true })).toBeUndefined();
    });

    async function createTestServer(
        resolvers: Record<string, Record<string, (...args: unknown[]) => unknown>>,
        options: EdgePluginOptions = {},
    ) {
        const server = new ApolloServer<ResolverContext>({
            typeDefs: schema,
            resolvers,
            plugins: [apolloEdgePlugin({ SOR_INSTANCE: false }, options)!],
        });
        await server.start();

        const run = async (
            query: string,
            { variables, headers = [] }: { variables?: Record<string, unknown>; headers?: [string, string][] } = {},
        ) => {
            const response = await server.executeOperation(
                {
                    query,
                    variables,
                    http: { method: 'POST', headers: new HeaderMap(headers), search: '', body: {} },
                },
                { contextValue: { adminApiKey: null, req: {} as ResolverContext['req'] } },
            );
            if (response.body.kind !== 'single') throw new Error('Expected a single result');
            return {
                status: response.http.status,
                headers: response.http.headers,
                ...response.body.singleResult,
            };
        };

        return { server, run };
    }

    it('caches fresh responses, serves stale-while-revalidate and refreshes in the background', async () => {
        let currentTime = 1_000_000;
        let count = 0;
        const poolGetPoolsCount = vi.fn(() => ++count);
        const { server, run } = await createTestServer({ Query: { poolGetPoolsCount } }, { now: () => currentTime });

        // Initial request: cache miss (poolGetPoolsCount: maxAge=10s, swr=20s)
        const first = await run('{ poolGetPoolsCount }');
        expect(first.data).toEqual({ poolGetPoolsCount: 1 });
        expect(first.headers.get('x-cache')).toBe('MISS');
        expect(first.headers.get('cache-control')).toBe('public, max-age=10, stale-while-revalidate=20');
        expect(poolGetPoolsCount).toHaveBeenCalledTimes(1);

        // Within maxAge (t + 5s): fresh cache hit without calling the resolver
        currentTime += 5_000;
        const second = await run('{ poolGetPoolsCount }');
        expect(second.data).toEqual({ poolGetPoolsCount: 1 });
        expect(second.headers.get('x-cache')).toBe('HIT');
        expect(poolGetPoolsCount).toHaveBeenCalledTimes(1);

        // Inside SWR window (t + 15s): returns stale value immediately and refreshes in background
        currentTime += 10_000;
        const stale = await run('{ poolGetPoolsCount }');
        expect(stale.data).toEqual({ poolGetPoolsCount: 1 });
        expect(stale.headers.get('x-cache')).toBe('STALE');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(poolGetPoolsCount).toHaveBeenCalledTimes(2);

        // Subsequent request after background refresh gets fresh value
        currentTime += 1_000;
        const refreshed = await run('{ poolGetPoolsCount }');
        expect(refreshed.data).toEqual({ poolGetPoolsCount: 2 });
        expect(refreshed.headers.get('x-cache')).toBe('HIT');

        // Past maxAge + swr (t + 35s): cache entry expires
        currentTime += 35_000;
        const expired = await run('{ poolGetPoolsCount }');
        expect(expired.data).toEqual({ poolGetPoolsCount: 3 });
        expect(expired.headers.get('x-cache')).toBe('MISS');
        expect(poolGetPoolsCount).toHaveBeenCalledTimes(3);

        await server.stop();
    });

    it('uses the shortest rule when a query combines fields from multiple rules, and skips errors', async () => {
        let shouldFail = false;
        const { server, run } = await createTestServer({
            Query: {
                tokenGetTokens: () => [],
                poolGetPoolsCount: () => {
                    if (shouldFail) throw new Error('db down');
                    return 5;
                },
            },
        });

        // tokenGetTokens (60s/300s) + poolGetPoolsCount (10s/20s) -> 10s/20s
        const combined = await run('{ tokenGetTokens(chains: [SEPOLIA]) { address } poolGetPoolsCount }');
        expect(combined.headers.get('cache-control')).toBe('public, max-age=10, stale-while-revalidate=20');

        shouldFail = true;
        const failed = await run('{ poolGetPoolsCount }');
        expect(failed.errors).toBeDefined();
        expect(failed.headers.get('x-cache')).toBeUndefined();

        await server.stop();
    });

    it('enforces per-IP rate limits and counts aliased sorGetSwapPaths fields individually', async () => {
        let currentTime = 1_000_000;
        const { server, run } = await createTestServer(
            {
                Query: {
                    poolGetPoolsCount: () => 1,
                    sorGetSwapPaths: () => ({ returnAmount: '1' }),
                },
            },
            {
                now: () => currentTime,
                requestsPerIpBudget: 5,
                swapQuotesPerIpBudget: 3,
            },
        );

        const ipA: [string, string][] = [['cf-connecting-ip', '203.0.113.1']];
        const ipB: [string, string][] = [['cf-connecting-ip', '203.0.113.2']];

        // A single query with 3 aliased sorGetSwapPaths fields consumes all 3 units of the swap quote budget
        const aliasedQuotes = await run(
            `{
                a: sorGetSwapPaths(${QUOTE_ARGS}) { returnAmount }
                b: sorGetSwapPaths(${QUOTE_ARGS}) { returnAmount }
                c: sorGetSwapPaths(${QUOTE_ARGS}) { returnAmount }
            }`,
            { headers: ipA },
        );
        expect(aliasedQuotes.errors).toBeUndefined();

        // A 4th swap quote from the same IP is rejected with 429
        const blockedQuote = await run(`{ sorGetSwapPaths(${QUOTE_ARGS}) { returnAmount } }`, { headers: ipA });
        expect(blockedQuote.status).toBe(429);
        expect(blockedQuote.errors?.[0]?.extensions?.code).toBe('TOO_MANY_REQUESTS');
        expect(blockedQuote.headers.get('retry-after')).toBe('60');

        // Another IP is unaffected
        const otherIpQuote = await run(`{ sorGetSwapPaths(${QUOTE_ARGS}) { returnAmount } }`, { headers: ipB });
        expect(otherIpQuote.errors).toBeUndefined();

        // General queries from ipA still work until the general request budget (5) is exhausted
        for (let i = 0; i < 4; i++) {
            const ok = await run('{ poolGetPoolsCount }', { headers: ipA });
            expect(ok.errors).toBeUndefined();
        }
        const blockedGeneral = await run('{ poolGetPoolsCount }', { headers: ipA });
        expect(blockedGeneral.status).toBe(429);
        expect(blockedGeneral.errors?.[0]?.extensions?.code).toBe('TOO_MANY_REQUESTS');

        // After the 1-minute window resets, requests succeed again
        currentTime += RATE_LIMIT_WINDOW_MS + 1;
        const afterReset = await run(`{ sorGetSwapPaths(${QUOTE_ARGS}) { returnAmount } }`, { headers: ipA });
        expect(afterReset.errors).toBeUndefined();

        await server.stop();
    });
});
