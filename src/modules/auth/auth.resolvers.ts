import type { GraphQLContext } from '#/graphql/context.js';
import {
  register,
  login,
  refreshToken,
  changePassword,
  getCurrentUser,
  listUsers,
  deactivateUser,
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

    listUsers: async (
      _parent: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      // Owner and admin only — helpers cannot see the team list
      requireRoles(context, [ROLES.OWNER, ROLES.ADMIN] as Role[]);
      return listUsers(context.user!.id);
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
        // Bootstrap — first owner, no auth required.
        // callerRole null signals bootstrap path to the service.
        return register(input, null);
      }

      // All subsequent registrations require owner or admin at the resolver layer.
      // The service enforces this independently as a second layer of defence.
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
      // TODO (Phase B): Increment user.tokenVersion here for full revocation.
      return true;
    },

    deactivateUser: async (
      _parent: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      // Owner and admin only
      requireRoles(context, [ROLES.OWNER, ROLES.ADMIN] as Role[]);
      return deactivateUser(id, context.user!.id);
    },
  },
};