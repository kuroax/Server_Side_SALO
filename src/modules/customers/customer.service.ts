import { CustomerModel } from '#/modules/customers/customer.model.js';
import {
  createCustomerSchema,
  updateCustomerSchema,
  customerIdSchema,
  getCustomerByPhoneSchema,
  listCustomersSchema,
} from '#/modules/customers/customer.validation.js';
import type {
  CreateCustomerData,
  UpdateCustomerData,
  ListCustomersData,
} from '#/modules/customers/customer.validation.js';
import type { CustomerResponse } from '#/modules/customers/customer.types.js';
import { CUSTOMER_GENDERS } from '#/modules/customers/customer.types.js';
import { logger } from '#/config/logger.js';
import {
  NotFoundError,
  BadRequestError,
} from '#/shared/errors/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type CustomerLike = {
  _id:             { toString(): string };
  name:            string;
  phone?:          string;
  instagramHandle?: string;
  contactChannel:  string;
  notes?:          string;
  tags:            string[];
  address?:        string;
  gender:          string;
  isActive:        boolean;
  createdAt:       Date | string;
  updatedAt:       Date | string;
};

// ─── Mapper ───────────────────────────────────────────────────────────────────

const toCustomerResponse = (doc: CustomerLike): CustomerResponse => ({
  id:              doc._id.toString(),
  name:            doc.name,
  phone:           doc.phone,
  instagramHandle: doc.instagramHandle,
  contactChannel:  doc.contactChannel as CustomerResponse['contactChannel'],
  notes:           doc.notes,
  tags:            doc.tags as CustomerResponse['tags'],
  address:         doc.address,
  gender:          (doc.gender ?? CUSTOMER_GENDERS.UNKNOWN) as CustomerResponse['gender'],
  isActive:        doc.isActive,
  createdAt: doc.createdAt instanceof Date
    ? doc.createdAt.toISOString()
    : new Date(doc.createdAt).toISOString(),
  updatedAt: doc.updatedAt instanceof Date
    ? doc.updatedAt.toISOString()
    : new Date(doc.updatedAt).toISOString(),
});

// ─── Normalization helpers ────────────────────────────────────────────────────
// Canonical phone format: digits only, no +, spaces, hyphens, or parentheses.
// Example: "+521 332 820 5715" → "5213328205715"
// Must be applied before any DB query or write involving phone.
// pre-save hooks normalize on create()/save() but NOT on findByIdAndUpdate —
// those paths must call normalizePhoneForLookup explicitly.

const normalizePhoneForLookup = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const digits = value.trim().replace(/\D+/g, '');
  return digits || undefined;
};

const normalizeInstagramHandle = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/^@/, '').trim().toLowerCase();
  return normalized || undefined;
};

// Normalizes phone and instagramHandle on any CreateCustomerData-shaped object.
// Used for both create and update paths — eliminates the need for two
// identical functions.
const normalizeCustomerData = (data: CreateCustomerData): CreateCustomerData => ({
  ...data,
  phone:           normalizePhoneForLookup(data.phone),
  instagramHandle: normalizeInstagramHandle(data.instagramHandle),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findCustomerByIdOrThrow = async (id: string) => {
  const doc = await CustomerModel.findById(id);
  if (!doc) throw new NotFoundError('Customer not found');
  return doc;
};

// ─── Duplicate Key Handling ───────────────────────────────────────────────────

const isMongoDuplicateKeyError = (
  error: unknown,
): error is { code: number; keyPattern?: Record<string, unknown> } =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: number }).code === 11000;

const mapDuplicateCustomerError = (error: unknown): never => {
  if (isMongoDuplicateKeyError(error)) {
    if (error.keyPattern?.phone) {
      throw new BadRequestError('A customer with this phone already exists');
    }
    if (error.keyPattern?.instagramHandle) {
      throw new BadRequestError('A customer with this Instagram handle already exists');
    }
    throw new BadRequestError('Customer already exists');
  }
  throw error;
};

// ─── Create ───────────────────────────────────────────────────────────────────
// CustomerModel.create() calls save() which triggers the pre-save hook.
// normalizeCustomerData runs first here for consistency — the hook is a
// safety net, not the primary normalization path.

export const createCustomer = async (input: unknown): Promise<CustomerResponse> => {
  const parsed: CreateCustomerData = createCustomerSchema.parse(input);
  const data = normalizeCustomerData(parsed);

  try {
    const doc = await CustomerModel.create({
      ...data,
      tags:     data.tags   ?? [],
      gender:   data.gender ?? CUSTOMER_GENDERS.UNKNOWN,
      isActive: true,
    });

    logger.info(
      {
        customerId:      doc._id.toString(),
        phone:           doc.phone,
        instagramHandle: doc.instagramHandle,
        contactChannel:  doc.contactChannel,
        gender:          doc.gender,
      },
      'Customer created',
    );

    return toCustomerResponse(doc.toObject() as CustomerLike);
  } catch (error) {
    return mapDuplicateCustomerError(error);
  }
};

// ─── Get by ID ────────────────────────────────────────────────────────────────

export const getCustomerById = async (input: unknown): Promise<CustomerResponse> => {
  const { id } = customerIdSchema.parse(input);
  const doc = await findCustomerByIdOrThrow(id);
  return toCustomerResponse(doc.toObject() as CustomerLike);
};

// ─── Get by Phone ─────────────────────────────────────────────────────────────
// Phone must be normalized before querying — the unique index stores digits only.
// +5213328205715 and 5213328205715 must resolve to the same document.

export const getCustomerByPhone = async (
  input: unknown,
): Promise<CustomerResponse | null> => {
  const { phone } = getCustomerByPhoneSchema.parse(input);

  const normalizedPhone = normalizePhoneForLookup(phone);
  if (!normalizedPhone) return null;

  const doc = await CustomerModel.findOne({ phone: normalizedPhone }).lean<CustomerLike | null>();
  return doc ? toCustomerResponse(doc) : null;
};

// ─── List ─────────────────────────────────────────────────────────────────────

export const listCustomers = async (input: unknown): Promise<{
  customers:  CustomerResponse[];
  total:      number;
  page:       number;
  limit:      number;
  totalPages: number;
}> => {
  const {
    page,
    limit,
    contactChannel,
    tags,
    isActive,
    search,
  }: ListCustomersData = listCustomersSchema.parse(input);

  const filter: Record<string, unknown> = {};

  if (contactChannel) filter.contactChannel = contactChannel;
  if (typeof isActive === 'boolean') filter.isActive = isActive;
  if (tags && tags.length > 0) filter.tags = { $in: tags };

  if (search) {
    const trimmedSearch        = search.trim();
    const escapedSearch        = escapeRegex(trimmedSearch);
    const normalizedPhoneSearch = normalizePhoneForLookup(trimmedSearch);

    filter.$or = [
      { name:            { $regex: escapedSearch, $options: 'i' } },
      { instagramHandle: { $regex: escapedSearch, $options: 'i' } },
      ...(normalizedPhoneSearch
        ? [{ phone: { $regex: escapeRegex(normalizedPhoneSearch), $options: 'i' } }]
        : []),
    ];
  }

  const skip = (page - 1) * limit;

  const [docs, total] = await Promise.all([
    CustomerModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<CustomerLike[]>(),
    CustomerModel.countDocuments(filter),
  ]);

  return {
    customers:  docs.map(toCustomerResponse),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
};

// ─── Update ───────────────────────────────────────────────────────────────────
// findByIdAndUpdate bypasses pre-save hooks — normalizeCustomerData must be
// called explicitly before writing. The $set uses the already-normalized values
// directly — no second normalization call needed.

export const updateCustomer = async (
  id: string,
  input: unknown,
): Promise<CustomerResponse> => {
  customerIdSchema.parse({ id });

  const patch: UpdateCustomerData = updateCustomerSchema.parse(input);

  if (Object.keys(patch).length === 0) {
    throw new BadRequestError('No fields provided for update');
  }

  const existing = await findCustomerByIdOrThrow(id);

  const merged = normalizeCustomerData({
  name:            patch.name                          ?? existing.name,
  phone:           patch.phone                         ?? existing.phone          ?? undefined,
  instagramHandle: patch.instagramHandle               ?? existing.instagramHandle ?? undefined,
  contactChannel:  patch.contactChannel                ?? existing.contactChannel,
  notes:           patch.notes                         ?? existing.notes          ?? undefined,
  tags:            patch.tags                          ?? existing.tags,
  address:         patch.address                       ?? existing.address        ?? undefined,
  gender:          patch.gender                        ?? existing.gender,
});

  const validatedCustomer = createCustomerSchema.parse(merged);

  try {
    const doc = await CustomerModel.findByIdAndUpdate(
      id,
      {
        $set: {
          name:            validatedCustomer.name,
          phone:           validatedCustomer.phone,
          instagramHandle: validatedCustomer.instagramHandle,
          contactChannel:  validatedCustomer.contactChannel,
          notes:           validatedCustomer.notes,
          tags:            validatedCustomer.tags,
          address:         validatedCustomer.address,
          gender:          validatedCustomer.gender,
        },
      },
      { new: true, runValidators: true },
    ).lean<CustomerLike | null>();

    if (!doc) throw new NotFoundError('Customer not found');

    logger.info(
      { customerId: id, contactChannel: doc.contactChannel, gender: doc.gender },
      'Customer updated',
    );

    return toCustomerResponse(doc);
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    return mapDuplicateCustomerError(error);
  }
};

// ─── Deactivate / Activate ────────────────────────────────────────────────────

export const deactivateCustomer = async (input: unknown): Promise<CustomerResponse> => {
  const { id } = customerIdSchema.parse(input);

  const doc = await CustomerModel.findByIdAndUpdate(
    id,
    { $set: { isActive: false } },
    { new: true },
  ).lean<CustomerLike | null>();

  if (!doc) throw new NotFoundError('Customer not found');

  logger.info({ customerId: id }, 'Customer deactivated');

  return toCustomerResponse(doc);
};

export const activateCustomer = async (input: unknown): Promise<CustomerResponse> => {
  const { id } = customerIdSchema.parse(input);

  const doc = await CustomerModel.findByIdAndUpdate(
    id,
    { $set: { isActive: true } },
    { new: true },
  ).lean<CustomerLike | null>();

  if (!doc) throw new NotFoundError('Customer not found');

  logger.info({ customerId: id }, 'Customer activated');

  return toCustomerResponse(doc);
};