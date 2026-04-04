import { Types } from 'mongoose';
import { logger } from '#/config/logger.js';
import { BadRequestError, NotFoundError } from '#/shared/errors/index.js';
import { OrderModel } from '#/modules/orders/order.model.js';
import { CounterModel } from '#/shared/models/counter.model.js';
import { ProductModel } from '#/modules/products/product.model.js';
import { CustomerModel } from '#/modules/customers/customer.model.js';
import { InventoryModel } from '#/modules/inventory/inventory.model.js';
import { ORDER_NUMBER_PREFIX } from '#/modules/orders/order.types.js';
import type {
  OrderChannel,
  OrderItemSnapshot,
  OrderNote,
  OrderNoteKind,
  OrderStatus,
  PaymentStatus,
  SafeOrder,
} from '#/modules/orders/order.types.js';
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
} from '#/modules/orders/order.validation.js';

// ─── State machine ────────────────────────────────────────────────────────────
// Only explicitly listed transitions are permitted.
// Terminal states (delivered, cancelled) have empty arrays — no exit.

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending:    ['confirmed', 'cancelled'],
  confirmed:  ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped:    ['delivered'],
  delivered:  [],
  cancelled:  [],
};

function assertValidTransition(from: OrderStatus, to: OrderStatus): void {
  if (!VALID_TRANSITIONS[from].includes(to)) {
    throw new BadRequestError(
      `Cannot transition order from '${from}' to '${to}'`,
    );
  }
}

// ─── System note helper ───────────────────────────────────────────────────────
// Builds a structured audit note from service-level events.
// createdBy is always null — system events have no human author.

function makeSystemNote(message: string): {
  message:   string;
  createdBy: null;
  kind:      'system';
  createdAt: Date;
} {
  return { message, createdBy: null, kind: 'system', createdAt: new Date() };
}

// ─── Financial computation ────────────────────────────────────────────────────
// Single source of truth for all derived numeric fields.
// Called explicitly before any persistence call — no Mongoose hook dependency.

type EnrichedOrderItem = {
  productId:   string;
  productName: string;
  productSlug: string;
  size:        string;
  color:       string;
  quantity:    number;
  unitPrice:   number;
};

type ComputedOrderItem = EnrichedOrderItem & { lineTotal: number };

function computeOrderFinancials(items: EnrichedOrderItem[]): {
  items:    ComputedOrderItem[];
  subtotal: number;
  total:    number;
} {
  const computed: ComputedOrderItem[] = items.map(item => ({
    ...item,
    lineTotal: item.quantity * item.unitPrice,
  }));
  const subtotal = computed.reduce((sum, item) => sum + item.lineTotal, 0);
  const total    = subtotal; // V1 — extend here for discounts / tax
  return { items: computed, subtotal, total };
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

type OrderItemLike = {
  productId:   Types.ObjectId;
  productName: string;
  productSlug: string;
  size:        string;
  color:       string;
  quantity:    number;
  unitPrice:   number;
  lineTotal:   number;
};

type OrderNoteLike = {
  message:   string;
  createdBy: Types.ObjectId | null;
  kind:      string;
  createdAt: Date;
};

type OrderLike = {
  _id:              Types.ObjectId;
  orderNumber:      string;
  customerId:       Types.ObjectId | null;
  channel:          string;
  status:           string;
  paymentStatus:    string;
  items:            OrderItemLike[];
  notes:            OrderNoteLike[];
  subtotal:         number;
  total:            number;
  inventoryApplied: boolean;
  createdAt:        Date;
  updatedAt:        Date;
};

function mapNote(raw: OrderNoteLike): OrderNote {
  return {
    message:   raw.message,
    createdBy: raw.createdBy ? raw.createdBy.toString() : null,
    kind:      raw.kind as OrderNoteKind,
    createdAt: raw.createdAt.toISOString(),
  };
}

function mapOrder(raw: OrderLike): SafeOrder {
  return {
    id:            raw._id.toString(),
    orderNumber:   raw.orderNumber,
    customerId:    raw.customerId ? raw.customerId.toString() : null,
    channel:       raw.channel as OrderChannel,
    status:        raw.status as OrderStatus,
    paymentStatus: raw.paymentStatus as PaymentStatus,
    items: raw.items.map(
      (item): OrderItemSnapshot => ({
        productId:   item.productId.toString(),
        productName: item.productName,
        productSlug: item.productSlug,
        size:        item.size,
        color:       item.color,
        quantity:    item.quantity,
        unitPrice:   item.unitPrice,
        lineTotal:   item.lineTotal,
      }),
    ),
    notes:            (raw.notes ?? []).map(mapNote),
    subtotal:         raw.subtotal,
    total:            raw.total,
    inventoryApplied: raw.inventoryApplied,
    createdAt:        raw.createdAt.toISOString(),
    updatedAt:        raw.updatedAt.toISOString(),
  };
}

// ─── Duplicate-key error handler ──────────────────────────────────────────────

function mapDuplicateOrderError(err: unknown): never {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 11000 &&
    'keyPattern' in err
  ) {
    const kp = (err as { keyPattern: Record<string, unknown> }).keyPattern;
    if (kp['orderNumber']) {
      throw new BadRequestError('Order number collision — please retry');
    }
  }
  throw err;
}

// ─── Order number generation ──────────────────────────────────────────────────
// Format: SALO-100001  (globally sequential, atomic, collision-safe)
//
// Uses a dedicated counters collection with MongoDB's atomic findOneAndUpdate
// + $inc. This guarantees uniqueness under any concurrency — no race conditions,
// no daily resets, no timezone edge cases.
//
// Counter document: { _id: "orderNumber", seq: 100000 }
// First order generated: SALO-100001
// Seed the counter before first use:
//   db.counters.insertOne({ _id: "orderNumber", seq: 100000 })

async function buildUniqueOrderNumber(): Promise<string> {
  const counter = await CounterModel.findOneAndUpdate(
    { _id: 'orderNumber' },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  ).lean<{ seq: number } | null>();

  if (!counter) throw new Error('Failed to generate order number');

  return `SALO-${counter.seq}`;
}

// ─── Product snapshot helper ──────────────────────────────────────────────────
// Minimal lean type — only the fields needed for the order snapshot.

type ProductSnapshotLike = {
  _id:  Types.ObjectId;
  name: string;
  slug: string;
};

// Fetches product name and slug from the products collection.
// Throws NotFoundError if any productId in the order does not exist.
// Called once per createOrder — one DB read per unique product in the order.

async function fetchProductSnapshots(
  productIds: string[],
): Promise<Map<string, { name: string; slug: string }>> {
  const uniqueIds    = [...new Set(productIds)];
  const objectIds    = uniqueIds.map(id => new Types.ObjectId(id));
  const products     = await ProductModel
    .find({ _id: { $in: objectIds } })
    .select('name slug')
    .lean<ProductSnapshotLike[]>();

  const found = new Map(
    products.map(p => [p._id.toString(), { name: p.name, slug: p.slug }]),
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
  if (!order) throw new NotFoundError('Order not found');
  return mapOrder(order);
}

export async function getOrderByOrderNumber(input: unknown): Promise<SafeOrder> {
  const { orderNumber } = getOrderByOrderNumberSchema.parse(input);
  const order = await OrderModel.findOne({ orderNumber }).lean<OrderLike>();
  if (!order) throw new NotFoundError('Order not found');
  return mapOrder(order);
}

export async function listOrders(input: unknown): Promise<SafeOrder[]> {
  const filter = orderFilterSchema.parse(input);
  const query: Record<string, unknown> = {};

  if (filter.customerId)    query['customerId']    = new Types.ObjectId(filter.customerId);
  if (filter.status)        query['status']        = filter.status;
  if (filter.paymentStatus) query['paymentStatus'] = filter.paymentStatus;
  if (filter.channel)       query['channel']       = filter.channel;

  const orders = await OrderModel
    .find(query)
    .sort({ createdAt: -1 })
    .skip(filter.skip)
    .limit(filter.limit)
    .lean<OrderLike[]>();

  return orders.map(mapOrder);
}

export async function getCustomerOrders(input: unknown): Promise<SafeOrder[]> {
  const { customerId } = getCustomerOrdersSchema.parse(input);

  const orders = await OrderModel
    .find({ customerId: new Types.ObjectId(customerId) })
    .sort({ createdAt: -1 })
    .lean<OrderLike[]>();

  return orders.map(mapOrder);
}

// ─── Mutations ────────────────────────────────────────────────────────────────

// createdBy is the authenticated user's ID — passed from the resolver,
// never from client-supplied input.
export async function createOrder(
  input: unknown,
  createdBy: string | null,
): Promise<SafeOrder> {
  const data = createOrderSchema.parse(input);

  // Verify customer exists before creating a reference — prevents dangling ObjectIds.
  if (data.customerId) {
    const customerExists = await CustomerModel.exists({ _id: new Types.ObjectId(data.customerId) });
    if (!customerExists) throw new NotFoundError('Customer not found');
  }

  // Fetch product snapshots — service owns this data, not the client.
  const productIds = data.items.map(item => item.productId);
  const snapshots  = await fetchProductSnapshots(productIds);

  // Enrich items with snapshot fields before computing financials.
  const enrichedItems = data.items.map(item => ({
    ...item,
    productName: snapshots.get(item.productId)!.name,
    productSlug: snapshots.get(item.productId)!.slug,
  }));

  const { items: computedItems, subtotal, total } = computeOrderFinancials(enrichedItems);

  const orderNumber = await buildUniqueOrderNumber();

  // Map any creation-time notes — createdBy comes from auth context.
  // System note appended last so 'Order created.' is always the final entry.
  const initialNotes = [
    ...data.notes.map(note => ({
      message:   note.message,
      createdBy: createdBy ? new Types.ObjectId(createdBy) : null,
      kind:      note.kind,
      createdAt: new Date(),
    })),
    makeSystemNote('Order created.'),
  ];

  const order = new OrderModel({
    orderNumber,
    customerId: data.customerId ? new Types.ObjectId(data.customerId) : null,
    channel:    data.channel,
    notes:      initialNotes,
    subtotal,
    total,
    items: computedItems.map(item => ({
      productId:   new Types.ObjectId(item.productId),
      productName: item.productName,
      productSlug: item.productSlug,
      size:        item.size,
      color:       item.color,
      quantity:    item.quantity,
      unitPrice:   item.unitPrice,
      lineTotal:   item.lineTotal,
    })),
    // status → 'pending', paymentStatus → 'unpaid', inventoryApplied → false (schema defaults)
  });

  try {
    await order.save();
  } catch (err) {
    return mapDuplicateOrderError(err);
  }

  logger.info({ orderId: order._id.toString(), orderNumber }, 'Order created');

  return mapOrder(order.toObject() as OrderLike);
}

export async function updateOrderStatus(input: unknown): Promise<SafeOrder> {
  const { orderId, status } = updateOrderStatusSchema.parse(input);

  const order = await OrderModel.findById(orderId);
  if (!order) throw new NotFoundError('Order not found');

  assertValidTransition(order.status as OrderStatus, status);

  // ── Deduct inventory when order is confirmed ──────────────────────────────
  // Only runs once — guard: inventoryApplied must be false before proceeding.
  // Uses atomic $gte filter in findOneAndUpdate so it fails safely if stock
  // is insufficient rather than going negative.
  if (status === 'confirmed' && !order.inventoryApplied) {
    const insufficientItems: string[] = [];

    for (const item of order.items) {
      const result = await InventoryModel.findOneAndUpdate(
        {
          productId: item.productId,
          size:      item.size,
          color:     item.color,
          quantity:  { $gte: item.quantity },
        },
        { $inc: { quantity: -item.quantity } },
        { new: true },
      ).lean();

      if (!result) {
        // Check if record exists to give a clearer error message
        const current = await InventoryModel.findOne({
          productId: item.productId,
          size:      item.size,
          color:     item.color,
        }).select('quantity').lean<{ quantity: number } | null>();

        const available = current?.quantity ?? 0;
        insufficientItems.push(
          `${item.productName} (${item.size} · ${item.color}): requested ${item.quantity}, available ${available}`,
        );
      }
    }

    if (insufficientItems.length > 0) {
      throw new BadRequestError(
        `Insufficient stock for: ${insufficientItems.join('; ')}`,
      );
    }

    order.inventoryApplied = true;
    order.notes.push(makeSystemNote('Inventory deducted on order confirmation.'));
    logger.info({ orderId, items: order.items.length }, 'Inventory deducted on confirm');
  }

  order.status = status;
  order.notes.push(makeSystemNote(`Order status changed to '${status}'.`));
  await order.save();

  logger.info({ orderId, status }, 'Order status updated');
  return mapOrder(order.toObject() as OrderLike);
}

export async function updatePaymentStatus(input: unknown): Promise<SafeOrder> {
  const { orderId, paymentStatus } = updatePaymentStatusSchema.parse(input);

  const order = await OrderModel.findById(orderId);
  if (!order) throw new NotFoundError('Order not found');

  if (order.status === 'cancelled') {
    throw new BadRequestError('Cannot update payment status of a cancelled order');
  }

  order.paymentStatus = paymentStatus;
  order.notes.push(makeSystemNote(`Payment status changed to '${paymentStatus}'.`));
  await order.save();

  logger.info({ orderId, paymentStatus }, 'Order payment status updated');
  return mapOrder(order.toObject() as OrderLike);
}

export async function cancelOrder(input: unknown): Promise<SafeOrder> {
  const { orderId } = cancelOrderSchema.parse(input);

  const order = await OrderModel.findById(orderId);
  if (!order) throw new NotFoundError('Order not found');

  // Reuses the transition map — 'delivered' and 'cancelled' have no exit,
  // both are rejected automatically without extra ad-hoc guards.
  assertValidTransition(order.status as OrderStatus, 'cancelled');

  order.status = 'cancelled';
  order.notes.push(makeSystemNote('Order cancelled.'));

  // ── Restore inventory if it was previously deducted ───────────────────────
  // Only restore if inventoryApplied is true — prevents double-restore on
  // orders cancelled before reaching confirmed status.
  if (order.inventoryApplied) {
    for (const item of order.items) {
      await InventoryModel.findOneAndUpdate(
        { productId: item.productId, size: item.size, color: item.color },
        { $inc: { quantity: item.quantity } },
        { new: true },
      ).lean();
    }
    order.inventoryApplied = false;
    order.notes.push(makeSystemNote('Inventory restored on cancellation.'));
    logger.info({ orderId, items: order.items.length }, 'Inventory restored on cancel');
  }

  await order.save();

  logger.info({ orderId }, 'Order cancelled');

  return mapOrder(order.toObject() as OrderLike);
}

// createdBy comes from auth context in the resolver — trusted value,
// not part of the user-supplied input object.
export async function addOrderNote(
  input: unknown,
  createdBy: string | null,
): Promise<SafeOrder> {
  const { orderId, note } = addOrderNoteSchema.parse(input);

  const noteDoc = {
    message:   note.message,
    createdBy: createdBy ? new Types.ObjectId(createdBy) : null,
    kind:      note.kind,
    createdAt: new Date(),
  };

  const order = await OrderModel.findByIdAndUpdate(
    orderId,
    { $push: { notes: noteDoc } },
    { new: true },
  ).lean<OrderLike>();

  if (!order) throw new NotFoundError('Order not found');

  logger.info({ orderId, kind: note.kind }, 'Note added to order');
  return mapOrder(order);
}

// Resolves a null customerId to a confirmed customer record.
// Called by the bot after it successfully identifies or creates a customer.
export async function assignCustomerToOrder(input: unknown): Promise<SafeOrder> {
  const { orderId, customerId } = assignCustomerSchema.parse(input);

  // Verify the customer exists before creating a reference — prevents dangling ObjectIds.
  const customerExists = await CustomerModel.exists({ _id: new Types.ObjectId(customerId) });
  if (!customerExists) throw new NotFoundError('Customer not found');

  const order = await OrderModel.findById(orderId);
  if (!order) throw new NotFoundError('Order not found');

  if (order.customerId !== null) {
    throw new BadRequestError('Order already has a customer assigned');
  }

  order.customerId = new Types.ObjectId(customerId);
  order.notes.push(makeSystemNote('Customer assigned to order.'));
  await order.save();

  logger.info({ orderId, customerId }, 'Customer assigned to order');
  return mapOrder(order.toObject() as OrderLike);
}

// ─── Delete Order ─────────────────────────────────────────────────────────────
// Hard delete — permanently removes the order from the database.
// Restores inventory if it was previously applied (same logic as cancelOrder).
// Owner-only operation — enforced at the resolver level.

export async function deleteOrder(input: unknown): Promise<boolean> {
  const { orderId } = cancelOrderSchema.parse(input); // reuses same shape { orderId }

  const order = await OrderModel.findById(orderId);
  if (!order) throw new NotFoundError('Order not found');

  // Restore inventory if it was deducted — prevents phantom stock reduction.
  if (order.inventoryApplied) {
    for (const item of order.items) {
      await InventoryModel.findOneAndUpdate(
        { productId: item.productId, size: item.size, color: item.color },
        { $inc: { quantity: item.quantity } },
        { new: true },
      ).lean();
    }
    logger.info({ orderId, items: order.items.length }, 'Inventory restored on delete');
  }

  await OrderModel.findByIdAndDelete(orderId);

  logger.info({ orderId, orderNumber: order.orderNumber }, 'Order hard-deleted');
  return true;
}

// ─── Revenue stats ────────────────────────────────────────────────────────────
// Aggregates revenue per calendar month for the last N months.
// Excludes cancelled orders — cancelled orders never contribute to revenue.
// Fills in months with zero revenue so the frontend always gets a full series.

type MonthRevenue = {
  year:       number;
  month:      number;
  label:      string;
  revenue:    number;
  orderCount: number;
};

export async function getRevenueStats(months = 3): Promise<MonthRevenue[]> {
  const now  = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

  const raw = await OrderModel.aggregate<{
    _id: { year: number; month: number };
    revenue:    number;
    orderCount: number;
  }>([
    {
      $match: {
        createdAt: { $gte: from },
        status:    { $ne: 'cancelled' },
      },
    },
    {
      $group: {
        _id:        { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
        revenue:    { $sum: '$total' },
        orderCount: { $sum: 1 },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  // Build a full series — fill zeroes for months with no orders.
  const series: MonthRevenue[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d     = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year  = d.getFullYear();
    const month = d.getMonth() + 1; // MongoDB  is 1-indexed
    const found = raw.find(r => r._id.year === year && r._id.month === month);
    series.push({
      year,
      month,
      label:      d.toLocaleDateString('es-MX', { month: 'short', year: 'numeric' }),
      revenue:    found?.revenue    ?? 0,
      orderCount: found?.orderCount ?? 0,
    });
  }

  return series;
}
// ─── Revenue detail ───────────────────────────────────────────────────────────
// Returns three datasets in one call for the revenue detail screen:
//   1. Monthly stats for the last N months (reuses MonthRevenue type)
//   2. Payment status breakdown (paid / partial / unpaid)
//   3. Top products by revenue (across all non-cancelled orders)

type ProductRevenueResult = {
  productId:   string;
  productName: string;
  revenue:     number;
  unitsSold:   number;
};

type RevenueDetailResult = {
  monthlyStats: MonthRevenue[];
  paymentBreakdown: {
    paid:    { count: number; revenue: number };
    partial: { count: number; revenue: number };
    unpaid:  { count: number; revenue: number };
  };
  topProducts: ProductRevenueResult[];
};

export async function getRevenueDetail(
  months = 12,
  topProductsLimit = 10,
): Promise<RevenueDetailResult> {
  const now  = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

  // ── 1. Monthly stats ────────────────────────────────────────────────────────
  const monthlyRaw = await OrderModel.aggregate<{
    _id: { year: number; month: number };
    revenue:    number;
    orderCount: number;
  }>([
    {
      $match: {
        createdAt: { $gte: from },
        status:    { $ne: 'cancelled' },
      },
    },
    {
      $group: {
        _id:        { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
        revenue:    { $sum: '$total' },
        orderCount: { $sum: 1 },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  const monthlyStats: MonthRevenue[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d     = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year  = d.getFullYear();
    const month = d.getMonth() + 1;
    const found = monthlyRaw.find(r => r._id.year === year && r._id.month === month);
    monthlyStats.push({
      year,
      month,
      label:      d.toLocaleDateString('es-MX', { month: 'short', year: 'numeric' }),
      revenue:    found?.revenue    ?? 0,
      orderCount: found?.orderCount ?? 0,
    });
  }

  // ── 2. Payment breakdown ────────────────────────────────────────────────────
  const paymentRaw = await OrderModel.aggregate<{
    _id:     string;
    count:   number;
    revenue: number;
  }>([
    { $match: { status: { $ne: 'cancelled' } } },
    {
      $group: {
        _id:     '$paymentStatus',
        count:   { $sum: 1 },
        revenue: { $sum: '$total' },
      },
    },
  ]);

  const getBreakdown = (status: string) => {
    const found = paymentRaw.find(r => r._id === status);
    return { count: found?.count ?? 0, revenue: found?.revenue ?? 0 };
  };

  // ── 3. Top products by revenue ──────────────────────────────────────────────
  const productsRaw = await OrderModel.aggregate<{
    _id:      { productId: string; productName: string };
    revenue:  number;
    unitsSold: number;
  }>([
    { $match: { status: { $ne: 'cancelled' } } },
    { $unwind: '$items' },
    {
      $group: {
        _id: {
          productId:   { $toString: '$items.productId' },
          productName: '$items.productName',
        },
        revenue:   { $sum: '$items.lineTotal' },
        unitsSold: { $sum: '$items.quantity' },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: topProductsLimit },
  ]);

  return {
    monthlyStats,
    paymentBreakdown: {
      paid:    getBreakdown('paid'),
      partial: getBreakdown('partial'),
      unpaid:  getBreakdown('unpaid'),
    },
    topProducts: productsRaw.map(p => ({
      productId:   p._id.productId,
      productName: p._id.productName,
      revenue:     p.revenue,
      unitsSold:   p.unitsSold,
    })),
  };
}