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

export const CUSTOMER_GENDERS = {
  FEMALE: 'female',
  MALE: 'male',
  UNKNOWN: 'unknown',
} as const;

export type CustomerChannel =
  (typeof CUSTOMER_CHANNELS)[keyof typeof CUSTOMER_CHANNELS];

export type CustomerTag =
  (typeof CUSTOMER_TAGS)[keyof typeof CUSTOMER_TAGS];

export type CustomerGender =
  (typeof CUSTOMER_GENDERS)[keyof typeof CUSTOMER_GENDERS];

// ─── Base ─────────────────────────────────────────────────────────────────────

export type CustomerBase = {
  name: string;
  phone?: string;
  instagramHandle?: string;
  contactChannel: CustomerChannel;
  notes?: string;
  tags: CustomerTag[];
  address?: string;
  isActive: boolean;
  // Used by Luis to adapt communication style (female/male/unknown)
  // Defaults to 'unknown' — can be set manually or inferred from name
  gender: CustomerGender;
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

export type CreateCustomerInput = Omit<CustomerBase, 'isActive' | 'tags'> & {
  tags?: CustomerTag[];
};

export type UpdateCustomerInput = Partial<Omit<CustomerBase, 'isActive'>>;