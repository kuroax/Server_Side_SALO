import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { webhookPayloadSchema } from '#/integrations/whatsapp/webhook.validation.js';
import { handleIncomingMessage } from '#/integrations/whatsapp/webhook.service.js';
import { WEBHOOK_SECRET } from '#/config/env.js';
import { logger } from '#/config/logger.js';

// Pre-encode the expected secret once at module load so timingSafeEqual can
// compare buffers of equal length. Buffers must be the same length; if the
// incoming value differs in length we reject immediately (no timing leak since
// length is not secret).
const EXPECTED_SECRET_BYTES = Buffer.from(WEBHOOK_SECRET, 'utf8');

export const whatsappWebhookHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  // ── Validate webhook secret ──────────────────────────────────────────────
  const rawHeader = req.headers['x-webhook-secret'];
  // The header can be a string or an array — always use the first value.
  const secretValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

  const isValid = (() => {
    if (!secretValue) return false;
    const incoming = Buffer.from(secretValue, 'utf8');
    if (incoming.length !== EXPECTED_SECRET_BYTES.length) return false;
    return timingSafeEqual(EXPECTED_SECRET_BYTES, incoming);
  })();

  if (!isValid) {
    logger.warn({ ip: req.ip }, 'Webhook secret validation failed');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // ── Validate payload ─────────────────────────────────────────────────────
  const parsed = webhookPayloadSchema.safeParse(req.body);

  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, 'Invalid webhook payload');
    res.status(400).json({ error: 'Invalid payload', details: parsed.error.issues });
    return;
  }

  // ── Process message ──────────────────────────────────────────────────────
  try {
    const result = await handleIncomingMessage(parsed.data);

    // n8n reads the reply field and sends it back to WhatsApp.
    res.status(200).json({ reply: result.reply, escalate: result.escalate, customerPhone: result.customerPhone, customerName: result.customerName });
  } catch (err) {
    logger.error({ err }, 'Webhook handler error');
    res.status(500).json({ error: 'Internal server error' });
  }
};