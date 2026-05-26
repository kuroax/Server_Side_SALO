import {
  addStock,
  removeStock,
  getProductInventory,
  getLowStock,
  updateThreshold,
} from '#/modules/inventory/inventory.service.js';
import type { GraphQLContext } from '#/graphql/context.js';
import type { Role } from '#/modules/auth/auth.types.js';
import { requireAuth, requireRoles } from '#/shared/utils/auth.guards.js';

// ─── Role constants ───────────────────────────────────────────────────────────

const STOCK_MANAGERS: Role[] = ['owner', 'admin', 'inventory'];

// boutiqueId for every inventory call is taken from context.user — never from
// client args — so a caller cannot inspect or mutate another tenant's stock.

// ─── Resolvers ────────────────────────────────────────────────────────────────

export const inventoryResolvers = {
  Query: {
    // Authenticated — every read is scoped to the caller's boutique.
    productInventory: (
      _parent: unknown,
      args: { productId: string },
      context: GraphQLContext,
    ) => {
      requireAuth(context);
      return getProductInventory({
        productId: args.productId,
        boutiqueId: context.user!.boutiqueId,
      });
    },

    // Protected — internal operational query, not for public consumption
    lowStock: (
      _parent: unknown,
      args: { productId?: string },
      context: GraphQLContext,
    ) => {
      requireRoles(context, STOCK_MANAGERS);
      return getLowStock({
        productId: args.productId,
        boutiqueId: context.user!.boutiqueId,
      });
    },
  },

  Mutation: {
    addStock: (
      _parent: unknown,
      args: { input: Record<string, unknown> },
      context: GraphQLContext,
    ) => {
      requireRoles(context, STOCK_MANAGERS);
      return addStock({ ...args.input, boutiqueId: context.user!.boutiqueId });
    },

    removeStock: (
      _parent: unknown,
      args: { input: Record<string, unknown> },
      context: GraphQLContext,
    ) => {
      requireRoles(context, STOCK_MANAGERS);
      return removeStock({ ...args.input, boutiqueId: context.user!.boutiqueId });
    },

    updateThreshold: (
      _parent: unknown,
      args: { input: Record<string, unknown> },
      context: GraphQLContext,
    ) => {
      requireRoles(context, STOCK_MANAGERS);
      return updateThreshold({ ...args.input, boutiqueId: context.user!.boutiqueId });
    },
  },
};