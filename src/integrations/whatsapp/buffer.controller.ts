import type { Request, Response } from 'express';
import { pushToBuffer, claimBuffer } from '#/integrations/whatsapp/buffer.service.js';
import { logger } from '#/config/logger.js';

// ─── Small helpers ────────────────────────────────────────────────────────────

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const asOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const asOptionalNullableString = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || null;
};

const asOptionalTimestamp = (value: unknown): string | number | null | undefined => {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return undefined;
};

// ─── Message type validation ──────────────────────────────────────────────────

const VALID_MESSAGE_TYPES = ['text', 'image'] as const;
type ValidMessageType = typeof VALID_MESSAGE_TYPES[number];

const asMessageType = (value: unknown): ValidMessageType | undefined => {
  return VALID_MESSAGE_TYPES.includes(value as ValidMessageType)
    ? (value as ValidMessageType)
    : undefined;
};

// ─── Push handler ─────────────────────────────────────────────────────────────

export const bufferPushHandler = async (req: Request, res: Response): Promise<void> => {
  const body = req.body ?? {};

  const from        = asNonEmptyString(body.from);
  const executionId = asNonEmptyString(body.executionId);

  if (!from) {
    res.status(400).json({ error: 'Missing or invalid field: from' });
    return;
  }

  if (!executionId) {
    res.status(400).json({ error: 'Missing or invalid field: executionId' });
    return;
  }

  // Multi-tenant scoping: defaults to '' when the n8n payload omits it,
  // matching the buffer schema default and preserving single-tenant behavior.
  const phoneNumberId = asOptionalString(body.phoneNumberId)   ?? '';
  const message      = asOptionalString(body.message)          ?? '';
  const messageId    = asOptionalString(body.messageId);
  const messageType  = asMessageType(body.messageType);
  const imageMediaId = asOptionalNullableString(body.imageMediaId) ?? null;
  const imageCaption = asOptionalString(body.imageCaption)     ?? '';
  const contactName  = asOptionalString(body.contactName)      ?? 'Cliente';
  const timestamp    = asOptionalTimestamp(body.timestamp)     ?? null;

  logger.info(
    { from, phoneNumberId, executionId, messageId, messageType },
    'Buffer push request received',
  );

  try {
    const result = await pushToBuffer({
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
    });

    if (result.duplicate) {
      logger.info(
        { from, phoneNumberId, executionId, messageId },
        'Buffer push — duplicate detected at controller',
      );
    }

    res.json(result);
  } catch (err) {
    logger.error(
      { err, from, phoneNumberId, executionId, messageId },
      'Buffer push failed',
    );
    res.status(500).json({ error: 'Buffer push failed' });
  }
};

// ─── Claim handler ────────────────────────────────────────────────────────────

export const bufferClaimHandler = async (req: Request, res: Response): Promise<void> => {
  const body = req.body ?? {};

  const from        = asNonEmptyString(body.from);
  const executionId = asNonEmptyString(body.executionId);

  if (!from) {
    res.status(400).json({ error: 'Missing or invalid field: from' });
    return;
  }

  if (!executionId) {
    res.status(400).json({ error: 'Missing or invalid field: executionId' });
    return;
  }

  // Multi-tenant scoping: defaults to '' when omitted so the claim targets the
  // same buffer document the push created (preserves single-tenant behavior).
  const phoneNumberId = asOptionalString(body.phoneNumberId) ?? '';

  logger.info(
    { from, phoneNumberId, executionId },
    'Buffer claim request received',
  );

  try {
    const result = await claimBuffer(from, executionId, phoneNumberId);

    if (result.skip) {
      logger.info(
        { from, phoneNumberId, executionId, reason: result.reason },
        'Buffer claim skipped at controller',
      );
    }

    res.json(result);
  } catch (err) {
    logger.error(
      { err, from, phoneNumberId, executionId },
      'Buffer claim failed',
    );
    res.status(500).json({ error: 'Buffer claim failed' });
  }
};