import { z } from "zod";

// Zod v4 syntax — use { error: } not { message: }.
export const conversationModeSchema = z.enum(["ai", "human", "paused"]);

export const setModeInputSchema = z.object({
  customerPhone: z.string().min(7, { error: "customerPhone is required" }),
  mode: conversationModeSchema,
  autoResumeMinutes: z.number().int().positive().max(1440).optional(),
});

export type SetModeInput = z.infer<typeof setModeInputSchema>;
