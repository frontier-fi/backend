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
import { BoundedLruCache, estimateByteSize } from '../../../modules/common/bounded-cache';
import { stableStringify } from '../../../modules/common/stable-stringify';

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
export const DEFAULT_MAX_CACHE_BYTES = 16 * 1024 * 1024;
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
    maxCacheBytes?: number;
    requestsPerIpBudget?: number;
    swapQuotesPerIpBudget?: number;
}

export interface EdgeCacheStats {
    responseCacheEntries: number;
    responseCacheBytes: number;
    rateLimitBuckets: number;
    inFlightRequests: number;
}

/**
 * In-process GraphQL response cache (maxAge + stale-while-revalidate, bounded by entries and bytes),
 * cold-miss single-flight deduplication, and per-IP rate limiter.
 * Disabled on the SOR instance, whose traffic is internal proxy calls from the API container.
 */
export function createApolloEdgePlugin(
    settings: { SOR_INSTANCE: boolean },
    options: EdgePluginOptions = {},
): { plugin: ApolloServerPlugin<ResolverContext>; getStats: () => EdgeCacheStats } | undefined {
    if (settings.SOR_INSTANCE) {
        return undefined;
    }

    const now = options.now ?? Date.now;
    const maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    const maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
    const requestsBudget = options.requestsPerIpBudget ?? REQUESTS_PER_IP_BUDGET;
    const swapQuotesBudget = options.swapQuotesPerIpBudget ?? SWAP_QUOTES_PER_IP_BUDGET;

    const cache = new BoundedLruCache<CacheEntry>({
        maxEntries: maxCacheEntries,
        maxBytes: maxCacheBytes,
        sizeOf: (entry) => estimateByteSize(entry.data),
        now,
    });
    const inFlight = new Map<string, Promise<Record<string, unknown> | undefined>>();
    const rateBuckets = new Map<string, RateBucket>();
    let cacheGeneration = 0;

    const setCacheEntry = (key: string, entry: CacheEntry) => {
        cache.setSync(key, entry);
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

    const plugin: ApolloServerPlugin<ResolverContext> = {
        async requestDidStart() {
            let cacheCandidate: { key: string; maxAge: number; swr: number; generation: number } | undefined;
            let inFlightLeader:
                | {
                      key: string;
                      promise: Promise<Record<string, unknown> | undefined>;
                      resolve: (data: Record<string, unknown> | undefined) => void;
                  }
                | undefined;
            let servedFromPlugin = false;

            const settleLeader = (data: Record<string, unknown> | undefined) => {
                if (!inFlightLeader) {
                    return;
                }
                const leader = inFlightLeader;
                inFlightLeader = undefined;
                if (inFlight.get(leader.key) === leader.promise) {
                    inFlight.delete(leader.key);
                }
                leader.resolve(data);
            };

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
                    const entry = cache.getSync(key);

                    if (entry && currentTime < entry.staleUntil) {
                        servedFromPlugin = true;
                        const isFresh = currentTime < entry.freshUntil;

                        if (!isFresh && !entry.revalidating) {
                            entry.revalidating = true;
                            const generationAtStart = cacheGeneration;
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
                                    if (
                                        result.data &&
                                        !result.errors?.length &&
                                        generationAtStart === cacheGeneration
                                    ) {
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
                        cache.deleteSync(key);
                    }

                    const pending = inFlight.get(key);
                    if (pending) {
                        const sharedData = await pending;
                        if (sharedData !== undefined) {
                            servedFromPlugin = true;
                            return {
                                http: {
                                    status: undefined,
                                    headers: new HeaderMap([
                                        ['cache-control', cacheControl],
                                        ['x-cache', 'HIT'],
                                    ]),
                                },
                                body: {
                                    kind: 'single',
                                    singleResult: { data: sharedData },
                                },
                            };
                        }
                        return null;
                    }

                    let resolveLeader!: (data: Record<string, unknown> | undefined) => void;
                    const leaderPromise = new Promise<Record<string, unknown> | undefined>((resolve) => {
                        resolveLeader = resolve;
                    });
                    inFlight.set(key, leaderPromise);
                    inFlightLeader = { key, promise: leaderPromise, resolve: resolveLeader };
                    cacheCandidate = { key, ...ttl, generation: cacheGeneration };
                    return null;
                },

                async willSendResponse(requestContext) {
                    let resolvedData: Record<string, unknown> | undefined;
                    try {
                        if (
                            requestContext.operation?.operation === 'mutation' &&
                            !requestContext.errors?.length &&
                            requestContext.response.body.kind === 'single' &&
                            !requestContext.response.body.singleResult.errors?.length
                        ) {
                            cacheGeneration += 1;
                            cache.clear();
                            return;
                        }
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

                        if (cacheCandidate.generation === cacheGeneration) {
                            resolvedData = singleResult.data;
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
                        }
                    } finally {
                        settleLeader(resolvedData);
                    }
                },
            };
        },
    };

    return {
        plugin,
        getStats: () => ({
            responseCacheEntries: cache.entries,
            responseCacheBytes: cache.bytes,
            rateLimitBuckets: rateBuckets.size,
            inFlightRequests: inFlight.size,
        }),
    };
}

export function apolloEdgePlugin(
    settings: { SOR_INSTANCE: boolean },
    options: EdgePluginOptions = {},
): ApolloServerPlugin<ResolverContext> | undefined {
    return createApolloEdgePlugin(settings, options)?.plugin;
}
