import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import {
  GENDERS,
  SIZES,
  PRODUCT_STATUS,
} from '#/modules/products/product.types.js';

// ─── Variant Subschema ────────────────────────────────────────────────────────

const variantSchema = new Schema(
  {
    size: {
      type: String,
      enum: {
        values: Object.values(SIZES),
        message: '{VALUE} is not a valid size',
      },
      required: [true, 'Variant size is required'],
    },
    color: {
      type: String,
      required: [true, 'Variant color is required'],
      trim: true,
      lowercase: true,
    },
  },
  { _id: false },
);

// ─── Product Schema ───────────────────────────────────────────────────────────

const productSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true,
      minlength: [2, 'Product name must be at least 2 characters'],
      maxlength: [120, 'Product name must be at most 120 characters'],
    },
    slug: {
      type: String,
      required: [true, 'Slug is required'],
      unique: true,
      trim: true,
      lowercase: true,
    },
    description: {
      type: String,
      required: [true, 'Product description is required'],
      trim: true,
      maxlength: [2000, 'Description must be at most 2000 characters'],
    },
    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [0, 'Price cannot be negative'],
    },
    brand: {
      type: String,
      required: [true, 'Brand is required'],
      trim: true,
      maxlength: [60, 'Brand must be at most 60 characters'],
    },
    gender: {
      type: String,
      enum: {
        values: Object.values(GENDERS),
        message: '{VALUE} is not a valid gender',
      },
      required: [true, 'Gender is required'],
    },
    categoryGroup: {
      type: String,
      required: [true, 'Category group is required'],
      trim: true,
      maxlength: [60, 'Category group must be at most 60 characters'],
    },
    subcategory: {
      type: String,
      required: [true, 'Subcategory is required'],
      trim: true,
      maxlength: [60, 'Subcategory must be at most 60 characters'],
    },
    images: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: {
        values: Object.values(PRODUCT_STATUS),
        message: '{VALUE} is not a valid status',
      },
      default: PRODUCT_STATUS.ACTIVE,
    },
    variants: {
      type: [variantSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// slug index is handled automatically by unique: true
productSchema.index({ gender: 1, categoryGroup: 1, subcategory: 1 });
productSchema.index({ status: 1 });
productSchema.index({ brand: 1 });

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProductSchemaType = InferSchemaType<typeof productSchema>;
export type ProductDocument = HydratedDocument<ProductSchemaType>;

// ─── Model ────────────────────────────────────────────────────────────────────

export const ProductModel = model<ProductDocument>('Product', productSchema);