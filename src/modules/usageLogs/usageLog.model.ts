import {
  Schema,
  model,
  type InferSchemaType,
  type HydratedDocument,
  type Model,
} from "mongoose";

// ─── Schema ───────────────────────────────────────────────────────────────────
// One document per completed (or attempted) Claude API turn, scoped to the
// boutique that triggered it. Powers per-tenant billing / cost analysis.
// Written non-blocking from claude.service.ts — a failed write never affects
// the WhatsApp response.

const usageLogSchema = new Schema(
  {
    // Tenant scope — every usage log belongs to exactly one boutique.
    boutiqueId: {
      type: Schema.Types.ObjectId,
      ref: "Boutique",
      required: true,
    },

    // Claude model id used for the call, e.g. "claude-sonnet-4-6".
    model: {
      type: String,
      required: true,
    },

    // Resolved intent, when available. Absent on SAFE_FALLBACK paths where the
    // call failed before a valid intent was produced.
    intent: {
      type: String,
      required: false,
    },

    inputTokens: {
      type: Number,
      required: true,
      min: 0,
    },

    outputTokens: {
      type: Number,
      required: true,
      min: 0,
    },

    // inputTokens + outputTokens — denormalized so billing queries can sum a
    // single field without a computed expression.
    totalTokens: {
      type: Number,
      required: true,
      min: 0,
    },

    // How many agentic loop iterations ran for this turn. Useful for cost
    // analysis (tool-heavy turns cost more). Always >= 1.
    toolIterations: {
      type: Number,
      required: true,
      min: 1,
    },

    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    versionKey: false,
  },
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Billing queries: "all usage for boutique X, newest first / within a window".
usageLogSchema.index({ boutiqueId: 1, createdAt: -1 });

// TTL — auto-delete logs older than 90 days to keep the collection lean.
usageLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 },
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type UsageLogSchemaType = InferSchemaType<typeof usageLogSchema>;
export type UsageLogDocument = HydratedDocument<UsageLogSchemaType>;
export type UsageLogModelType = Model<UsageLogSchemaType>;

// ─── Model ────────────────────────────────────────────────────────────────────

export const UsageLogModel = model<UsageLogSchemaType>(
  "UsageLog",
  usageLogSchema,
);
