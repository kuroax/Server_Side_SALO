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

// ─── Base Schema ──────────────────────────────────────────────────────────────

const customerBaseSchema = z.object({
  name: z
    .string({ error: 'Name is required' })
    .trim()
    .min(1, 'Name cannot be empty')
    .max(100, 'Name is too long'),

  phone: z
    .string()
    .trim()
    .min(7, 'Phone number is too short')
    .max(20, 'Phone number is too long')
    .optional(),

  instagramHandle: z
    .string()
    .trim()
    .min(1, 'Instagram handle cannot be empty')
    .max(30, 'Instagram handle is too long')
    .transform((v) => v.replace(/^@/, '').toLowerCase())
    .optional(),

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

  // Defaults to 'unknown' — set manually in the app or inferred from conversation
  gender: customerGenderEnum.default(CUSTOMER_GENDERS.UNKNOWN),
});

// ─── Channel/Contact Consistency ──────────────────────────────────────────────

const enforceChannelConsistency = <
  T extends {
    phone?: string;
    instagramHandle?: string;
    contactChannel?: string;
  },
>(
  data: T,
  ctx: z.RefinementCtx,
) => {
  if (!data.contactChannel) return;

  if (data.contactChannel === CUSTOMER_CHANNELS.WHATSAPP && !data.phone) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['phone'],
      message: 'Phone is required when contactChannel is whatsapp',
    });
  }

  if (
    data.contactChannel === CUSTOMER_CHANNELS.INSTAGRAM &&
    !data.instagramHandle
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['instagramHandle'],
      message: 'Instagram handle is required when contactChannel is instagram',
    });
  }

  if (data.contactChannel === CUSTOMER_CHANNELS.BOTH) {
    if (!data.phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['phone'],
        message: 'Phone is required when contactChannel is both',
      });
    }
    if (!data.instagramHandle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instagramHandle'],
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
    enforceChannelConsistency(data, ctx);
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

export const getCustomerByPhoneSchema = z.object({
  phone: z.string().trim().min(1, 'Phone is required'),
});

// ─── List Customers ───────────────────────────────────────────────────────────

export const listCustomersSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  contactChannel: contactChannelEnum.optional(),
  tags: z.array(customerTagEnum).optional(),
  isActive: z.boolean().optional(),
  search: z.string().trim().optional(),
});

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type CreateCustomerData = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerData = z.infer<typeof updateCustomerSchema>;
export type ListCustomersData = z.infer<typeof listCustomersSchema>;