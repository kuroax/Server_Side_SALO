import { z } from 'zod';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '#/modules/inventory/inventory.constants.js';

// ─── Reusable Fields ──────────────────────────────────────────────────────────

const productIdField = z
  .string({ error: 'Product ID is required' })
  .regex(/^[a-f\d]{24}$/i, 'Invalid product ID');

const sizeField = z
  .string({ error: 'Size is required' })
  .trim()
  .min(1, 'Size cannot be empty')
  .transform((v) => v.toUpperCase());

const colorField = z
  .string({ error: 'Color is required' })
  .trim()
  .min(1, 'Color cannot be empty')
  .transform((v) => v.toLowerCase());

const quantityField = z
  .number({ error: 'Quantity must be a number' })
  .int('Quantity must be an integer')
  .min(0, 'Quantity cannot be negative');

const thresholdField = z
  .number({ error: 'Low stock threshold must be a number' })
  .int('Low stock threshold must be an integer')
  .min(0, 'Low stock threshold cannot be negative');

// ─── Inventory Key ────────────────────────────────────────────────────────────

// Shared base for all variant-targeted operations
const inventoryKeySchema = z.object({
  productId: productIdField,
  size: sizeField,
  color: colorField,
});

// ─── Add Stock ────────────────────────────────────────────────────────────────

export const addStockSchema = inventoryKeySchema.extend({
  quantity: quantityField.min(1, 'Quantity to add must be at least 1'),
  // optional first, then default — correct Zod v4 order
  lowStockThreshold: thresholdField.optional().default(DEFAULT_LOW_STOCK_THRESHOLD),
});

// ─── Remove Stock ─────────────────────────────────────────────────────────────

export const removeStockSchema = inventoryKeySchema.extend({
  quantity: quantityField.min(1, 'Quantity to remove must be at least 1'),
});

// ─── Get Product Inventory ────────────────────────────────────────────────────

export const getProductInventorySchema = z.object({
  productId: productIdField,
});

// ─── Get Low Stock ────────────────────────────────────────────────────────────

export const getLowStockSchema = z.object({
  productId: productIdField.optional(),
});

// ─── Update Threshold ─────────────────────────────────────────────────────────

export const updateThresholdSchema = inventoryKeySchema.extend({
  lowStockThreshold: thresholdField,
});

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type AddStockData = z.infer<typeof addStockSchema>;
export type RemoveStockData = z.infer<typeof removeStockSchema>;
export type GetProductInventoryData = z.infer<typeof getProductInventorySchema>;
export type GetLowStockData = z.infer<typeof getLowStockSchema>;
export type UpdateThresholdData = z.infer<typeof updateThresholdSchema>;