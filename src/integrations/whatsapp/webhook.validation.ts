import { z } from 'zod';

// Payload shape sent by n8n from the WhatsApp Business API trigger.
// Supports both text and image message types.
export const webhookPayloadSchema = z.object({
  // WhatsApp sends non-message events (read receipts, delivery notifications,
  // status updates) with an empty or absent from field. Accept empty string
  // and guard in the service — never reject these with a 400.
  from: z.string().default(''),

  message:   z.string().default(''), // text body — empty for image-only messages

  // n8n may send messageId as an empty string for certain message types.
  messageId: z.string().default(''),

  // n8n may send values other than "text" | "image" (e.g. empty string,
  // "interactive", "reaction", "status", etc.). Normalize: anything that
  // isn't explicitly "image" becomes "text". Never reject with a 400.
  messageType: z
    .string()
    .optional()
    .transform((v) => (v === 'image' ? 'image' : 'text') as 'text' | 'image'),

  imageMediaId: z.string().optional(),
  timestamp:    z.string().optional(),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;