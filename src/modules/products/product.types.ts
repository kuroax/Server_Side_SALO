// ─── Enums ────────────────────────────────────────────────────────────────────

// NOTE: Claude service uses 'female'/'male' for gender — normalized to
// 'women'/'men' in webhook.service.ts searchProductsForClaude before querying
// MongoDB. Any new entry point that calls the search must apply the same
// normalization or the gender filter will silently return no results.
export const GENDERS = {
  MEN: "men",
  WOMEN: "women",
} as const;

export const SIZES = {
  XS: "XS",
  S: "S",
  M: "M",
  L: "L",
  XL: "XL",
} as const;

export const PRODUCT_STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export type Gender = (typeof GENDERS)[keyof typeof GENDERS];
export type Size = (typeof SIZES)[keyof typeof SIZES];
export type ProductStatus =
  (typeof PRODUCT_STATUS)[keyof typeof PRODUCT_STATUS];

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
  // Searchable aliases stored lowercase. Auto-populated from subcategory +
  // categoryGroup by the service layer. Owners can add manual terms.
  searchKeywords: string[];
};

// NOTE: _id is typed as string here for ergonomics after the toProductResponse
// mapper calls .toString() on the raw Mongoose ObjectId. Do not use this type
// directly against hydrated Mongoose documents — use ProductDocument instead.
export type ProductEntity = ProductBase & {
  _id: string;
  createdAt: Date;
  updatedAt: Date;
};

// Fields omitted: slug (server-generated from name).
// Fields made optional: images, status, variants, searchKeywords — these all
// have Zod defaults in createProductSchema and are not required by callers.
// Without this, TypeScript forces callers to provide them even though the
// runtime would default them, creating a false type contract.
export type CreateProductInput = Omit<
  ProductBase,
  "slug" | "images" | "status" | "variants" | "searchKeywords"
> & {
  images?: string[];
  status?: ProductStatus;
  variants?: ProductVariant[];
  searchKeywords?: string[];
};

// All fields optional for partial updates.
// NOTE: searchKeywords is a full array replacement — there is no additive
// type support for "append this keyword". The service layer handles merging
// with existing keywords in updateProduct via buildSearchKeywords.
// Consider { addKeywords?: string[]; removeKeywords?: string[] } if the UI
// evolves to support individual keyword add/remove without full replacement.
export type UpdateProductInput = Partial<Omit<ProductBase, "slug">>;

// createdAt and updatedAt are strings — serialized via toISOString() before returning
export type ProductResponse = Omit<
  ProductEntity,
  "_id" | "createdAt" | "updatedAt"
> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};
