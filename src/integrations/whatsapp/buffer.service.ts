import { createHash } from "node:crypto";
import { ConversationBufferModel } from "#/modules/conversations/conversation-buffer.model.js";
import { logger } from "#/config/logger.js";
import { env } from "#/config/env.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// env.ts coerces, validates as a positive integer, and defaults to 55000 —
// no defensive parsing needed here.
const ELAPSED_THRESHOLD_MS = env.WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS;

// MongoDB duplicate-key (E11000) detector — used by the atomic buffer push to
// recognize a unique-index collision on { from, phoneNumberId }.
const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  "code" in err &&
  (err as { code: number }).code === 11000;

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
      // Deterministic idempotency key derived from the constituent messageIds.
      // The webhook uses it for the dedup gate + createOrder sourceMessageId so
      // an n8n retry of the same buffer claim is deduplicated. null only when no
      // buffered message carried a messageId.
      mergedMessageId: string | null;
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

  const newMessage = {
    text: message,
    messageId: normalizedMessageId,
    messageType: messageType ?? "text",
    imageMediaId: imageMediaId ?? null,
    imageCaption: imageCaption ?? "",
    contactName: contactName ?? "Cliente",
    timestamp: timestamp ?? null,
    executionId,
  };

  // Atomic dedup-and-push. When the message carries an id, the filter only
  // matches the buffer if that id is NOT already present, so two concurrent
  // pushes of the SAME id cannot both append — closing the check-then-write
  // race the prior exists()+push pattern had. The $ne condition is omitted when
  // there is no id (nothing to dedup on).
  const filter: Record<string, unknown> = { from, phoneNumberId };
  if (normalizedMessageId) {
    filter["messages.messageId"] = { $ne: normalizedMessageId };
  }
  const update = {
    $push: { messages: newMessage },
    $set: { lastSeen: new Date(), ownerExecutionId: executionId },
  };

  try {
    await ConversationBufferModel.findOneAndUpdate(filter, update, {
      upsert: true,
      new: true,
    });
  } catch (err) {
    // E11000 = a { from, phoneNumberId } buffer already exists but the $ne
    // filter excluded it, so the upsert tried to insert a colliding document.
    // Two causes: (a) this id is already buffered → genuine duplicate; or
    // (b) a concurrent push created the doc with a DIFFERENT id and we raced
    // its insert. Disambiguate, and for (b) retry as a plain conditional push
    // (no upsert) so a legitimate distinct message is never dropped.
    if (!isDuplicateKeyError(err)) throw err;

    if (normalizedMessageId) {
      const alreadyBuffered = await ConversationBufferModel.exists({
        from,
        phoneNumberId,
        "messages.messageId": normalizedMessageId,
      });
      if (alreadyBuffered) {
        logger.info(
          { from, phoneNumberId, executionId, messageId: normalizedMessageId },
          "Buffer push — duplicate messageId ignored",
        );
        return { ok: true, duplicate: true };
      }
    }

    const retried = await ConversationBufferModel.findOneAndUpdate(
      filter,
      update,
      { new: true },
    );
    if (!retried) {
      // The id was buffered by another racer between our check and this retry.
      logger.info(
        { from, phoneNumberId, executionId, messageId: normalizedMessageId },
        "Buffer push — duplicate messageId ignored (post-retry)",
      );
      return { ok: true, duplicate: true };
    }
  }

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

  // ── Deterministic merged messageId ────────────────────────────────────────
  // The claimed buffer collapses several WhatsApp messages into one webhook
  // POST. That POST previously carried no messageId, so the dedup gate and
  // createOrder's idempotency index were both inert — an n8n retry of the same
  // claim could double-process (duplicate order / prospect bump / alert).
  // Hash the SORTED constituent messageIds so the same set of buffered messages
  // always yields the same id regardless of arrival order. null when no buffered
  // message carried a messageId (nothing stable to key on).
  const sortedIds = messages
    .map((m) => m.messageId)
    .filter((id): id is string => Boolean(id))
    .sort()
    .join("|");
  const mergedMessageId = sortedIds
    ? "buf_" + createHash("sha256").update(sortedIds).digest("hex").slice(0, 32)
    : null;

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
    mergedMessageId,
  };
};
