import { makeExecutableSchema } from '@graphql-tools/schema';
import { mergeTypeDefs, mergeResolvers } from '@graphql-tools/merge';

import { authTypeDefs } from '#/modules/auth/auth.typeDefs.js';
import { authResolvers } from '#/modules/auth/auth.resolvers.js';
import { productTypeDefs } from '#/modules/products/product.typeDefs.js';
import { productResolvers } from '#/modules/products/product.resolvers.js';

// ─── Root Types ───────────────────────────────────────────────────────────────

const rootTypeDefs = `
  type Query {
    health: String!
  }

  type Mutation {
    _noop: Boolean
  }
`;

// ─── Schema ───────────────────────────────────────────────────────────────────

const typeDefs = mergeTypeDefs([
  rootTypeDefs,
  authTypeDefs,
  productTypeDefs,
]);

const resolvers = mergeResolvers([
  {
    Query: {
      health: () => 'ok',
    },
  },
  authResolvers,
  productResolvers,
]);

export const schema = makeExecutableSchema({ typeDefs, resolvers });