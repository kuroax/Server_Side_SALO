import { z } from "zod";
import {
  BOUTIQUE_STATUS,
  CONVERSATION_MODE,
} from "#/modules/boutiques/boutique.types.js";

// ─── Enums ────────────────────────────────────────────────────────────────────

const boutiqueStatusEnum = z.enum([
  BOUTIQUE_STATUS.ACTIVE,
  BOUTIQUE_STATUS.INACTIVE,
  BOUTIQUE_STATUS.SUSPENDED,
]);

const conversationModeEnum = z.enum([
  CONVERSATION_MODE.AUTO,
  CONVERSATION_MODE.MANUAL,
]);

// ─── Business info ────────────────────────────────────────────────────────────

export const businessInfoSchema = z.object({
  showroomAddress: z
    .string({ error: "showroomAddress is required" })
    .trim()
    .min(1, { error: "showroomAddress cannot be empty" }),
  businessHours: z
    .string({ error: "businessHours is required" })
    .trim()
    .min(1, { error: "businessHours cannot be empty" }),
  shippingPrice: z
    .number({ error: "shippingPrice must be a number" })
    .min(0, { error: "shippingPrice cannot be negative" }),
  paymentMethods: z
    .string({ error: "paymentMethods is required" })
    .trim()
    .min(1, { error: "paymentMethods cannot be empty" }),
  depositPercent: z
    .number({ error: "depositPercent must be a number" })
    .min(0, { error: "depositPercent cannot be negative" })
    .max(100, { error: "depositPercent cannot exceed 100" }),
  paymentDays: z
    .number({ error: "paymentDays must be a number" })
    .int({ error: "paymentDays must be an integer" })
    .min(0, { error: "paymentDays cannot be negative" }),
  deliveryInfo: z
    .string({ error: "deliveryInfo is required" })
    .trim()
    .min(1, { error: "deliveryInfo cannot be empty" }),
  activePromotion: z.string().trim().min(1).optional(),
});

// ─── Create boutique ──────────────────────────────────────────────────────────

export const createBoutiqueSchema = z.object({
  name: z
    .string({ error: "name is required" })
    .trim()
    .min(1, { error: "name cannot be empty" })
    .max(120, { error: "name must be at most 120 characters" }),
  phoneNumberId: z
    .string({ error: "phoneNumberId is required" })
    .trim()
    .min(1, { error: "phoneNumberId cannot be empty" }),
  wabaId: z
    .string({ error: "wabaId is required" })
    .trim()
    .min(1, { error: "wabaId cannot be empty" }),
  accessToken: z
    .string({ error: "accessToken is required" })
    .min(1, { error: "accessToken cannot be empty" }),
  businessPortfolioId: z.string().trim().min(1).optional(),
  bankAccountImageUrl: z.string().trim().url().optional(),
  businessInfo: businessInfoSchema,
  globalMode: conversationModeEnum.optional(),
  status: boutiqueStatusEnum.optional(),
  connectedAt: z.date().optional(),
});

// ─── Update boutique ──────────────────────────────────────────────────────────
// Excludes credential fields (phoneNumberId, wabaId, accessToken). Those
// updates go through updateBoutiqueCredentialsSchema so credential rotations
// stay explicit and auditable.

export const updateBoutiqueSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { error: "name cannot be empty" })
      .max(120, { error: "name must be at most 120 characters" })
      .optional(),
    businessPortfolioId: z.string().trim().min(1).optional(),
    bankAccountImageUrl: z.string().trim().url().optional(),
    businessInfo: businessInfoSchema.partial().optional(),
    globalMode: conversationModeEnum.optional(),
    status: boutiqueStatusEnum.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    error: "At least one field must be provided",
  });

// ─── Update credentials ───────────────────────────────────────────────────────
// Separate flow so credential rotations are explicit.

export const updateBoutiqueCredentialsSchema = z.object({
  phoneNumberId: z
    .string({ error: "phoneNumberId is required" })
    .trim()
    .min(1, { error: "phoneNumberId cannot be empty" }),
  wabaId: z
    .string({ error: "wabaId is required" })
    .trim()
    .min(1, { error: "wabaId cannot be empty" }),
  accessToken: z
    .string({ error: "accessToken is required" })
    .min(1, { error: "accessToken cannot be empty" }),
  businessPortfolioId: z.string().trim().min(1).optional(),
  connectedAt: z.date(),
});

// ─── Embedded Signup payload ──────────────────────────────────────────────────
// Sent by the frontend after FB.login() completes. The backend exchanges the
// `code` (30-second token) for a permanent access token via the Meta Graph API
// using META_APP_ID + META_APP_SECRET.

export const embeddedSignupSchema = z.object({
  code: z
    .string({ error: "code is required" })
    .trim()
    .min(1, { error: "code cannot be empty" }),
  boutiqueId: z
    .string({ error: "boutiqueId is required" })
    .trim()
    .min(1, { error: "boutiqueId cannot be empty" }),
  phoneNumberId: z
    .string({ error: "phoneNumberId is required" })
    .trim()
    .min(1, { error: "phoneNumberId cannot be empty" }),
  wabaId: z
    .string({ error: "wabaId is required" })
    .trim()
    .min(1, { error: "wabaId cannot be empty" }),
  businessPortfolioId: z.string().trim().min(1).optional(),
});

// ─── Set mode ─────────────────────────────────────────────────────────────────

export const setModeSchema = z.object({
  mode: conversationModeEnum,
});

// ─── Inferred types ───────────────────────────────────────────────────────────

export type BusinessInfoData = z.infer<typeof businessInfoSchema>;
export type CreateBoutiqueData = z.infer<typeof createBoutiqueSchema>;
export type UpdateBoutiqueData = z.infer<typeof updateBoutiqueSchema>;
export type UpdateBoutiqueCredentialsData = z.infer<
  typeof updateBoutiqueCredentialsSchema
>;
export type EmbeddedSignupData = z.infer<typeof embeddedSignupSchema>;
export type SetModeData = z.infer<typeof setModeSchema>;
