/**
 * migrate-search-keywords.ts
 *
 * Backfills the searchKeywords field on all existing products.
 * Safe to run multiple times — uses $set with a deduped array each time.
 *
 * Run with:
 *   npx tsx src/scripts/migrate-search-keywords.ts
 */

import mongoose from "mongoose";
import { ProductModel } from "#/modules/products/product.model.js";
import { MONGODB_URI } from "#/config/env.js";
import { logger } from "#/config/logger.js";

async function migrate(): Promise<void> {
  await mongoose.connect(MONGODB_URI);
  logger.info("Connected to MongoDB");

  // Fetch only the fields needed for keyword generation.
  // Does NOT load images, variants, or description — keeps memory low.
  const products = await ProductModel.find({})
    .select("_id subcategory categoryGroup searchKeywords")
    .lean();

  logger.info({ total: products.length }, "Products to migrate");

  let updated = 0;
  let skipped = 0;

  for (const product of products) {
    const auto = [product.subcategory, product.categoryGroup]
      .filter(Boolean)
      .map((k) => (k as string).toLowerCase().trim());

    // Preserve any manual keywords the owner may have already added
    const existing = ((product.searchKeywords as string[]) ?? []).map((k) =>
      k.toLowerCase().trim(),
    );

    const merged = Array.from(new Set([...auto, ...existing]));

    // Skip if nothing changed — avoids unnecessary writes
    const current = new Set(existing);
    const hasNew = merged.some((k) => !current.has(k));

    if (!hasNew && existing.length === merged.length) {
      skipped++;
      continue;
    }

    await ProductModel.findByIdAndUpdate(product._id, {
      $set: { searchKeywords: merged },
    });

    updated++;
  }

  logger.info({ updated, skipped }, "Migration complete");

  await mongoose.disconnect();
  logger.info("Disconnected from MongoDB");
}

migrate().catch((err) => {
  logger.error({ err }, "Migration failed");
  process.exit(1);
});
