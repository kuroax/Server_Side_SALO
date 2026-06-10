// ─── Webhook I/O schemas + idempotency helpers ────────────────────────────────
// Validated input/output contracts for the WhatsApp webhook, plus the
// message-idempotency gate and phone normalization. Extracted from
// webhook.service.ts.

import { z } from "zod";
import mongoose from "mongoose";
import { ProcessedMessageModel } from "#/modules/processedMessages/processedMessage.model.js";
import { logger } from "#/config/logger.js";
import {
  buildErrorReply,
  buildEscalationMessage,
} from "#/integrations/whatsapp/webhook.escalation.js";

// ─── Response schema ──────────────────────────────────────────────────────────

export const productImageSchema = z.object({
  url: z.string().url(),
  caption: z.string().optional(),
});

export type ProductImage = z.infer<typeof productImageSchema>;

export const webhookResultSchema = z.object({
  reply: z.string(),
  escalate: z.boolean(),
  customerPhone: z.string(),
  customerName: z.string().nullable(),
  productImages: z.array(productImageSchema),
  escalationMessage: z.string().optional(),
});

export type WebhookResult = z.infer<typeof webhookResultSchema>;

// Returns a new object on every call — prevents shared array mutation across
// requests if any caller ever does result.productImages.push(...).
export const emptyResult = (): WebhookResult => ({
  reply: "",
  escalate: false,
  customerPhone: "",
  customerName: null,
  productImages: [],
});

export function toSafeResult(
  raw: unknown,
  customerPhone = "",
  customerName: string | null = null,
  gender: "female" | "male" | "unknown" = "unknown",
): WebhookResult {
  const parsed = webhookResultSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues, raw },
      "WebhookResult failed schema validation — escalating instead of silent empty",
    );
    return {
      reply: buildErrorReply(gender),
      escalate: true,
      customerPhone,
      customerName,
      productImages: [],
      escalationMessage: buildEscalationMessage({
        customerPhone,
        customerName,
        reason:
          "Error interno de validación — el resultado del procesamiento no cumple el esquema esperado.",
        suggestedAction:
          "Revisar logs de Railway para detalles del error. Responder al cliente manualmente.",
      }),
    };
  }
  return parsed.data;
}

// ─── Integration boundary schemas ─────────────────────────────────────────────

export const processMessageResultSchema = z.object({
  intent: z.enum([
    "catalog_query",
    "product_search",
    "price_query",
    "create_order",
    "order_status",
    "order_summary", // NEW: customer asked for their full accumulated order list
    "showroom_visit", // NEW: customer wants to visit the showroom in person
    "payment_info",
    "payment_receipt",
    "needs_human",
    "general",
  ]),
  response: z.string().min(1),
  searchHints: z
    .object({
      keyword: z.string().min(1),
      gender: z.enum(["female", "male", "unknown"]).optional(),
      size: z.string().optional(),
      color: z.string().optional(),
    })
    .optional(),
  orderHints: z
    .array(
      z.object({
        productNameHint: z.string().min(1),
        size: z.string().min(1),
        color: z.string().min(1),
        quantity: z.number().int().positive(),
      }),
    )
    .optional(),
  productImages: z.array(productImageSchema),
  detectedGender: z.enum(["female", "male"]).optional(),
});

export type ProcessMessageResult = z.infer<typeof processMessageResultSchema>;

export const imageSearchResultSchema = z.object({
  reply: z.string().min(1),
  // Use productImageSchema instead of z.unknown() — validates URLs and prevents
  // malformed image objects from crashing the WhatsApp send node downstream.
  productImages: z.array(productImageSchema).default([]),
});

// ─── Message idempotency (text + image) ──────────────────────────────────────
// MongoDB TTL collection keyed by { messageId, boutiqueId }.
// Inserting before processing; E11000 = already processed, skip.
// Works across instances and survives restarts (unlike the prior in-memory Set).
export async function markMessageProcessed(
  messageId: string,
  boutiqueId: string,
): Promise<boolean> {
  try {
    await ProcessedMessageModel.create({
      messageId,
      boutiqueId: new mongoose.Types.ObjectId(boutiqueId),
    });
    return true; // first time seeing this message
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code: number }).code === 11000
    ) {
      return false; // duplicate — already processed
    }
    // On unexpected DB errors, BLOCK processing rather than allow through. A
    // blocked message is safer than a duplicate order/alert — n8n will retry the
    // delivery, and the next attempt can record the dedup marker cleanly.
    logger.warn(
      { err, messageId, boutiqueId },
      "[webhook] processedMessage insert failed — blocking to prevent duplicate",
    );
    return false;
  }
}

// Compensating rollback for markMessageProcessed: when processing throws AFTER
// the marker was inserted, delete it so the n8n retry is processed instead of
// being silently dropped as a duplicate. Best-effort — if the delete itself
// fails, the retry is treated as a duplicate (the pre-existing behavior);
// this must never throw into the webhook flow.
export async function unmarkMessageProcessed(
  messageId: string,
  boutiqueId: string,
): Promise<void> {
  try {
    await ProcessedMessageModel.deleteOne({
      messageId,
      boutiqueId: new mongoose.Types.ObjectId(boutiqueId),
    });
    logger.info(
      { messageId, boutiqueId },
      "[webhook] processedMessage marker rolled back after processing error",
    );
  } catch (err) {
    logger.warn(
      { err, messageId, boutiqueId },
      "[webhook] processedMessage rollback failed — n8n retry will be treated as duplicate",
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function normalizePhoneForLookup(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\D+/g, "");
}
