import type { Request, Response } from 'express';
import { webhookPayloadSchema } from '#/integrations/whatsapp/webhook.validation.js';
import { handleIncomingMessage } from '#/integrations/whatsapp/webhook.service.js';
import { WEBHOOK_SECRET } from '#/config/env.js';
import { logger } from '#/config/logger.js';

export const whatsappWebhookHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  // ── Validate webhook secret ──────────────────────────────────────────────
  const secret = req.headers['x-webhook-secret'];

  if (!secret || secret !== WEBHOOK_SECRET) {
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
    res.status(200).json({ reply: result.reply });
  } catch (err) {
    logger.error({ err }, 'Webhook handler error');
    res.status(500).json({ error: 'Internal server error' });
  }
};