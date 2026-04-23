import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

import { pushToBuffer, claimBuffer } from '#/integrations/whatsapp/buffer.service.js';
import { logger } from '#/config/logger.js';

// ─── Small helpers ────────────────────────────────────────────────────────────

const asNonEmptyString = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const asOptionalString = (value: unknown): string | undefined => {
  return typeof value === 'string' ? value : undefined;
};

const asOptionalNullableString = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
};

const asOptionalTimestamp = (value: unknown): string | number | null | undefined => {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return undefined;
};

const getHeaderString = (value: string | string[] | undefined): string | null => {
  if (typeof value === 'string') return value;
  return null;
};

// ─── Secret validation ────────────────────────────────────────────────────────
// NOTE:
// For launch week this is acceptable here.
// Long-term, move this into shared middleware and apply it at the router layer.

const validateSecret = (req: Request, res: Response): boolean => {
  const incoming = getHeaderString(req.headers['x-webhook-secret']);
  const expected = process.env.BUFFER_WEBHOOK_SECRET;

  if (!expected) {
    logger.error(
      { path: req.path },
      'BUFFER_WEBHOOK_SECRET is not set — rejecting all buffer requests',
    );
    res.status(500).json({ error: 'Server misconfiguration' });
    return false;
  }

  if (!incoming) {
    logger.warn(
      { from: req.body?.from, path: req.path },
      'Buffer request rejected — missing x-webhook-secret',
    );
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  const incomingBuf = Buffer.from(incoming, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  const isValid =
    incomingBuf.length === expectedBuf.length &&
    timingSafeEqual(incomingBuf, expectedBuf);

  if (!isValid) {
    logger.warn(
      { from: req.body?.from, path: req.path },
      'Buffer request rejected — invalid x-webhook-secret',
    );
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  return true;
};

// ─── Push handler ─────────────────────────────────────────────────────────────

export const bufferPushHandler = async (req: Request, res: Response): Promise<void> => {
  if (!validateSecret(req, res)) return;

  const body = req.body ?? {};

  const from = asNonEmptyString(body.from);
  const executionId = asNonEmptyString(body.executionId);

  if (!from) {
    res.status(400).json({ error: 'Missing or invalid field: from' });
    return;
  }

  if (!executionId) {
    res.status(400).json({ error: 'Missing or invalid field: executionId' });
    return;
  }

  const message = asOptionalString(body.message) ?? '';
  const messageId = asOptionalString(body.messageId);
  const messageType = asOptionalString(body.messageType);
  const imageMediaId = asOptionalNullableString(body.imageMediaId) ?? null;
  const imageCaption = asOptionalString(body.imageCaption) ?? '';
  const contactName = asOptionalString(body.contactName) ?? 'Cliente';
  const timestamp = asOptionalTimestamp(body.timestamp) ?? null;

  logger.info(
    { from, executionId, messageId, messageType },
    'Buffer push request received',
  );

  try {
    const result = await pushToBuffer({
      from,
      message,
      executionId,
      messageId,
      messageType,
      imageMediaId,
      imageCaption,
      contactName,
      timestamp,
    });

    res.json(result);
  } catch (err) {
    logger.error(
      { err, from, executionId, messageId },
      'Buffer push failed',
    );
    res.status(500).json({ error: 'Buffer push failed' });
  }
};

// ─── Claim handler ────────────────────────────────────────────────────────────

export const bufferClaimHandler = async (req: Request, res: Response): Promise<void> => {
  if (!validateSecret(req, res)) return;

  const body = req.body ?? {};

  const from = asNonEmptyString(body.from);
  const executionId = asNonEmptyString(body.executionId);

  if (!from) {
    res.status(400).json({ error: 'Missing or invalid field: from' });
    return;
  }

  if (!executionId) {
    res.status(400).json({ error: 'Missing or invalid field: executionId' });
    return;
  }

  logger.info(
    { from, executionId },
    'Buffer claim request received',
  );

  try {
    const result = await claimBuffer(from, executionId);
    res.json(result);
  } catch (err) {
    logger.error(
      { err, from, executionId },
      'Buffer claim failed',
    );
    res.status(500).json({ error: 'Buffer claim failed' });
  }
};