import { ApolloServerPlugin } from '@apollo/server';
import { logger } from '../../../modules/common/logger';
import { ResolverContext } from '../gql/resolver-context';

const CLIENT_ERROR_CODES = new Set([
    'GRAPHQL_PARSE_FAILED',
    'GRAPHQL_VALIDATION_FAILED',
    'BAD_USER_INPUT',
    'ACCESS_DENIED',
    'NOT_FOUND',
    'TOO_MANY_REQUESTS',
]);

/**
 * Logs unexpected GraphQL execution errors to stderr so they are captured by Better Stack.
 * Client input, validation, auth, and rate-limit errors are skipped.
 */
export const apolloErrorLoggerPlugin: ApolloServerPlugin<ResolverContext> = {
    async requestDidStart({ request }) {
        return {
            async didEncounterErrors(ctx) {
                for (const err of ctx.errors) {
                    if (CLIENT_ERROR_CODES.has(err.extensions?.code as string)) {
                        continue;
                    }
                    if (err.message === 'SOR queryBatchSwap failed') {
                        continue;
                    }

                    logger.error('GraphQL execution error', {
                        operationName: ctx.operationName ?? request.operationName ?? 'anonymous',
                        err: err.originalError ?? err,
                    });
                }
            },
        };
    },
};
