import type { Types } from 'mongoose';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const GENDERS = {
  MEN: 'men',
  WOMEN: 'women',
} as const;

export type Gender = (typeof GENDERS)[keyof typeof GENDERS];

export const SIZES = {
  XS: 'XS',
  S: 'S',
  M: 'M',
  L: 'L',
  XL: 'XL',
  XXL: 'XXL',
} as const;

export type Size = (typeof SIZES)[keyof typeof SIZES];

export const PRODUCT_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const;

export type ProductStatus = (typeof PRODUCT_STATUS)[keyof typeof PRODUCT_STATUS];

// ─── Variant ──────────────────────────────────────────────────────────────────

export interface ProductVariant {
  size: Size;
  color: string;
}

// ─── Shared Product Fields ────────────────────────────────────────────────────

export interface ProductBase {
  name: string;
  slug: string;
  description: string;
  price: number;
  brand: string;
  gender: Gender;
  categoryGroup: string;
  subcategory: string;
  images: string[];
  status: ProductStatus;
  variants: ProductVariant[];
}

// ─── Persisted Product ────────────────────────────────────────────────────────

export interface ProductEntity extends ProductBase {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Inputs ───────────────────────────────────────────────────────────────────

// slug is auto-generated from name in the service — owner never provides it
export interface CreateProductInput extends Omit<ProductBase, 'slug'> {}

export interface UpdateProductInput extends Partial<Omit<ProductBase, 'slug'>> {}

// ─── API Response ─────────────────────────────────────────────────────────────

export type ProductResponse = Omit<ProductEntity, '_id'> & { id: string };