import { Schema, model } from "mongoose";

// Stores the mapping between a WhatsApp sent-message ID and the product it
// contained. Created by the n8n "Log Sent Image" Function node immediately
// after each Send Image response from the WhatsApp API.
//
// When a customer replies to a gallery image, WhatsApp attaches context.id
// pointing to the specific sent message. Looking up that ID here resolves
// the exact product — name, color, price — without fuzzy inference.
//
// TTL: 48 hours. Gallery replies older than 48h are unlikely and the mapping
// can be rebuilt on next search. MongoDB drops expired documents automatically
// via the createdAt TTL index.

export interface ISentImage {
  // WhatsApp message ID returned by the Graph API after sending the image.
  // Format: "wamid.xxx..." — unique per sent message.
  sentMessageId: string;

  // Caption attached to the image when sent.
  // Format from searchProductsForClaude: "$1,990 — Jersey Accolade Athletic Heather Grey (Alo)"
  // Empty string for secondary product photos (only the first photo has a caption).
  caption: string;

  // Customer phone the image was sent to — used for scoping lookups to the
  // correct conversation when sentMessageId alone is ambiguous.
  customerPhone: string;

  createdAt: Date;
}

const sentImageSchema = new Schema<ISentImage>({
  sentMessageId: { type: String, required: true, unique: true, index: true },
  caption: { type: String, required: true },
  customerPhone: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 172800 }, // 48h TTL
});

export const SentImageModel = model<ISentImage>("SentImage", sentImageSchema);
