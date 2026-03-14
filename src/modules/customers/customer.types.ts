// ─── Enums ────────────────────────────────────────────────────────────────────

export const CUSTOMER_CHANNELS = {
  WHATSAPP: 'whatsapp',
  INSTAGRAM: 'instagram',
  BOTH: 'both',
} as const;

export const CUSTOMER_TAGS = {
  VIP: 'vip',
  WHOLESALE: 'wholesale',
  PROBLEMATIC: 'problematic',
  REGULAR: 'regular',
} as const;

export type CustomerChannel =
  (typeof CUSTOMER_CHANNELS)[keyof typeof CUSTOMER_CHANNELS];

export type CustomerTag =
  (typeof CUSTOMER_TAGS)[keyof typeof CUSTOMER_TAGS];

// ─── Base ─────────────────────────────────────────────────────────────────────

export type CustomerBase = {
  name: string;
  // Stored as received — no normalization in V1
  // V2: enforce canonical format, add unique sparse index
  phone?: string;
  // Stored without @ prefix — normalized in validation layer
  // V2: add unique sparse index
  instagramHandle?: string;
  // Renamed from channel — makes intent clearer
  // MVP assumption: BOTH means customer has both phone and instagramHandle
  // V2: consider channels: CustomerChannel[] for stronger modeling
  contactChannel: CustomerChannel;
  notes?: string;
  // Tags mix dimensions (status, type, behavior) — acceptable for MVP CRM
  // V2: consider separate segment and flags fields
  tags: CustomerTag[];
  address?: string;
  isActive: boolean;
};

// ─── Entity ───────────────────────────────────────────────────────────────────

export type CustomerEntity = CustomerBase & {
  _id: string;
  createdAt: Date;
  updatedAt: Date;
};

// ─── Response ─────────────────────────────────────────────────────────────────

export type CustomerResponse = Omit<
  CustomerEntity,
  '_id' | 'createdAt' | 'updatedAt'
> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

// ─── Input Types ──────────────────────────────────────────────────────────────

// tags optional on create — defaults to [] in model
// channel/contact consistency enforced in validation:
//   whatsapp → phone required
//   instagram → instagramHandle required
//   both → both required
export type CreateCustomerInput = Omit<CustomerBase, 'isActive' | 'tags'> & {
  tags?: CustomerTag[];
};

// id handled separately by service layer — consistent with product/auth pattern
export type UpdateCustomerInput = Partial<Omit<CustomerBase, 'isActive'>>;