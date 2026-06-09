/**
 * Interactive boutique onboarding CLI
 *
 * Creates ONE boutique document and ONE owner user document atomically.
 * The boutique is created in the pre-WhatsApp state:
 *   status            = "active"
 *   globalMode        = "auto"
 *   onboardingStatus  = "CREATED"
 * with NO phoneNumberId / wabaId / accessToken — those are filled in later by
 * the Embedded Signup flow (see embeddedSignup.controller.ts).
 *
 * Atomicity: both inserts run inside a single MongoDB transaction
 * (mongoose withTransaction). If either insert fails the transaction aborts and
 * BOTH documents are rolled back — there is never a boutique without its owner
 * or vice-versa.
 *
 * Usage:
 *   npm run create-boutique
 *   # or
 *   npx tsx src/scripts/create-boutique.ts
 *
 * Required env vars (validated by src/config/env.ts):
 *   MONGODB_URI                     — Atlas replica set (transactions required)
 *   BOUTIQUE_TOKEN_ENCRYPTION_KEY   — loaded by the model layer
 *   BCRYPT_SALT_ROUNDS              — used by hashPassword (optional, default 12)
 */

import mongoose from "mongoose";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { MONGODB_URI } from "#/config/env.js";
import { BoutiqueModel } from "#/modules/boutiques/boutique.model.js";
import { UserModel } from "#/modules/auth/auth.model.js";
import { hashPassword } from "#/modules/auth/auth.utils.js";
import {
  BOUTIQUE_STATUS,
  CONVERSATION_MODE,
  BOUTIQUE_ONBOARDING_STATUS,
} from "#/modules/boutiques/boutique.types.js";
import type { Role } from "#/modules/auth/auth.types.js";

// ─── Prompt helpers ─────────────────────────────────────────────────────────--

const rl = readline.createInterface({ input, output });

// A simple email shape check — intentionally permissive; the source of truth is
// still the unique index on the users collection.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function askRequired(label: string): Promise<string> {
  for (;;) {
    const answer = (await rl.question(`${label}: `)).trim();
    if (answer) return answer;
    console.log("  ↳ This field is required. Please enter a value.");
  }
}

async function askOptional(label: string): Promise<string | undefined> {
  const answer = (await rl.question(`${label} (optional, Enter to skip): `)).trim();
  return answer === "" ? undefined : answer;
}

async function askNumber(
  label: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): Promise<number> {
  const { min, max, integer } = opts;
  for (;;) {
    const raw = (await rl.question(`${label}: `)).trim();
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value)) {
      console.log("  ↳ Please enter a valid number.");
      continue;
    }
    if (integer && !Number.isInteger(value)) {
      console.log("  ↳ Please enter a whole number.");
      continue;
    }
    if (min !== undefined && value < min) {
      console.log(`  ↳ Must be at least ${min}.`);
      continue;
    }
    if (max !== undefined && value > max) {
      console.log(`  ↳ Must be at most ${max}.`);
      continue;
    }
    return value;
  }
}

async function askEmail(): Promise<string | undefined> {
  for (;;) {
    const raw = (await rl.question("Owner email (optional, Enter to skip): ")).trim();
    if (raw === "") return undefined;
    if (EMAIL_RE.test(raw)) return raw.toLowerCase();
    console.log("  ↳ That doesn't look like a valid email. Try again or press Enter to skip.");
  }
}

async function askPassword(): Promise<string> {
  for (;;) {
    const raw = await rl.question("Initial owner password (min 8 chars): ");
    if (raw.length >= 8) return raw;
    console.log("  ↳ Password must be at least 8 characters.");
  }
}

// Owner phone normalized to digits-only (matches the customer-phone convention
// and how alert.service.ts expects ownerPhone). Re-asks until at least 10 digits.
async function askPhone(label: string): Promise<string> {
  for (;;) {
    const raw = (await rl.question(`${label}: `)).trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 10) return digits;
    console.log("  ↳ Enter a valid phone number (at least 10 digits).");
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────--

async function run() {
  console.log("\n────────────────────────────────────────────────────────────");
  console.log("  SALO · Create a new boutique");
  console.log("────────────────────────────────────────────────────────────\n");

  // ── Gather + validate every input BEFORE any write ────────────────────────--
  console.log("Boutique\n────────");
  const name = await askRequired("Boutique name");
  const ownerPhone = await askPhone("Owner WhatsApp phone (for alerts)");

  console.log("\nAI agent\n────────");
  const agentName = await askRequired("Agent name (e.g. Luis)");
  const categoryDescription = await askRequired("Category description");
  const brandKnowledge = await askOptional("Brand knowledge");

  console.log("\nBusiness info\n─────────────");
  const showroomAddress = await askRequired("Showroom address");
  const businessHours = await askRequired("Business hours");
  const shippingPrice = await askNumber("Shipping price (MXN)", { min: 0 });
  const paymentMethods = await askRequired("Payment methods");
  const depositPercent = await askNumber("Deposit percent (0–100)", {
    min: 0,
    max: 100,
  });
  const paymentDays = await askNumber("Payment days", { min: 0, integer: true });
  const deliveryInfo = await askRequired("Delivery info");

  console.log("\nOwner account\n─────────────");
  const ownerUsername = (await askRequired("Owner username")).toLowerCase();
  const ownerEmail = await askEmail();
  const password = await askPassword();

  rl.close();

  // ── Connect ───────────────────────────────────────────────────────────────--
  await mongoose.connect(MONGODB_URI);
  console.log("\n✓ Connected to MongoDB");

  // ── Duplicate-username pre-check (friendly error before the transaction) ────--
  const existing = await UserModel.exists({ username: ownerUsername });
  if (existing) {
    console.error(
      `\n✗ Username "${ownerUsername}" is already taken. Choose another and re-run.`,
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  // Hash the password up front — bcrypt is async and we want the transaction
  // body to be as short as possible.
  const hashedPassword = await hashPassword(password);

  // ── Atomic create (boutique + owner) ──────────────────────────────────────--
  const session = await mongoose.startSession();
  let createdBoutiqueId: string | null = null;

  try {
    await session.withTransaction(async () => {
      const [boutique] = await BoutiqueModel.create(
        [
          {
            name,
            ownerPhone,
            businessInfo: {
              showroomAddress,
              businessHours,
              shippingPrice,
              paymentMethods,
              depositPercent,
              paymentDays,
              deliveryInfo,
            },
            agentConfig: {
              agentName,
              categoryDescription,
              ...(brandKnowledge ? { brandKnowledge } : {}),
            },
            status: BOUTIQUE_STATUS.ACTIVE,
            globalMode: CONVERSATION_MODE.AUTO,
            onboardingStatus: BOUTIQUE_ONBOARDING_STATUS.CREATED,
            // phoneNumberId / wabaId / accessToken intentionally omitted —
            // filled in by Embedded Signup.
          },
        ],
        { session },
      );

      await UserModel.create(
        [
          {
            boutiqueId: boutique._id,
            username: ownerUsername,
            ...(ownerEmail ? { email: ownerEmail } : {}),
            password: hashedPassword,
            role: "owner" as Role,
            isActive: true,
          },
        ],
        { session },
      );

      createdBoutiqueId = boutique._id.toString();
    });
  } catch (err) {
    // withTransaction already aborted → both documents rolled back.
    console.error("\n✗ Failed to create boutique — transaction rolled back.");
    console.error(err);
    await session.endSession();
    await mongoose.disconnect();
    process.exit(1);
  }

  await session.endSession();

  // ── Success summary ───────────────────────────────────────────────────────--
  console.log("\n────────────────────────────────────────────────────────────");
  console.log("✓ Boutique created");
  console.log("────────────────────────────────────────────────────────────");
  console.log(`  Boutique _id    : ${createdBoutiqueId}`);
  console.log(`  Name            : ${name}`);
  console.log(`  phoneNumberId   : (empty — filled by Embedded Signup)`);
  console.log(`  onboardingStatus: ${BOUTIQUE_ONBOARDING_STATUS.CREATED}`);
  console.log("\n  Owner login");
  console.log(`    username      : ${ownerUsername}`);
  if (ownerEmail) console.log(`    email         : ${ownerEmail}`);
  console.log(`    password      : (the one you just entered)`);
  console.log("\n  First-login instructions:");
  console.log("    1. Open the SALO app and sign in with the username + password above.");
  console.log("    2. Change the password from your profile after first login.");
  console.log("    3. Connect WhatsApp via Embedded Signup to finish onboarding");
  console.log("       (this fills in phoneNumberId / wabaId / accessToken).");
  console.log("────────────────────────────────────────────────────────────\n");

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("create-boutique failed:", err);
  try {
    rl.close();
  } catch {
    // already closed
  }
  try {
    await mongoose.disconnect();
  } catch {
    // ignore disconnect errors during failure path
  }
  process.exit(1);
});
