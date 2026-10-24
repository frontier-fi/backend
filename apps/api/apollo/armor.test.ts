import { ApolloServer } from '@apollo/server';
import { getIntrospectionQuery } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../gql/generated-schema-ast';
import { apolloProtection } from './armor';

// Each level adds two to the depth: 5 levels is depth 13, 6 is 15, 7 is 17.
function nestedPoolTokens(levels: number): string {
    let selection = 'address';
    for (let i = 0; i < levels; i++) selection = `nestedPool { tokens { ${selection} } }`;
    return `poolGetPool(id: "0x1", chain: SEPOLIA) { poolTokens { ${selection} } }`;
}

function aliased(count: number, field: string): string {
    return `{ ${Array.from({ length: count }, (_, i) => `a${i}: ${field}`).join(' ')} }`;
}

describe('apolloProtection', () => {
    let server: ApolloServer;

    beforeAll(async () => {
        server = new ApolloServer({
            typeDefs: schema,
            resolvers: {
                Query: {
                    poolGetPool: () => ({ __typename: 'GqlPoolWeighted', poolTokens: [] }),
                    poolGetPools: () => [],
                    poolGetPoolsCount: () => {
                        throw new Error('database password in a stack trace');
                    },
                },
            },
            ...apolloProtection(),
        });
        await server.start();
    });

    afterAll(async () => {
        await server.stop();
    });

    async function execute(query: string) {
        const response = await server.executeOperation({ query });
        if (response.body.kind !== 'single') throw new Error('Expected a single result');
        return { status: response.http.status, ...response.body.singleResult };
    }

    async function expectRejected(query: string, code: string, reason: RegExp) {
        const result = await execute(query);
        expect(result.status).toBe(400);
        expect(result.errors?.[0]?.extensions?.code).toBe(code);
        expect(result.errors?.[0]?.message).toMatch(reason);
    }

    it('accepts a query as deep as the frontend sends', async () => {
        const result = await execute(`{ ${nestedPoolTokens(5)} }`);

        expect(result.errors).toBeUndefined();
    });

    it('rejects a query past the depth limit', async () => {
        await expectRejected(
            `{ ${nestedPoolTokens(7)} }`,
            'GRAPHQL_VALIDATION_FAILED',
            /depth limit of 15 exceeded, found 17/,
        );
    });

    it('rejects more than 15 aliases', async () => {
        expect((await execute(aliased(15, 'poolGetPools { id }'))).errors).toBeUndefined();
        await expectRejected(
            aliased(16, 'poolGetPools { id }'),
            'GRAPHQL_VALIDATION_FAILED',
            /Aliases limit of 15 exceeded, found 16/,
        );
    });

    it('rejects an operation whose combined cost is too high', async () => {
        await expectRejected(
            aliased(15, nestedPoolTokens(6)),
            'GRAPHQL_VALIDATION_FAILED',
            /Query Cost limit of 15000 exceeded/,
        );
    });

    it('rejects an operation with too many tokens as a parse error', async () => {
        await expectRejected(`{ ${'__typename '.repeat(1_100)} }`, 'GRAPHQL_PARSE_FAILED', /1000 tokens/);
    });

    it('still answers a syntax error with GRAPHQL_PARSE_FAILED', async () => {
        await expectRejected('{ poolGetPools { id }', 'GRAPHQL_PARSE_FAILED', /Syntax Error/);
    });

    it('accepts the introspection query Apollo Sandbox sends', async () => {
        const result = await execute(
            getIntrospectionQuery({
                descriptions: true,
                specifiedByUrl: true,
                directiveIsRepeatable: true,
                schemaDescription: true,
                inputValueDeprecation: true,
            }),
        );

        expect(result.errors).toBeUndefined();
    });

    it('keeps stack traces out of error responses', async () => {
        const result = await execute('{ poolGetPoolsCount }');

        expect(result.errors?.[0]?.extensions?.stacktrace).toBeUndefined();
    });
});
