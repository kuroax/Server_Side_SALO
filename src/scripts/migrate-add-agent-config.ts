/**
 * One-time migration — add agentConfig to the ShopaloGDL boutique (tenant #1)
 *
 * The WhatsApp agent's identity (name, business category, brand knowledge) used
 * to be hardcoded in the SYSTEM_PROMPT constant in claude.service.ts. It now
 * lives per-tenant in boutique.agentConfig and is injected into the prompt at
 * runtime by buildAgentSection(). This script writes the exact values that were
 * previously hardcoded for ShopaloGDL so Luis's behavior is unchanged.
 *
 * Idempotent: re-running just re-sets the same values.
 *
 * Usage:
 *   npm run migrate:add-agent-config
 *   # or: npx tsx src/scripts/migrate-add-agent-config.ts
 *
 * Required env vars (validated by src/config/env.ts): MONGODB_URI
 */

import mongoose from "mongoose";
import { MONGODB_URI } from "#/config/env.js";
import { BoutiqueModel } from "#/modules/boutiques/boutique.model.js";
import { logger } from "#/config/logger.js";

// ShopaloGDL identifiers. We match on either so the script works whether the
// boutique is keyed by its known phoneNumberId or its known _id.
const SHOPALO_PHONE_NUMBER_ID = "1056527177541784";
const SHOPALO_ID = "6a15631c074684288beaa0f6";

// Exact values previously hardcoded in SYSTEM_PROMPT for ShopaloGDL.
// - agentName + categoryDescription reproduce the opening identity paragraph.
// - brandKnowledge reproduces the Lululemon size-equivalence guide.
// - personalityNotes is intentionally omitted (undefined): the persona is
//   encoded in the structure of the base platform prompt, not per-tenant.
const SHOPALO_AGENT_CONFIG = {
  agentName: "Luis",
  categoryDescription:
    "tienda de ropa deportiva y lifestyle de marcas premium como Alo Yoga, Lululemon, Wiskii, 437, Better Me y Skims",
  brandKnowledge:
    "En Lululemon: talla M = talla 8, talla S = talla 6, talla XS = talla 4",
} as const;

async function main(): Promise<void> {
  await mongoose.connect(MONGODB_URI);
  logger.info("Connected to MongoDB — migrating agentConfig for ShopaloGDL");

  // Build an $or that tolerates the _id being either a real ObjectId or absent.
  const or: Array<Record<string, unknown>> = [
    { phoneNumberId: SHOPALO_PHONE_NUMBER_ID },
  ];
  if (mongoose.isValidObjectId(SHOPALO_ID)) {
    or.push({ _id: new mongoose.Types.ObjectId(SHOPALO_ID) });
  }

  const boutique = await BoutiqueModel.findOneAndUpdate(
    { $or: or },
    { $set: { agentConfig: SHOPALO_AGENT_CONFIG } },
    { new: true, runValidators: true },
  );

  if (!boutique) {
    logger.error(
      {
        phoneNumberId: SHOPALO_PHONE_NUMBER_ID,
        id: SHOPALO_ID,
      },
      "ShopaloGDL boutique not found — nothing migrated",
    );
    throw new Error("ShopaloGDL boutique not found");
  }

  logger.info(
    {
      boutiqueId: boutique._id.toString(),
      phoneNumberId: boutique.phoneNumberId,
      agentName: boutique.agentConfig.agentName,
    },
    "agentConfig migration succeeded",
  );
}

main()
  .then(async () => {
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err }, "agentConfig migration failed");
    try {
      await mongoose.disconnect();
    } catch {
      // ignore disconnect errors during failure path
    }
    process.exit(1);
  });
