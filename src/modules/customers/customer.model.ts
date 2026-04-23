import { Schema, model, type InferSchemaType, type HydratedDocument, type Model } from 'mongoose';
import { CUSTOMER_CHANNELS, CUSTOMER_TAGS, CUSTOMER_GENDERS } from '#/modules/customers/customer.types.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

const customerSchema = new Schema(
  {
    name: {
      type:     String,
      required: true,
      trim:     true,
    },

    // Stored in normalized form: digits only, no spaces, hyphens, or + prefix.
    // Example: "5213328205715" (Meta E.164 without the +).
    // Normalization is applied before any query or upsert — see webhook.service.ts.
    // The pre-save hook also normalizes on direct save calls.
    phone: {
      type:   String,
      trim:   true,
      unique: true,
      sparse: true,
    },

    instagramHandle: {
      type:      String,
      trim:      true,
      lowercase: true,
      unique:    true,
      sparse:    true,
    },

    contactChannel: {
      type:     String,
      required: true,
      enum:     Object.values(CUSTOMER_CHANNELS),
    },

    notes: {
      type: String,
      trim: true,
    },

    tags: {
      type:    [{ type: String, enum: Object.values(CUSTOMER_TAGS) }],
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
      type:    String,
      enum:    Object.values(CUSTOMER_GENDERS),
      default: CUSTOMER_GENDERS.UNKNOWN,
    },

    // Soft-delete flag. One canonical document per customer — never replaced.
    // isActive: false means the customer has been deactivated by the owner.
    // Deactivated customers are excluded from active lookups but their
    // record and history are preserved.
    // If a deactivated customer contacts via WhatsApp, the existing record
    // is reused (not replaced) — the owner must reactivate manually if needed.
    isActive: {
      type:    Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ─── Normalization ────────────────────────────────────────────────────────────
// Applies on direct save() calls.
// For findOneAndUpdate upserts (e.g. webhook.service.ts), normalization must
// be applied in the application before the query — hooks do not run on upserts.

customerSchema.pre('save', function () {
  // Remove @ prefix from Instagram handles if present.
  if (typeof this.instagramHandle === 'string') {
    this.instagramHandle = this.instagramHandle.replace(/^@/, '').trim();
  }

  // Normalize phone to digits only — strips +, spaces, hyphens, parentheses.
  // Ensures +5213328205715 and 5213328205715 resolve to the same index key.
  if (typeof this.phone === 'string') {
    this.phone = this.phone.replace(/\D/g, '');
  }
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

customerSchema.index({ isActive: 1, contactChannel: 1 });
customerSchema.index({ tags: 1 });

// ─── Types ────────────────────────────────────────────────────────────────────

export type CustomerSchemaType = InferSchemaType<typeof customerSchema>;
export type CustomerDocument   = HydratedDocument<CustomerSchemaType>;
export type CustomerModelType  = Model<CustomerSchemaType>;

// ─── Model ────────────────────────────────────────────────────────────────────

export const CustomerModel = model<CustomerSchemaType>('Customer', customerSchema);