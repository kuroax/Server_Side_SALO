import {
  addStock,
  removeStock,
  getProductInventory,
  getLowStock,
  updateThreshold,
} from '#/modules/inventory/inventory.service.js';
import type { GraphQLContext } from '#/graphql/context.js';
import type { Role } from '#/modules/auth/auth.types.js';
import { requireRoles } from '#/shared/utils/auth.guards.js';

// ─── Role constants ───────────────────────────────────────────────────────────

const STOCK_MANAGERS: Role[] = ['owner', 'admin', 'inventory'];

// ─── Resolvers ────────────────────────────────────────────────────────────────

export const inventoryResolvers = {
  Query: {
    // Public — owner app and bots need to check availability without auth
    productInventory: (
      _parent: unknown,
      args: { productId: string },
    ) => {
      return getProductInventory({ productId: args.productId });
    },

    // Protected — internal operational query, not for public consumption
    lowStock: (
      _parent: unknown,
      args: { productId?: string },
      context: GraphQLContext,
    ) => {
      requireRoles(context, STOCK_MANAGERS);
      return getLowStock({ productId: args.productId });
    },
  },

  Mutation: {
    addStock: (
      _parent: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) => {
      requireRoles(context, STOCK_MANAGERS);
      return addStock(args.input);
    },

    removeStock: (
      _parent: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) => {
      requireRoles(context, STOCK_MANAGERS);
      return removeStock(args.input);
    },

    updateThreshold: (
      _parent: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) => {
      requireRoles(context, STOCK_MANAGERS);
      return updateThreshold(args.input);
    },
  },
};