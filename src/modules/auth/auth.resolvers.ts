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
    me: async (_: unknown, __: unknown, context: GraphQLContext) => {
      if (!context.user) return null;
      return getCurrentUser(context.user.id);
    },
  },

  Mutation: {
    register: async (
      _: unknown,
      { input }: { input: Record<string, unknown> },
      context: GraphQLContext,
    ) => {
      requireRoles(context, [ROLES.OWNER, ROLES.ADMIN]);
      return register(input as unknown);
    },

    login: async (
      _: unknown,
      { input }: { input: Record<string, unknown> },
    ) => {
      return login(input as unknown);
    },

    refreshToken: async (
      _: unknown,
      { input }: { input: Record<string, unknown> },
    ) => {
      return refreshToken(input as unknown);
    },

    changePassword: async (
      _: unknown,
      { input }: { input: Record<string, unknown> },
      context: GraphQLContext,
    ) => {
      const user = requireAuth(context);
      await changePassword(user.id, input as unknown);
      return true;
    },

    logout: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext,
    ) => {
      requireAuth(context);
      // Reminder: Implement tokenVersion increment in DB here for true revocation
      return true;
    },
  },
};