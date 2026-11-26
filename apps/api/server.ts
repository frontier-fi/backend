import express from 'express';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import helmet from 'helmet';
import * as http from 'http';
import { DocumentNode } from 'graphql';
import { env } from '../env';
import { loadRestRoutes } from './rest-routes';
import { corsMiddleware, jsonErrorHandler, lowerCaseMiddleware } from './middleware';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { ApolloServerPluginUsageReporting } from '@apollo/server/plugin/usageReporting';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { examplePoolsQuery } from './apollo/landing-page';
import { schema } from './gql/generated-schema-ast';
import { resolvers } from './gql/resolvers';
import { ResolverContext, resolverContext } from './gql/resolver-context';
import { apolloErrorLoggerPlugin } from './apollo/error-logger';
import { apolloProtection } from './apollo/armor';
import { createApolloEdgePlugin, EdgeCacheStats } from './apollo/edge';
import { startMemoryLogging } from './memory-logger';
import type { Stoppable } from '../shutdown';
import { logger } from '../../modules/common/logger';
import { BoundedLruCache } from '../../modules/common/bounded-cache';

// Apollo defaults both caches to 30 MiB measured on JSON size; parsed ASTs use ~3-4x that on heap.
const APOLLO_DOCUMENT_STORE_MAX_BYTES = 8 * 1024 * 1024;
const APOLLO_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const APOLLO_MAX_CACHE_ENTRIES = 500;

const configureHelmet = (app: express.Express) => {
    app.use(helmet.dnsPrefetchControl());
    app.use(helmet.frameguard());
    app.use(helmet.hidePoweredBy());
    app.use(helmet.hsts());
    app.use(helmet.ieNoOpen());
    app.use(helmet.noSniff());
    app.use(helmet.originAgentCluster());
    app.use(helmet.permittedCrossDomainPolicies());
    app.use(helmet.referrerPolicy());
};

const configureMiddlewares = (app: express.Express) => {
    app.use(corsMiddleware);
    app.use(lowerCaseMiddleware);
};

const configureApolloServer = async (
    httpServer: http.Server,
    app: express.Express,
): Promise<{
    apollo: ApolloServer<ResolverContext>;
    documentStore: BoundedLruCache<DocumentNode>;
    apolloCache: BoundedLruCache<string>;
    getEdgeStats?: () => EdgeCacheStats;
}> => {
    const protection = apolloProtection();
    const plugins = [...protection.plugins, ApolloServerPluginDrainHttpServer({ httpServer }), apolloErrorLoggerPlugin];

    plugins.push(ApolloServerPluginLandingPageLocalDefault({ document: examplePoolsQuery }));

    const edge = createApolloEdgePlugin(env);
    if (edge) {
        plugins.push(edge.plugin);
    }

    if (process.env.APOLLO_SCHEMA_REPORTING === 'true') {
        plugins.push(
            ApolloServerPluginUsageReporting({
                sendVariableValues: { all: true },
                // Apollo only drops authorization and cookie headers on its own.
                sendHeaders: { exceptNames: ['AdminApiKey'] },
            }),
        );
    }

    const documentStore = new BoundedLruCache<DocumentNode>({
        maxBytes: APOLLO_DOCUMENT_STORE_MAX_BYTES,
        maxEntries: APOLLO_MAX_CACHE_ENTRIES,
    });
    const apolloCache = new BoundedLruCache<string>({
        maxBytes: APOLLO_CACHE_MAX_BYTES,
        maxEntries: APOLLO_MAX_CACHE_ENTRIES,
    });

    const server = new ApolloServer<ResolverContext>({
        resolvers,
        typeDefs: schema,
        introspection: true,
        cache: apolloCache,
        documentStore,
        ...protection,
        plugins,
    });

    await server.start();

    app.use(
        '/graphql',
        express.json(),
        expressMiddleware(server, {
            context: async ({ req }) => resolverContext(req),
        }),
    );

    return { apollo: server, documentStore, apolloCache, getEdgeStats: edge?.getStats };
};

export const startApiServer = async (): Promise<Stoppable> => {
    const app = express();

    loadRestRoutes(app);
    configureHelmet(app);
    configureMiddlewares(app);

    const httpServer = http.createServer(app);

    const { apollo, documentStore, apolloCache, getEdgeStats } = await configureApolloServer(httpServer, app);
    const stopMemoryLogging = startMemoryLogging({ documentStore, apolloCache, getEdgeStats });

    // Error handlers only see errors from routes registered before them.
    app.use(jsonErrorHandler);

    await new Promise<void>((resolve) => httpServer.listen({ port: env.PORT, host: '0.0.0.0' }, resolve));
    logger.info('API server listening', { port: env.PORT, url: `http://localhost:${env.PORT}/graphql` });

    // The drain plugin closes the HTTP server and lets requests in flight finish first.
    return {
        stop: async () => {
            stopMemoryLogging();
            await apollo.stop();
        },
    };
};
