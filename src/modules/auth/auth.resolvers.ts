import type { GraphQLContext } from '#/graphql/context.js';
import {
  register,
  login,
  refreshToken,
  changePassword,
  getCurrentUser,
  logoutUser,
} from '#/modules/auth/auth.service.js';
import { requireAuth, requireRoles } from '#/shared/utils/auth.guards.js';
import { ROLES, type Role } from '#/modules/auth/auth.types.js';
import { UserModel } from '#/modules/auth/auth.model.js';

// ─── Resolvers ────────────────────────────────────────────────────────────────

export const authResolvers = {
  Query: {
    me: async (_parent: unknown, _args: unknown, context: GraphQLContext) => {
      if (!context.user) return null;
      return getCurrentUser(context.user.id);
    },
  },

  Mutation: {
    register: async (
      _parent: unknown,
      { input }: { input: Record<string, unknown> },
      context: GraphQLContext,
    ) => {
      const userCount = await UserModel.countDocuments();

      if (userCount === 0) {
        return register(input, null);
      }

      requireRoles(context, [ROLES.OWNER, ROLES.ADMIN] as Role[]);
      return register(input, context.user!.role as Role);
    },

    login: async (
      _parent: unknown,
      { input }: { input: Record<string, unknown> },
    ) => {
      return login(input);
    },

    refreshToken: async (
      _parent: unknown,
      { input }: { input: Record<string, unknown> },
    ) => {
      return refreshToken(input);
    },

    changePassword: async (
      _parent: unknown,
      { input }: { input: Record<string, unknown> },
      context: GraphQLContext,
    ) => {
      requireAuth(context);
      await changePassword(context.user!.id, input);
      return true;
    },

    logout: async (
      _parent: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireAuth(context);
      // Increment tokenVersion — invalidates all outstanding refresh tokens.
      await logoutUser(context.user!.id);
      return true;
    },
  },
};