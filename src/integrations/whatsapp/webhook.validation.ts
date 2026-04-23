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

// Preserve the original messageType truthfully.
// We only trim it; we do not rewrite unknown values into "text".
const normalizeMessageType = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

export const webhookPayloadSchema = z.object({
  // Non-message events may arrive with missing/empty sender info.
  // Let the service layer decide whether to skip them.
  from: z.string().default('').transform(trimOrEmpty),

  // Text body. May be empty for image-only or non-message events.
  message: z.string().default('').transform(trimOrEmpty),

  // Meta's unique message ID — blank IDs become undefined.
  messageId: z.string().optional().transform(trimToUndefined),

  // Keep the raw type truthful for downstream logic and debugging.
  messageType: z.unknown().transform(normalizeMessageType),

  // Image metadata — only present for image messages.
  imageMediaId: z.string().nullable().optional().transform(trimToNullOrUndefined),
  imageCaption: z.string().default('').transform(trimOrEmpty),

  // Best-effort display name from WhatsApp profile.
  contactName: z.string().optional().transform(trimToUndefined),

  // Meta may send timestamp as string, number, or null.
  timestamp: z.union([z.string(), z.number(), z.null()]).optional(),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;