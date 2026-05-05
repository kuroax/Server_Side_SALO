import type { Request, Response } from "express";
import { z } from "zod";
import { SentImageModel } from "#/modules/sentImages/sentImage.model.js";
import { logger } from "#/config/logger.js";

// ─── Request schema ───────────────────────────────────────────────────────────

const logSentImageSchema = z.object({
  // WhatsApp message ID from the Graph API send response (messages[0].id).
  sentMessageId: z.string().trim().min(1),

  // Caption of the sent image — identifies the product.
  // Only the first image of a product has a caption; secondary photos have "".
  // We only store entries with non-empty captions — secondary photos carry no
  // product identity and don't need to be looked up.
  caption: z.string().trim(),

  // Customer phone the image was sent to.
  customerPhone: z.string().trim().min(1),
});

// ─── Handler ──────────────────────────────────────────────────────────────────

// POST /api/webhooks/whatsapp/log-sent-image
//
// Called by n8n "Log Sent Image" Function node after each WhatsApp Send Image
// response. Stores sentMessageId → product mapping so contextMessageId lookups
// in webhook.service.ts can resolve the exact product a customer replied to.
//
// Auth: requireBufferWebhookSecret (same secret as buffer endpoints — no new
// env variable needed).
export const logSentImageHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const parsed = logSentImageSchema.safeParse(req.body);

  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues, body: req.body },
      "logSentImage — invalid payload",
    );
    res.status(400).json({ ok: false, error: "invalid_payload" });
    return;
  }

  const { sentMessageId, caption, customerPhone } = parsed.data;

  // Skip secondary photos — they have no caption and carry no product identity.
  if (!caption) {
    res.json({ ok: true, skipped: true, reason: "empty_caption" });
    return;
  }

  try {
    // upsert: true — idempotent if n8n retries the same message ID.
    await SentImageModel.findOneAndUpdate(
      { sentMessageId },
      { sentMessageId, caption, customerPhone, createdAt: new Date() },
      { upsert: true, returnDocument: "after" },
    );

    logger.info(
      { sentMessageId, customerPhone, captionPreview: caption.slice(0, 80) },
      "logSentImage — mapping stored",
    );

    res.json({ ok: true });
  } catch (err) {
    logger.error(
      { err, sentMessageId, customerPhone },
      "logSentImage — DB write failed",
    );
    res.status(500).json({ ok: false, error: "db_error" });
  }
};
