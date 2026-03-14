import { z } from 'zod';
import { objectIdSchema } from '#/shared/validation/common.validation.js';
import {
  ORDER_CHANNELS,
  ORDER_NOTE_KINDS,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
} from '#/modules/orders/order.types.js';

// ─── Item input ───────────────────────────────────────────────────────────────
// Client supplies variant identity and pricing only.
// productName and productSlug are fetched from the product record by the service
// at creation time — client input is not trusted for historical snapshot data.

const orderItemInputSchema = z.object({
  productId: objectIdSchema,
  size: z
    .string({ error: 'Size must be a string' })
    .min(1, { error: 'Size is required' })
    .transform(s => s.trim()),
  color: z
    .string({ error: 'Color must be a string' })
    .min(1, { error: 'Color is required' })
    .transform(s => s.trim()),
  quantity: z
    .number({ error: 'Quantity must be a number' })
    .int({ error: 'Quantity must be an integer' })
    .min(1, { error: 'Quantity must be at least 1' }),
  unitPrice: z
    .number({ error: 'Unit price must be a number' })
    .min(0, { error: 'Unit price must be non-negative' }),
});

// ─── Note input ───────────────────────────────────────────────────────────────
// createdBy is service-owned — derived from auth context, never from client input.

const orderNoteInputSchema = z.object({
  message: z
    .string({ error: 'Message must be a string' })
    .min(1, { error: 'Message cannot be empty' })
    .max(1000, { error: 'Message must be 1000 characters or less' })
    .transform(s => s.trim()),
  kind: z.enum(ORDER_NOTE_KINDS, { error: 'Invalid note kind' }),
});

// ─── Mutations ────────────────────────────────────────────────────────────────

export const createOrderSchema = z.object({
  // Nullable — bot may not have a confirmed customer record at creation time
  customerId: objectIdSchema.nullable().optional().default(null),
  channel:    z.enum(ORDER_CHANNELS, { error: 'Invalid channel' }),
  items: z
    .array(orderItemInputSchema, { error: 'Items must be an array' })
    .min(1, { error: 'Order must have at least one item' }),
  // Structured notes may be supplied at creation time (e.g. bot logs first message)
  notes: z
    .array(orderNoteInputSchema)
    .optional()
    .default([]),
});

export const updateOrderStatusSchema = z.object({
  orderId: objectIdSchema,
  status:  z.enum(ORDER_STATUSES, { error: 'Invalid order status' }),
});

export const updatePaymentStatusSchema = z.object({
  orderId:       objectIdSchema,
  paymentStatus: z.enum(PAYMENT_STATUSES, { error: 'Invalid payment status' }),
});

export const addOrderNoteSchema = z.object({
  orderId: objectIdSchema,
  note:    orderNoteInputSchema,
});

export const cancelOrderSchema = z.object({
  orderId: objectIdSchema,
});

// Resolves a null customerId to a confirmed customer record.
// Called by the bot after it successfully identifies or creates a customer.
export const assignCustomerSchema = z.object({
  orderId:    objectIdSchema,
  customerId: objectIdSchema,
});

// ─── Queries ──────────────────────────────────────────────────────────────────

export const getOrderByIdSchema = z.object({
  orderId: objectIdSchema,
});

export const getOrderByOrderNumberSchema = z.object({
  orderNumber: z
    .string({ error: 'Order number must be a string' })
    .min(1, { error: 'Order number is required' })
    .transform(s => s.trim()),
});

export const getCustomerOrdersSchema = z.object({
  customerId: objectIdSchema,
});

export const orderFilterSchema = z
  .object({
    customerId:    objectIdSchema.optional(),
    status:        z.enum(ORDER_STATUSES,   { error: 'Invalid order status' }).optional(),
    paymentStatus: z.enum(PAYMENT_STATUSES, { error: 'Invalid payment status' }).optional(),
    channel:       z.enum(ORDER_CHANNELS,   { error: 'Invalid channel' }).optional(),
    limit:         z.number().int().min(1).max(100).optional().default(20),
    skip:          z.number().int().min(0).optional().default(0),
  })
  .optional()
  .default({ limit: 20, skip: 0 });

// ─── Inferred types ───────────────────────────────────────────────────────────

export type CreateOrderInput         = z.infer<typeof createOrderSchema>;
export type UpdateOrderStatusInput   = z.infer<typeof updateOrderStatusSchema>;
export type UpdatePaymentStatusInput = z.infer<typeof updatePaymentStatusSchema>;
export type AddOrderNoteInput        = z.infer<typeof addOrderNoteSchema>;
export type CancelOrderInput         = z.infer<typeof cancelOrderSchema>;
export type AssignCustomerInput      = z.infer<typeof assignCustomerSchema>;
export type GetOrderByIdInput        = z.infer<typeof getOrderByIdSchema>;
export type GetOrderByOrderNumber    = z.infer<typeof getOrderByOrderNumberSchema>;
export type GetCustomerOrdersInput   = z.infer<typeof getCustomerOrdersSchema>;
export type OrderFilterInput         = z.infer<typeof orderFilterSchema>;