import { makeExecutableSchema } from '@graphql-tools/schema';
import { mergeTypeDefs, mergeResolvers } from '@graphql-tools/merge';

import { authTypeDefs } from '#/modules/auth/auth.typeDefs.js';
import { authResolvers } from '#/modules/auth/auth.resolvers.js';

import { productTypeDefs } from '#/modules/products/product.typeDefs.js';
import { productResolvers } from '#/modules/products/product.resolvers.js';

import { inventoryTypeDefs } from '#/modules/inventory/inventory.typeDefs.js';
import { inventoryResolvers } from '#/modules/inventory/inventory.resolvers.js';

import { customerTypeDefs } from '#/modules/customers/customer.typeDefs.js';
import { customerResolvers } from '#/modules/customers/customer.resolvers.js';

// ─── Root Types ───────────────────────────────────────────────────────────────

const rootTypeDefs = `#graphql
  type Query
  type Mutation
`;

// ─── Schema ───────────────────────────────────────────────────────────────────

export const schema = makeExecutableSchema({
  typeDefs: mergeTypeDefs([
    rootTypeDefs,
    authTypeDefs,
    productTypeDefs,
    inventoryTypeDefs,
    customerTypeDefs,
  ]),
  resolvers: mergeResolvers([
    authResolvers,
    productResolvers,
    inventoryResolvers,
    customerResolvers,
  ]),
});