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
