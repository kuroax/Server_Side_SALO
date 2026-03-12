import { z } from 'zod';
import { GENDERS, SIZES, PRODUCT_STATUS } from '#/modules/products/product.types.js';

// ─── Enum Arrays ──────────────────────────────────────────────────────────────

const SIZES_VALUES = Object.values(SIZES) as [string, ...string[]];
const GENDERS_VALUES = Object.values(GENDERS) as [string, ...string[]];
const STATUS_VALUES = Object.values(PRODUCT_STATUS) as [string, ...string[]];

// ─── Shared Schemas ───────────────────────────────────────────────────────────

const variantSchema = z.object({
  size: z.enum(SIZES_VALUES, {
    error: `Size must be one of: ${SIZES_VALUES.join(', ')}`,
  }),
  color: z
    .string()
    .trim()
    .min(1, 'Color is required')
    .max(50, 'Color must be at most 50 characters')
    .toLowerCase(),
});

const nameSchema = z
  .string()
  .trim()
  .min(2, 'Product name must be at least 2 characters')
  .max(120, 'Product name must be at most 120 characters');

const descriptionSchema = z
  .string()
  .trim()
  .min(10, 'Description must be at least 10 characters')
  .max(2000, 'Description must be at most 2000 characters');

const priceSchema = z
  .number({ error: 'Price must be a number' })
  .min(0, 'Price cannot be negative');

const brandSchema = z
  .string()
  .trim()
  .min(2, 'Brand must be at least 2 characters')
  .max(60, 'Brand must be at most 60 characters');

const genderSchema = z.enum(GENDERS_VALUES, {
  error: `Gender must be one of: ${GENDERS_VALUES.join(', ')}`,
});

const categoryGroupSchema = z
  .string()
  .trim()
  .min(2, 'Category group must be at least 2 characters')
  .max(60, 'Category group must be at most 60 characters');

const subcategorySchema = z
  .string()
  .trim()
  .min(2, 'Subcategory must be at least 2 characters')
  .max(60, 'Subcategory must be at most 60 characters');

const imagesSchema = z
  .array(z.string().url('Each image must be a valid URL'))
  .max(20, 'A product can have at most 20 images');

const statusSchema = z.enum(STATUS_VALUES, {
  error: `Status must be one of: ${STATUS_VALUES.join(', ')}`,
});

const variantsSchema = z
  .array(variantSchema)
  .max(50, 'A product can have at most 50 variants')
  .refine(
    (variants) => {
      const keys = variants.map((v) => `${v.size}-${v.color}`);
      return new Set(keys).size === keys.length;
    },
    { message: 'Duplicate variants are not allowed' },
  );

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
});

// ─── Get / Delete Product by ID ───────────────────────────────────────────────

export const productIdSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid product ID format'),
});

// ─── List Products (filters + pagination) ────────────────────────────────────

export const listProductsSchema = z.object({
  gender: genderSchema.optional(),
  categoryGroup: categoryGroupSchema.optional(),
  subcategory: subcategorySchema.optional(),
  brand: brandSchema.optional(),
  status: statusSchema.optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
});

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ProductIdInput = z.infer<typeof productIdSchema>;
export type ListProductsInput = z.infer<typeof listProductsSchema>;