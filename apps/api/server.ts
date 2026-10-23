import { setupExpressErrorHandler } from '@sentry/node';
import express from 'express';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import helmet from 'helmet';
import * as http from 'http';
import { env } from '../env';
import { loadRestRoutes } from './rest-routes';
import { corsMiddleware, lowerCaseMiddleware } from './middleware';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { ApolloServerPluginUsageReporting } from '@apollo/server/plugin/usageReporting';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { examplePoolsQuery } from './apollo/landing-page';
import { schema } from './gql/generated-schema-ast';
import { resolvers } from './gql/resolvers';
import { ResolverContext, resolverContext } from './gql/resolver-context';
import { apolloSentryPlugin } from './apollo/sentry-plugin';

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
    const plugins = [ApolloServerPluginDrainHttpServer({ httpServer }), apolloSentryPlugin];

    plugins.push(ApolloServerPluginLandingPageLocalDefault({ document: examplePoolsQuery }));

    if (process.env.APOLLO_SCHEMA_REPORTING === 'true') {
        plugins.push(
            ApolloServerPluginUsageReporting({
                sendVariableValues: { all: true },
                sendHeaders: { all: true },
            }),
        );
    }

    const server = new ApolloServer<ResolverContext>({
        resolvers,
        typeDefs: schema,
        introspection: true,
        cache: 'bounded',
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

export const startApiServer = async () => {
    const app = express();

    loadRestRoutes(app);
    setupExpressErrorHandler(app);
    configureHelmet(app);
    configureMiddlewares(app);

    const httpServer = http.createServer(app);

    await configureApolloServer(httpServer, app);

    await new Promise<void>((resolve) => httpServer.listen({ port: env.PORT, host: '0.0.0.0' }, resolve));
    console.log(`🚀 Server ready at http://localhost:${env.PORT}/graphql`);
};
