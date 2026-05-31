import { Schema, model, type HydratedDocument } from "mongoose";
import { PROSPECT_STAGES, type IProspect } from "./prospect.types.js";

// ─── Subdocument ──────────────────────────────────────────────────────────────

const stageHistorySchema = new Schema(
  {
    stage: { type: String, enum: PROSPECT_STAGES, required: true },
    changedAt: { type: Date, required: true, default: () => new Date() },
    note: { type: String, trim: true },
  },
  { _id: false },
);

// ─── Schema ───────────────────────────────────────────────────────────────────

const prospectSchema = new Schema<IProspect>(
  {
    boutiqueId: {
      type: Schema.Types.ObjectId,
      ref: "Boutique",
      required: true,
    },
    customerPhone: { type: String, required: true, trim: true },
    customerName: { type: String, trim: true },
    stage: {
      type: String,
      enum: PROSPECT_STAGES,
      default: "nuevo",
      required: true,
    },
    stageHistory: { type: [stageHistorySchema], default: [] },
    notes: { type: [String], default: [] },
    totalMessages: { type: Number, default: 0 },
    firstContactAt: { type: Date, default: () => new Date() },
    lastContactAt: { type: Date, default: () => new Date() },
    convertedToCustomerId: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      default: undefined,
    },
    estimatedValue: { type: Number, min: 0 },
    tags: { type: [String], default: [] },
    isArchived: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// One prospect per customer per boutique — primary lookup on every message.
prospectSchema.index({ boutiqueId: 1, customerPhone: 1 }, { unique: true });

// Pipeline board queries — list prospects of a boutique by stage.
prospectSchema.index({ boutiqueId: 1, stage: 1 });

// Active-vs-archived filtering within a boutique.
prospectSchema.index({ boutiqueId: 1, isArchived: 1 });

// ─── Model ────────────────────────────────────────────────────────────────────

export const ProspectModel = model<IProspect>("Prospect", prospectSchema);

export type ProspectDocument = HydratedDocument<IProspect>;
