import { z } from 'zod';
import {
  CUSTOMER_CHANNELS,
  CUSTOMER_TAGS,
  CUSTOMER_GENDERS,
} from '#/modules/customers/customer.types.js';

// ─── Enums ────────────────────────────────────────────────────────────────────

const contactChannelEnum = z.enum([
  CUSTOMER_CHANNELS.WHATSAPP,
  CUSTOMER_CHANNELS.INSTAGRAM,
  CUSTOMER_CHANNELS.BOTH,
]);

const customerTagEnum = z.enum([
  CUSTOMER_TAGS.VIP,
  CUSTOMER_TAGS.WHOLESALE,
  CUSTOMER_TAGS.PROBLEMATIC,
  CUSTOMER_TAGS.REGULAR,
]);

const customerGenderEnum = z.enum([
  CUSTOMER_GENDERS.FEMALE,
  CUSTOMER_GENDERS.MALE,
  CUSTOMER_GENDERS.UNKNOWN,
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const dedupeTags = (tags: string[] | undefined): string[] | undefined =>
  tags ? Array.from(new Set(tags)) : undefined;

// Strips all non-digit characters from a phone string.
// Used to validate digit count against the raw formatted input.
// The service layer applies the same logic for storage normalization.
const normalizePhoneDigits = (value: string): string =>
  value.replace(/\D+/g, '');

const hasUsablePhone = (value: string | undefined): boolean => {
  if (typeof value !== 'string') return false;
  const digits = normalizePhoneDigits(value);
  return digits.length >= 7 && digits.length <= 15;
};

const normalizeInstagramHandle = (value: string): string =>
  value.replace(/^@/, '').trim().toLowerCase();

// ─── Field Schemas ────────────────────────────────────────────────────────────

// Validates digit count after stripping formatting so "+52 (332) 820-5715"
// is accepted. min/max apply to the raw formatted string — the service
// normalizes to digits-only before storing.
const phoneSchema = z
  .string()
  .trim()
  .min(1, 'Phone cannot be empty')
  .max(40, 'Phone number is too long')
  .refine(
    (value) => {
      const digits = normalizePhoneDigits(value);
      return digits.length >= 7 && digits.length <= 15;
    },
    'Phone must contain between 7 and 15 digits',
  )
  .optional();

// Strips leading @ and lowercases at the schema boundary.
// The service also normalizes — both are idempotent, schema runs first.
const instagramHandleSchema = z
  .string()
  .trim()
  .min(1, 'Instagram handle cannot be empty')
  .max(30, 'Instagram handle is too long')
  .transform(normalizeInstagramHandle)
  .optional();

// ─── Base Schema ──────────────────────────────────────────────────────────────

const customerBaseSchema = z.object({
  name: z
    .string({ error: 'Name is required' })
    .trim()
    .min(1, 'Name cannot be empty')
    .max(100, 'Name is too long'),

  phone: phoneSchema,

  instagramHandle: instagramHandleSchema,

  contactChannel: contactChannelEnum,

  notes: z
    .string()
    .trim()
    .max(500, 'Notes are too long')
    .optional(),

  tags: z.array(customerTagEnum).optional(),

  address: z
    .string()
    .trim()
    .max(200, 'Address is too long')
    .optional(),

  // Defaults to 'unknown' — set manually in the app or inferred from conversation.
  gender: customerGenderEnum.default(CUSTOMER_GENDERS.UNKNOWN),
});

// ─── Channel/Contact Consistency ──────────────────────────────────────────────
// Zod v4 requires code: 'custom' as a literal and path: PropertyKey[]
// to match its internal $RefinementCtx addIssue signature.

type ChannelConsistencyCtx = {
  addIssue: (arg: {
    code:    'custom';
    path:    PropertyKey[];
    message: string;
  }) => void;
};

const enforceChannelConsistency = (
  data: {
    phone?:           string | undefined;
    instagramHandle?: string | undefined;
    contactChannel?:  string | undefined;
  },
  ctx: ChannelConsistencyCtx,
): void => {
  if (!data.contactChannel) return;

  // Check digit count after stripping formatting — raw phone string may be
  // formatted e.g. "+52 332 820 5715" which is valid despite having spaces.
  const hasPhone     = hasUsablePhone(data.phone);
  const hasInstagram = typeof data.instagramHandle === 'string' && data.instagramHandle.length > 0;

  if (data.contactChannel === CUSTOMER_CHANNELS.WHATSAPP && !hasPhone) {
    ctx.addIssue({
      code:    'custom',
      path:    ['phone'],
      message: 'Phone is required when contactChannel is whatsapp',
    });
  }

  if (data.contactChannel === CUSTOMER_CHANNELS.INSTAGRAM && !hasInstagram) {
    ctx.addIssue({
      code:    'custom',
      path:    ['instagramHandle'],
      message: 'Instagram handle is required when contactChannel is instagram',
    });
  }

  if (data.contactChannel === CUSTOMER_CHANNELS.BOTH) {
    if (!hasPhone) {
      ctx.addIssue({
        code:    'custom',
        path:    ['phone'],
        message: 'Phone is required when contactChannel is both',
      });
    }
    if (!hasInstagram) {
      ctx.addIssue({
        code:    'custom',
        path:    ['instagramHandle'],
        message: 'Instagram handle is required when contactChannel is both',
      });
    }
  }
};

// ─── Create Customer ──────────────────────────────────────────────────────────

export const createCustomerSchema = customerBaseSchema
  .superRefine(enforceChannelConsistency)
  .transform((data) => ({
    ...data,
    tags: dedupeTags(data.tags) ?? [],
  }));

// ─── Update Customer ──────────────────────────────────────────────────────────

export const updateCustomerSchema = customerBaseSchema
  .partial()
  .superRefine((data, ctx) => {
    if (!data.contactChannel) return;
    enforceChannelConsistency(data, ctx as unknown as ChannelConsistencyCtx);
  })
  .transform((data) => ({
    ...data,
    tags: dedupeTags(data.tags),
  }));

// ─── Customer ID ──────────────────────────────────────────────────────────────

export const customerIdSchema = z.object({
  id: z
    .string({ error: 'Customer ID is required' })
    .regex(/^[a-f\d]{24}$/i, 'Invalid customer ID'),
});

// ─── Get by Phone ─────────────────────────────────────────────────────────────
// Accepts any non-empty string — the service normalizes before querying.
// No digit count check here: partial inputs like "521332" are valid lookups.

export const getCustomerByPhoneSchema = z.object({
  phone: z.string().trim().min(1, 'Phone is required'),
});

// ─── List Customers ───────────────────────────────────────────────────────────

export const listCustomersSchema = z.object({
  page:           z.number().int().min(1).default(1),
  limit:          z.number().int().min(1).max(100).default(20),
  contactChannel: contactChannelEnum.optional(),
  tags:           z.array(customerTagEnum).optional(),
  isActive:       z.boolean().optional(),
  search:         z.string().trim().optional(),
});

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type CreateCustomerData = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerData = z.infer<typeof updateCustomerSchema>;
export type ListCustomersData  = z.infer<typeof listCustomersSchema>;