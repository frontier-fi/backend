import type { Config } from 'stellate';

/**
 * Stellate edge in front of api.frontier.fi. CI pushes this file with `bunx stellate push`.
 * STELLATE_ORIGIN_SECRET must match the value set on the api component, which rejects requests
 * without it. Stellate also answers CORS preflights itself.
 */
const config: Config = {
    config: {
        name: 'frontier-api',
        originUrl: 'https://api-origin.frontier.fi/graphql',
        // Read through the edge, so the request carries the origin secret below.
        schema: 'https://api.frontier.fi/graphql',
        headers: process.env.STELLATE_ORIGIN_SECRET
            ? { 'x-stellate-origin-secret': process.env.STELLATE_ORIGIN_SECRET }
            : null,
        // The origin serves Apollo Sandbox with an example query on GET /graphql.
        graphiql: { enabled: false },
        // A query that matches several rules is cached for the shortest of them.
        rules: [
            {
                description: 'Swap quotes',
                types: { Query: ['sorGetSwapPaths'] },
                maxAge: 5,
                swr: 5,
            },
            {
                description: 'Pools, user balances and events. The worker syncs these every 20-60s.',
                types: {
                    Query: [
                        'poolGetPool',
                        'poolGetPools',
                        'poolGetPoolsCount',
                        'poolEvents',
                        'aggregatorPools',
                        'poolGetAggregatorPools',
                    ],
                },
                maxAge: 10,
                swr: 20,
            },
            {
                description: 'Prices',
                types: { Query: ['tokenGetCurrentPrices', 'tokenGetTokenDynamicData', 'tokenGetTokensDynamicData'] },
                maxAge: 30,
                swr: 60,
            },
            {
                description: 'Mostly static',
                types: {
                    Query: [
                        'tokenGetTokens',
                        'poolGetFeaturedPools',
                        'poolGetSnapshots',
                        'tokenGetHistoricalPrices',
                        'tokenGetRelativePriceChartData',
                        'protocolMetricsChain',
                        'protocolMetricsAggregated',
                    ],
                },
                maxAge: 60,
                swr: 300,
            },
        ],
        // Runs at the edge as a standalone function, so it cannot use anything outside its body.
        rateLimits: (req) => [
            {
                name: 'Requests per IP',
                groupBy: 'ip',
                state: 'enabled',
                limit: { type: 'RequestCount', window: '1m', budget: 600 },
            },
            req.rootFields.some((field) => field.name === 'sorGetSwapPaths')
                ? {
                      name: 'Swap quotes per IP',
                      groupBy: 'ip',
                      state: 'enabled',
                      limit: { type: 'RequestCount', window: '1m', budget: 120 },
                  }
                : null,
        ],
    },
};

export default config;
