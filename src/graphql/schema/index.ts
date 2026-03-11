import { makeExecutableSchema } from '@graphql-tools/schema';
import { mergeResolvers, mergeTypeDefs } from '@graphql-tools/merge';

import { authTypeDefs } from '#/modules/auth/auth.typeDefs.js';
// import { productsTypeDefs } from '#/modules/products/products.typeDefs.js';
// import { inventoryTypeDefs } from '#/modules/inventory/inventory.typeDefs.js';
// import { ordersTypeDefs } from '#/modules/orders/orders.typeDefs.js';
// import { customersTypeDefs } from '#/modules/customers/customers.typeDefs.js';

import { authResolvers } from '#/modules/auth/auth.resolvers.js';
// import { productsResolvers } from '#/modules/products/products.resolvers.js';
// import { inventoryResolvers } from '#/modules/inventory/inventory.resolvers.js';
// import { ordersResolvers } from '#/modules/orders/orders.resolvers.js';
// import { customersResolvers } from '#/modules/customers/customers.resolvers.js';

const rootTypeDefs = /* GraphQL */ `
  type Query {
    health: String!
  }

  type Mutation {
    _noop: String
  }
`;

const rootResolvers = {
  Query: {
    health: () => 'ok',
  },
};

const typeDefs = mergeTypeDefs([
  rootTypeDefs,
  authTypeDefs,
  // productsTypeDefs,
  // inventoryTypeDefs,
  // ordersTypeDefs,
  // customersTypeDefs,
]);

const resolvers = mergeResolvers([
  rootResolvers,
  authResolvers,
  // productsResolvers,
  // inventoryResolvers,
  // ordersResolvers,
  // customersResolvers,
]);

export const schema = makeExecutableSchema({
  typeDefs,
  resolvers,
});