import { z } from 'zod';

// Payload shape sent by n8n from the WhatsApp Business API trigger.
// Keep validation permissive enough to avoid 400-ing non-message events,
// but do not falsify the original messageType.

const trimOrEmpty = (value: string): string => value.trim();

const trimToUndefined = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const trimToNullOrUndefined = (
  value: string | null | undefined,
): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || null;
};

const normalizeMessageType = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

export const webhookPayloadSchema = z.object({
  from: z.string().default('').transform(trimOrEmpty),
  message: z.string().default('').transform(trimOrEmpty),
  messageId: z.string().optional().transform(trimToUndefined),
  messageType: z.unknown().transform(normalizeMessageType),
  imageMediaId: z.string().nullable().optional().transform(trimToNullOrUndefined),
  imageCaption: z.string().default('').transform(trimOrEmpty),
  contactName: z.string().optional().transform(trimToUndefined),
  timestamp: z.union([z.string(), z.number(), z.null()]).optional(),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;