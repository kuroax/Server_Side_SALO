import { Router } from 'express';
import { whatsappWebhookHandler } from '#/integrations/whatsapp/webhook.controller.js';
import { bufferPushHandler, bufferClaimHandler } from '#/integrations/whatsapp/buffer.controller.js';

export const whatsappWebhookRouter = Router();

// POST /api/webhooks/whatsapp
// Called by n8n after receiving a WhatsApp message.
whatsappWebhookRouter.post('/', whatsappWebhookHandler);

// POST /api/webhooks/whatsapp/buffer/push
// Called by n8n Accumulate Message node — appends message to MongoDB buffer.
whatsappWebhookRouter.post('/buffer/push', bufferPushHandler);

// POST /api/webhooks/whatsapp/buffer/claim
// Called by n8n Check & Merge node — claims and clears buffer if owner.
whatsappWebhookRouter.post('/buffer/claim', bufferClaimHandler);