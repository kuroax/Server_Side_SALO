// ─── Enums ────────────────────────────────────────────────────────────────────

export const GENDERS = {
  MEN: 'men',
  WOMEN: 'women',
} as const;

export const SIZES = {
  XS: 'XS',
  S: 'S',
  M: 'M',
  L: 'L',
  XL: 'XL',
  XXL: 'XXL',
} as const;

export const PRODUCT_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export type Gender = (typeof GENDERS)[keyof typeof GENDERS];
export type Size = (typeof SIZES)[keyof typeof SIZES];
export type ProductStatus = (typeof PRODUCT_STATUS)[keyof typeof PRODUCT_STATUS];

export type ProductVariant = {
  size: Size;
  color: string;
};

export type ProductBase = {
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
};

export type ProductEntity = ProductBase & {
  _id: string;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateProductInput = Omit<ProductBase, 'slug'>;
export type UpdateProductInput = Partial<Omit<ProductBase, 'slug'>>;

// createdAt and updatedAt are strings — serialized via toISOString() before returning
export type ProductResponse = Omit<ProductEntity, '_id' | 'createdAt' | 'updatedAt'> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};