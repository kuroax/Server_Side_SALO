/**
 * One-time backfill script
 *
 * Creates inventory records (quantity 0) for all existing products
 * that have variants but no matching inventory rows.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-inventory.ts
 *
 * Safe to run multiple times — duplicates are skipped via the unique index.
 */

import mongoose from 'mongoose';
import { ProductModel } from '#/modules/products/product.model.js';
import { InventoryModel } from '#/modules/inventory/inventory.model.js';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '#/modules/inventory/inventory.constants.js';

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/salo';

async function backfill() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const products = await ProductModel.find({
    'variants.0': { $exists: true },
  }).lean();

  console.log(`Found ${products.length} products with variants`);

  let created = 0;
  let skipped = 0;

  for (const product of products) {
    const docs = (product.variants ?? []).map((v) => ({
      productId: product._id,
      size: (v as { size: string }).size,
      color: (v as { color: string }).color,
      quantity: 0,
      lowStockThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
    }));

    try {
      const result = await InventoryModel.insertMany(docs, { ordered: false });
      created += result.length;
      console.log(`  ✓ ${product.name}: ${result.length} inventory records created`);
    } catch (err: unknown) {
      // Count successful inserts from bulk write error
      const bulkErr = err as { insertedDocs?: unknown[] };
      const inserted = bulkErr.insertedDocs?.length ?? 0;
      created += inserted;
      skipped += docs.length - inserted;
      console.log(`  ⊘ ${product.name}: ${inserted} created, ${docs.length - inserted} already existed`);
    }
  }

  console.log(`\nDone — ${created} records created, ${skipped} duplicates skipped`);
  await mongoose.disconnect();
}

backfill().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});