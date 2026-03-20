import { Router } from 'express';
import { whatsappWebhookHandler } from '#/integrations/whatsapp/webhook.controller.js';

export const whatsappWebhookRouter = Router();

// POST /api/webhooks/whatsapp
// Called by n8n Cloud after receiving a WhatsApp message.
whatsappWebhookRouter.post('/', whatsappWebhookHandler);