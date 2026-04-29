import { z } from "zod";
import {
  GENDERS,
  SIZES,
  PRODUCT_STATUS,
} from "#/modules/products/product.types.js";

// ─── Enum Arrays ──────────────────────────────────────────────────────────────

const SIZES_VALUES = Object.values(SIZES) as [string, ...string[]];
const GENDERS_VALUES = Object.values(GENDERS) as [string, ...string[]];
const STATUS_VALUES = Object.values(PRODUCT_STATUS) as [string, ...string[]];

// ─── Shared Schemas ───────────────────────────────────────────────────────────

const variantSchema = z.object({
  size: z.enum(SIZES_VALUES, {
    error: `Size must be one of: ${SIZES_VALUES.join(", ")}`,
  }),
  color: z
    .string()
    .trim()
    .min(1, "Color is required")
    .max(50, "Color must be at most 50 characters")
    .toLowerCase(),
});

const nameSchema = z
  .string()
  .trim()
  // Collapse internal whitespace — prevents "Alo  Crop Top" (double space)
  // generating a different slug from "Alo Crop Top" (single space).
  .transform((v) => v.replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(2, "Product name must be at least 2 characters")
      .max(120, "Product name must be at most 120 characters"),
  );

const descriptionSchema = z
  .string()
  .trim()
  .min(10, "Description must be at least 10 characters")
  .max(2000, "Description must be at most 2000 characters");

const priceSchema = z
  .number({ error: "Price must be a number" })
  .min(1, "Price must be greater than 0");

const brandSchema = z
  .string()
  .trim()
  .min(2, "Brand must be at least 2 characters")
  .max(60, "Brand must be at most 60 characters");

const genderSchema = z.enum(GENDERS_VALUES, {
  error: `Gender must be one of: ${GENDERS_VALUES.join(", ")}`,
});

const categoryGroupSchema = z
  .string()
  .trim()
  .min(2, "Category group must be at least 2 characters")
  .max(60, "Category group must be at most 60 characters");

const subcategorySchema = z
  .string()
  .trim()
  .min(2, "Subcategory must be at least 2 characters")
  .max(60, "Subcategory must be at most 60 characters");

const imagesSchema = z
  .array(z.string().url("Each image must be a valid URL"))
  .max(20, "A product can have at most 20 images");

const statusSchema = z.enum(STATUS_VALUES, {
  error: `Status must be one of: ${STATUS_VALUES.join(", ")}`,
});

const variantsSchema = z
  .array(variantSchema)
  .max(50, "A product can have at most 50 variants")
  .refine(
    (variants) => {
      const keys = variants.map((v) => `${v.size}-${v.color}`);
      return new Set(keys).size === keys.length;
    },
    { message: "Duplicate variants are not allowed" },
  );

// Individual keywords are stored lowercase and trimmed.
// Max 30 keywords per product — guards against index bloat.
// NOTE: No .default([]) here — defaults are applied per-schema below.
// Adding .default([]) at this level causes .optional() in updateProductSchema
// to silently apply [] instead of leaving the field absent, which would wipe
// all keywords on any partial update that omits this field.
const searchKeywordsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1, "Keyword cannot be empty")
      .max(60, "Each keyword must be at most 60 characters")
      .toLowerCase(),
  )
  .max(30, "A product can have at most 30 search keywords");

// ─── Create Product ───────────────────────────────────────────────────────────

export const createProductSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
  price: priceSchema,
  brand: brandSchema,
  gender: genderSchema,
  categoryGroup: categoryGroupSchema,
  subcategory: subcategorySchema,
  images: imagesSchema.default([]),
  status: statusSchema.default(PRODUCT_STATUS.ACTIVE),
  variants: variantsSchema.default([]),
  // .default([]) applied here only — not on the shared schema.
  // updateProductSchema uses .optional() so omitting this field
  // on a partial update correctly leaves existing keywords untouched.
  searchKeywords: searchKeywordsSchema.default([]),
});

// ─── Update Product ───────────────────────────────────────────────────────────

export const updateProductSchema = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  price: priceSchema.optional(),
  brand: brandSchema.optional(),
  gender: genderSchema.optional(),
  categoryGroup: categoryGroupSchema.optional(),
  subcategory: subcategorySchema.optional(),
  images: imagesSchema.optional(),
  status: statusSchema.optional(),
  variants: variantsSchema.optional(),
  searchKeywords: searchKeywordsSchema.optional(),
});

// ─── Get / Delete Product by ID ───────────────────────────────────────────────

export const productIdSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid product ID format"),
});

// ─── List Products (filters + pagination) ────────────────────────────────────

// Filter schemas are intentionally looser than the create/update schemas.
// Using the shared schemas (which have min(2)) would throw validation errors
// on single-character filter values instead of simply returning no results.
const filterStringSchema = (max: number) =>
  z.string().trim().min(1).max(max).optional();

export const listProductsSchema = z.object({
  gender: genderSchema.optional(),
  categoryGroup: filterStringSchema(60),
  subcategory: filterStringSchema(60),
  brand: filterStringSchema(60),
  status: statusSchema.optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
});

// ─── Inferred Types ───────────────────────────────────────────────────────────

// NOTE: CreateProductInput and UpdateProductInput are intentionally NOT exported
// here — they are defined in product.types.ts. Exporting Zod-inferred versions
// with the same name would create a collision and two types with the same name
// but different shapes (Zod infers all defaulted fields as optional).
export type ProductIdInput = z.infer<typeof productIdSchema>;
export type ListProductsInput = z.infer<typeof listProductsSchema>;
