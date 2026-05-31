import { Schema, model, type HydratedDocument } from "mongoose";
import type { IConversationState } from "./conversationState.types.js";

// ─── Schema ───────────────────────────────────────────────────────────────────

const conversationStateSchema = new Schema<IConversationState>(
  {
    boutiqueId: {
      type: Schema.Types.ObjectId,
      ref: "Boutique",
      required: true,
      index: true,
    },
    customerPhone: { type: String, required: true, trim: true },
    mode: {
      type: String,
      enum: ["ai", "human", "paused"],
      default: "ai",
      required: true,
    },
    humanTookOverAt: { type: Date },
    autoResumeAt: { type: Date },
    lastMessageAt: { type: Date, default: () => new Date() },
    messageCount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// One state document per customer per boutique — the primary lookup on every
// incoming message and the hybrid gate's uniqueness guarantee.
conversationStateSchema.index(
  { boutiqueId: 1, customerPhone: 1 },
  { unique: true },
);

// ─── Model ────────────────────────────────────────────────────────────────────

// Registered as "ConversationState" — NOT "Conversation". The "Conversation"
// model name is already owned by the conversation-memory module; reusing it
// would throw OverwriteModelError at boot.
export const ConversationStateModel = model<IConversationState>(
  "ConversationState",
  conversationStateSchema,
);

export type ConversationStateDocument = HydratedDocument<IConversationState>;
