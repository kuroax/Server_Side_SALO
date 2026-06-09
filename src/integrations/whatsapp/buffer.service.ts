import { ConversationBufferModel } from "#/modules/conversations/conversation-buffer.model.js";
import { logger } from "#/config/logger.js";
import { env } from "#/config/env.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// env.ts coerces, validates as a positive integer, and defaults to 55000 —
// no defensive parsing needed here.
const ELAPSED_THRESHOLD_MS = env.WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS;

// ─── Types ────────────────────────────────────────────────────────────────────

export type PushPayload = {
  from: string;
  // Boutique WhatsApp phoneNumberId — scopes the buffer per tenant so two
  // boutiques receiving messages from the same customer phone do not collide.
  // Falls back to '' when the caller (older n8n payload) omits it, matching the
  // schema default; this keeps single-tenant behavior intact during migration.
  phoneNumberId: string;
  message: string;
  executionId: string;
  messageId?: string;
  messageType?: string;
  imageMediaId?: string | null;
  imageCaption?: string;
  contactName?: string;
  timestamp?: string | number | null;
};

export type PushResult =
  | { ok: true; duplicate: false }
  | { ok: true; duplicate: true };

export type ClaimSkipReason =
  | "buffer_not_found"
  | "elapsed_too_short"
  | "not_owner"
  | "empty_merged_message"
  | "claim_not_granted";

export type ClaimResult =
  | { skip: true; reason: ClaimSkipReason }
  | {
      skip: false;
      shouldRespond: true;
      mergedMessage: string;
      messageCount: number;
      // Aggregated media context resolved across ALL buffered messages.
      // Critical: when the customer sends an image then text (e.g. receipt +
      // "Aqui esta el deposito"), the text execution wins ownership. Without
      // these fields, imageMediaId is silently lost and receipt detection fails.
      messageType: string; // "image" if ANY buffered message was an image
      imageMediaId: string | null; // First non-null imageMediaId across all messages
      imageCaption: string; // Caption from the image message (or empty string)
      contactName: string | null; // Contact name from the first message that has one
    };

// ─── Push ─────────────────────────────────────────────────────────────────────
// Called by Accumulate Message node.
// Appends the message to this customer's buffer, stamps lastSeen,
// and sets ownerExecutionId to the current execution.
// The last execution to push wins ownership.
//
// NOTE:
// This adds a practical launch-week duplicate guard using messageId.
// True hard idempotency is still best enforced with a dedicated
// unique-message store at the business layer.

export const pushToBuffer = async (
  payload: PushPayload,
): Promise<PushResult> => {
  const {
    from,
    phoneNumberId,
    message,
    executionId,
    messageId,
    messageType,
    imageMediaId,
    imageCaption,
    contactName,
    timestamp,
  } = payload;

  const normalizedMessageId =
    typeof messageId === "string" && messageId.trim() ? messageId.trim() : null;

  // Launch-week duplicate guard:
  // if the same messageId is already buffered for this sender, no-op safely.
  if (normalizedMessageId) {
    const duplicateExists = await ConversationBufferModel.exists({
      from,
      phoneNumberId,
      "messages.messageId": normalizedMessageId,
    });

    if (duplicateExists) {
      logger.info(
        { from, phoneNumberId, executionId, messageId: normalizedMessageId },
        "Buffer push — duplicate messageId ignored",
      );

      return { ok: true, duplicate: true };
    }
  }

  await ConversationBufferModel.findOneAndUpdate(
    { from, phoneNumberId },
    {
      $push: {
        messages: {
          text: message,
          messageId: normalizedMessageId,
          messageType: messageType ?? "text",
          imageMediaId: imageMediaId ?? null,
          imageCaption: imageCaption ?? "",
          contactName: contactName ?? "Cliente",
          timestamp: timestamp ?? null,
          executionId,
        },
      },
      $set: {
        lastSeen: new Date(),
        ownerExecutionId: executionId,
      },
    },
    { upsert: true, new: true },
  );

  logger.info(
    { from, phoneNumberId, executionId, messageId: normalizedMessageId, messageType },
    "Buffer push — message appended",
  );

  return { ok: true, duplicate: false };
};

// ─── Claim ────────────────────────────────────────────────────────────────────
// Called by Check & Merge Messages node.
// Only the current owner may claim, and only after enough idle time has passed.
//
// Important:
// The winning path uses findOneAndDelete(...) so the read + clear action
// is atomic for the owner/cutoff condition.

export const claimBuffer = async (
  from: string,
  executionId: string,
  phoneNumberId: string,
): Promise<ClaimResult> => {
  const cutoff = new Date(Date.now() - ELAPSED_THRESHOLD_MS);

  const claimedBuffer = await ConversationBufferModel.findOneAndDelete({
    from,
    phoneNumberId,
    ownerExecutionId: executionId,
    lastSeen: { $lte: cutoff },
  });

  if (!claimedBuffer) {
    // Diagnostic read only.
    // This does NOT decide the winner; it only improves skip reason visibility.
    // Best-effort only: document may already be deleted by another execution.
    const current = await ConversationBufferModel.findOne({ from, phoneNumberId })
      .select({ lastSeen: 1, ownerExecutionId: 1 })
      .lean();

    if (!current) {
      logger.info({ from, phoneNumberId, executionId }, "Claim — no buffer found, skip");
      return { skip: true, reason: "buffer_not_found" };
    }

    const elapsed = current.lastSeen
      ? Date.now() - new Date(current.lastSeen).getTime()
      : null;

    if (typeof elapsed === "number" && elapsed < ELAPSED_THRESHOLD_MS) {
      logger.info(
        { from, phoneNumberId, executionId, elapsed, threshold: ELAPSED_THRESHOLD_MS },
        "Claim — elapsed too short, skip",
      );
      return { skip: true, reason: "elapsed_too_short" };
    }

    if (current.ownerExecutionId !== executionId) {
      logger.info(
        { from, phoneNumberId, executionId, owner: current.ownerExecutionId },
        "Claim — not owner, skip",
      );
      return { skip: true, reason: "not_owner" };
    }

    logger.warn(
      { from, phoneNumberId, executionId },
      "Claim — atomic claim not granted despite ownership diagnostics",
    );
    return { skip: true, reason: "claim_not_granted" };
  }

  const messages = claimedBuffer.messages ?? [];

  // ── Aggregate media context across all buffered messages ─────────────────
  // The owning execution is the LAST one to push, which may be a plain text
  // message even when an earlier message in the same burst was an image.
  // We scan all messages to surface the imageMediaId so n8n can include it
  // in the webhook POST regardless of which execution claimed the buffer.
  const imageMessage = messages.find(
    (m) => m.messageType === "image" && m.imageMediaId,
  );
  const aggregatedMessageType = imageMessage ? "image" : "text";
  const aggregatedImageMediaId = imageMessage?.imageMediaId ?? null;
  const aggregatedImageCaption = imageMessage?.imageCaption ?? "";
  const aggregatedContactName =
    messages.find((m) => m.contactName && m.contactName !== "Cliente")
      ?.contactName ?? null;

  // ── Build merged text ─────────────────────────────────────────────────────
  // Exclude empty text entries (image-only messages have no text).
  const mergedParts = messages
    .map((m) => (typeof m.text === "string" ? m.text.trim() : ""))
    .filter(Boolean);

  // If an image was buffered but the text parts are empty, keep the response
  // going — the webhook will handle it as an image message via imageMediaId.
  const mergedMessage = mergedParts.join("\n").trim();

  if (!mergedMessage && !aggregatedImageMediaId) {
    logger.info(
      { from, phoneNumberId, executionId },
      "Claim — buffer claimed but merged message was empty and no imageMediaId, skip",
    );
    return { skip: true, reason: "empty_merged_message" };
  }

  logger.info(
    {
      from,
      phoneNumberId,
      executionId,
      messageCount: messages.length,
      aggregatedMessageType,
      hasImageMediaId: !!aggregatedImageMediaId,
      threshold: ELAPSED_THRESHOLD_MS,
    },
    "Claim — buffer claimed and cleared",
  );

  return {
    skip: false,
    shouldRespond: true,
    mergedMessage,
    messageCount: messages.length,
    messageType: aggregatedMessageType,
    imageMediaId: aggregatedImageMediaId,
    imageCaption: aggregatedImageCaption,
    contactName: aggregatedContactName,
  };
};
