import mongoose, { Types } from "mongoose";
import { logger } from "#/config/logger.js";
import { BadRequestError, NotFoundError } from "#/shared/errors/index.js";
import { OrderModel } from "#/modules/orders/order.model.js";
import { CounterModel } from "#/shared/models/counter.model.js";
import { ProductModel } from "#/modules/products/product.model.js";
import { CustomerModel } from "#/modules/customers/customer.model.js";
import { InventoryModel } from "#/modules/inventory/inventory.model.js";
import { ORDER_NUMBER_PREFIX } from "#/modules/orders/order.types.js";
import type {
  OrderChannel,
  OrderItemSnapshot,
  OrderNote,
  OrderNoteKind,
  OrderStatus,
  PaymentStatus,
  SafeOrder,
} from "#/modules/orders/order.types.js";
import {
  addOrderNoteSchema,
  assignCustomerSchema,
  cancelOrderSchema,
  createOrderSchema,
  getCustomerOrdersSchema,
  getOrderByIdSchema,
  getOrderByOrderNumberSchema,
  orderFilterSchema,
  updateOrderStatusSchema,
  updatePaymentStatusSchema,
} from "#/modules/orders/order.validation.js";

// ─── State machine ────────────────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

function assertValidTransition(from: OrderStatus, to: OrderStatus): void {
  if (!VALID_TRANSITIONS[from].includes(to)) {
    throw new BadRequestError(
      `Cannot transition order from '${from}' to '${to}'`,
    );
  }
}

// ─── System note helper ───────────────────────────────────────────────────────

function makeSystemNote(message: string): {
  message: string;
  createdBy: null;
  kind: "system";
  createdAt: Date;
} {
  return { message, createdBy: null, kind: "system", createdAt: new Date() };
}

// ─── Financial computation ────────────────────────────────────────────────────

type EnrichedOrderItem = {
  productId: string;
  productName: string;
  productSlug: string;
  size: string;
  color: string;
  quantity: number;
  unitPrice: number;
};

type ComputedOrderItem = EnrichedOrderItem & { lineTotal: number };

function computeOrderFinancials(items: EnrichedOrderItem[]): {
  items: ComputedOrderItem[];
  subtotal: number;
  total: number;
} {
  const computed: ComputedOrderItem[] = items.map((item) => ({
    ...item,
    lineTotal: item.quantity * item.unitPrice,
  }));
  const subtotal = computed.reduce((sum, item) => sum + item.lineTotal, 0);
  const total = subtotal;
  return { items: computed, subtotal, total };
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

type OrderItemLike = {
  productId: Types.ObjectId;
  productName: string;
  productSlug: string;
  size: string;
  color: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

type OrderNoteLike = {
  message: string;
  createdBy: Types.ObjectId | null;
  kind: string;
  createdAt: Date;
};

type OrderLike = {
  _id: Types.ObjectId;
  orderNumber: string;
  customerId: Types.ObjectId | null;
  channel: string;
  sourceMessageId?: string | null;
  status: string;
  paymentStatus: string;
  items: OrderItemLike[];
  notes: OrderNoteLike[];
  subtotal: number;
  total: number;
  inventoryApplied: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function mapNote(raw: OrderNoteLike): OrderNote {
  return {
    message: raw.message,
    createdBy: raw.createdBy ? raw.createdBy.toString() : null,
    kind: raw.kind as OrderNoteKind,
    createdAt: raw.createdAt.toISOString(),
  };
}

function mapOrder(raw: OrderLike): SafeOrder {
  return {
    id: raw._id.toString(),
    orderNumber: raw.orderNumber,
    customerId: raw.customerId ? raw.customerId.toString() : null,
    channel: raw.channel as OrderChannel,
    sourceMessageId: raw.sourceMessageId ?? null,
    status: raw.status as OrderStatus,
    paymentStatus: raw.paymentStatus as PaymentStatus,
    items: raw.items.map(
      (item): OrderItemSnapshot => ({
        productId: item.productId.toString(),
        productName: item.productName,
        productSlug: item.productSlug,
        size: item.size,
        color: item.color,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineTotal: item.lineTotal,
      }),
    ),
    notes: (raw.notes ?? []).map(mapNote),
    subtotal: raw.subtotal,
    total: raw.total,
    inventoryApplied: raw.inventoryApplied,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
  };
}

// ─── Duplicate-key helpers ────────────────────────────────────────────────────

function isMongoDuplicateKeyError(
  err: unknown,
): err is { code: number; keyPattern?: Record<string, unknown> } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === 11000
  );
}

async function resolveCreateOrderDuplicate(
  err: unknown,
  args: { channel: OrderChannel; sourceMessageId: string | null },
): Promise<SafeOrder | null> {
  if (!isMongoDuplicateKeyError(err)) throw err;

  const kp = err.keyPattern ?? {};

  if (kp.orderNumber) {
    throw new BadRequestError("Order number collision — please retry");
  }

  if (
    args.sourceMessageId &&
    (kp.sourceMessageId || (kp.channel && kp.sourceMessageId))
  ) {
    const existing = await OrderModel.findOne({
      channel: args.channel,
      sourceMessageId: args.sourceMessageId,
    }).lean<OrderLike>();

    if (existing) {
      logger.warn(
        {
          channel: args.channel,
          sourceMessageId: args.sourceMessageId,
          orderNumber: existing.orderNumber,
        },
        "Duplicate createOrder request resolved by returning existing order",
      );
      return mapOrder(existing);
    }

    throw new BadRequestError(
      "Duplicate source message detected, but existing order lookup failed",
    );
  }

  throw err;
}

// ─── Lifetime value helper ────────────────────────────────────────────────────

// Keeps customer.lifetimeValue in sync whenever an order is created or cancelled.
// Non-fatal: a failure here never affects the order operation itself.
//
// Rules:
//   +total on createOrder  (new order only — not duplicate recovery)
//   -total on cancelOrder  (regardless of payment status)
//   -total on deleteOrder  (only when status !== 'cancelled')
//
// $inc on an undefined field sets it to the delta — correct for first-time
// customers where lifetimeValue starts as undefined (not 0).
async function safeUpdateLifetimeValue(
  customerId: Types.ObjectId | null | undefined,
  delta: number,
  context: string,
): Promise<void> {
  if (!customerId) return;
  try {
    await CustomerModel.updateOne(
      { _id: customerId },
      { $inc: { lifetimeValue: delta } },
    );
    logger.info({ customerId: customerId.toString(), delta }, context);
  } catch (err) {
    // Non-fatal: LTV cache may be temporarily stale but the order operation
    // must never fail because of a secondary write.
    logger.warn(
      { err, customerId: customerId.toString(), delta },
      `${context} — LTV update failed (non-fatal)`,
    );
  }
}

// ─── Order number generation ──────────────────────────────────────────────────

async function buildUniqueOrderNumber(): Promise<string> {
  const counter = await CounterModel.findOneAndUpdate(
    { _id: "orderNumber" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  ).lean<{ seq: number } | null>();

  if (!counter) throw new Error("Failed to generate order number");

  return `${ORDER_NUMBER_PREFIX}-${counter.seq}`;
}

// ─── Product snapshot helper ──────────────────────────────────────────────────

type ProductSnapshotLike = {
  _id: Types.ObjectId;
  name: string;
  slug: string;
};

async function fetchProductSnapshots(
  productIds: string[],
  boutiqueId?: string,
): Promise<Map<string, { name: string; slug: string }>> {
  const uniqueIds = [...new Set(productIds)];
  const objectIds = uniqueIds.map((id) => new Types.ObjectId(id));

  // Multi-tenant guard: when boutiqueId is supplied, only resolve products that
  // belong to that boutique so one tenant's products cannot be snapshotted into
  // another tenant's order. Optional to stay backward-compatible with callers
  // that have not yet been scoped (the missing-id check below still fires).
  const filter: Record<string, unknown> = { _id: { $in: objectIds } };
  if (boutiqueId) filter.boutiqueId = new Types.ObjectId(boutiqueId);

  const products = await ProductModel.find(filter)
    .select("name slug")
    .lean<ProductSnapshotLike[]>();

  const found = new Map(
    products.map((p) => [p._id.toString(), { name: p.name, slug: p.slug }]),
  );

  for (const id of uniqueIds) {
    if (!found.has(id)) throw new NotFoundError(`Product not found: ${id}`);
  }

  return found;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function getOrderById(input: unknown): Promise<SafeOrder> {
  const { orderId } = getOrderByIdSchema.parse(input);
  const order = await OrderModel.findById(orderId).lean<OrderLike>();
  if (!order) throw new NotFoundError("Order not found");
  return mapOrder(order);
}

export async function getOrderByOrderNumber(
  input: unknown,
): Promise<SafeOrder> {
  const { orderNumber } = getOrderByOrderNumberSchema.parse(input);
  const order = await OrderModel.findOne({ orderNumber }).lean<OrderLike>();
  if (!order) throw new NotFoundError("Order not found");
  return mapOrder(order);
}

export async function listOrders(input: unknown): Promise<SafeOrder[]> {
  const filter = orderFilterSchema.parse(input);
  const query: Record<string, unknown> = {};

  if (filter.boutiqueId)
    query.boutiqueId = new Types.ObjectId(filter.boutiqueId);
  if (filter.customerId)
    query.customerId = new Types.ObjectId(filter.customerId);
  if (filter.status) query.status = filter.status;
  if (filter.paymentStatus) query.paymentStatus = filter.paymentStatus;
  if (filter.channel) query.channel = filter.channel;

  const orders = await OrderModel.find(query)
    .sort({ createdAt: -1 })
    .skip(filter.skip)
    .limit(filter.limit)
    .lean<OrderLike[]>();

  return orders.map(mapOrder);
}

export async function getCustomerOrders(
  input: unknown,
  boutiqueId?: string,
): Promise<SafeOrder[]> {
  const { customerId } = getCustomerOrdersSchema.parse(input);

  // Multi-tenant guard: when boutiqueId is supplied, scope the lookup so a
  // customerId from another tenant cannot resolve cross-boutique orders.
  const query: Record<string, unknown> = {
    customerId: new Types.ObjectId(customerId),
  };
  if (boutiqueId) query.boutiqueId = new Types.ObjectId(boutiqueId);

  const orders = await OrderModel.find(query)
    .sort({ createdAt: -1 })
    .lean<OrderLike[]>();

  return orders.map(mapOrder);
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export async function createOrder(
  input: unknown,
  createdBy: string | null,
  sourceMessageId: string | null = null,
): Promise<SafeOrder> {
  const data = createOrderSchema.parse(input);

  const normalizedSourceMessageId =
    typeof sourceMessageId === "string" && sourceMessageId.trim()
      ? sourceMessageId.trim()
      : null;

  if (data.customerId) {
    const customerExists = await CustomerModel.exists({
      _id: new Types.ObjectId(data.customerId),
    });
    if (!customerExists) throw new NotFoundError("Customer not found");
  }

  const productIds = data.items.map((item) => item.productId);
  const snapshots = await fetchProductSnapshots(productIds, data.boutiqueId);

  const enrichedItems = data.items.map((item) => ({
    ...item,
    productName: snapshots.get(item.productId)!.name,
    productSlug: snapshots.get(item.productId)!.slug,
  }));

  const {
    items: computedItems,
    subtotal,
    total,
  } = computeOrderFinancials(enrichedItems);

  const orderNumber = await buildUniqueOrderNumber();

  const initialNotes = [
    ...data.notes.map((note) => ({
      message: note.message,
      createdBy: createdBy ? new Types.ObjectId(createdBy) : null,
      kind: note.kind,
      createdAt: new Date(),
    })),
    makeSystemNote("Order created."),
  ];

  const order = new OrderModel({
    orderNumber,
    boutiqueId: data.boutiqueId ? new Types.ObjectId(data.boutiqueId) : undefined,
    customerId: data.customerId ? new Types.ObjectId(data.customerId) : null,
    channel: data.channel,
    sourceMessageId: normalizedSourceMessageId,
    notes: initialNotes,
    subtotal,
    total,
    items: computedItems.map((item) => ({
      productId: new Types.ObjectId(item.productId),
      productName: item.productName,
      productSlug: item.productSlug,
      size: item.size,
      color: item.color,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
    })),
  });

  try {
    await order.save();
  } catch (err) {
    const recovered = await resolveCreateOrderDuplicate(err, {
      channel: data.channel,
      sourceMessageId: normalizedSourceMessageId,
    });

    if (recovered) return recovered;
    throw err;
  }

  logger.info(
    {
      orderId: order._id.toString(),
      orderNumber,
      channel: data.channel,
      sourceMessageId: normalizedSourceMessageId,
    },
    "Order created",
  );

  return mapOrder(order.toObject() as OrderLike);
}

export async function updateOrderStatus(input: unknown): Promise<SafeOrder> {
  const { orderId, status } = updateOrderStatusSchema.parse(input);

  // Cancellation must go through cancelOrder so inventory restoration and
  // lifetime value decrement run together. Allowing cancellation via this
  // endpoint silently corrupts both inventory and the cached LTV.
  if (status === "cancelled") {
    throw new BadRequestError(
      "Use cancelOrder to cancel an order — updateOrderStatus does not run inventory restoration or lifetime value decrement.",
    );
  }

  const order = await OrderModel.findById(orderId);
  if (!order) throw new NotFoundError("Order not found");

  assertValidTransition(order.status as OrderStatus, status);

  if (status === "confirmed" && !order.inventoryApplied) {
    // Pre-check + deduct loops run inside a single MongoDB transaction so
    // partial deductions cannot stick if any item fails. Throws inside the
    // callback abort the transaction and roll back every prior deduction
    // atomically — no manual per-item rollback needed.
    //
    // Requires a replica set / Atlas. If the connection is not replica-set
    // aware, withTransaction throws a clear MongoServerError at runtime.
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const insufficientItems: string[] = [];

        for (const item of order.items) {
          const current = await InventoryModel.findOne({
            productId: item.productId,
            size: item.size,
            color: item.color,
          })
            .select("quantity")
            .session(session)
            .lean<{ quantity: number } | null>();

          if (!current || current.quantity < item.quantity) {
            const available = current?.quantity ?? 0;
            insufficientItems.push(
              `${item.productName} (${item.size} · ${item.color}): requested ${item.quantity}, available ${available}`,
            );
          }
        }

        if (insufficientItems.length > 0) {
          throw new BadRequestError(
            `Insufficient stock for: ${insufficientItems.join("; ")}`,
          );
        }

        for (const item of order.items) {
          const result = await InventoryModel.findOneAndUpdate(
            {
              productId: item.productId,
              size: item.size,
              color: item.color,
              quantity: { $gte: item.quantity },
            },
            { $inc: { quantity: -item.quantity } },
            { new: true, session },
          ).lean();

          if (!result) {
            const current = await InventoryModel.findOne({
              productId: item.productId,
              size: item.size,
              color: item.color,
            })
              .select("quantity")
              .session(session)
              .lean<{ quantity: number } | null>();

            const available = current?.quantity ?? 0;
            throw new BadRequestError(
              `Insufficient stock for ${item.productName} (${item.size} · ${item.color}): requested ${item.quantity}, available ${available}`,
            );
          }
        }
      });
    } finally {
      await session.endSession();
    }

    order.inventoryApplied = true;
    order.notes.push(
      makeSystemNote("Inventory deducted on order confirmation."),
    );
    logger.info(
      { orderId, items: order.items.length },
      "Inventory deducted on confirm",
    );
  }

  order.status = status;
  order.notes.push(makeSystemNote(`Order status changed to '${status}'.`));
  await order.save();

  logger.info({ orderId, status }, "Order status updated");
  return mapOrder(order.toObject() as OrderLike);
}

export async function updatePaymentStatus(input: unknown): Promise<SafeOrder> {
  const { orderId, paymentStatus } = updatePaymentStatusSchema.parse(input);

  const order = await OrderModel.findById(orderId);
  if (!order) throw new NotFoundError("Order not found");

  if (order.status === "cancelled") {
    throw new BadRequestError(
      "Cannot update payment status of a cancelled order",
    );
  }

  // Capture the status before mutating so the guard below compares against the
  // pre-update value (avoids double-counting if called with "paid" twice).
  const previousPaymentStatus = order.paymentStatus;

  order.paymentStatus = paymentStatus;
  order.notes.push(
    makeSystemNote(`Payment status changed to '${paymentStatus}'.`),
  );
  await order.save();

  // Increment lifetimeValue only when payment is fully confirmed.
  // Partial payments are tracked via outstandingBalance — not LTV.
  if (paymentStatus === "paid" && previousPaymentStatus !== "paid") {
    await safeUpdateLifetimeValue(
      order.customerId,
      order.total,
      "Payment confirmed — incremented customer lifetimeValue",
    );
  }

  logger.info({ orderId, paymentStatus }, "Order payment status updated");
  return mapOrder(order.toObject() as OrderLike);
}

export async function cancelOrder(input: unknown): Promise<SafeOrder> {
  const { orderId } = cancelOrderSchema.parse(input);

  const order = await OrderModel.findById(orderId);
  if (!order) throw new NotFoundError("Order not found");

  assertValidTransition(order.status as OrderStatus, "cancelled");

  order.status = "cancelled";
  order.notes.push(makeSystemNote("Order cancelled."));

  if (order.inventoryApplied) {
    for (const item of order.items) {
      await InventoryModel.findOneAndUpdate(
        { productId: item.productId, size: item.size, color: item.color },
        { $inc: { quantity: item.quantity } },
        { new: true },
      ).lean();
    }
    order.inventoryApplied = false;
    order.notes.push(makeSystemNote("Inventory restored on cancellation."));
    logger.info(
      { orderId, items: order.items.length },
      "Inventory restored on cancel",
    );
  }

  await order.save();

  logger.info({ orderId }, "Order cancelled");

  // Only decrement lifetimeValue if the payment was confirmed —
  // unpaid orders were never counted so there is nothing to reverse.
  if (order.paymentStatus === "paid") {
    await safeUpdateLifetimeValue(
      order.customerId,
      -order.total,
      "Order cancelled after payment — decremented customer lifetimeValue",
    );
  }
  return mapOrder(order.toObject() as OrderLike);
}

export async function addOrderNote(
  input: unknown,
  createdBy: string | null,
): Promise<SafeOrder> {
  const { orderId, note } = addOrderNoteSchema.parse(input);

  const noteDoc = {
    message: note.message,
    createdBy: createdBy ? new Types.ObjectId(createdBy) : null,
    kind: note.kind,
    createdAt: new Date(),
  };

  const order = await OrderModel.findByIdAndUpdate(
    orderId,
    { $push: { notes: noteDoc } },
    { new: true },
  ).lean<OrderLike>();

  if (!order) throw new NotFoundError("Order not found");

  logger.info({ orderId, kind: note.kind }, "Note added to order");
  return mapOrder(order);
}

export async function assignCustomerToOrder(
  input: unknown,
): Promise<SafeOrder> {
  const { orderId, customerId } = assignCustomerSchema.parse(input);

  const customerExists = await CustomerModel.exists({
    _id: new Types.ObjectId(customerId),
  });
  if (!customerExists) throw new NotFoundError("Customer not found");

  const order = await OrderModel.findById(orderId);
  if (!order) throw new NotFoundError("Order not found");

  // The guard below confirms the order had no customer before this call —
  // otherwise the BadRequestError fires and we never reach the LTV credit.
  if (order.customerId !== null) {
    throw new BadRequestError("Order already has a customer assigned");
  }

  order.customerId = new Types.ObjectId(customerId);
  order.notes.push(makeSystemNote("Customer assigned to order."));
  await order.save();

  logger.info({ orderId, customerId }, "Customer assigned to order");

  // Credit the cached lifetime value now that the order finally has a customer.
  // Bot-originated orders are commonly created without a customerId; without
  // this credit the customer's lifetimeValue permanently understates VIP context.
  // Skip cancelled orders — those should not contribute to LTV.
  if (order.status !== "cancelled") {
    await safeUpdateLifetimeValue(
      order.customerId,
      order.total,
      "Customer assigned to order — credited customer lifetimeValue",
    );
  }

  return mapOrder(order.toObject() as OrderLike);
}

export async function deleteOrder(input: unknown): Promise<boolean> {
  const { orderId } = cancelOrderSchema.parse(input);

  const order = await OrderModel.findById(orderId);
  if (!order) throw new NotFoundError("Order not found");

  if (order.inventoryApplied) {
    for (const item of order.items) {
      await InventoryModel.findOneAndUpdate(
        { productId: item.productId, size: item.size, color: item.color },
        { $inc: { quantity: item.quantity } },
        { new: true },
      ).lean();
    }
    logger.info(
      { orderId, items: order.items.length },
      "Inventory restored on delete",
    );
  }

  await OrderModel.findByIdAndDelete(orderId);

  logger.info(
    { orderId, orderNumber: order.orderNumber },
    "Order hard-deleted",
  );

  // Decrement LTV only if not already cancelled (cancelOrder decrements on cancel).
  if (order.status !== "cancelled") {
    await safeUpdateLifetimeValue(
      order.customerId,
      -order.total,
      "Order hard-deleted (non-cancelled) — decremented customer lifetimeValue",
    );
  }
  return true;
}

// ─── Revenue stats ────────────────────────────────────────────────────────────

type MonthRevenue = {
  year: number;
  month: number;
  label: string;
  revenue: number;
  orderCount: number;
};

export async function getRevenueStats(
  months = 3,
  boutiqueId?: string,
): Promise<MonthRevenue[]> {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

  // Multi-tenant scope: when supplied, restrict the aggregation to one boutique
  // so revenue is not summed across every tenant in the dashboard.
  const match: Record<string, unknown> = {
    createdAt: { $gte: from },
    status: { $ne: "cancelled" },
  };
  if (boutiqueId) match.boutiqueId = new Types.ObjectId(boutiqueId);

  const raw = await OrderModel.aggregate<{
    _id: { year: number; month: number };
    revenue: number;
    orderCount: number;
  }>([
    {
      $match: match,
    },
    {
      $group: {
        _id: {
          year: { $year: "$createdAt" },
          month: { $month: "$createdAt" },
        },
        revenue: { $sum: "$total" },
        orderCount: { $sum: 1 },
      },
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } },
  ]);

  const series: MonthRevenue[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const found = raw.find((r) => r._id.year === year && r._id.month === month);
    series.push({
      year,
      month,
      label: d.toLocaleDateString("es-MX", { month: "short", year: "numeric" }),
      revenue: found?.revenue ?? 0,
      orderCount: found?.orderCount ?? 0,
    });
  }

  return series;
}

// ─── Revenue detail ───────────────────────────────────────────────────────────

type ProductRevenueResult = {
  productId: string;
  productName: string;
  revenue: number;
  unitsSold: number;
};

type RevenueDetailResult = {
  monthlyStats: MonthRevenue[];
  paymentBreakdown: {
    paid: { count: number; revenue: number };
    partial: { count: number; revenue: number };
    unpaid: { count: number; revenue: number };
  };
  topProducts: ProductRevenueResult[];
};

export async function getRevenueDetail(
  months = 12,
  topProductsLimit = 10,
  boutiqueId?: string,
): Promise<RevenueDetailResult> {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

  // Multi-tenant scope applied to all three pipelines below. When supplied,
  // each $match also filters by boutiqueId so monthly stats, payment breakdown,
  // and top products are scoped to one tenant instead of aggregating globally.
  const boutiqueMatch: Record<string, unknown> = boutiqueId
    ? { boutiqueId: new Types.ObjectId(boutiqueId) }
    : {};

  const monthlyRaw = await OrderModel.aggregate<{
    _id: { year: number; month: number };
    revenue: number;
    orderCount: number;
  }>([
    {
      $match: {
        ...boutiqueMatch,
        createdAt: { $gte: from },
        status: { $ne: "cancelled" },
      },
    },
    {
      $group: {
        _id: {
          year: { $year: "$createdAt" },
          month: { $month: "$createdAt" },
        },
        revenue: { $sum: "$total" },
        orderCount: { $sum: 1 },
      },
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } },
  ]);

  const monthlyStats: MonthRevenue[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const found = monthlyRaw.find(
      (r) => r._id.year === year && r._id.month === month,
    );
    monthlyStats.push({
      year,
      month,
      label: d.toLocaleDateString("es-MX", { month: "short", year: "numeric" }),
      revenue: found?.revenue ?? 0,
      orderCount: found?.orderCount ?? 0,
    });
  }

  const paymentRaw = await OrderModel.aggregate<{
    _id: string;
    count: number;
    revenue: number;
  }>([
    { $match: { ...boutiqueMatch, status: { $ne: "cancelled" } } },
    {
      $group: {
        _id: "$paymentStatus",
        count: { $sum: 1 },
        revenue: { $sum: "$total" },
      },
    },
  ]);

  const getBreakdown = (status: string) => {
    const found = paymentRaw.find((r) => r._id === status);
    return { count: found?.count ?? 0, revenue: found?.revenue ?? 0 };
  };

  const productsRaw = await OrderModel.aggregate<{
    _id: { productId: string; productName: string };
    revenue: number;
    unitsSold: number;
  }>([
    { $match: { ...boutiqueMatch, status: { $ne: "cancelled" } } },
    { $unwind: "$items" },
    {
      $group: {
        _id: {
          productId: { $toString: "$items.productId" },
          productName: "$items.productName",
        },
        revenue: { $sum: "$items.lineTotal" },
        unitsSold: { $sum: "$items.quantity" },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: topProductsLimit },
  ]);

  return {
    monthlyStats,
    paymentBreakdown: {
      paid: getBreakdown("paid"),
      partial: getBreakdown("partial"),
      unpaid: getBreakdown("unpaid"),
    },
    topProducts: productsRaw.map((p) => ({
      productId: p._id.productId,
      productName: p._id.productName,
      revenue: p.revenue,
      unitsSold: p.unitsSold,
    })),
  };
}
