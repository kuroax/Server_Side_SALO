import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

// ─── Subdocument ──────────────────────────────────────────────────────────────

const conversationTurnSchema = new Schema(
  {
    // 'user'      = incoming customer message
    // 'assistant' = outgoing bot reply
    role:      { type: String, required: true, enum: ['user', 'assistant'] },
    content:   { type: String, required: true, trim: true },
    createdAt: { type: Date,   required: true, default: () => new Date() },
  },
  { _id: false },
);

// ─── Schema ───────────────────────────────────────────────────────────────────

const conversationSchema = new Schema(
  {
    // One conversation document per customer+channel pair.
    // Indexed together for fast lookup on every incoming message.
    customerId: {
      type:     Schema.Types.ObjectId,
      ref:      'Customer',
      required: true,
    },

    channel: {
      type:     String,
      required: true,
      enum:     ['whatsapp', 'instagram'],
    },

    // Rolling window of the last MAX_TURNS turns.
    // Older turns are sliced off in the service layer before saving,
    // so this array never grows unboundedly.
    turns: {
      type:    [conversationTurnSchema],
      default: [],
    },

    // Updated on every exchange — makes it easy to find stale conversations.
    lastMessageAt: {
      type:    Date,
      default: () => new Date(),
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

// TTL index — auto-delete conversations inactive for 30 days.
// Keeps the collection lean without manual cleanup jobs.
conversationSchema.index(
  { lastMessageAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 30 },
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConversationTurn = {
  role:      'user' | 'assistant';
  content:   string;
  createdAt: Date;
};

export type ConversationSchemaType = InferSchemaType<typeof conversationSchema>;
export type ConversationDocument    = HydratedDocument<ConversationSchemaType>;

// ─── Constants ────────────────────────────────────────────────────────────────

// How many turns (user + assistant pairs) to keep in the rolling window.
// 10 turns = 5 exchanges = enough context without bloating the prompt.
export const MAX_CONVERSATION_TURNS = 10;

// ─── Model ────────────────────────────────────────────────────────────────────

export const ConversationModel = model<ConversationSchemaType>(
  'Conversation',
  conversationSchema,
);