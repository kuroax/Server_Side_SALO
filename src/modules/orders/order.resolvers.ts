import type { GraphQLContext } from '#/graphql/context.js';
import type { Role } from '#/modules/auth/auth.types.js';
import { requireAuth, requireRoles } from '#/shared/utils/auth.guards.js';
import {
  addOrderNote,
  assignCustomerToOrder,
  cancelOrder,
  createOrder,
  getCustomerOrders,
  getOrderById,
  getOrderByOrderNumber,
  getRevenueStats,
  getRevenueDetail,
  listOrders,
  updateOrderStatus,
  updatePaymentStatus,
  deleteOrder,
} from '#/modules/orders/order.service.js';

// ─── Role sets ────────────────────────────────────────────────────────────────
// Named constants — role changes are a single-line edit, not a grep-and-replace.
// READ and WRITE are kept separate even though identical in V1 — they may diverge.

const ORDER_READ_ROLES:   Role[] = ['owner', 'admin', 'sales'];
const ORDER_WRITE_ROLES:  Role[] = ['owner', 'admin', 'sales'];
const ORDER_CANCEL_ROLES: Role[] = ['owner', 'admin'];
const ORDER_DELETE_ROLES: Role[] = ['owner'];

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

    async revenueStats(
      _: unknown,
      args: { months?: number },
      context: GraphQLContext,
    ) {
      requireAuth(context);
      return getRevenueStats(args.months ?? 3);
    },

    async revenueDetail(
      _: unknown,
      args: { months?: number; topProductsLimit?: number },
      context: GraphQLContext,
    ) {
      requireAuth(context);
      return getRevenueDetail(args.months ?? 12, args.topProductsLimit ?? 10);
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

    async deleteOrder(
      _: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_DELETE_ROLES);
      return deleteOrder(args.input);
    },
  },
};