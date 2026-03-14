import type { GraphQLContext } from '#/graphql/context.js';
import {
  createProduct,
  getProductById,
  getProductBySlug,
  listProducts,
  updateProduct,
  deleteProduct,
} from '#/modules/products/product.service.js';
import { requireRoles } from '#/shared/utils/auth.guards.js';
import { ROLES, type Role } from '#/modules/auth/auth.types.js';

// ─── Resolvers ────────────────────────────────────────────────────────────────

export const productResolvers = {
  Query: {
    product: (
      _parent: unknown,
      { id }: { id: string },
    ) => {
      return getProductById({ id });
    },

    productBySlug: (
      _parent: unknown,
      { slug }: { slug: string },
    ) => {
      return getProductBySlug(slug);
    },

    products: (
      _parent: unknown,
      { filters }: { filters?: Record<string, unknown> },
    ) => {
      return listProducts(filters ?? {});
    },
  },

  Mutation: {
    createProduct: (
      _parent: unknown,
      { input }: { input: Record<string, unknown> },
      context: GraphQLContext,
    ) => {
      requireRoles(context, [ROLES.OWNER, ROLES.ADMIN, ROLES.INVENTORY] as Role[]);
      return createProduct(input);
    },

    updateProduct: (
      _parent: unknown,
      { id, input }: { id: string; input: Record<string, unknown> },
      context: GraphQLContext,
    ) => {
      requireRoles(context, [ROLES.OWNER, ROLES.ADMIN, ROLES.INVENTORY] as Role[]);
      return updateProduct(id, input);
    },

    deleteProduct: (
      _parent: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireRoles(context, [ROLES.OWNER, ROLES.ADMIN] as Role[]);
      return deleteProduct({ id });
    },
  },
};