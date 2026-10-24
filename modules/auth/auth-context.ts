import { env } from '../../apps/env';
import { ResolverContext } from '../../apps/api/gql/resolver-context';
import { GraphQLError } from 'graphql';

export function isAdminRoute(context: ResolverContext) {
    if (!context?.adminApiKey || context.adminApiKey !== env.ADMIN_API_KEY) {
        throw new GraphQLError('Missing or invalid admin api key', {
            extensions: {
                code: 'ACCESS_DENIED',
            },
        });
    }
}
