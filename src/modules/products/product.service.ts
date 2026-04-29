import { ProductModel } from "#/modules/products/product.model.js";
import type { ProductDocument } from "#/modules/products/product.model.js";
import {
  createProductSchema,
  updateProductSchema,
  productIdSchema,
  listProductsSchema,
} from "#/modules/products/product.validation.js";
import type { ProductResponse } from "#/modules/products/product.types.js";
import { logger } from "#/config/logger.js";
import { NotFoundError, BadRequestError } from "#/shared/errors/index.js";
import { InventoryModel } from "#/modules/inventory/inventory.model.js";
import { DEFAULT_LOW_STOCK_THRESHOLD } from "#/modules/inventory/inventory.constants.js";

// ─── ProductLike ──────────────────────────────────────────────────────────────

// Accepts both hydrated documents and lean plain objects — removes all as-casts
type ProductLike = {
  _id: { toString(): string };
  name: string;
  slug: string;
  description: string;
  price: number;
  brand: string;
  gender: ProductResponse["gender"];
  categoryGroup: string;
  subcategory: string;
  images: string[];
  status: ProductResponse["status"];
  variants: ProductResponse["variants"];
  searchKeywords: string[];
  createdAt: Date | string;
  updatedAt: Date | string;
};

// ─── Slug Generator ───────────────────────────────────────────────────────────

const generateSlug = (name: string): string => {
  return name
    .toLowerCase()
    .trim()
    .normalize("NFD") // decompose accented chars
    .replace(/[\u0300-\u036f]/g, "") // strip diacritic marks
    .replace(/[^a-z0-9\s-]/g, "") // remove non-alphanumeric
    .replace(/\s+/g, "-") // spaces to hyphens
    .replace(/-+/g, "-") // collapse multiple hyphens
    .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
};

// Escapes special regex characters — defensive against future slug rule changes
const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildUniqueSlug = async (
  name: string,
  excludeId?: string,
): Promise<string> => {
  const base = generateSlug(name);

  if (!base) {
    throw new BadRequestError(
      `Product name "${name}" does not contain any letters or numbers that can form a URL slug. Please use standard characters.`,
    );
  }

  const regex = new RegExp(`^${escapeRegex(base)}(-\\d+)?$`);
  const query: Record<string, unknown> = { slug: { $regex: regex } };
  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  const existingSlugs = await ProductModel.find(query).select("slug").lean();

  if (existingSlugs.length === 0) return base;

  const suffixes = existingSlugs.map((p) => {
    const match = (p.slug as string).match(/-(\d+)$/);
    return match ? parseInt(match[1], 10) : 0;
  });

  const nextSuffix = Math.max(...suffixes) + 1;
  return `${base}-${nextSuffix}`;
};

// ─── Safe date serializer ─────────────────────────────────────────────────────

// Converts Date or string to ISO string. Guards against malformed date values
// (e.g. "invalid-date") which would cause new Date().toISOString() to throw
// RangeError and crash the mapper entirely.
const toISOStringSafe = (v: Date | string): string => {
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) {
    logger.warn(
      { value: v },
      "toProductResponse — invalid date value, falling back to epoch",
    );
    return new Date(0).toISOString();
  }
  return d.toISOString();
};

// ─── Mapper ───────────────────────────────────────────────────────────────────

const toProductResponse = (product: ProductLike): ProductResponse => ({
  id: product._id.toString(),
  name: product.name,
  slug: product.slug,
  description: product.description,
  price: product.price,
  brand: product.brand,
  gender: product.gender,
  categoryGroup: product.categoryGroup,
  subcategory: product.subcategory,
  images: product.images,
  status: product.status,
  variants: product.variants,
  searchKeywords: product.searchKeywords ?? [],
  createdAt: toISOStringSafe(product.createdAt),
  updatedAt: toISOStringSafe(product.updatedAt),
});

// ─── Inventory Sync Helper ───────────────────────────────────────────────────

/**
 * Creates inventory records (quantity 0) for each variant that doesn't
 * already have one. Uses ordered: false so existing duplicates are
 * silently skipped via the unique compound index.
 */
const syncInventoryForVariants = async (
  productId: { toString(): string },
  variants: { size: string; color: string }[],
): Promise<void> => {
  if (!variants || variants.length === 0) return;

  const inventoryDocs = variants.map((variant) => ({
    productId,
    size: variant.size,
    color: variant.color,
    quantity: 0,
    lowStockThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
  }));

  try {
    await InventoryModel.insertMany(inventoryDocs, { ordered: false });
    logger.info(
      { productId: productId.toString(), variantCount: inventoryDocs.length },
      "Inventory records created for product variants",
    );
  } catch (err: unknown) {
    // With ordered: false, duplicate key errors are expected for existing
    // variants — only log if there are non-duplicate failures
    const bulkErr = err as { writeErrors?: { code: number }[] };
    const nonDuplicateErrors = (bulkErr.writeErrors ?? []).filter(
      (e) => e.code !== 11000,
    );
    if (nonDuplicateErrors.length > 0) {
      logger.warn(
        { productId: productId.toString(), error: err },
        "Failed to auto-create some inventory records",
      );
    } else {
      // All errors were duplicates — variants already existed, nothing to create.
      // Logged at debug level to distinguish from "insertMany was never called".
      logger.debug(
        { productId: productId.toString(), variantCount: inventoryDocs.length },
        "syncInventoryForVariants — all variants already exist, no new records created",
      );
    }
  }
};

// ─── Search Keywords Builder ──────────────────────────────────────────────────

// Merges auto-generated keywords (from subcategory + categoryGroup) with any
// manual keywords provided by the owner. All stored lowercase and deduplicated.
// Lives in the service layer — NOT a pre-save hook — because updateProduct uses
// findByIdAndUpdate which bypasses Mongoose hooks entirely.
const buildSearchKeywords = (
  subcategory: string,
  categoryGroup: string,
  manualKeywords: string[] = [],
): string[] => {
  const auto = [subcategory, categoryGroup]
    .filter(Boolean)
    .map((k) => k.toLowerCase().trim());

  const manual = manualKeywords
    .map((k) => k.toLowerCase().trim())
    .filter(Boolean);

  return Array.from(new Set([...auto, ...manual]));
};

// ─── Create ───────────────────────────────────────────────────────────────────

export const createProduct = async (
  input: unknown,
): Promise<ProductResponse> => {
  const validated = createProductSchema.parse(input);
  const slug = await buildUniqueSlug(validated.name);

  const searchKeywords = buildSearchKeywords(
    validated.subcategory,
    validated.categoryGroup,
    validated.searchKeywords,
  );

  let product: ProductDocument;

  try {
    product = await ProductModel.create({
      ...validated,
      slug,
      searchKeywords,
    });
  } catch (err: unknown) {
    // Slug has a unique index — two concurrent creates with the same name
    // can both compute the same slug and race to insert. Catch E11000 and
    // surface a clear error instead of a generic 500.
    const mongoErr = err as { code?: number };
    if (mongoErr.code === 11000) {
      throw new BadRequestError(
        `A product with a similar name already exists. Try a more specific name.`,
      );
    }
    throw err;
  }

  // Auto-create inventory records (quantity 0) for each variant
  await syncInventoryForVariants(product._id, validated.variants ?? []);

  logger.info(
    { productId: product._id, slug, searchKeywords },
    "Product created",
  );

  return toProductResponse(product.toObject() as ProductLike);
};

// ─── Get by ID ────────────────────────────────────────────────────────────────

export const getProductById = async (
  input: unknown,
): Promise<ProductResponse> => {
  const { id } = productIdSchema.parse(input);

  const product = await ProductModel.findById(id).lean<ProductLike>();

  if (!product) {
    throw new NotFoundError("Product not found");
  }

  return toProductResponse(product);
};

// ─── Get by Slug ──────────────────────────────────────────────────────────────

export const getProductBySlug = async (
  slug: string,
): Promise<ProductResponse> => {
  const normalizedSlug = slug.trim().toLowerCase();

  if (!normalizedSlug) {
    throw new BadRequestError("Slug cannot be empty");
  }

  const product = await ProductModel.findOne({
    slug: normalizedSlug,
  }).lean<ProductLike>();

  if (!product) {
    throw new NotFoundError("Product not found");
  }

  return toProductResponse(product);
};

// ─── List ─────────────────────────────────────────────────────────────────────

export const listProducts = async (
  input: unknown,
): Promise<{
  products: ProductResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}> => {
  const { page, limit, gender, categoryGroup, subcategory, brand, status } =
    listProductsSchema.parse(input);

  const filter: Record<string, unknown> = {};
  if (gender) filter.gender = gender;
  if (categoryGroup) filter.categoryGroup = categoryGroup;
  if (subcategory) filter.subcategory = subcategory;
  if (brand) filter.brand = brand;
  if (status) filter.status = status;

  const skip = (page - 1) * limit;

  // NOTE: sort by { createdAt: -1 } has no dedicated index.
  // At pilot scale (3–20 products) this is negligible.
  // Add productSchema.index({ createdAt: -1 }) in product.model.ts if
  // listProducts becomes slow as the catalog grows.
  const [products, total] = await Promise.all([
    ProductModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<ProductLike[]>(),
    ProductModel.countDocuments(filter),
  ]);

  return {
    products: products.map(toProductResponse),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
};

// ─── Update ───────────────────────────────────────────────────────────────────

export const updateProduct = async (
  id: unknown,
  input: unknown,
): Promise<ProductResponse> => {
  const { id: productId } = productIdSchema.parse({ id });
  const validated = updateProductSchema.parse(input);

  // Check is post-parse intentionally — Zod strips unknown fields and applies
  // defaults, so the check reflects the actual validated payload, not raw input.
  // A client sending only unknown fields will hit this error after Zod cleaning.
  if (Object.keys(validated).length === 0) {
    throw new BadRequestError("No fields provided for update");
  }

  const updateData: Record<string, unknown> = { ...validated };

  // Determine if we need to read the current document.
  // Consolidate into ONE read to avoid reading inconsistent state across
  // two separate queries (race condition if another update fires between them).
  const needsSlugRebuild = !!validated.name;
  const needsKeywordRebuild =
    validated.subcategory !== undefined ||
    validated.categoryGroup !== undefined ||
    validated.searchKeywords !== undefined;

  if (needsSlugRebuild || needsKeywordRebuild) {
    const current = await ProductModel.findById(productId)
      .select("name subcategory categoryGroup searchKeywords")
      .lean();

    if (!current) throw new NotFoundError("Product not found");

    // Slug rebuild — only if name actually changed
    if (needsSlugRebuild && validated.name !== current.name) {
      updateData.slug = await buildUniqueSlug(validated.name!, productId);
    }

    // Keyword rebuild — merge new values with current stored values
    if (needsKeywordRebuild) {
      const effectiveSubcategory =
        validated.subcategory ?? (current.subcategory as string);
      const effectiveCategoryGroup =
        validated.categoryGroup ?? (current.categoryGroup as string);
      const effectiveManual =
        validated.searchKeywords ?? (current.searchKeywords as string[]) ?? [];

      updateData.searchKeywords = buildSearchKeywords(
        effectiveSubcategory,
        effectiveCategoryGroup,
        effectiveManual,
      );
    }
  }

  const product = await ProductModel.findByIdAndUpdate(
    productId,
    { $set: updateData },
    { new: true, runValidators: true },
  ).lean<ProductLike>();

  if (!product) {
    throw new NotFoundError("Product not found");
  }

  // If variants were updated, sync inventory for any new ones
  if (validated.variants) {
    await syncInventoryForVariants(product._id, validated.variants);
  }

  logger.info(
    { productId, updatedFields: Object.keys(validated) },
    "Product updated",
  );

  return toProductResponse(product);
};

// ─── Delete ───────────────────────────────────────────────────────────────────

export const deleteProduct = async (input: unknown): Promise<boolean> => {
  const { id } = productIdSchema.parse(input);

  // Verify product exists before deleting anything
  const product = await ProductModel.findById(id).select("_id").lean();
  if (!product) {
    throw new NotFoundError("Product not found");
  }

  // Delete inventory BEFORE the product — if inventory cleanup fails, the
  // product still exists and the operation can be retried cleanly.
  // Reversing this order would delete the product first, leaving orphaned
  // inventory records with no recovery path.
  await InventoryModel.deleteMany({ productId: id }).catch((err) => {
    logger.warn(
      { productId: id, error: err },
      "Failed to clean up inventory records before product deletion — aborting delete",
    );
    throw err; // Re-throw so product is NOT deleted if inventory cleanup fails
  });

  await ProductModel.findByIdAndDelete(id);

  logger.info({ productId: id }, "Product deleted");

  return true;
};
