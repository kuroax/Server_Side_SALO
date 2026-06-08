import mongoose, { Schema } from "mongoose";

// TTL collection for message idempotency.
// A record is inserted before processing begins; if the insert fails with
// E11000 (duplicate key), the message has already been processed and is skipped.
// Records expire after DEDUP_TTL_SECONDS to prevent unbounded growth.

const DEDUP_TTL_SECONDS = 300; // 5 minutes — matches prior image dedup window

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
