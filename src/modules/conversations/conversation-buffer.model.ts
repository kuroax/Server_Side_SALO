import mongoose, { Schema, type Document } from 'mongoose';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IConversationBuffer extends Document {
  from:             string;
  messages:         string[];
  lastSeen:         Date;
  ownerExecutionId: string;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const conversationBufferSchema = new Schema<IConversationBuffer>(
  {
    from:             { type: String, required: true, unique: true, index: true },
    messages:         { type: [String], default: [] },
    lastSeen:         { type: Date, required: true },
    ownerExecutionId: { type: String, required: true },
  },
  {
    timestamps: true,
  },
);

// Auto-delete buffer documents 24 hours after lastSeen —
// prevents stale buffers accumulating from abandoned conversations.
conversationBufferSchema.index({ lastSeen: 1 }, { expireAfterSeconds: 86400 });

export const ConversationBufferModel = mongoose.model<IConversationBuffer>(
  'ConversationBuffer',
  conversationBufferSchema,
);