import { Schema, model, type InferSchemaType, type HydratedDocument, type Model } from 'mongoose';
import { CUSTOMER_CHANNELS, CUSTOMER_TAGS, CUSTOMER_GENDERS } from '#/modules/customers/customer.types.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

const customerSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

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

    // Used by Luis to adapt communication style
    // female → "bonita", "bella", "corazón"
    // male   → "amigo", direct tone, no feminine nicknames
    // unknown → defaults to female (majority of SALO customers)
    gender: {
      type: String,
      enum: Object.values(CUSTOMER_GENDERS),
      default: CUSTOMER_GENDERS.UNKNOWN,
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

customerSchema.pre('save', function () {
  if (typeof this.instagramHandle === 'string') {
    this.instagramHandle = this.instagramHandle.replace(/^@/, '').trim();
  }
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

customerSchema.index({ isActive: 1, contactChannel: 1 });
customerSchema.index({ tags: 1 });

// ─── Types ────────────────────────────────────────────────────────────────────

export type CustomerSchemaType = InferSchemaType<typeof customerSchema>;
export type CustomerDocument = HydratedDocument<CustomerSchemaType>;
export type CustomerModelType = Model<CustomerSchemaType>;

// ─── Model ────────────────────────────────────────────────────────────────────

export const CustomerModel = model<CustomerSchemaType>('Customer', customerSchema);