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
import { requireRoles } from '#/shared/utils/auth.guards.js';

// ─── Role constants ───────────────────────────────────────────────────────────

const CUSTOMER_READERS:  Role[] = ['owner', 'admin', 'sales'];
const CUSTOMER_WRITERS:  Role[] = ['owner', 'admin', 'sales'];
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