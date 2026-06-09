import {
  Schema,
  model,
  type InferSchemaType,
  type HydratedDocument,
  type Model,
} from "mongoose";
import {
  BOUTIQUE_STATUS,
  CONVERSATION_MODE,
  BOUTIQUE_ONBOARDING_STATUS,
} from "#/modules/boutiques/boutique.types.js";
import { encrypt, decrypt, isEncrypted } from "#/shared/crypto.js";

// ─── Business info subdocument ────────────────────────────────────────────────

const businessInfoSchema = new Schema(
  {
    showroomAddress: { type: String, required: true, trim: true },
    businessHours: { type: String, required: true, trim: true },
    shippingPrice: { type: Number, required: true, min: 0 },
    paymentMethods: { type: String, required: true, trim: true },
    depositPercent: { type: Number, required: true, min: 0, max: 100 },
    paymentDays: { type: Number, required: true, min: 0 },
    deliveryInfo: { type: String, required: true, trim: true },
    activePromotion: { type: String, trim: true, default: undefined },
  },
  { _id: false },
);

// ─── Agent config subdocument ─────────────────────────────────────────────────
// Per-tenant identity for the WhatsApp AI agent. Lets a new boutique change the
// agent's name, business category, brand knowledge and persona WITHOUT any code
// change — these values are injected into the platform prompt at runtime by
// claude.service.ts via buildAgentSection(). The boutique-agnostic prompt rules
// (JSON contract, intents, payment flow, etc.) live in prompt/base.prompt.ts.

const agentConfigSchema = new Schema(
  {
    // Agent display name used in the system prompt, e.g. "Luis".
    agentName: { type: String, required: true, trim: true },
    // One phrase describing the business type, e.g.
    // "tienda de ropa deportiva y lifestyle de marcas premium como Alo Yoga…".
    categoryDescription: { type: String, required: true, trim: true },
    // Optional brand-specific product knowledge injected into the prompt, e.g.
    // "En Lululemon: talla M = talla 8, talla S = talla 6, talla XS = talla 4".
    brandKnowledge: { type: String, trim: true, default: undefined },
    // Optional per-boutique sales rules, phrases, emojis, upsell logic and size
    // guidance. Resolves the placeholders the base prompt references under
    // "INSTRUCCIONES DE VENTAS Y ESTILO". ShopaloGDL-specific content that used
    // to be hardcoded in base.prompt.ts now lives here per tenant.
    salesInstructions: { type: String, trim: true, default: undefined },
    // Optional additional tone/persona instructions specific to this boutique.
    personalityNotes: { type: String, trim: true, default: undefined },
  },
  { _id: false },
);

// ─── Schema ───────────────────────────────────────────────────────────────────

const boutiqueSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "Boutique name is required"],
      trim: true,
      maxlength: [120, "Boutique name must be at most 120 characters"],
    },

    // Human-readable URL-safe identifier (e.g. "shopalogdl"). Optional —
    // existing boutiques predate this field and are backfilled by
    // scripts/migrate-boutique-slugs.ts. The sparse-unique index is declared
    // explicitly below (boutiqueSchema.index) — do NOT add an index shortcut
    // (sparse/unique/index) here or Mongoose builds the index twice.
    slug: {
      type: String,
      trim: true,
      lowercase: true,
    },

    // Meta WhatsApp Cloud API phone number ID — globally unique across the
    // platform: one phone number can only be owned by one boutique.
    //
    // Optional + sparse: a boutique can be created (scripts/create-boutique.ts)
    // BEFORE its WhatsApp account is connected. The field is left unset until
    // Embedded Signup fills it in. Sparse-unique keeps the one-number-per-tenant
    // guarantee for connected boutiques while allowing many unconnected ones
    // (which simply omit the field) to coexist without colliding.
    phoneNumberId: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      default: undefined,
    },

    // WhatsApp Business Account ID. Optional until Embedded Signup completes.
    wabaId: {
      type: String,
      trim: true,
      default: undefined,
    },

    // Permanent access token used by n8n to send messages on the boutique's
    // behalf. Never expose in GraphQL responses — boutique.resolvers.ts must
    // strip this field before returning. Optional until Embedded Signup
    // completes; encrypted at rest by the hooks below when present.
    accessToken: {
      type: String,
      select: false,
      default: undefined,
    },

    // Optional Meta Business Portfolio ID — captured during Embedded Signup
    // when available, otherwise null for manually onboarded boutiques.
    businessPortfolioId: {
      type: String,
      trim: true,
      default: undefined,
    },

    // Cloudinary URL for the bank account image sent in payment_info flows.
    bankAccountImageUrl: {
      type: String,
      trim: true,
      default: undefined,
    },

    // Owner's personal WhatsApp number (digits-only). Receives owner alerts
    // (new prospect, receipt received, handoff needed) sent via alert.service.
    // Distinct from phoneNumberId, which is the boutique's Cloud API sender.
    ownerPhone: {
      type: String,
      trim: true,
    },

    // Embedded business info — replaces the old BUSINESS_INFO constant in
    // webhook.service.ts. Each tenant owns its own copy.
    businessInfo: {
      type: businessInfoSchema,
      required: true,
    },

    // Per-tenant agent identity — injected into the platform prompt at runtime.
    // Required: every active boutique must define its agent's name + category.
    agentConfig: {
      type: agentConfigSchema,
      required: true,
    },

    // Tenant-wide bot toggle. When "manual" the bot stays silent for every
    // conversation of this boutique. Per-conversation mode lives on the
    // conversation document and is checked separately.
    globalMode: {
      type: String,
      enum: Object.values(CONVERSATION_MODE),
      default: CONVERSATION_MODE.AUTO,
    },

    status: {
      type: String,
      enum: Object.values(BOUTIQUE_STATUS),
      default: BOUTIQUE_STATUS.ACTIVE,
    },

    // Onboarding funnel stage — see BOUTIQUE_ONBOARDING_STATUS. Defaults to
    // CREATED for boutiques minted by scripts/create-boutique.ts, advanced as
    // the tenant connects WhatsApp and goes live.
    onboardingStatus: {
      type: String,
      enum: Object.values(BOUTIQUE_ONBOARDING_STATUS),
      default: BOUTIQUE_ONBOARDING_STATUS.CREATED,
    },

    // Set when the boutique completed Embedded Signup. Null/undefined for
    // the first boutique (Axel Monterrubio) which was onboarded manually.
    connectedAt: {
      type: Date,
      default: undefined,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// phoneNumberId is the primary webhook lookup key — read on every incoming
// message. The unique constraint above already creates this index, but we
// keep it explicit for documentation. Skipping the redundant declaration to
// avoid the Mongoose "duplicate index" warning.

boutiqueSchema.index({ status: 1 });

// Sparse-unique slug — lets boutiques without a slug coexist (sparse skips
// null/missing) while guaranteeing no two boutiques share the same slug.
boutiqueSchema.index({ slug: 1 }, { unique: true, sparse: true });

// ─── accessToken at-rest encryption ─────────────────────────────────────────────
//
// accessToken is encrypted (AES-256-GCM) before it ever touches MongoDB and
// decrypted transparently on read, so callers always see plaintext.
//
// Decryption lives at the MODEL layer (post find/findOne) rather than in
// boutique.service.ts because accessToken is read from TWO independent places:
//   - boutique.service.ts (findBoutiqueByPhoneNumberIdWithToken)
//   - ownerConfirm.service.ts (its own direct .select("+accessToken") query)
// A model-level hook is the single point that gives BOTH plaintext with zero
// caller changes. All hooks are idempotent via isEncrypted() so a deploy that
// precedes the migration still works (legacy plaintext is read/written as-is).

// Mutates a read result in place: decrypts accessToken when present + encrypted.
// Legacy plaintext (pre-migration) is left untouched so reads never break.
function decryptAccessTokenInPlace(doc: unknown): void {
  if (!doc || typeof doc !== "object") return;
  const record = doc as { accessToken?: unknown };
  if (typeof record.accessToken === "string" && isEncrypted(record.accessToken)) {
    record.accessToken = decrypt(record.accessToken);
  }
}

// Encrypt on document save() — covers createBoutique and any model.create().
boutiqueSchema.pre("save", function () {
  if (
    this.isModified("accessToken") &&
    typeof this.accessToken === "string" &&
    this.accessToken &&
    !isEncrypted(this.accessToken)
  ) {
    this.accessToken = encrypt(this.accessToken);
  }
});

// Encrypt on $set updates — covers updateBoutiqueCredentials (findByIdAndUpdate)
// and any updateOne. Only touches $set.accessToken; all other fields untouched.
boutiqueSchema.pre(["findOneAndUpdate", "updateOne"], function () {
  const update = this.getUpdate() as {
    $set?: { accessToken?: unknown };
  } | null;
  const set = update?.$set;
  if (
    set &&
    typeof set.accessToken === "string" &&
    set.accessToken &&
    !isEncrypted(set.accessToken)
  ) {
    set.accessToken = encrypt(set.accessToken);
  }
});

// Decrypt on read — fires for find, findOne, findById (findById → findOne).
// Query middleware runs regardless of .lean(), so lean reads are covered.
boutiqueSchema.post("findOne", function (doc) {
  decryptAccessTokenInPlace(doc);
});

boutiqueSchema.post("find", function (docs) {
  if (Array.isArray(docs)) docs.forEach(decryptAccessTokenInPlace);
});

// ─── Types ────────────────────────────────────────────────────────────────────

export type BoutiqueSchemaType = InferSchemaType<typeof boutiqueSchema>;
export type BoutiqueDocument = HydratedDocument<BoutiqueSchemaType>;
export type BoutiqueModelType = Model<BoutiqueSchemaType>;

// ─── Model ────────────────────────────────────────────────────────────────────

export const BoutiqueModel = model<BoutiqueSchemaType>(
  "Boutique",
  boutiqueSchema,
);
