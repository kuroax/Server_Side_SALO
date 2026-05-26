import type { GraphQLContext } from '#/graphql/context.js';
import {
  createProduct,
  getProductById,
  getProductBySlug,
  listProducts,
  updateProduct,
  deleteProduct,
} from '#/modules/products/product.service.js';
import { requireAuth, requireRoles } from '#/shared/utils/auth.guards.js';
import { ROLES, type Role } from '#/modules/auth/auth.types.js';

// ─── Resolvers ────────────────────────────────────────────────────────────────

export const productResolvers = {
  Query: {
    product: (
      _parent: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireAuth(context);
      return getProductById({ id, boutiqueId: context.user!.boutiqueId });
    },

    productBySlug: (
      _parent: unknown,
      { slug }: { slug: string },
      context: GraphQLContext,
    ) => {
      requireAuth(context);
      return getProductBySlug({ slug, boutiqueId: context.user!.boutiqueId });
    },

    products: (
      _parent: unknown,
      { filters }: { filters?: Record<string, unknown> },
      context: GraphQLContext,
    ) => {
      requireAuth(context);
      // boutiqueId is injected from context — any client-supplied boutiqueId
      // in `filters` is overridden so callers cannot read another tenant's data.
      return listProducts({
        ...(filters ?? {}),
        boutiqueId: context.user!.boutiqueId,
      });
    },
  },

  Mutation: {
    createProduct: (
      _parent: unknown,
      { input }: { input: Record<string, unknown> },
      context: GraphQLContext,
    ) => {
      requireRoles(context, [ROLES.OWNER, ROLES.ADMIN, ROLES.INVENTORY] as Role[]);
      // boutiqueId is injected from context — never accepted from client input.
      return createProduct({
        ...input,
        boutiqueId: context.user!.boutiqueId,
      });
    },

    updateProduct: (
      _parent: unknown,
      { id, input }: { id: string; input: Record<string, unknown> },
      context: GraphQLContext,
    ) => {
      requireRoles(context, [ROLES.OWNER, ROLES.ADMIN, ROLES.INVENTORY] as Role[]);
      return updateProduct(id, context.user!.boutiqueId, input);
    },

    deleteProduct: (
      _parent: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireRoles(context, [ROLES.OWNER, ROLES.ADMIN] as Role[]);
      return deleteProduct({ id, boutiqueId: context.user!.boutiqueId });
    },
  },
};