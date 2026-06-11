import { z } from "zod";

// Payload shape sent by n8n from the WhatsApp Business API trigger.
// Keep validation permissive enough to avoid 400-ing non-message events,
// but do not falsify the original messageType.

const trimOrEmpty = (value: string): string => value.trim();

const trimToUndefined = (value: string | undefined): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const trimToNullOrUndefined = (
  value: string | null | undefined,
): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || null;
};

const normalizeMessageType = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim();
};

export const webhookPayloadSchema = z.object({
  from: z.string().default("").transform(trimOrEmpty),
  message: z.string().default("").transform(trimOrEmpty),
  messageId: z.string().optional().transform(trimToUndefined),
  // Deterministic idempotency key produced by claimBuffer when several WhatsApp
  // messages are merged into one webhook POST. n8n forwards it here from the
  // buffer-claim response. When present, webhook.service.ts uses it as the
  // effective messageId (dedup gate + createOrder sourceMessageId) so a retry of
  // the merged claim is deduplicated — a single buffered message has no stable
  // per-burst messageId otherwise. Falls back to messageId when absent.
  mergedMessageId: z.string().optional().transform(trimToUndefined),
  messageType: z.unknown().transform(normalizeMessageType),
  imageMediaId: z
    .string()
    .nullable()
    .optional()
    .transform(trimToNullOrUndefined),
  imageCaption: z.string().default("").transform(trimOrEmpty),
  contactName: z.string().optional().transform(trimToUndefined),
  timestamp: z.union([z.string(), z.number(), z.null()]).optional(),
  // Set by Extract Message node when the customer replies directly to a
  // specific WhatsApp message (e.g. tapping a gallery image and typing).
  // null when the message is not a reply to anything.
  contextMessageId: z
    .string()
    .nullable()
    .optional()
    .transform(trimToNullOrUndefined),
  // Meta WhatsApp Cloud API phone_number_id — identifies which boutique
  // the message was sent to. Sourced by n8n from
  // entry[].changes[].value.metadata.phone_number_id. Optional during the
  // multi-tenant rollout — when missing, webhook.service.ts falls back to
  // the only active boutique (single-tenant compatibility shim).
  phoneNumberId: z.string().optional().transform(trimToUndefined),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
