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
      // boutiqueId is read from the JWT context — never from client args.
      return getOrderById({ orderId: args.orderId }, context.user!.boutiqueId);
    },

    async orderByOrderNumber(
      _: unknown,
      args: { orderNumber: string },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_READ_ROLES);
      // boutiqueId is read from the JWT context — never from client args.
      return getOrderByOrderNumber(
        { orderNumber: args.orderNumber },
        context.user!.boutiqueId,
      );
    },

    async orders(
      _: unknown,
      args: { filter?: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_READ_ROLES);
      // boutiqueId is read from the JWT and applied AFTER the client filter so a
      // client-supplied filter.boutiqueId can never widen the tenant scope.
      const filter = (args.filter ?? {}) as Record<string, unknown>;
      return listOrders({ ...filter, boutiqueId: context.user?.boutiqueId });
    },

    async customerOrders(
      _: unknown,
      args: { customerId: string },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_READ_ROLES);
      return getCustomerOrders(
        { customerId: args.customerId },
        context.user?.boutiqueId,
      );
    },

    async revenueStats(
      _: unknown,
      args: { months?: number },
      context: GraphQLContext,
    ) {
      requireAuth(context);
      return getRevenueStats(args.months ?? 3, context.user?.boutiqueId);
    },

    async revenueDetail(
      _: unknown,
      args: { months?: number; topProductsLimit?: number },
      context: GraphQLContext,
    ) {
      requireAuth(context);
      return getRevenueDetail(
        args.months ?? 12,
        args.topProductsLimit ?? 10,
        context.user?.boutiqueId,
      );
    },
  },

  Mutation: {
    async createOrder(
      _: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_WRITE_ROLES);
      // boutiqueId is read from the JWT and applied AFTER the client input so a
      // client-supplied input.boutiqueId can never create a cross-tenant order.
      const input = (args.input ?? {}) as Record<string, unknown>;
      return createOrder(
        { ...input, boutiqueId: context.user?.boutiqueId },
        context.user?.id ?? null,
      );
    },

    async updateOrderStatus(
      _: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_WRITE_ROLES);
      // boutiqueId is read from the JWT context — never from client args.
      return updateOrderStatus(args.input, context.user!.boutiqueId);
    },

    async updatePaymentStatus(
      _: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_WRITE_ROLES);
      // boutiqueId is read from the JWT context — never from client args.
      return updatePaymentStatus(args.input, context.user!.boutiqueId);
    },

    async cancelOrder(
      _: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_CANCEL_ROLES);
      // boutiqueId is read from the JWT context — never from client args.
      return cancelOrder(args.input, context.user!.boutiqueId);
    },

    async addOrderNote(
      _: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_WRITE_ROLES);
      // boutiqueId is read from the JWT context — never from client args.
      return addOrderNote(
        args.input,
        context.user?.id ?? null,
        context.user!.boutiqueId,
      );
    },

    async assignCustomerToOrder(
      _: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_WRITE_ROLES);
      // boutiqueId is read from the JWT context — never from client args.
      return assignCustomerToOrder(args.input, context.user!.boutiqueId);
    },

    async deleteOrder(
      _: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ) {
      requireRoles(context, ORDER_DELETE_ROLES);
      // boutiqueId is read from the JWT context — never from client args.
      return deleteOrder(args.input, context.user!.boutiqueId);
    },
  },
};