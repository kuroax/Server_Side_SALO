import type { GraphQLContext } from '#/graphql/context.js';
import {
  createProduct,
  getProductById,
  getProductBySlug,
  listProducts,
  updateProduct,
  deleteProduct,
} from '#/modules/products/product.service.js';
import { AuthenticationError, AuthorizationError } from '#/shared/errors/index.js';
import { ROLES, type Role } from '#/modules/auth/auth.types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const requireAuth = (context: GraphQLContext) => {
  if (!context.user) {
    throw new AuthenticationError('You must be logged in');
  }
  return context.user;
};

const requireRoles = (context: GraphQLContext, roles: Role[]) => {
  const user = requireAuth(context);
  if (!roles.includes(user.role as Role)) {
    throw new AuthorizationError();
  }
  return user;
};

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
      requireRoles(context, [ROLES.OWNER, ROLES.ADMIN, ROLES.INVENTORY]);
      return createProduct(input);
    },

    updateProduct: (
      _parent: unknown,
      { id, input }: { id: string; input: Record<string, unknown> },
      context: GraphQLContext,
    ) => {
      requireRoles(context, [ROLES.OWNER, ROLES.ADMIN, ROLES.INVENTORY]);
      return updateProduct(id, input);
    },

    deleteProduct: (
      _parent: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireRoles(context, [ROLES.OWNER, ROLES.ADMIN]);
      return deleteProduct({ id });
    },
  },
};