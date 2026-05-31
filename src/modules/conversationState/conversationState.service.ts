import { ConversationStateModel } from "./conversationState.model.js";
import type {
  ConversationMode,
  ConversationStateDTO,
  ConversationStateLean,
} from "./conversationState.types.js";

// ─── Mapper ───────────────────────────────────────────────────────────────────

const toDTO = (doc: ConversationStateLean): ConversationStateDTO => ({
  id: doc._id.toString(),
  boutiqueId: doc.boutiqueId.toString(),
  customerPhone: doc.customerPhone,
  mode: doc.mode,
  humanTookOverAt: doc.humanTookOverAt?.toISOString(),
  autoResumeAt: doc.autoResumeAt?.toISOString(),
  lastMessageAt: doc.lastMessageAt.toISOString(),
  messageCount: doc.messageCount,
  isActive: doc.isActive,
});

// ─── Reads ────────────────────────────────────────────────────────────────────

// Returns the current gate mode for a customer. Defaults to "ai" when no
// state document exists yet (a brand-new conversation is always bot-handled).
export const getConversationMode = async (
  boutiqueId: string,
  customerPhone: string,
): Promise<ConversationMode> => {
  const doc = await ConversationStateModel.findOne({
    boutiqueId,
    customerPhone,
  }).lean<ConversationStateLean | null>();

  return doc?.mode ?? "ai";
};

// Upserts a state document and returns it. Used when the caller needs the full
// DTO (e.g. resolver queries) rather than just the mode.
export const getOrCreateConversation = async (
  boutiqueId: string,
  customerPhone: string,
): Promise<ConversationStateDTO> => {
  const doc = await ConversationStateModel.findOneAndUpdate(
    { boutiqueId, customerPhone },
    {
      $setOnInsert: {
        boutiqueId,
        customerPhone,
        mode: "ai" as ConversationMode,
        lastMessageAt: new Date(),
        messageCount: 0,
        isActive: true,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean<ConversationStateLean>();

  return toDTO(doc);
};

// ─── Writes ───────────────────────────────────────────────────────────────────

// Transitions a conversation's gate mode.
//   "human" → records humanTookOverAt; schedules autoResumeAt when minutes given,
//             otherwise clears any pending auto-resume.
//   "ai"    → clears both humanTookOverAt and autoResumeAt.
//   "paused" → sets mode only.
// Upserts so an owner takeover works even on a not-yet-seen conversation.
export const setConversationMode = async (
  boutiqueId: string,
  customerPhone: string,
  mode: ConversationMode,
  autoResumeMinutes?: number,
): Promise<ConversationStateDTO> => {
  const now = new Date();

  const set: Record<string, unknown> = { mode };
  const unset: Record<string, "" > = {};

  if (mode === "human") {
    set.humanTookOverAt = now;
    if (typeof autoResumeMinutes === "number") {
      set.autoResumeAt = new Date(now.getTime() + autoResumeMinutes * 60_000);
    } else {
      unset.autoResumeAt = "";
    }
  } else if (mode === "ai") {
    unset.humanTookOverAt = "";
    unset.autoResumeAt = "";
  }

  const update: Record<string, unknown> = { $set: set };
  if (Object.keys(unset).length > 0) {
    update.$unset = unset;
  }

  const doc = await ConversationStateModel.findOneAndUpdate(
    { boutiqueId, customerPhone },
    update,
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean<ConversationStateLean>();

  return toDTO(doc);
};

// Records that an inbound customer message was received. Increments the counter
// and refreshes lastMessageAt. Upserts so the very first message is counted.
export const trackIncomingMessage = async (
  boutiqueId: string,
  customerPhone: string,
): Promise<void> => {
  await ConversationStateModel.findOneAndUpdate(
    { boutiqueId, customerPhone },
    {
      $inc: { messageCount: 1 },
      $set: { lastMessageAt: new Date() },
      $setOnInsert: {
        boutiqueId,
        customerPhone,
        mode: "ai" as ConversationMode,
        isActive: true,
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
};

// If the conversation is in "human" mode and its scheduled auto-resume time has
// passed, flip it back to "ai" and clear the handoff timestamps. Atomic — the
// filter guards against racing a manual transition.
export const checkAndApplyAutoResume = async (
  boutiqueId: string,
  customerPhone: string,
): Promise<void> => {
  await ConversationStateModel.findOneAndUpdate(
    {
      boutiqueId,
      customerPhone,
      mode: "human",
      autoResumeAt: { $lte: new Date() },
    },
    {
      $set: { mode: "ai" as ConversationMode },
      $unset: { humanTookOverAt: "", autoResumeAt: "" },
    },
  );
};

// ─── Listing (resolver support) ─────────────────────────────────────────────

export const listConversations = async (
  boutiqueId: string,
  mode?: ConversationMode,
): Promise<ConversationStateDTO[]> => {
  const filter: Record<string, unknown> = { boutiqueId };
  if (mode) {
    filter.mode = mode;
  }

  const docs = await ConversationStateModel.find(filter)
    .sort({ lastMessageAt: -1 })
    .lean<ConversationStateLean[]>();

  return docs.map(toDTO);
};

export const getConversation = async (
  boutiqueId: string,
  customerPhone: string,
): Promise<ConversationStateDTO | null> => {
  const doc = await ConversationStateModel.findOne({
    boutiqueId,
    customerPhone,
  }).lean<ConversationStateLean | null>();

  return doc ? toDTO(doc) : null;
};
