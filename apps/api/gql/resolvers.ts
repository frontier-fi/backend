import poolResolver from './resolvers/pool.resolvers';
import protocolResolver from './resolvers/protocol.resolvers';
import scalarResolver from './resolvers/scalar.resolvers';
import sorResolver from './resolvers/sor.resolvers';
import tokenResolver from './resolvers/token.resolvers';
import userResolver from './resolvers/user.resolvers';

export const resolvers = {
    Date: scalarResolver.Date!,
    Query: {
        ...poolResolver.Query,
        ...protocolResolver.Query,
        ...sorResolver.Query,
        ...tokenResolver.Query,
        ...userResolver.Query,
    },
    Mutation: {
        ...poolResolver.Mutation,
        ...protocolResolver.Mutation,
        ...sorResolver.Mutation,
        ...tokenResolver.Mutation,
        ...userResolver.Mutation,
    },
};
