import type { GraphQLContext } from '#/graphql/context.js';
import { AuthenticationError, AuthorizationError } from '#/shared/errors/index.js';
import type { Role } from '#/modules/auth/auth.types.js';
import {
  addOrderNote,
  assignCustomerToOrder,
  cancelOrder,
  createOrder,
  getCustomerOrders,
  getOrderById,
  getOrderByOrderNumber,
  listOrders,
  updateOrderStatus,
  updatePaymentStatus,
} from '#/modules/orders/order.service.js';

// ─── Auth guards ──────────────────────────────────────────────────────────────
// TODO: extract to src/shared/utils/auth.guards.ts after all modules are built

function requireAuth(context: GraphQLContext): void {
  if (!context.user) {
    throw new AuthenticationError('Authentication required.');
  }
}

function requireRoles(context: GraphQLContext, allowedRoles: Role[]): void {
  requireAuth(context);
  if (!allowedRoles.includes(context.user!.role)) {
    throw new AuthorizationError('You do not have permission to perform this action.');
  }
}

// ─── Role sets ────────────────────────────────────────────────────────────────
// Named constants — role changes are a single-line edit, not a grep-and-replace.
// READ and WRITE are kept separate even though identical in V1 — they may diverge.

const ORDER_READ_ROLES:   Role[] = ['owner', 'admin', 'sales'];
const ORDER_WRITE_ROLES:  Role[] = ['owner', 'admin', 'sales'];
const ORDER_CANCEL_ROLES: Role[] = ['owner', 'admin'];

// ─── Resolvers ────────────────────────────────────────────────────────────────

export const orderResolvers = {
  Query: {
    async order(
      _: unknown,
      args: { orderId: string },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_READ_ROLES);
      return getOrderById({ orderId: args.orderId });
    },

    async orderByOrderNumber(
      _: unknown,
      args: { orderNumber: string },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_READ_ROLES);
      return getOrderByOrderNumber({ orderNumber: args.orderNumber });
    },

    async orders(
      _: unknown,
      args: { filter?: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_READ_ROLES);
      return listOrders(args.filter ?? {});
    },

    async customerOrders(
      _: unknown,
      args: { customerId: string },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_READ_ROLES);
      return getCustomerOrders({ customerId: args.customerId });
    },
  },

  Mutation: {
    async createOrder(
      _: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_WRITE_ROLES);
      return createOrder(args.input, context.user?.id ?? null);
    },

    async updateOrderStatus(
      _: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_WRITE_ROLES);
      return updateOrderStatus(args.input);
    },

    async updatePaymentStatus(
      _: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_WRITE_ROLES);
      return updatePaymentStatus(args.input);
    },

    async cancelOrder(
      _: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_CANCEL_ROLES);
      return cancelOrder(args.input);
    },

    async addOrderNote(
      _: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_WRITE_ROLES);
      return addOrderNote(args.input, context.user?.id ?? null);
    },

    async assignCustomerToOrder(
      _: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_WRITE_ROLES);
      return assignCustomerToOrder(args.input);
    },
  },
};