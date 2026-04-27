/**
 * scripts/migrate-color-from-name.ts
 *
 * ONE-TIME migration: promotes the color suffix in product names into the
 * variant.color field and updates matching inventory records.
 *
 * BEFORE:
 *   products.name = "CROPPED ALL DAY SHORT SLEEVE - WHITE"
 *   products.variants[*].color = "default"
 *   inventories.color = "default"
 *
 * AFTER:
 *   products.name = "CROPPED ALL DAY SHORT SLEEVE"
 *   products.variants[*].color = "white"  ← lowercase, matches inventory pre-save hook
 *   inventories.color = "white"
 *
 * SAFE TO RUN:
 *   - Dry-run by default (pass --commit to write)
 *   - Idempotent: skips products whose variants already have a real color
 *   - Skips products whose name has no recognizable color suffix
 *   - All product + inventory updates for one product happen in a single
 *     bulkWrite / updateMany pair — not perfectly atomic but isolated per product
 *
 * USAGE:
 *   npx tsx src/scripts/migrate-color-from-name.ts           # dry run
 *   npx tsx src/scripts/migrate-color-from-name.ts --commit  # write to DB
 */

import mongoose from 'mongoose';
import { MONGODB_URI } from '#/config/env.js';
import { ProductModel } from '#/modules/products/product.model.js';
import { InventoryModel } from '#/modules/inventory/inventory.model.js';

const DRY_RUN = !process.argv.includes('--commit');

// ─── Color extraction ─────────────────────────────────────────────────────────
// Matches the pattern: "PRODUCT NAME - COLOR" where COLOR is the last word(s)
// after the final " - " separator.
// Examples:
//   "CROPPED ALL DAY SHORT SLEEVE - WHITE"  → { name: "CROPPED ALL DAY SHORT SLEEVE", color: "white" }
//   "ALIGN LEGGING - HEATHERED BLACK"       → { name: "ALIGN LEGGING", color: "heathered black" }
//   "ALIGN LEGGING"                         → null (no suffix found)

const COLOR_SUFFIX_RE = /^(.+?)\s+-\s+([A-Z][A-Z\s]+)$/;

function extractColor(name: string): { strippedName: string; color: string } | null {
  const match = name.trim().match(COLOR_SUFFIX_RE);
  if (!match) return null;
  return {
    strippedName: match[1].trim(),
    color: match[2].trim().toLowerCase(),
  };
}

// ─── Slug generator (mirrors product.service.ts) ──────────────────────────────

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log(`Connected to MongoDB — starting color migration (dryRun: ${DRY_RUN})`);

  const products = await ProductModel.find({}).lean();

  let skippedAlreadyMigrated = 0;
  let skippedNoColorSuffix   = 0;
  let migrated               = 0;
  let errors                 = 0;

  for (const product of products) {
    const productId = product._id.toString();

    // Skip if any variant already has a real color value
    const alreadyMigrated = product.variants.some(
      (v) => v.color && v.color !== 'default',
    );
    if (alreadyMigrated) {
      console.log(`  ⊘ ${product.name} (${productId}): skip — variants already have real color`);
      skippedAlreadyMigrated++;
      continue;
    }

    // Extract color from name
    const extracted = extractColor(product.name);
    if (!extracted) {
      console.warn(`  ⚠ ${product.name} (${productId}): skip — no color suffix detected in name`);
      skippedNoColorSuffix++;
      continue;
    }

    const { strippedName, color } = extracted;
    const newSlug = generateSlug(strippedName);

    console.log(`  → ${product.name}`);
    console.log(`    newName: ${strippedName} | color: ${color} | slug: ${newSlug} | dryRun: ${DRY_RUN}`);

    if (DRY_RUN) {
      migrated++;
      continue;
    }

    try {
      // 1. Update product: strip color from name, update slug, set color on all variants
      const updatedVariants = product.variants.map((v) => ({ ...v, color }));

      await ProductModel.updateOne(
        { _id: product._id },
        {
          $set: {
            name:     strippedName,
            slug:     newSlug,
            variants: updatedVariants,
          },
        },
        { runValidators: true },
      );

      // 2. Update all inventory records for this product from "default" → real color.
      //    The inventory pre-save hook runs on .save() but NOT on updateMany —
      //    we write lowercase explicitly here to match the hook's behavior.
      const inventoryResult = await InventoryModel.updateMany(
        { productId: product._id, color: 'default' },
        { $set: { color } },
      );

      console.log(`  ✓ ${strippedName} (${productId}): migrated — ${inventoryResult.modifiedCount} inventory records updated`);

      migrated++;
    } catch (err) {
      console.error(`  ✗ ${product.name} (${productId}): migration failed`, err);
      errors++;
    }
  }

  console.log(`\nDone — ${migrated} migrated, ${skippedAlreadyMigrated} already done, ${skippedNoColorSuffix} skipped (no suffix), ${errors} errors`);

  await mongoose.disconnect();
  process.exit(errors > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Unhandled migration error:', err);
  process.exit(1);
});