import {
  Schema,
  model,
  type InferSchemaType,
  type HydratedDocument,
} from "mongoose";
import { CONVERSATION_MODE } from "#/modules/boutiques/boutique.types.js";
export type { ConversationMode } from "#/modules/boutiques/boutique.types.js";

// ─── Subdocument ──────────────────────────────────────────────────────────────

const conversationTurnSchema = new Schema(
  {
    // 'user'      = incoming customer message
    // 'assistant' = outgoing bot reply
    role: { type: String, required: true, enum: ["user", "assistant"] },
    content: { type: String, required: true, trim: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

// ─── Schema ───────────────────────────────────────────────────────────────────

const conversationSchema = new Schema(
  {
    // Denormalized from customer for direct n8n mode-check queries.
    // The n8n mode-check endpoint queries by boutiqueId + customerPhone,
    // not customerId, so this field avoids a join.
    boutiqueId: {
      type: Schema.Types.ObjectId,
      ref: "Boutique",
      required: [true, "Boutique ID is required"],
    },

    // One conversation document per customer+channel pair.
    // Indexed together for fast lookup on every incoming message.
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },

    channel: {
      type: String,
      required: true,
      enum: ["whatsapp", "instagram"],
    },

    // Rolling window of the last MAX_TURNS turns.
    // Older turns are sliced off in the service layer before saving,
    // so this array never grows unboundedly.
    turns: {
      type: [conversationTurnSchema],
      default: [],
    },

    // Updated on every exchange — makes it easy to find stale conversations.
    lastMessageAt: {
      type: Date,
      default: () => new Date(),
    },

    // Per-conversation bot toggle.
    //   "auto"   → Luis handles all messages for this customer (default).
    //   "manual" → n8n skips the AI entirely; the owner responds manually.
    // Flipped to "manual" automatically when Luis returns escalate: true.
    // Reset to "auto" manually by the owner via the SALO app.
    mode: {
      type: String,
      enum: Object.values(CONVERSATION_MODE),
      default: CONVERSATION_MODE.AUTO,
    },

    // Timestamp of the most recent transition to "manual" — surfaced on the
    // owner dashboard so they can see how long a conversation has been waiting
    // for a human response.
    escalatedAt: {
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

// Primary lookup: find conversation by customer + channel on every message.
conversationSchema.index({ customerId: 1, channel: 1 }, { unique: true });

// Tenant-scoped mode lookup — used by the owner dashboard to list all
// conversations currently in manual mode for a given boutique.
conversationSchema.index({ boutiqueId: 1, mode: 1 });

// TTL index — auto-delete conversations inactive for 30 days.
// Keeps the collection lean without manual cleanup jobs.
conversationSchema.index(
  { lastMessageAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 30 },
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
};

export type ConversationSchemaType = InferSchemaType<typeof conversationSchema>;
export type ConversationDocument = HydratedDocument<ConversationSchemaType>;

// ─── Constants ────────────────────────────────────────────────────────────────

// How many turns (user + assistant pairs) to keep in the rolling window.
// 10 turns = 5 exchanges = enough context without bloating the prompt.
//
// Why 20 and not 10:
//   hasRecentPaymentInfoContext (webhook.service.ts) searches stored turns for
//   the [payment_info_sent] sentinel to detect receipt images. If the window is
//   too small, the sentinel is evicted before the customer sends their receipt
//   (after several follow-up messages). When that happens, searchProductsByImage
//   runs on a bank receipt → SAFE_FALLBACK fires instead of the receipt ack.
//   With 20 turns there is room for ~9 follow-up exchanges after payment_info.
//   Claude still only receives MAX_HISTORY_TURNS_FOR_AI = 10 turns per request
//   (set in webhook.service.ts) — storage increase does NOT affect prompt size.
export const MAX_CONVERSATION_TURNS = 20;

// ─── Model ────────────────────────────────────────────────────────────────────

export const ConversationModel = model<ConversationSchemaType>(
  "Conversation",
  conversationSchema,
);
