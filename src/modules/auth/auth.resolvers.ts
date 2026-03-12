import type { GraphQLContext } from '#/graphql/context.js';
import {
  register,
  login,
  refreshToken,
  changePassword,
  getCurrentUser,
} from '#/modules/auth/auth.service.js';
import { AuthenticationError, AuthorizationError } from '#/shared/errors/index.js';
import { ROLES, type Role } from '#/modules/auth/auth.types.js';
import { UserModel } from '#/modules/auth/auth.model.js';

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
      // Allow registration without auth only if no users exist yet (first owner setup)
      const userCount = await UserModel.countDocuments();
      if (userCount === 0) {
        return register(input);
      }

      // After first user exists, require owner or admin
      requireRoles(context, [ROLES.OWNER, ROLES.ADMIN]);
      return register(input);
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
      const user = requireAuth(context);
      await changePassword(user.id, input);
      return true;
    },

    logout: async (
      _parent: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireAuth(context);
      // Reminder: Implement tokenVersion increment in DB here for true revocation
      return true;
    },
  },
};