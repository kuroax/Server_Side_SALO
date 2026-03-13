import {
  addStock,
  removeStock,
  getProductInventory,
  getLowStock,
  updateThreshold,
} from '#/modules/inventory/inventory.service.js';
import type { GraphQLContext } from '#/graphql/context.js';
import type { Role } from '#/modules/auth/auth.types.js';
import { AuthorizationError } from '#/shared/errors/index.js';

// ─── Auth Guards ──────────────────────────────────────────────────────────────

const requireAuth = (context: GraphQLContext) => {
  if (!context.user) {
    throw new AuthorizationError('You must be logged in');
  }
  return context.user;
};

const requireRoles = (context: GraphQLContext, roles: Role[]) => {
  const user = requireAuth(context);
  if (!roles.includes(user.role)) {
    throw new AuthorizationError('You do not have permission to perform this action');
  }
  return user;
};

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