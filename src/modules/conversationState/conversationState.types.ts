import type { Types } from "mongoose";

// Hybrid AI/human gate for a single customer conversation.
//   "ai"     → Luis handles all messages for this customer (default).
//   "human"  → owner has taken over; the bot stays silent.
//   "paused" → temporarily muted (no auto-resume implied).
//
// NOTE: This is the per-customer *runtime gate*, distinct from the
// conversation-memory document in `#/modules/conversations` (which stores
// the rolling turn window and uses an "auto"/"manual" mode). They are
// intentionally separate models backed by separate collections.
export type ConversationMode = "ai" | "human" | "paused";

export interface IConversationState {
  boutiqueId: Types.ObjectId;
  customerPhone: string;
  mode: ConversationMode;
  humanTookOverAt?: Date;
  autoResumeAt?: Date;
  lastMessageAt: Date;
  messageCount: number;
  isActive: boolean;
}

// Plain (lean) document shape returned from reads.
export interface ConversationStateLean extends IConversationState {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationStateDTO {
  id: string;
  boutiqueId: string;
  customerPhone: string;
  mode: ConversationMode;
  humanTookOverAt?: string;
  autoResumeAt?: string;
  lastMessageAt: string;
  messageCount: number;
  isActive: boolean;
}
