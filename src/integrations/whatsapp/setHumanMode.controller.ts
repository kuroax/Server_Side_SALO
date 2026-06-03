import type { Request, Response } from "express";
import { z } from "zod";
import { findBoutiqueByPhoneNumberId } from "#/modules/boutiques/boutique.service.js";
import { setConversationMode } from "#/modules/conversationState/conversationState.service.js";
import { logger } from "#/config/logger.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_AUTO_RESUME_MINUTES = 30;

// ─── Request schema ───────────────────────────────────────────────────────────

const setHumanModeSchema = z.object({
  // Customer phone in digits-only form. Min 7 guards against obviously malformed
  // numbers without over-fitting to a single country's length.
  customerPhone: z.string().trim().min(7, { error: "customerPhone too short" }),

  // Meta phone number ID used to resolve the boutique tenant.
  phoneNumberId: z.string().trim().min(1, { error: "phoneNumberId required" }),

  // Minutes until the gate auto-resumes back to "ai". Defaults to 30 when absent.
  autoResumeMinutes: z
    .number()
    .int({ error: "autoResumeMinutes must be an integer" })
    .min(1, { error: "autoResumeMinutes must be >= 1" })
    .max(1440, { error: "autoResumeMinutes must be <= 1440" })
    .optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Masks all but the last 4 digits so the customer phone never lands in logs.
const maskPhone = (phone: string): string => {
  if (phone.length <= 4) return "****";
  return `${"*".repeat(phone.length - 4)}${phone.slice(-4)}`;
};

// ─── Handler ──────────────────────────────────────────────────────────────────

// POST /api/webhooks/whatsapp/set-human-mode
//
// Flips the conversationState gate to "human" for a given customer so the bot
// stops replying and the owner handles the conversation manually. Auto-resumes
// to "ai" after autoResumeMinutes (default 30) via checkAndApplyAutoResume.
//
// Auth: requireBufferWebhookSecret (same secret as buffer endpoints).
// Never throws — always returns a JSON response so n8n gets a clean status.
export const setHumanModeHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const parsed = setHumanModeSchema.safeParse(req.body);

  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues },
      "[setHumanMode] invalid payload",
    );
    res.status(400).json({ error: "invalid_payload" });
    return;
  }

  const { customerPhone, phoneNumberId, autoResumeMinutes } = parsed.data;
  const resumeMinutes = autoResumeMinutes ?? DEFAULT_AUTO_RESUME_MINUTES;

  try {
    const boutique = await findBoutiqueByPhoneNumberId(phoneNumberId);

    if (!boutique) {
      logger.warn(
        { phoneNumberId, customerPhone: maskPhone(customerPhone) },
        "[setHumanMode] boutique not found",
      );
      res.status(404).json({ error: "boutique_not_found" });
      return;
    }

    await setConversationMode(
      boutique._id.toString(),
      customerPhone,
      "human",
      resumeMinutes,
    );

    logger.info(
      {
        boutiqueId: boutique._id.toString(),
        customerPhone: maskPhone(customerPhone),
        autoResumeMinutes: resumeMinutes,
      },
      "[setHumanMode] gate set to human",
    );

    res.status(200).json({
      ok: true,
      mode: "human",
      customerPhone,
      autoResumeMinutes: resumeMinutes,
    });
  } catch (err) {
    logger.error(
      { err, customerPhone: maskPhone(customerPhone) },
      "[setHumanMode] failed",
    );
    res.status(500).json({ error: "internal" });
  }
};
