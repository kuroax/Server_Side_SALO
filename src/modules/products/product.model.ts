import {
  Schema,
  model,
  type InferSchemaType,
  type HydratedDocument,
} from "mongoose";
import {
  GENDERS,
  SIZES,
  PRODUCT_STATUS,
} from "#/modules/products/product.types.js";

// ─── Variant Subschema ────────────────────────────────────────────────────────

const variantSchema = new Schema(
  {
    size: {
      type: String,
      enum: {
        values: Object.values(SIZES),
        message: "{VALUE} is not a valid size",
      },
      required: [true, "Variant size is required"],
    },
    color: {
      type: String,
      required: [true, "Variant color is required"],
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
      required: [true, "Product name is required"],
      trim: true,
      minlength: [2, "Product name must be at least 2 characters"],
      maxlength: [120, "Product name must be at most 120 characters"],
    },
    slug: {
      type: String,
      required: [true, "Slug is required"],
      unique: true,
      trim: true,
      lowercase: true,
    },
    description: {
      type: String,
      required: [true, "Product description is required"],
      trim: true,
      maxlength: [2000, "Description must be at most 2000 characters"],
    },
    price: {
      type: Number,
      required: [true, "Price is required"],
      min: [0, "Price cannot be negative"],
    },
    brand: {
      type: String,
      required: [true, "Brand is required"],
      trim: true,
      maxlength: [60, "Brand must be at most 60 characters"],
    },
    gender: {
      type: String,
      enum: {
        values: Object.values(GENDERS),
        message: "{VALUE} is not a valid gender",
      },
      required: [true, "Gender is required"],
    },
    categoryGroup: {
      type: String,
      required: [true, "Category group is required"],
      trim: true,
      maxlength: [60, "Category group must be at most 60 characters"],
    },
    subcategory: {
      type: String,
      required: [true, "Subcategory is required"],
      trim: true,
      maxlength: [60, "Subcategory must be at most 60 characters"],
    },
    images: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: {
        values: Object.values(PRODUCT_STATUS),
        message: "{VALUE} is not a valid status",
      },
      default: PRODUCT_STATUS.ACTIVE,
    },
    variants: {
      type: [variantSchema],
      default: [],
    },
    // ── Search keywords ──────────────────────────────────────────────────────
    // Searchable aliases, synonyms, and colloquial terms for this product.
    // Always stored lowercase. Auto-populated from subcategory + categoryGroup
    // by the service layer on create and update (not a pre-save hook — hooks
    // are bypassed by findByIdAndUpdate which is used in updateProduct).
    // Owners can add manual entries for regional terms or brand-specific names.
    // Included in the MongoDB text index with weight 6 (below name/brand).
    searchKeywords: {
      type: [String],
      default: [],
      // Schema-level lowercase transform — safety net for any code path that
      // bypasses buildSearchKeywords in product.service.ts (e.g. direct DB writes).
      // Primary normalization still happens in the service layer.
      // Note: 'lowercase: true' only works on scalar String, not [String] arrays,
      // so we use a 'set' transform instead.
      set: (keywords: string[]) =>
        Array.isArray(keywords)
          ? keywords.map((k) =>
              typeof k === "string" ? k.toLowerCase().trim() : k,
            )
          : keywords,
      validate: {
        validator: (v: string[]) => v.length <= 30,
        message: "A product can have at most 30 search keywords",
        // NOTE: this array-level validator is bypassed by findByIdAndUpdate
        // even with runValidators: true. Primary enforcement is in
        // product.validation.ts searchKeywordsSchema (Zod, runs on every mutation).
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// slug index is handled automatically by unique: true

// Used by listProducts (admin filtering by gender/category/subcategory).
// Not used by $text search queries — those use the text index below.
productSchema.index({ gender: 1, categoryGroup: 1, subcategory: 1 });

// Used as a pre-filter alongside $text queries in searchProductsForClaude.
// MongoDB text indexes don't support compound field ordering with $text,
// so this scalar index is the correct approach for status filtering.
productSchema.index({ status: 1 });

// NOTE: { brand: 1 } scalar index intentionally omitted.
// brand is included in the text index below with weight 8, which already
// makes brand searches fast via $text. Having both would cause a MongoDB
// conflict: a field cannot appear in both a scalar and a text index.

// Full-text search index — used by searchProductsForClaude in webhook.service.ts.
// Weights control relevance ranking: name and brand are highest-signal fields.
// searchKeywords carries subcategory + categoryGroup (auto-populated) plus any
// manual aliases the owner adds (e.g. "sweatshirt" for English-speaking customers).
// default_language 'spanish' enables correct stemming for Spanish search terms
// so "sudadera" matches "sudaderas", "legging" matches "leggings", etc.
// NOTE: description (weight 1) is intentionally low to reduce false positives.
// Monitor at scale — remove description from index if irrelevant results appear.
productSchema.index(
  {
    name: "text",
    brand: "text",
    searchKeywords: "text",
    subcategory: "text",
    categoryGroup: "text",
    description: "text",
  },
  {
    weights: {
      name: 10,
      brand: 8,
      searchKeywords: 6,
      subcategory: 6,
      categoryGroup: 3,
      description: 1,
    },
    name: "product_text_search",
    default_language: "spanish",
  },
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProductSchemaType = InferSchemaType<typeof productSchema>;
export type ProductDocument = HydratedDocument<ProductSchemaType>;

// ─── Model ────────────────────────────────────────────────────────────────────

export const ProductModel = model<ProductDocument>("Product", productSchema);
