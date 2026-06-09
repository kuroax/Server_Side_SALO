// ─── Enums ────────────────────────────────────────────────────────────────────

export const BOUTIQUE_STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  SUSPENDED: "suspended",
} as const;

export type BoutiqueStatus =
  (typeof BOUTIQUE_STATUS)[keyof typeof BOUTIQUE_STATUS];

// Per-conversation mode lives on the conversation document, but the boutique
// also carries a globalMode that gates the bot for ALL conversations of the
// tenant — used when the owner wants to disable Luis temporarily without
// touching individual conversations.
export const CONVERSATION_MODE = {
  AUTO: "auto",
  MANUAL: "manual",
} as const;

export type ConversationMode =
  (typeof CONVERSATION_MODE)[keyof typeof CONVERSATION_MODE];

// ─── Onboarding status ────────────────────────────────────────────────────────
// Tracks a tenant's progress through the onboarding funnel. A boutique can be
// created (via scripts/create-boutique.ts) BEFORE its WhatsApp account is
// connected, so credentials (phoneNumberId/wabaId/accessToken) may be absent
// until Embedded Signup flips this to WHATSAPP_CONNECTED.
//
//   CREATED             → boutique + owner exist; no WhatsApp yet
//   BUSINESS_CONFIGURED → businessInfo captured
//   AI_CONFIGURED       → agentConfig captured
//   WHATSAPP_PENDING    → Embedded Signup started, not finished
//   WHATSAPP_CONNECTED  → Meta credentials persisted
//   TESTING             → owner verifying the bot end-to-end
//   ACTIVE              → live, serving customers
//   SUSPENDED           → disabled
export const BOUTIQUE_ONBOARDING_STATUS = {
  CREATED: "CREATED",
  BUSINESS_CONFIGURED: "BUSINESS_CONFIGURED",
  AI_CONFIGURED: "AI_CONFIGURED",
  WHATSAPP_PENDING: "WHATSAPP_PENDING",
  WHATSAPP_CONNECTED: "WHATSAPP_CONNECTED",
  TESTING: "TESTING",
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
} as const;

export type BoutiqueOnboardingStatus =
  (typeof BOUTIQUE_ONBOARDING_STATUS)[keyof typeof BOUTIQUE_ONBOARDING_STATUS];

// ─── Embedded business info ───────────────────────────────────────────────────
// Mirrors the BUSINESS_INFO constant previously hardcoded in webhook.service.ts.
// Each tenant owns its own copy so prices, hours, and shipping costs can vary.

export type BoutiqueBusinessInfo = {
  showroomAddress: string;
  businessHours: string;
  shippingPrice: number;
  paymentMethods: string;
  depositPercent: number;
  paymentDays: number;
  deliveryInfo: string;
  activePromotion?: string;
};
