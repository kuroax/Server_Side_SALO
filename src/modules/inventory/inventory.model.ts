import { Schema, model, type InferSchemaType, type HydratedDocument, type Model } from 'mongoose';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '#/modules/inventory/inventory.constants.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

const inventorySchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },

    size: {
      type: String,
      required: true,
      trim: true,
    },

    color: {
      type: String,
      required: true,
      trim: true,
    },

    quantity: {
      type: Number,
      required: true,
      min: [0, 'Quantity cannot be negative'],
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: 'Quantity must be an integer',
      },
    },

    lowStockThreshold: {
      type: Number,
      required: true,
      min: [0, 'Low stock threshold cannot be negative'],
      default: DEFAULT_LOW_STOCK_THRESHOLD,
      validate: {
        validator: Number.isInteger,
        message: 'Low stock threshold must be an integer',
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ─── Normalization ────────────────────────────────────────────────────────────

// MVP assumption: within a product, size + color uniquely identifies a variant.
// Normalize before validation to ensure consistent compound index matching.
// size → uppercase (XS, S, M, L, XL, XXL)
// color → lowercase (black, white, red...)
inventorySchema.pre('save', async function () {
  if (typeof this.size === 'string') {
    this.size = this.size.trim().toUpperCase();
  }

  if (typeof this.color === 'string') {
    this.color = this.color.trim().toLowerCase();
  }
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Unique compound index — one record per product variant
// The leftmost prefix { productId } also covers single-field productId queries
inventorySchema.index({ productId: 1, size: 1, color: 1 }, { unique: true });

// ─── Types ────────────────────────────────────────────────────────────────────

export type InventorySchemaType = InferSchemaType<typeof inventorySchema>;
export type InventoryDocument = HydratedDocument<InventorySchemaType>;
export type InventoryModelType = Model<InventorySchemaType>;

// ─── Model ────────────────────────────────────────────────────────────────────

export const InventoryModel = model<InventorySchemaType>('Inventory', inventorySchema);