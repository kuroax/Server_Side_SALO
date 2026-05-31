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
} from "#/modules/boutiques/boutique.types.js";

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

// ─── Schema ───────────────────────────────────────────────────────────────────

const boutiqueSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "Boutique name is required"],
      trim: true,
      maxlength: [120, "Boutique name must be at most 120 characters"],
    },

    // Meta WhatsApp Cloud API phone number ID — globally unique across the
    // platform: one phone number can only be owned by one boutique.
    phoneNumberId: {
      type: String,
      required: [true, "phoneNumberId is required"],
      unique: true,
      trim: true,
    },

    // WhatsApp Business Account ID.
    wabaId: {
      type: String,
      required: [true, "wabaId is required"],
      trim: true,
    },

    // Permanent access token used by n8n to send messages on the boutique's
    // behalf. Never expose in GraphQL responses — boutique.resolvers.ts must
    // strip this field before returning.
    accessToken: {
      type: String,
      required: [true, "accessToken is required"],
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

// ─── Types ────────────────────────────────────────────────────────────────────

export type BoutiqueSchemaType = InferSchemaType<typeof boutiqueSchema>;
export type BoutiqueDocument = HydratedDocument<BoutiqueSchemaType>;
export type BoutiqueModelType = Model<BoutiqueSchemaType>;

// ─── Model ────────────────────────────────────────────────────────────────────

export const BoutiqueModel = model<BoutiqueSchemaType>(
  "Boutique",
  boutiqueSchema,
);
