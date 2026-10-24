import { ApolloArmor } from '@escape.tech/graphql-armor';

/**
 * Enforced by graphql-js through Apollo's `parseOptions` and in the lower-case middleware.
 * Armor's own token plugin rejects from a plugin hook, which Apollo answers with a 500, and it
 * turns every syntax error into a 500 too.
 */
export const MAX_TOKENS = 1_000;

/**
 * Limits on a single operation. The frontend's largest operation, GetPool, measures depth 12,
 * cost about 8,400 and 442 tokens, so these leave headroom above it.
 */
const armor = new ApolloArmor({
    maxDepth: { n: 15 },
    costLimit: { maxCost: 15_000 },
    maxAliases: { n: 15 },
    maxDirectives: { n: 50 },
    maxTokens: { enabled: false },
    // Introspection is public, so hiding field suggestions would not hide the schema.
    blockFieldSuggestion: { enabled: false },
});

/** Apollo Server options that apply the limits. Also turns off batching and stack traces in errors. */
export function apolloProtection() {
    return { ...armor.protect(), parseOptions: { maxTokens: MAX_TOKENS } };
}
