import { ConversationBufferModel } from '#/modules/conversations/conversation-buffer.model.js';
import { logger } from '#/config/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const ELAPSED_THRESHOLD_MS = 55_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type PushPayload = {
  from:          string;
  message:       string;
  executionId:   string;
  messageId?:    string;
  messageType?:  string;
  imageMediaId?: string | null;
  imageCaption?: string;
  contactName?:  string;
  timestamp?:    string | number | null;
};

export type PushResult = {
  ok: true;
};

export type ClaimResult =
  | { skip: true }
  | { skip: false; shouldRespond: true; mergedMessage: string; messageCount: number };

// ─── Push ─────────────────────────────────────────────────────────────────────
// Called by Accumulate Message node.
// Atomically appends the message to this customer's buffer,
// stamps lastSeen, and sets ownerExecutionId to the current execution.
// The last execution to push always wins ownership.

export const pushToBuffer = async (payload: PushPayload): Promise<PushResult> => {
  const {
    from,
    message,
    executionId,
    messageId,
    messageType,
    imageMediaId,
    imageCaption,
    contactName,
    timestamp,
  } = payload;

  await ConversationBufferModel.findOneAndUpdate(
    { from },
    {
      $push: {
        messages: {
          text:         message,
          messageId:    messageId    ?? null,
          messageType:  messageType  ?? 'text',
          imageMediaId: imageMediaId ?? null,
          imageCaption: imageCaption ?? '',
          contactName:  contactName  ?? 'Cliente',
          timestamp:    timestamp    ?? null,
          executionId,
        },
      },
      $set: { lastSeen: new Date(), ownerExecutionId: executionId },
    },
    { upsert: true, new: true },
  );

  logger.info({ from, executionId, messageId, messageType }, 'Buffer push — message appended');

  return { ok: true };
};

// ─── Claim ────────────────────────────────────────────────────────────────────
// Called by Check & Merge Messages node.
// Checks elapsed time and execution ownership, then atomically reads
// and clears the buffer. Returns skip: true if this execution should not respond.

export const claimBuffer = async (
  from:        string,
  executionId: string,
): Promise<ClaimResult> => {
  const buffer = await ConversationBufferModel.findOne({ from });

  if (!buffer) {
    logger.info({ from, executionId }, 'Claim — no buffer found, skip');
    return { skip: true };
  }

  const elapsed = Date.now() - buffer.lastSeen.getTime();

  if (elapsed < ELAPSED_THRESHOLD_MS) {
    logger.info({ from, executionId, elapsed }, 'Claim — elapsed too short, skip');
    return { skip: true };
  }

  if (buffer.ownerExecutionId !== executionId) {
    logger.info(
      { from, executionId, owner: buffer.ownerExecutionId },
      'Claim — not owner, skip',
    );
    return { skip: true };
  }

  const messages = buffer.messages as { text: string }[];
  const merged   = messages.map((m) => m.text).join('\n').trim();

  if (!merged) {
    logger.info({ from, executionId }, 'Claim — buffer empty after merge, skip');
    await ConversationBufferModel.deleteOne({ from });
    return { skip: true };
  }

  await ConversationBufferModel.deleteOne({ from });

  logger.info(
    { from, executionId, messageCount: messages.length, elapsed },
    'Claim — buffer claimed and cleared',
  );

  return { skip: false, shouldRespond: true, mergedMessage: merged, messageCount: messages.length };
};