import { ApolloServer } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../gql/generated-schema-ast';
import { ResolverContext } from '../gql/resolver-context';
import { apolloErrorLoggerPlugin } from './error-logger';

describe('apolloErrorLoggerPlugin', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('logs unexpected resolver errors to stderr and skips client errors', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const failure = new Error('database connection reset');

        const server = new ApolloServer<ResolverContext>({
            typeDefs: schema,
            resolvers: {
                Query: {
                    poolGetPoolsCount: () => {
                        throw failure;
                    },
                    poolGetPool: () => {
                        throw new GraphQLError('Pool not found', { extensions: { code: 'NOT_FOUND' } });
                    },
                },
            },
            plugins: [apolloErrorLoggerPlugin],
        });
        await server.start();

        await server.executeOperation(
            { query: 'query GetMissing { poolGetPool(id: "0x1", chain: SEPOLIA) { id } }' },
            { contextValue: { adminApiKey: null, req: {} as ResolverContext['req'] } },
        );
        expect(errorSpy).not.toHaveBeenCalled();

        await server.executeOperation(
            { query: 'query CountPools { poolGetPoolsCount }' },
            { contextValue: { adminApiKey: null, req: {} as ResolverContext['req'] } },
        );
        expect(errorSpy).toHaveBeenCalledWith('GraphQL error in CountPools:', failure);

        await server.stop();
    });
});
