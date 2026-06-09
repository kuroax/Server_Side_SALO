/**
 * One-time migration: encrypt existing plaintext boutique.accessToken values.
 *
 * Run AFTER deploying the encryption code (boutique.model.ts hooks + crypto.ts).
 * The deploy is safe on its own: reads pass plaintext through untouched and new
 * writes are encrypted. This script encrypts the legacy plaintext token(s) that
 * already exist in MongoDB (currently Boutique #1).
 *
 * Idempotent: re-running skips anything already encrypted.
 *
 * IMPORTANT: reads/writes go through the NATIVE driver (BoutiqueModel.collection)
 * to bypass the Mongoose hooks — otherwise the post-find hook would decrypt on
 * read (breaking isEncrypted detection) and the pre-update hook would re-encrypt
 * (double encryption). The native driver gives raw, single-pass control.
 *
 * Usage:
 *   npm run migrate:encrypt-tokens
 *   # or: npx tsx src/scripts/migrate-encrypt-tokens.ts
 *
 * Required env vars (validated by src/config/env.ts at import):
 *   MONGODB_URI
 *   BOUTIQUE_TOKEN_ENCRYPTION_KEY
 */

import mongoose from "mongoose";
import { MONGODB_URI } from "#/config/env.js";
import { BoutiqueModel } from "#/modules/boutiques/boutique.model.js";
import { encrypt, isEncrypted } from "#/shared/crypto.js";
import { logger } from "#/config/logger.js";

async function run(): Promise<void> {
  await mongoose.connect(MONGODB_URI);
  logger.info("migrate-encrypt-tokens — connected to MongoDB");

  // Native collection read — bypasses the decrypt-on-read model hook so we see
  // the raw stored value and can correctly tell plaintext from ciphertext.
  const collection = BoutiqueModel.collection;

  const docs = await collection
    .find({ accessToken: { $exists: true, $ne: null } })
    .project({ _id: 1, accessToken: 1, phoneNumberId: 1 })
    .toArray();

  let encrypted = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of docs) {
    const id = doc._id;
    const token = doc.accessToken;

    if (typeof token !== "string" || token.length === 0) {
      skipped++;
      logger.info({ boutiqueId: String(id) }, "skip — no string accessToken");
      continue;
    }

    if (isEncrypted(token)) {
      skipped++;
      logger.info({ boutiqueId: String(id) }, "skip — already encrypted");
      continue;
    }

    try {
      const ciphertext = encrypt(token);
      // Native write — bypasses the pre-update encrypt hook (no double encryption).
      await collection.updateOne(
        { _id: id },
        { $set: { accessToken: ciphertext } },
      );
      encrypted++;
      logger.info({ boutiqueId: String(id) }, "encrypted accessToken");
    } catch (err) {
      failed++;
      logger.error({ err, boutiqueId: String(id) }, "failed to encrypt accessToken");
    }
  }

  logger.info(
    { total: docs.length, encrypted, skipped, failed },
    "migrate-encrypt-tokens — summary",
  );

  await mongoose.disconnect();
  logger.info("migrate-encrypt-tokens — disconnected");

  if (failed > 0) process.exit(1);
}

run().catch(async (err) => {
  logger.error({ err }, "migrate-encrypt-tokens — fatal error");
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
