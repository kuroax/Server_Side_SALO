import { Schema, model, type InferSchemaType, type HydratedDocument, type Model } from 'mongoose';
import { CUSTOMER_CHANNELS, CUSTOMER_TAGS } from '#/modules/customers/customer.types.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

const customerSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    // Stored as received — no normalization in V1
    // sparse: true allows multiple nulls while enforcing uniqueness on non-null
    phone: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },

    // @ prefix stripped in validation + pre('save') hook
    // sparse: true — same uniqueness strategy as phone
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

    // Nested object form — correctly validates each element against enum
    // Deduplication enforced in validation layer
    tags: {
      type: [{ type: String, enum: Object.values(CUSTOMER_TAGS) }],
      default: [],
    },

    address: {
      type: String,
      trim: true,
    },

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

// Defensive second layer after Zod — strips @ prefix from instagramHandle
customerSchema.pre('save', function () {
  if (typeof this.instagramHandle === 'string') {
    // lowercase: true on schema handles lowercasing
    // hook only needs to strip @ prefix
    this.instagramHandle = this.instagramHandle.replace(/^@/, '').trim();
  }
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Compound index — covers isActive alone (leftmost prefix) and isActive+channel
customerSchema.index({ isActive: 1, contactChannel: 1 });

// Tag-based filtering for CRM segmentation
customerSchema.index({ tags: 1 });

// ─── Types ────────────────────────────────────────────────────────────────────

export type CustomerSchemaType = InferSchemaType<typeof customerSchema>;
export type CustomerDocument = HydratedDocument<CustomerSchemaType>;
export type CustomerModelType = Model<CustomerSchemaType>;

// ─── Model ────────────────────────────────────────────────────────────────────

export const CustomerModel = model<CustomerSchemaType>('Customer', customerSchema);