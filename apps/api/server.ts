import express from 'express';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import helmet from 'helmet';
import * as http from 'http';
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
import { apolloEdgePlugin } from './apollo/edge';
import type { Stoppable } from '../shutdown';

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

const configureApolloServer = async (httpServer: http.Server, app: express.Express) => {
    const protection = apolloProtection();
    const plugins = [...protection.plugins, ApolloServerPluginDrainHttpServer({ httpServer }), apolloErrorLoggerPlugin];

    plugins.push(ApolloServerPluginLandingPageLocalDefault({ document: examplePoolsQuery }));

    const edgePlugin = apolloEdgePlugin(env);
    if (edgePlugin) {
        plugins.push(edgePlugin);
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

    const server = new ApolloServer<ResolverContext>({
        resolvers,
        typeDefs: schema,
        introspection: true,
        cache: 'bounded',
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

    return server;
};

export const startApiServer = async (): Promise<Stoppable> => {
    const app = express();

    loadRestRoutes(app);
    configureHelmet(app);
    configureMiddlewares(app);

    const httpServer = http.createServer(app);

    const apollo = await configureApolloServer(httpServer, app);

    // Error handlers only see errors from routes registered before them.
    app.use(jsonErrorHandler);

    await new Promise<void>((resolve) => httpServer.listen({ port: env.PORT, host: '0.0.0.0' }, resolve));
    console.log(`🚀 Server ready at http://localhost:${env.PORT}/graphql`);

    // The drain plugin closes the HTTP server and lets requests in flight finish first.
    return { stop: () => apollo.stop() };
};
