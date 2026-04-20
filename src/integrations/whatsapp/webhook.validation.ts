import { z } from 'zod';

// Payload shape sent by n8n from the WhatsApp Business API trigger.
// Supports both text and image message types.
export const webhookPayloadSchema = z.object({
  from:         z.string().min(1),                          // sender phone number, e.g. "521234567890"
  message:      z.string().default(''),                     // text body — empty for image-only messages
  messageId:    z.string().min(1),                          // WhatsApp message ID — used for idempotency
  messageType:  z.enum(['text', 'image']).default('text'),  // message type from WhatsApp payload
  imageMediaId: z.string().optional(),                      // present only when messageType === 'image'
  timestamp:    z.string().optional(),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;