import {
  Schema,
  model,
  type InferSchemaType,
  type HydratedDocument,
  type Model,
} from "mongoose";
import {
  CUSTOMER_CHANNELS,
  CUSTOMER_TAGS,
  CUSTOMER_GENDERS,
} from "#/modules/customers/customer.types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const normalizePhone = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\D/g, "");
  return normalized || undefined;
};

const normalizeInstagramHandle = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/^@/, "").trim().toLowerCase();
  return normalized || undefined;
};

// ─── Schema ───────────────────────────────────────────────────────────────────

const customerSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    // Stored in normalized form: digits only, no spaces, hyphens, or + prefix.
    // Example: "5213328205715" (Meta E.164 without the +).
    // Normalization is applied before any query or upsert — see service/boundary layer.
    // The pre-save hook below is only a fallback for direct save() calls.
    phone: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },

    instagramHandle: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
    },

    contactChannel: {
      type: String,
      required: true,
      enum: Object.values(CUSTOMER_CHANNELS),
    },

    notes: {
      type: String,
      trim: true,
    },

    tags: {
      type: [{ type: String, enum: Object.values(CUSTOMER_TAGS) }],
      default: [],
    },

    address: {
      type: String,
      trim: true,
    },

    // Used by Luis to adapt communication style.
    // female  → "bonita", "bella", "corazón"
    // male    → "amigo", direct tone, no feminine nicknames
    // unknown → defaults to female (majority of SALO customers)
    gender: {
      type: String,
      enum: Object.values(CUSTOMER_GENDERS),
      default: CUSTOMER_GENDERS.UNKNOWN,
    },

    // Cached sum of all non-cancelled order totals for this customer (MXN).
    // Updated by order.service.ts whenever an order is created, completed,
    // or cancelled — never computed on the fly.
    //
    // Why cached and not aggregated:
    //   webhook.service.ts reads this on every incoming WhatsApp message to
    //   give Luis VIP vs. new-customer context. An aggregation on every message
    //   is a full orders-collection scan per request. The cache makes it free.
    //
    // Thresholds used by Luis (claude.service.ts buildVipContext):
    //   ≥ $50,000 MXN → VIP treatment, maximum payment flexibility
    //   ≥ $10,000 MXN → returning customer, warm confident tone
    //   undefined / 0  → new customer, standard onboarding tone
    //
    // Undefined (not 0) for customers who have no orders yet — lets the bot
    // distinguish "never ordered" from "ordered but total is genuinely $0".
    lifetimeValue: {
      type: Number,
      min: 0,
      default: undefined,
    },

    // Soft-delete flag. One canonical document per customer — never replaced.
    // isActive: false means the customer has been deactivated by the owner.
    // Deactivated customers are excluded from active lookups but their
    // record and history are preserved.
    // If a deactivated customer contacts again, the existing record is reused.
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ─── Normalization ────────────────────────────────────────────────────────────
// Applies only on direct save() calls.
// Query/upsert paths must normalize in the application layer before querying.

customerSchema.pre("save", function () {
  this.phone = normalizePhone(this.phone);
  this.instagramHandle = normalizeInstagramHandle(this.instagramHandle);
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

customerSchema.index({ isActive: 1, contactChannel: 1 });
customerSchema.index({ tags: 1 });

// Supports sorting / filtering customers by spend in the SALO dashboard.
// Also used if a future query ever needs to find all VIP customers directly.
customerSchema.index({ lifetimeValue: -1 });

// ─── Types ────────────────────────────────────────────────────────────────────

export type CustomerSchemaType = InferSchemaType<typeof customerSchema>;
export type CustomerDocument = HydratedDocument<CustomerSchemaType>;
export type CustomerModelType = Model<CustomerSchemaType>;

// ─── Model ────────────────────────────────────────────────────────────────────

export const CustomerModel = model<CustomerSchemaType>(
  "Customer",
  customerSchema,
);
