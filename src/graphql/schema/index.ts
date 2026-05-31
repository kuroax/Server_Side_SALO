import { makeExecutableSchema } from '@graphql-tools/schema';

import { authTypeDefs }      from '#/modules/auth/auth.typeDefs.js';
import { authResolvers }     from '#/modules/auth/auth.resolvers.js';

import { productTypeDefs }   from '#/modules/products/product.typeDefs.js';
import { productResolvers }  from '#/modules/products/product.resolvers.js';

import { inventoryTypeDefs }  from '#/modules/inventory/inventory.typeDefs.js';
import { inventoryResolvers } from '#/modules/inventory/inventory.resolvers.js';

import { customerTypeDefs }  from '#/modules/customers/customer.typeDefs.js';
import { customerResolvers } from '#/modules/customers/customer.resolvers.js';

import { orderTypeDefs }     from '#/modules/orders/order.typeDefs.js';
import { orderResolvers }    from '#/modules/orders/order.resolvers.js';

import { conversationStateTypeDefs }  from '#/modules/conversationState/conversationState.typeDefs.js';
import { conversationStateResolvers } from '#/modules/conversationState/conversationState.resolvers.js';

import { prospectTypeDefs }  from '#/modules/prospect/prospect.typeDefs.js';
import { prospectResolvers } from '#/modules/prospect/prospect.resolvers.js';

// Root types — every module extends these via `extend type Query / Mutation`
const rootTypeDefs = /* #graphql */ `
  type Query
  type Mutation
`;

export const schema = makeExecutableSchema({
  typeDefs: [
    rootTypeDefs,
    authTypeDefs,
    productTypeDefs,
    inventoryTypeDefs,
    customerTypeDefs,
    orderTypeDefs,
    conversationStateTypeDefs,
    prospectTypeDefs,
  ],
  resolvers: [
    authResolvers,
    productResolvers,
    inventoryResolvers,
    customerResolvers,
    orderResolvers,
    conversationStateResolvers,
    prospectResolvers,
  ],
});