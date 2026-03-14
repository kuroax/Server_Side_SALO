import {
  createCustomer,
  getCustomerById,
  getCustomerByPhone,
  listCustomers,
  updateCustomer,
  deactivateCustomer,
  activateCustomer,
} from '#/modules/customers/customer.service.js';
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

// ─── Role Constants ───────────────────────────────────────────────────────────

const CUSTOMER_READERS: Role[] = ['owner', 'admin', 'sales'];
const CUSTOMER_WRITERS: Role[] = ['owner', 'admin', 'sales'];
const CUSTOMER_MANAGERS: Role[] = ['owner', 'admin'];

// ─── Resolvers ────────────────────────────────────────────────────────────────

export const customerResolvers = {
  Query: {
    customer: (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ) => {
      requireRoles(context, CUSTOMER_READERS);
      return getCustomerById({ id: args.id });
    },

    // Returns null if not found — bot-friendly, no error thrown
    customerByPhone: (
      _parent: unknown,
      args: { phone: string },
      context: GraphQLContext,
    ) => {
      requireRoles(context, CUSTOMER_READERS);
      return getCustomerByPhone({ phone: args.phone });
    },

    customers: (
      _parent: unknown,
      args: { input?: unknown },
      context: GraphQLContext,
    ) => {
      requireRoles(context, CUSTOMER_READERS);
      return listCustomers(args.input ?? {});
    },
  },

  Mutation: {
    createCustomer: (
      _parent: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) => {
      requireRoles(context, CUSTOMER_WRITERS);
      return createCustomer(args.input);
    },

    updateCustomer: (
      _parent: unknown,
      args: { id: string; input: unknown },
      context: GraphQLContext,
    ) => {
      requireRoles(context, CUSTOMER_WRITERS);
      return updateCustomer(args.id, args.input);
    },

    // Soft deactivation — owner and admin only
    deactivateCustomer: (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ) => {
      requireRoles(context, CUSTOMER_MANAGERS);
      return deactivateCustomer({ id: args.id });
    },

    activateCustomer: (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ) => {
      requireRoles(context, CUSTOMER_MANAGERS);
      return activateCustomer({ id: args.id });
    },
  },
};