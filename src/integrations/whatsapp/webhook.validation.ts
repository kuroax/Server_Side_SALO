import { z } from 'zod';

// Payload shape sent by n8n from the WhatsApp Business API trigger.
// n8n normalizes the WhatsApp webhook format into this structure.
export const webhookPayloadSchema = z.object({
  from:      z.string().min(1),   // sender phone number, e.g. "521234567890"
  message:   z.string().min(1),   // message text body
  messageId: z.string().min(1),   // WhatsApp message ID — used for idempotency
  timestamp: z.string().optional(),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;