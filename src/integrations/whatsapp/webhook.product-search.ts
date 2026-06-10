// ─── Product search + image helpers ───────────────────────────────────────────
// On-demand product search (called by claude.service.ts via the searchProducts
// callback) plus the URL/image normalization and catalog-hint matching helpers.
// Extracted from webhook.service.ts.

import { ProductModel } from "#/modules/products/product.model.js";
import { InventoryModel } from "#/modules/inventory/inventory.model.js";
import { logger } from "#/config/logger.js";
import type { ProductImage } from "#/integrations/whatsapp/webhook.schemas.js";
import type {
  ClaudeSearchHints,
  ProductSearchItem,
} from "#/integrations/whatsapp/claude.service.js";

// Escapes regex metacharacters so a Claude-derived color string can be used
// safely inside a $regex query without throwing a MongoError or behaving as a
// pattern. Mirrors the helper used in ownerConfirm.service.ts / customer.service.ts.
const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function findProductByHint(
  hint: string,
  catalog: { id: string; name: string; price: number }[],
): { id: string; name: string; price: number } | null {
  const normalized = hint.toLowerCase().trim();
  const hintWords = normalized.split(/\s+/).filter(Boolean);

  // Pass 1: substring match — fast path for exact or near-exact names
  const exactMatch =
    catalog.find((p) => p.name.toLowerCase().includes(normalized)) ??
    catalog.find((p) => normalized.includes(p.name.toLowerCase()));
  if (exactMatch) return exactMatch;

  // Pass 2: word-overlap match — handles partial multi-word names.
  // e.g. hint "jersey accolade" matches "Jersey de cuello redondo Accolade"
  // because both words appear somewhere in the product name.
  return (
    catalog.find((p) => {
      const productWords = p.name.toLowerCase().split(/\s+/);
      return hintWords.every((hw) =>
        productWords.some((pw) => pw.includes(hw) || hw.includes(pw)),
      );
    }) ?? null
  );
}

export function toValidUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    return undefined;
  }
}

export function normalizeProductImages(value: unknown): ProductImage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const url = toValidUrl(item);
      return url ? { url } : undefined;
    })
    .filter((img): img is ProductImage => Boolean(img));
}

// ─── On-demand product search ─────────────────────────────────────────────────
// Called by claude.service.ts only when Claude invokes the search_products tool.
//
// ARCHITECTURE NOTE — why this joins InventoryModel instead of filtering
// products directly:
//
// Before the color migration, color lived in the product name as a suffix
// ("CROP TOP - WHITE") and variant.color was always "default". The old approach
// loaded all active products and filtered by name/brand/categoryGroup.
//
// After the migration, color is a first-class variant field and stock is tracked
// per (productId, size, color) in the inventories collection. The correct query
// for "tienes crop tops en negro talla S" is therefore:
//
//   1. Find products matching the keyword/gender filter (products collection)
//   2. Join with inventories to find which (product, size, color) combinations
//      actually have stock > 0
//   3. Filter by color hint and size hint at the inventory level
//   4. Return one ProductSearchItem per matching in-stock variant, with the
//      product's image and the variant's real color in the caption
//
// This means the bot only shows items that are actually available, and the
// caption accurately reflects color ("Crop Top (Alo) — Blanco — $1,599").

export async function searchProductsForClaude(
  boutiqueId: string,
  hints: ClaudeSearchHints,
): Promise<ProductSearchItem[]> {
  const keyword = hints.keyword.toLowerCase().trim();

  // Guard: empty keyword would throw "text search string is empty" from MongoDB.
  // claude.service.ts validates keyword with min(1) but we defend here too.
  if (!keyword) return [];

  // Special value "*" = browse all active products without text search.
  // Used by the explicit inventory fast-path when the customer asks to
  // see everything available rather than a specific product.
  if (keyword === "*") {
    const browseFilter: Record<string, unknown> = { boutiqueId, status: "active" };
    if (hints.gender && hints.gender !== "unknown") {
      browseFilter.gender = hints.gender === "female" ? "women" : "men";
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let browseProducts: any[] = [];
    try {
      browseProducts = await ProductModel.find(browseFilter)
        .select("name price brand gender categoryGroup subcategory images")
        .limit(20)
        .lean();
    } catch {
      return [];
    }
    // If gender filter returned 0, retry without gender
    if (browseProducts.length === 0 && browseFilter.gender) {
      delete browseFilter.gender;
      try {
        browseProducts = await ProductModel.find(browseFilter)
          .select("name price brand gender categoryGroup subcategory images")
          .limit(20)
          .lean();
      } catch {
        return [];
      }
    }
    if (browseProducts.length === 0) return [];
    // Reuse the rest of the function — set products and fall through
    // to the inventory join. We do this by temporarily replacing
    // the keyword search result. Since the function is async/sequential,
    // the cleanest approach is to duplicate the join inline.
    // (Refactor to shared helper is deferred — see technical debt.)
    const browseIds = browseProducts.map((p) => p._id);
    const browseInventory = await InventoryModel.find({
      boutiqueId,
      productId: { $in: browseIds },
      quantity: { $gt: 0 },
    })
      .select("productId size color quantity")
      .lean();
    if (browseInventory.length === 0) return [];
    const browseMap = new Map(browseProducts.map((p) => [p._id.toString(), p]));
    const browseSeen = new Set<string>();
    const browseResults: ProductSearchItem[] = [];
    for (const inv of browseInventory) {
      const idStr = inv.productId.toString();
      if (browseSeen.has(idStr)) continue;
      browseSeen.add(idStr);
      const product = browseMap.get(idStr);
      if (!product) continue;
      const displayColor = inv.color
        .split(" ")
        .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      const primaryCaption = `$${product.price.toLocaleString("es-MX")} — ${product.name} ${displayColor} (${product.brand})`;
      const images = (product.images ?? [])
        .map((uri: string, index: number) => {
          const url = toValidUrl(uri);
          return url ? { url, caption: index === 0 ? primaryCaption : "" } : null;
        })
        .filter((img: { url: string; caption: string } | null): img is { url: string; caption: string } =>
          img !== null && img !== undefined,
        );
      browseResults.push({
        name: product.name,
        brand: product.brand,
        price: product.price,
        color: displayColor,
        images,
      });
    }
    logger.info(
      { gender: hints.gender, returned: browseResults.length },
      "searchProductsForClaude — browse-all query complete",
    );
    return browseResults;
  }

  // Step 1: Match products using MongoDB full-text index.
  // The text index covers: name (weight 10), brand (8), searchKeywords (6),
  // subcategory (6), categoryGroup (3), description (1) — with Spanish stemming.
  // This replaces the previous in-memory .filter() which did a full collection
  // scan on every search call and missed subcategory-to-colloquial-term matches
  // (e.g. customer says "sudadera", product is named "Jersey de cuello redondo").
  //
  // Gender normalization: DB stores 'women'/'men', Claude sends 'female'/'male'.
  const productFilter: Record<string, unknown> = {
    boutiqueId,
    status: "active",
    $text: { $search: keyword },
  };

  if (hints.gender && hints.gender !== "unknown") {
    const dbGender = hints.gender === "female" ? "women" : "men";
    productFilter.gender = dbGender;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let products: any[] = [];

  try {
    products = await ProductModel.find(productFilter, {
      score: { $meta: "textScore" },
    })
      .select("name price brand gender categoryGroup subcategory images")
      .sort({ score: { $meta: "textScore" } })
      .limit(20)
      .lean();
  } catch (err: unknown) {
    // If the text index doesn't exist yet (fresh deploy, index still building),
    // MongoDB throws "text index required for $text query". Log clearly and
    // return empty rather than crashing the entire message handler.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("text index required")) {
      logger.error(
        { keyword, err },
        "searchProductsForClaude — text index not ready, returning empty. Check MongoDB index status.",
      );
      return [];
    }
    throw err;
  }

  if (products.length === 0 && productFilter.gender) {
    // Safety net: gender filter returned 0 results.
    // A male customer asking generically ("tienes sudaderas") should see all
    // available products — not 0 results because the catalog is women's clothing.
    // Retry without the gender filter before giving up.
    const filterWithoutGender = { ...productFilter };
    delete filterWithoutGender.gender;
    try {
      products = await ProductModel.find(filterWithoutGender, {
        score: { $meta: "textScore" },
      })
        .select("name price brand gender categoryGroup subcategory images")
        .sort({ score: { $meta: "textScore" } })
        .limit(20)
        .lean();
      if (products.length > 0) {
        logger.info(
          { keyword, removedGender: productFilter.gender },
          "searchProductsForClaude — gender filter returned 0, retried without gender and found results",
        );
      }
    } catch {
      // If retry also fails, fall through to return []
    }
  }

  if (products.length === 0) return [];

  const matchingProductIds = products.map((p) => p._id);

  // Step 2: Query inventory for in-stock variants of matching products.
  // Filter by size and color at the DB level so we don't return zero-stock rows.
  const inventoryFilter: Record<string, unknown> = {
    boutiqueId,
    productId: { $in: matchingProductIds },
    quantity: { $gt: 0 },
  };

  if (hints.size) {
    // inventory.size is stored uppercase via pre-save hook
    inventoryFilter.size = hints.size.trim().toUpperCase();
  }

  if (hints.color) {
    // inventory.color is stored lowercase via pre-save hook
    // Support partial color match: "negro" matches "negro intenso", etc.
    inventoryFilter.color = {
      $regex: escapeRegex(hints.color.trim().toLowerCase()),
      $options: "i",
    };
  }

  const inStockInventory = await InventoryModel.find(inventoryFilter)
    .select("productId size color quantity")
    .lean();

  if (inStockInventory.length === 0) return [];

  // Step 3: Build a product lookup map for fast joining
  const productMap = new Map(products.map((p) => [p._id.toString(), p]));

  // Step 4: Deduplicate by product and build one ProductSearchItem per matching
  // product (not per inventory variant).
  //
  // The previous implementation returned one item per in-stock inventory record.
  // For a product with XS/S/M all in stock, this produced 3 items each pointing
  // to product.images[0], causing the first image to be sent 3 times.
  //
  // The correct behaviour:
  //   - One ProductSearchItem per product
  //   - All product images included (not just images[0])
  //   - Caption on the first image identifies the product; subsequent images
  //     carry an empty caption so they arrive as a clean gallery
  //
  // We use a Map keyed by productId to collapse the inventory rows back into
  // one result per product while still reflecting that in-stock variants exist.

  const seenProductIds = new Set<string>();
  const results: ProductSearchItem[] = [];

  for (const inv of inStockInventory) {
    const productIdStr = inv.productId.toString();
    if (seenProductIds.has(productIdStr)) continue;
    seenProductIds.add(productIdStr);

    const product = productMap.get(productIdStr);
    if (!product) continue;

    // Human-readable color: capitalize first letter of each word for display
    const displayColor = inv.color
      .split(" ")
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

    const primaryCaption = `$${product.price.toLocaleString("es-MX")} — ${product.name} ${displayColor} (${product.brand})`;

    // Build one image entry per product photo.
    // First image carries the identifying caption; the rest arrive captionless
    // so WhatsApp groups them into a single gallery without repeated text.
    const images = (product.images ?? [])
      .map((uri: string, index: number) => {
        const url = toValidUrl(uri);
        return url ? { url, caption: index === 0 ? primaryCaption : "" } : null;
      })
      .filter(
        (
          img: { url: string; caption: string } | null,
        ): img is { url: string; caption: string } =>
          img !== null && img !== undefined,
      );

    results.push({
      name: product.name,
      brand: product.brand,
      price: product.price,
      color: displayColor,
      images,
    });
  }

  logger.info(
    {
      keyword,
      gender: hints.gender,
      size: hints.size,
      color: hints.color,
      productMatches: products.length,
      inventoryMatches: inStockInventory.length,
      returned: results.length,
    },
    "searchProductsForClaude — query complete",
  );

  return results;
}
