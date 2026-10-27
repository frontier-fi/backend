import { ApolloServerPlugin, HeaderMap } from '@apollo/server';
import {
    DocumentNode,
    execute,
    FragmentDefinitionNode,
    Kind,
    OperationDefinitionNode,
    OperationTypeNode,
    SelectionNode,
} from 'graphql';
import { ResolverContext } from '../gql/resolver-context';

export interface CacheRule {
    description: string;
    queries: readonly string[];
    maxAge: number;
    swr: number;
}

/**
 * Response cache TTLs (in seconds) for every Query field in the schema.
 * A query that selects fields from several rules is cached for the shortest of them.
 */
export const CACHE_RULES: readonly CacheRule[] = [
    {
        description: 'Swap quotes',
        queries: ['sorGetSwapPaths'],
        maxAge: 5,
        swr: 5,
    },
    {
        description: 'Pools, user balances and events. The worker syncs these every 20-60s.',
        queries: [
            'poolGetPool',
            'poolGetPools',
            'poolGetPoolsCount',
            'poolEvents',
            'aggregatorPools',
            'poolGetAggregatorPools',
        ],
        maxAge: 10,
        swr: 20,
    },
    {
        description: 'Prices',
        queries: ['tokenGetCurrentPrices', 'tokenGetTokenDynamicData', 'tokenGetTokensDynamicData'],
        maxAge: 30,
        swr: 60,
    },
    {
        description: 'Mostly static',
        queries: [
            'tokenGetTokens',
            'poolGetFeaturedPools',
            'poolGetSnapshots',
            'tokenGetHistoricalPrices',
            'tokenGetRelativePriceChartData',
            'protocolMetricsChain',
            'protocolMetricsAggregated',
        ],
        maxAge: 60,
        swr: 300,
    },
];

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const REQUESTS_PER_IP_BUDGET = 600;
export const SWAP_QUOTES_PER_IP_BUDGET = 120;

const DEFAULT_MAX_CACHE_ENTRIES = 1_000;
const MAX_RATE_BUCKETS = 5_000;

const RULE_BY_QUERY = new Map<string, { maxAge: number; swr: number }>(
    CACHE_RULES.flatMap((rule) => rule.queries.map((query) => [query, { maxAge: rule.maxAge, swr: rule.swr }])),
);

export function collectRootFields(document: DocumentNode, operation: OperationDefinitionNode): string[] {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const definition of document.definitions) {
        if (definition.kind === Kind.FRAGMENT_DEFINITION) {
            fragments.set(definition.name.value, definition);
        }
    }

    const fields: string[] = [];
    const visitedFragments = new Set<string>();

    const visitSelections = (selections: readonly SelectionNode[]) => {
        for (const selection of selections) {
            if (selection.kind === Kind.FIELD) {
                fields.push(selection.name.value);
            } else if (selection.kind === Kind.INLINE_FRAGMENT) {
                visitSelections(selection.selectionSet.selections);
            } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
                const name = selection.name.value;
                if (!visitedFragments.has(name)) {
                    visitedFragments.add(name);
                    const fragment = fragments.get(name);
                    if (fragment) {
                        visitSelections(fragment.selectionSet.selections);
                    }
                }
            }
        }
    };

    visitSelections(operation.selectionSet.selections);
    return fields;
}

export function cacheTtlForOperation(
    operation: OperationDefinitionNode,
    rootFields: readonly string[],
): { maxAge: number; swr: number } | undefined {
    if (operation.operation !== OperationTypeNode.QUERY) {
        return undefined;
    }

    const queryFields = rootFields.filter((name) => name !== '__typename');
    if (queryFields.length === 0) {
        return undefined;
    }

    let maxAge = Infinity;
    let swr = Infinity;
    for (const field of queryFields) {
        const rule = RULE_BY_QUERY.get(field);
        if (!rule) {
            return undefined;
        }
        maxAge = Math.min(maxAge, rule.maxAge);
        swr = Math.min(swr, rule.swr);
    }

    return { maxAge, swr };
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function buildCacheKey(
    queryHash: string,
    operationName: string | null | undefined,
    variables: Record<string, unknown> | undefined,
): string {
    return `${queryHash}:${operationName ?? ''}:${variables ? stableStringify(variables) : ''}`;
}

export function clientIp(headers: HeaderMap | undefined, contextValue: Partial<ResolverContext> | undefined): string {
    const cfIp = headers?.get('cf-connecting-ip')?.trim();
    if (cfIp) return cfIp;

    const forwarded = headers?.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;

    return contextValue?.req?.socket?.remoteAddress || 'unknown';
}

interface CacheEntry {
    data: Record<string, unknown>;
    freshUntil: number;
    staleUntil: number;
    revalidating: boolean;
}

interface RateBucket {
    count: number;
    resetAt: number;
}

export interface EdgePluginOptions {
    now?: () => number;
    maxCacheEntries?: number;
    requestsPerIpBudget?: number;
    swapQuotesPerIpBudget?: number;
}

/**
 * In-process GraphQL response cache (maxAge + stale-while-revalidate) and per-IP rate limiter.
 * Disabled on the SOR instance, whose traffic is internal proxy calls from the API container.
 */
export function apolloEdgePlugin(
    settings: { SOR_INSTANCE: boolean },
    options: EdgePluginOptions = {},
): ApolloServerPlugin<ResolverContext> | undefined {
    if (settings.SOR_INSTANCE) {
        return undefined;
    }

    const now = options.now ?? Date.now;
    const maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    const requestsBudget = options.requestsPerIpBudget ?? REQUESTS_PER_IP_BUDGET;
    const swapQuotesBudget = options.swapQuotesPerIpBudget ?? SWAP_QUOTES_PER_IP_BUDGET;

    const cache = new Map<string, CacheEntry>();
    const rateBuckets = new Map<string, RateBucket>();

    const setCacheEntry = (key: string, entry: CacheEntry) => {
        cache.delete(key);
        cache.set(key, entry);
        while (cache.size > maxCacheEntries) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey === undefined) break;
            cache.delete(oldestKey);
        }
    };

    const getBucket = (key: string, currentTime: number): RateBucket => {
        if (rateBuckets.size > MAX_RATE_BUCKETS) {
            for (const [k, b] of rateBuckets) {
                if (b.resetAt <= currentTime) {
                    rateBuckets.delete(k);
                }
            }
        }
        const existing = rateBuckets.get(key);
        if (existing && existing.resetAt > currentTime) {
            return existing;
        }
        const fresh: RateBucket = { count: 0, resetAt: currentTime + RATE_LIMIT_WINDOW_MS };
        rateBuckets.set(key, fresh);
        return fresh;
    };

    const checkRateLimit = (
        ip: string,
        swapQuoteCount: number,
        currentTime: number,
    ): { allowed: boolean; retryAfterSeconds: number } => {
        const reqBucket = getBucket(`req:${ip}`, currentTime);
        if (reqBucket.count + 1 > requestsBudget) {
            return {
                allowed: false,
                retryAfterSeconds: Math.max(1, Math.ceil((reqBucket.resetAt - currentTime) / 1_000)),
            };
        }

        if (swapQuoteCount > 0) {
            const sorBucket = getBucket(`sor:${ip}`, currentTime);
            if (sorBucket.count + swapQuoteCount > swapQuotesBudget) {
                return {
                    allowed: false,
                    retryAfterSeconds: Math.max(1, Math.ceil((sorBucket.resetAt - currentTime) / 1_000)),
                };
            }
            sorBucket.count += swapQuoteCount;
        }

        reqBucket.count += 1;
        return { allowed: true, retryAfterSeconds: 0 };
    };

    return {
        async requestDidStart() {
            let cacheCandidate: { key: string; maxAge: number; swr: number } | undefined;
            let servedFromPlugin = false;

            return {
                async responseForOperation(requestContext) {
                    const currentTime = now();
                    const rootFields = collectRootFields(requestContext.document, requestContext.operation);
                    const swapQuoteCount = rootFields.filter((name) => name === 'sorGetSwapPaths').length;
                    const ip = clientIp(requestContext.request.http?.headers, requestContext.contextValue);

                    const rateLimit = checkRateLimit(ip, swapQuoteCount, currentTime);
                    if (!rateLimit.allowed) {
                        servedFromPlugin = true;
                        return {
                            http: {
                                status: 429,
                                headers: new HeaderMap([['retry-after', String(rateLimit.retryAfterSeconds)]]),
                            },
                            body: {
                                kind: 'single',
                                singleResult: {
                                    errors: [
                                        {
                                            message: 'Too many requests',
                                            extensions: { code: 'TOO_MANY_REQUESTS' },
                                        },
                                    ],
                                },
                            },
                        };
                    }

                    const hasAdminKey = Boolean(
                        requestContext.contextValue?.adminApiKey ||
                        requestContext.request.http?.headers.get('adminapikey'),
                    );
                    if (hasAdminKey || !requestContext.queryHash) {
                        return null;
                    }

                    const ttl = cacheTtlForOperation(requestContext.operation, rootFields);
                    if (!ttl) {
                        return null;
                    }

                    const key = buildCacheKey(
                        requestContext.queryHash,
                        requestContext.operationName,
                        requestContext.request.variables,
                    );
                    const cacheControl = `public, max-age=${ttl.maxAge}, stale-while-revalidate=${ttl.swr}`;
                    const entry = cache.get(key);

                    if (entry && currentTime < entry.staleUntil) {
                        setCacheEntry(key, entry);
                        servedFromPlugin = true;
                        const isFresh = currentTime < entry.freshUntil;

                        if (!isFresh && !entry.revalidating) {
                            entry.revalidating = true;
                            Promise.resolve()
                                .then(() =>
                                    execute({
                                        schema: requestContext.schema,
                                        document: requestContext.document,
                                        operationName: requestContext.operationName,
                                        variableValues: requestContext.request.variables,
                                        contextValue: requestContext.contextValue,
                                    }),
                                )
                                .then((result) => {
                                    if (result.data && !result.errors?.length) {
                                        const refreshedAt = now();
                                        setCacheEntry(key, {
                                            data: result.data,
                                            freshUntil: refreshedAt + ttl.maxAge * 1_000,
                                            staleUntil: refreshedAt + (ttl.maxAge + ttl.swr) * 1_000,
                                            revalidating: false,
                                        });
                                    } else {
                                        entry.revalidating = false;
                                    }
                                })
                                .catch(() => {
                                    entry.revalidating = false;
                                });
                        }

                        return {
                            http: {
                                status: undefined,
                                headers: new HeaderMap([
                                    ['cache-control', cacheControl],
                                    ['x-cache', isFresh ? 'HIT' : 'STALE'],
                                ]),
                            },
                            body: {
                                kind: 'single',
                                singleResult: { data: entry.data },
                            },
                        };
                    }

                    if (entry) {
                        cache.delete(key);
                    }

                    cacheCandidate = { key, ...ttl };
                    return null;
                },

                async willSendResponse(requestContext) {
                    if (servedFromPlugin || !cacheCandidate) {
                        return;
                    }
                    if (requestContext.errors?.length || requestContext.response.body.kind !== 'single') {
                        return;
                    }

                    const { singleResult } = requestContext.response.body;
                    if (singleResult.errors?.length || !singleResult.data) {
                        return;
                    }

                    const currentTime = now();
                    setCacheEntry(cacheCandidate.key, {
                        data: singleResult.data,
                        freshUntil: currentTime + cacheCandidate.maxAge * 1_000,
                        staleUntil: currentTime + (cacheCandidate.maxAge + cacheCandidate.swr) * 1_000,
                        revalidating: false,
                    });
                    requestContext.response.http.headers.set(
                        'cache-control',
                        `public, max-age=${cacheCandidate.maxAge}, stale-while-revalidate=${cacheCandidate.swr}`,
                    );
                    requestContext.response.http.headers.set('x-cache', 'MISS');
                },
            };
        },
    };
}
