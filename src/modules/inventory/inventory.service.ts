import { Types } from 'mongoose';
import { InventoryModel } from '#/modules/inventory/inventory.model.js';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '#/modules/inventory/inventory.constants.js';
import {
  addStockSchema,
  removeStockSchema,
  getProductInventorySchema,
  getLowStockSchema,
  updateThresholdSchema,
} from '#/modules/inventory/inventory.validation.js';
import type { InventoryResponse } from '#/modules/inventory/inventory.types.js';
import { logger } from '#/config/logger.js';
import {
  NotFoundError,
  BadRequestError,
} from '#/shared/errors/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type InventoryLike = {
  _id: { toString(): string };
  productId: { toString(): string };
  size: string;
  color: string;
  quantity: number;
  lowStockThreshold: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

// ─── Mapper ───────────────────────────────────────────────────────────────────

const toInventoryResponse = (doc: InventoryLike): InventoryResponse => ({
  id: doc._id.toString(),
  productId: doc.productId.toString(),
  size: doc.size,
  color: doc.color,
  quantity: doc.quantity,
  lowStockThreshold: doc.lowStockThreshold,
  isLowStock: doc.quantity <= doc.lowStockThreshold,
  createdAt: doc.createdAt instanceof Date
    ? doc.createdAt.toISOString()
    : new Date(doc.createdAt).toISOString(),
  updatedAt: doc.updatedAt instanceof Date
    ? doc.updatedAt.toISOString()
    : new Date(doc.updatedAt).toISOString(),
});

// ─── Duplicate Key Guard ──────────────────────────────────────────────────────

const isDuplicateKeyError = (err: unknown): boolean => {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: number }).code === 11000
  );
};

// ─── Add Stock ────────────────────────────────────────────────────────────────

// Atomic upsert — increments quantity if exists, creates if not
// $setOnInsert and $set are kept mutually exclusive for lowStockThreshold
// to avoid MongoDB conflict errors
export const addStock = async (input: unknown): Promise<InventoryResponse> => {
  const { productId, size, color, quantity, lowStockThreshold } =
    addStockSchema.parse(input);

  const threshold = lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;

  try {
    const doc = await InventoryModel.findOneAndUpdate(
      { productId, size, color },
      {
        $inc: { quantity },
        // $setOnInsert only fires on document creation
        // lowStockThreshold included here only when NOT explicitly provided
        // prevents conflict with $set below
        $setOnInsert: {
          productId,
          size,
          color,
          ...(lowStockThreshold === undefined && { lowStockThreshold: threshold }),
        },
        // $set fires on both create and update
        // only included when threshold explicitly provided
        ...(lowStockThreshold !== undefined && {
          $set: { lowStockThreshold },
        }),
      },
      { new: true, upsert: true, runValidators: true },
    ).lean<InventoryLike>();

    if (!doc) {
      throw new BadRequestError('Failed to add stock');
    }

    logger.info(
      { productId, size, color, added: quantity, total: doc.quantity },
      'Stock added',
    );

    return toInventoryResponse(doc);
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw new BadRequestError(
        'Inventory record already exists for this product variant',
      );
    }
    throw err;
  }
};

// ─── Remove Stock ─────────────────────────────────────────────────────────────

// Atomic decrement with conditional filter — blocks at zero, safe under concurrency
export const removeStock = async (input: unknown): Promise<InventoryResponse> => {
  const { productId, size, color, quantity } = removeStockSchema.parse(input);

  const doc = await InventoryModel.findOneAndUpdate(
    {
      productId,
      size,
      color,
      quantity: { $gte: quantity },
    },
    { $inc: { quantity: -quantity } },
    { new: true, runValidators: true },
  ).lean<InventoryLike>();

  if (!doc) {
    const current = await InventoryModel.findOne({ productId, size, color })
      .select('quantity')
      .lean<{ quantity: number } | null>();

    if (!current) {
      throw new NotFoundError('Inventory record not found for this product variant');
    }

    throw new BadRequestError(
      `Insufficient stock — available: ${current.quantity}, requested: ${quantity}`,
    );
  }

  logger.info(
    { productId, size, color, removed: quantity, remaining: doc.quantity },
    'Stock removed',
  );

  return toInventoryResponse(doc);
};

// ─── Get Product Inventory ────────────────────────────────────────────────────

export const getProductInventory = async (
  input: unknown,
): Promise<InventoryResponse[]> => {
  const { productId } = getProductInventorySchema.parse(input);

  const docs = await InventoryModel.find({ productId })
    .sort({ size: 1, color: 1 })
    .lean<InventoryLike[]>();

  return docs.map(toInventoryResponse);
};

// ─── Get Low Stock ────────────────────────────────────────────────────────────

// Aggregation join against Product — only returns variants whose parent
// product has status: 'active', preventing inactive products from
// triggering false low-stock alerts on the dashboard.
export const getLowStock = async (
  input: unknown,
): Promise<InventoryResponse[]> => {
  const { productId } = getLowStockSchema.parse(input);

  const matchStage: Record<string, unknown> = {
    $expr: { $lte: ['$quantity', '$lowStockThreshold'] },
  };

  if (productId) {
    matchStage.productId = new Types.ObjectId(productId);
  }

  const docs = await InventoryModel.aggregate([
    { $match: matchStage },
    {
      $lookup: {
        from: 'products',
        localField: 'productId',
        foreignField: '_id',
        as: 'product',
      },
    },
    { $unwind: '$product' },
    { $match: { 'product.status': 'active' } },
    { $sort: { quantity: 1 } },
  ]) as InventoryLike[];

  return docs.map(toInventoryResponse);
};

// ─── Update Threshold ─────────────────────────────────────────────────────────

export const updateThreshold = async (
  input: unknown,
): Promise<InventoryResponse> => {
  const { productId, size, color, lowStockThreshold } =
    updateThresholdSchema.parse(input);

  const doc = await InventoryModel.findOneAndUpdate(
    { productId, size, color },
    { $set: { lowStockThreshold } },
    { new: true, runValidators: true },
  ).lean<InventoryLike>();

  if (!doc) {
    throw new NotFoundError('Inventory record not found for this product variant');
  }

  logger.info(
    { productId, size, color, lowStockThreshold },
    'Low stock threshold updated',
  );

  return toInventoryResponse(doc);
};