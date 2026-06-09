/**
 * One-time migration: backfill `slug` on existing boutiques.
 *
 * The boutique model gained a sparse-unique `slug` field (used by the app to
 * display the correct boutique name/identifier). Existing boutiques predate it
 * and have no slug. This script assigns the known slugs:
 *
 *   name matches /shopalo/i  →  slug: "shopalogdl"
 *   name matches /idea1/i    →  slug: "idea1"
 *
 * Any other boutique is logged and skipped (its slug must be set explicitly,
 * either via create-boutique.ts going forward or a follow-up migration).
 *
 * Idempotent: re-running simply re-sets the same slug values.
 *
 * Usage:
 *   npm run migrate:boutique-slugs
 *   # or
 *   npx tsx src/scripts/migrate-boutique-slugs.ts
 */

import mongoose from "mongoose";
import { MONGODB_URI } from "#/config/env.js";
import { BoutiqueModel } from "#/modules/boutiques/boutique.model.js";

// name regex → slug to assign
const SLUG_RULES: { match: RegExp; slug: string }[] = [
  { match: /shopalo/i, slug: "shopalogdl" },
  { match: /idea1/i, slug: "idea1" },
];

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log("✓ Connected to MongoDB");

  const boutiques = await BoutiqueModel.find()
    .select("_id name slug")
    .lean<{ _id: mongoose.Types.ObjectId; name: string; slug?: string }[]>();

  console.log(`\nFound ${boutiques.length} boutique(s).\n`);

  let updated = 0;
  let skipped = 0;

  for (const boutique of boutiques) {
    const rule = SLUG_RULES.find((r) => r.match.test(boutique.name));

    if (!rule) {
      console.warn(
        `  ⚠ Skipping "${boutique.name}" (${boutique._id.toString()}) — no slug rule matches.`,
      );
      skipped += 1;
      continue;
    }

    await BoutiqueModel.updateOne(
      { _id: boutique._id },
      { $set: { slug: rule.slug } },
    );

    console.log(
      `  ✓ "${boutique.name}" (${boutique._id.toString()}) → slug: "${rule.slug}"`,
    );
    updated += 1;
  }

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`✓ Slug migration complete — ${updated} updated, ${skipped} skipped.`);
  console.log("────────────────────────────────────────────────────────────");

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("migrate-boutique-slugs failed:", err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore disconnect errors during failure path
  }
  process.exit(1);
});
