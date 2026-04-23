import { Schema, model } from 'mongoose';
import type { HydratedDocument, InferSchemaType } from 'mongoose';
import {
  ORDER_CHANNELS,
  ORDER_NOTE_KINDS,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
} from '#/modules/orders/order.types.js';
import type { IWithTimestamps } from '#/modules/orders/order.types.js';

// ─── Note subdocument ─────────────────────────────────────────────────────────

const orderNoteSchema = new Schema(
  {
    message:   { type: String, required: true, trim: true },
    // userId of the author; null for system/bot-generated notes
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    kind:      { type: String, required: true, enum: ORDER_NOTE_KINDS },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

// ─── Item subdocument ─────────────────────────────────────────────────────────

const orderItemSchema = new Schema(
  {
    productId:   { type: Schema.Types.ObjectId, required: true, ref: 'Product' },
    productName: { type: String, required: true, trim: true }, // snapshot
    productSlug: { type: String, required: true, trim: true }, // snapshot
    size:        { type: String, required: true, trim: true },
    color:       { type: String, required: true, trim: true },
    quantity:    { type: Number, required: true, min: 1 },
    unitPrice:   { type: Number, required: true, min: 0 },
    // Computed in service before persistence — not derived by a hook.
    // See computeOrderFinancials() in order.service.ts.
    lineTotal:   { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

// ─── Order schema ─────────────────────────────────────────────────────────────

export const orderSchema = new Schema(
  {
    orderNumber: { type: String, required: true, unique: true, trim: true },

    // Nullable — bot may create the order before a customer record is confirmed
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },

    channel: { type: String, required: true, enum: ORDER_CHANNELS },

    // First-class source-message idempotency key.
    // Example: WhatsApp inbound message ID.
    // Optional because not all orders originate from message-driven flows.
    sourceMessageId: { type: String, default: null, trim: true },

    status: {
      type:     String,
      required: true,
      enum:     ORDER_STATUSES,
      default:  'pending',
    },

    paymentStatus: {
      type:     String,
      required: true,
      enum:     PAYMENT_STATUSES,
      default:  'unpaid',
    },

    items: {
      type:     [orderItemSchema],
      required: true,
      validate: {
        validator: (v: unknown[]) => Array.isArray(v) && v.length > 0,
        message:   'Order must have at least one item',
      },
    },

    notes: { type: [orderNoteSchema], default: [] },

    // subtotal and total are computed in service before persistence.
    // subtotal = sum of lineTotals (pre-discount).
    // total    = post-discount / post-tax (equals subtotal in V1).
    // Kept separate so a discount/coupon layer can be added without a migration.
    subtotal: { type: Number, required: true, min: 0 },
    total:    { type: Number, required: true, min: 0 },

    // Guards against double-decrement. Gates V2 RESERVE/RELEASE operations.
    inventoryApplied: { type: Boolean, required: true, default: false },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Enforce idempotency only when sourceMessageId is present.
// Compound uniqueness by channel avoids collisions if different channels ever
// produce similarly-shaped message IDs.
orderSchema.index(
  { channel: 1, sourceMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      sourceMessageId: { $type: 'string' },
    },
    name: 'channel_sourceMessageId_unique',
  },
);

// No pre('save') hook for financial fields — all derived values are computed
// explicitly in the service layer so they are correct regardless of which
// Mongoose update path is used (new + save, findOneAndUpdate, bulkWrite, etc.).

// ─── Types ────────────────────────────────────────────────────────────────────

export type OrderSchemaType = InferSchemaType<typeof orderSchema> & IWithTimestamps;
export type OrderDocument   = HydratedDocument<OrderSchemaType>;

// ─── Model ────────────────────────────────────────────────────────────────────

export const OrderModel = model<OrderSchemaType>('Order', orderSchema);