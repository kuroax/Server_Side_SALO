import { Router } from "express";
import { whatsappWebhookHandler } from "#/integrations/whatsapp/webhook.controller.js";
import {
  bufferPushHandler,
  bufferClaimHandler,
} from "#/integrations/whatsapp/buffer.controller.js";
import { logSentImageHandler } from "#/integrations/whatsapp/logSentImage.controller.js";
import { setHumanModeHandler } from "#/integrations/whatsapp/setHumanMode.controller.js";
import { requireBufferWebhookSecret } from "#/integrations/whatsapp/webhook.auth.js";

export const whatsappWebhookRouter = Router();

// POST /api/webhooks/whatsapp
whatsappWebhookRouter.post("/", whatsappWebhookHandler);

// POST /api/webhooks/whatsapp/buffer/push
whatsappWebhookRouter.post(
  "/buffer/push",
  requireBufferWebhookSecret,
  bufferPushHandler,
);

// POST /api/webhooks/whatsapp/buffer/claim
whatsappWebhookRouter.post(
  "/buffer/claim",
  requireBufferWebhookSecret,
  bufferClaimHandler,
);

// POST /api/webhooks/whatsapp/log-sent-image
// Called by n8n after each WhatsApp Send Image response to store the mapping
// sentMessageId → product. Enables exact product resolution when a customer
// replies to a specific gallery image (contextMessageId lookup).
whatsappWebhookRouter.post(
  "/log-sent-image",
  requireBufferWebhookSecret,
  logSentImageHandler,
);

// POST /api/webhooks/whatsapp/set-human-mode
// Called to flip the conversationState gate to "human" for a customer so the
// bot stops replying and the owner handles the conversation manually. Resolves
// the boutique by phoneNumberId and auto-resumes to "ai" after the given minutes.
whatsappWebhookRouter.post(
  "/set-human-mode",
  requireBufferWebhookSecret,
  setHumanModeHandler,
);
