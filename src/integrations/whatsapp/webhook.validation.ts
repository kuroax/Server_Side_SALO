import { z } from 'zod';

// Payload shape sent by n8n from the WhatsApp Business API trigger.
// Supports both text and image message types.
export const webhookPayloadSchema = z.object({
  from:         z.string().min(1),     // sender phone number, e.g. "521234567890"
  message:      z.string().default(''), // text body — empty for image-only messages

  // n8n may send messageId as an empty string for certain message types —
  // accept it rather than rejecting the whole request with a 400.
  messageId: z.string().default(''),

  // n8n may send values other than "text" | "image" (e.g. an empty string,
  // "text_message", "interactive", "reaction", etc.) depending on WhatsApp
  // message type. Normalize: treat anything that isn't explicitly "image"
  // as "text" so the request is never rejected by enum validation.
  messageType: z
    .string()
    .optional()
    .transform((v) => (v === 'image' ? 'image' : 'text') as 'text' | 'image'),

  imageMediaId: z.string().optional(), // present only when messageType === 'image'
  timestamp:    z.string().optional(),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;