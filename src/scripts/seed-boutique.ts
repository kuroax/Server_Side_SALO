/**
 * One-time multi-tenant migration script
 *
 * 1. Creates the first boutique document (Axel Monterrubio) keyed on
 *    phoneNumberId. Safe to re-run — uses findOneAndUpdate with upsert.
 * 2. Backfills boutiqueId on every existing document in:
 *      Products, Inventory, Customers, Conversations, Orders
 *    The backfill is filtered to { boutiqueId: { $exists: false } } so
 *    re-runs are idempotent and never re-tag documents that already
 *    belong to a different tenant.
 * 3. Verifies that no document remains without boutiqueId. Exits non-zero
 *    if any collection still has unscoped records.
 *
 * Usage:
 *   npx tsx src/scripts/seed-boutique.ts
 *
 * Required env vars (already validated by src/config/env.ts):
 *   MONGODB_URI
 *   WHATSAPP_ACCESS_TOKEN
 *   BANK_ACCOUNT_IMAGE_URL   (optional)
 */

import mongoose from "mongoose";
import {
  MONGODB_URI,
  WHATSAPP_ACCESS_TOKEN,
  BANK_ACCOUNT_IMAGE_URL,
} from "#/config/env.js";
import { BoutiqueModel } from "#/modules/boutiques/boutique.model.js";
import { ProductModel } from "#/modules/products/product.model.js";
import { InventoryModel } from "#/modules/inventory/inventory.model.js";
import { CustomerModel } from "#/modules/customers/customer.model.js";
import { ConversationModel } from "#/modules/conversations/conversation.model.js";
import { OrderModel } from "#/modules/orders/order.model.js";
import { UserModel } from "#/modules/auth/auth.model.js";

// ─── Tenant #1 — Axel Monterrubio ─────────────────────────────────────────────
// These values mirror the BUSINESS_INFO constant in webhook.service.ts at the
// time of migration. Do NOT edit values here once a boutique exists — update
// the document directly through the boutiques GraphQL mutation instead.

const FIRST_BOUTIQUE = {
  name: "shopalogdl",
  phoneNumberId: "1136131782919468",
  wabaId: "1470978480789686",
  businessInfo: {
    showroomAddress:
      "Av. Guadalupe 1390, Chapalita Oriente, Guadalajara, Jalisco",
    businessHours:
      "Lunes a Viernes 10:00am–8:30pm · Sábados 11:00am–7:00pm · Domingos cerrado",
    shippingPrice: 179,
    paymentMethods:
      "Transferencia bancaria, depósito o tarjeta de crédito/débito. No se acepta efectivo en pedidos sobre pedido.",
    depositPercent: 30,
    paymentDays: 20,
    deliveryInfo: "3 a 7 días hábiles una vez confirmado el pago",
  },
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

type CollectionBackfill = {
  name: string;
  count: () => Promise<number>;
  backfill: (boutiqueId: mongoose.Types.ObjectId) => Promise<number>;
};

const backfills: CollectionBackfill[] = [
  {
    name: "Product",
    count: () =>
      ProductModel.countDocuments({ boutiqueId: { $exists: false } }),
    backfill: async (boutiqueId) => {
      const result = await ProductModel.updateMany(
        { boutiqueId: { $exists: false } },
        { $set: { boutiqueId } },
        { strict: false },
      );
      return result.modifiedCount;
    },
  },
  {
    name: "Inventory",
    count: () =>
      InventoryModel.countDocuments({ boutiqueId: { $exists: false } }),
    backfill: async (boutiqueId) => {
      const result = await InventoryModel.updateMany(
        { boutiqueId: { $exists: false } },
        { $set: { boutiqueId } },
        { strict: false },
      );
      return result.modifiedCount;
    },
  },
  {
    name: "Customer",
    count: () =>
      CustomerModel.countDocuments({ boutiqueId: { $exists: false } }),
    backfill: async (boutiqueId) => {
      const result = await CustomerModel.updateMany(
        { boutiqueId: { $exists: false } },
        { $set: { boutiqueId } },
      );
      return result.modifiedCount;
    },
  },
  {
    name: "Conversation",
    count: () =>
      ConversationModel.countDocuments({ boutiqueId: { $exists: false } }),
    backfill: async (boutiqueId) => {
      const result = await ConversationModel.updateMany(
        { boutiqueId: { $exists: false } },
        { $set: { boutiqueId } },
      );
      return result.modifiedCount;
    },
  },
  {
    name: "Order",
    count: () => OrderModel.countDocuments({ boutiqueId: { $exists: false } }),
    backfill: async (boutiqueId) => {
      const result = await OrderModel.updateMany(
        { boutiqueId: { $exists: false } },
        { $set: { boutiqueId } },
        { strict: false },
      );
      return result.modifiedCount;
    },
  },
  {
    name: "User",
    count: () => UserModel.countDocuments({ boutiqueId: { $exists: false } }),
    backfill: async (boutiqueId) => {
      const result = await UserModel.updateMany(
        { boutiqueId: { $exists: false } },
        { $set: { boutiqueId } },
        { strict: false },
      );
      return result.modifiedCount;
    },
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log("✓ Connected to MongoDB");

  // ── Step 1: upsert the first boutique ───────────────────────────────────────
  const boutique = await BoutiqueModel.findOneAndUpdate(
    { phoneNumberId: FIRST_BOUTIQUE.phoneNumberId },
    {
      $setOnInsert: {
        name: FIRST_BOUTIQUE.name,
        phoneNumberId: FIRST_BOUTIQUE.phoneNumberId,
        wabaId: FIRST_BOUTIQUE.wabaId,
        accessToken: WHATSAPP_ACCESS_TOKEN,
        bankAccountImageUrl: BANK_ACCOUNT_IMAGE_URL,
        businessInfo: FIRST_BOUTIQUE.businessInfo,
        // connectedAt intentionally omitted — Axel was onboarded manually
        // before Embedded Signup existed.
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  if (!boutique) {
    throw new Error("Failed to upsert first boutique");
  }

  const boutiqueId = boutique._id;
  console.log(`✓ Boutique ready: ${boutique.name} (${boutiqueId.toString()})`);

  // ── Step 2: backfill boutiqueId on existing documents ───────────────────────
  console.log("\nBackfilling boutiqueId on existing documents…");
  for (const collection of backfills) {
    const modified = await collection.backfill(boutiqueId);
    console.log(`  ✓ ${collection.name}: ${modified} document(s) updated`);
  }

  // ── Step 3: verify ──────────────────────────────────────────────────────────
  console.log("\nVerifying — counting documents still missing boutiqueId…");
  let missingTotal = 0;
  for (const collection of backfills) {
    const remaining = await collection.count();
    if (remaining > 0) {
      console.error(
        `  ✗ ${collection.name}: ${remaining} document(s) still missing boutiqueId`,
      );
      missingTotal += remaining;
    } else {
      console.log(`  ✓ ${collection.name}: all documents scoped`);
    }
  }

  if (missingTotal > 0) {
    console.error(
      `\n✗ Migration incomplete — ${missingTotal} document(s) still unscoped.`,
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  // ── Step 4: summary ─────────────────────────────────────────────────────────
  console.log("\n────────────────────────────────────────────────────────────");
  console.log("✓ Migration complete.");
  console.log(`  SALO_BOUTIQUE_ID = ${boutiqueId.toString()}`);
  console.log(
    "  Save this value in Railway as SALO_BOUTIQUE_ID for reference.",
  );
  console.log("────────────────────────────────────────────────────────────");

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("Seed boutique failed:", err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore disconnect errors during failure path
  }
  process.exit(1);
});
