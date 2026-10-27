import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../../apps/env';
import { ResolverContext } from '../../apps/api/gql/resolver-context';
import { GraphQLError } from 'graphql';

function safeCompareStrings(a: string, b: string): boolean {
    const hashA = createHash('sha256').update(a).digest();
    const hashB = createHash('sha256').update(b).digest();
    return timingSafeEqual(hashA, hashB) && a.length === b.length;
}

export function isAdminRoute(context: ResolverContext) {
    if (!context?.adminApiKey || !env.ADMIN_API_KEY || !safeCompareStrings(context.adminApiKey, env.ADMIN_API_KEY)) {
        throw new GraphQLError('Missing or invalid admin api key', {
            extensions: {
                code: 'ACCESS_DENIED',
            },
        });
    }
}
