import { z } from "zod";
import { objectIdSchema } from "#/shared/validation/common.validation.js";
import { PROSPECT_STAGES } from "./prospect.types.js";

// Zod v4 syntax — use { error: } not { message: }.
export const prospectStageSchema = z.enum(
  PROSPECT_STAGES as [string, ...string[]],
);

export const registerProspectSchema = z.object({
  boutiqueId: objectIdSchema,
  customerPhone: z.string().min(7, { error: "customerPhone is required" }),
  customerName: z.string().trim().min(1).optional(),
});

export const advanceStageSchema = z.object({
  boutiqueId: objectIdSchema,
  customerPhone: z.string().min(7, { error: "customerPhone is required" }),
  stage: prospectStageSchema,
  note: z.string().trim().min(1).max(500).optional(),
});

export const addNoteSchema = z.object({
  boutiqueId: objectIdSchema,
  customerPhone: z.string().min(7, { error: "customerPhone is required" }),
  note: z
    .string({ error: "note is required" })
    .trim()
    .min(1, { error: "note is required" })
    .max(500, { error: "note must be at most 500 characters" }),
});

export type RegisterProspectInput = z.infer<typeof registerProspectSchema>;
export type AdvanceStageInput = z.infer<typeof advanceStageSchema>;
export type AddNoteInput = z.infer<typeof addNoteSchema>;
