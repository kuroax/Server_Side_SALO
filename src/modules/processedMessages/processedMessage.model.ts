import mongoose, { Schema } from "mongoose";

// TTL collection for message idempotency.
// A record is inserted before processing begins; if the insert fails with
// E11000 (duplicate key), the message has already been processed and is skipped.
// Records expire after DEDUP_TTL_SECONDS to prevent unbounded growth.

// 24 hours. Raised from 300s (5 min): a late n8n retry — delayed queue, backoff,
// or a manual replay hours later — must still be caught by the dedup gate. At 5
// minutes a retry past the window found no marker and reprocessed (duplicate
// order / alert). 24h matches the conversation-buffer TTL and the WhatsApp 24h
// session window.
//
// NOTE: changing this value does NOT require a manual index rebuild. Mongoose
// reconciles the TTL `expireAfterSeconds` via collMod on the next connection
// (and MongoDB applies it on the following TTL sweep, within ~60s), so existing
// markers simply adopt the new expiry — no migration needed.
const DEDUP_TTL_SECONDS = 86_400; // 24 hours

const processedMessageSchema = new Schema(
  {
    messageId: { type: String, required: true },
    boutiqueId: { type: Schema.Types.ObjectId, required: true },
    createdAt: { type: Date, default: Date.now, expires: DEDUP_TTL_SECONDS },
  },
  { timestamps: false },
);

processedMessageSchema.index(
  { messageId: 1, boutiqueId: 1 },
  { unique: true },
);

export const ProcessedMessageModel = mongoose.model(
  "ProcessedMessage",
  processedMessageSchema,
);
