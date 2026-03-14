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
import { logger } from '#/config/logger.js';
import {
  NotFoundError,
  BadRequestError,
} from '#/shared/errors/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type CustomerLike = {
  _id: { toString(): string };
  name: string;
  phone?: string;
  instagramHandle?: string;
  contactChannel: string;
  notes?: string;
  tags: string[];
  address?: string;
  isActive: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
};

// ─── Mapper ───────────────────────────────────────────────────────────────────

const toCustomerResponse = (doc: CustomerLike): CustomerResponse => ({
  id: doc._id.toString(),
  name: doc.name,
  phone: doc.phone,
  instagramHandle: doc.instagramHandle,
  contactChannel: doc.contactChannel as CustomerResponse['contactChannel'],
  notes: doc.notes,
  tags: doc.tags as CustomerResponse['tags'],
  address: doc.address,
  isActive: doc.isActive,
  createdAt: doc.createdAt instanceof Date
    ? doc.createdAt.toISOString()
    : new Date(doc.createdAt).toISOString(),
  updatedAt: doc.updatedAt instanceof Date
    ? doc.updatedAt.toISOString()
    : new Date(doc.updatedAt).toISOString(),
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

export const createCustomer = async (input: unknown): Promise<CustomerResponse> => {
  const data: CreateCustomerData = createCustomerSchema.parse(input);

  try {
    const doc = await CustomerModel.create({
      ...data,
      tags: data.tags ?? [],
      isActive: true,
    });

    logger.info(
      {
        customerId: doc._id.toString(),
        phone: doc.phone,
        instagramHandle: doc.instagramHandle,
        contactChannel: doc.contactChannel,
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

// Returns null instead of throwing — "not found" is a normal bot scenario
export const getCustomerByPhone = async (
  input: unknown,
): Promise<CustomerResponse | null> => {
  const { phone } = getCustomerByPhoneSchema.parse(input);
  const doc = await CustomerModel.findOne({ phone }).lean<CustomerLike | null>();
  return doc ? toCustomerResponse(doc) : null;
};

// ─── List ─────────────────────────────────────────────────────────────────────

export const listCustomers = async (input: unknown): Promise<{
  customers: CustomerResponse[];
  total: number;
  page: number;
  limit: number;
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

  // $in — customer must have AT LEAST ONE of the specified tags
  if (tags && tags.length > 0) filter.tags = { $in: tags };

  // Search across name, phone, instagramHandle — regex escaped for safety
  if (search) {
    const escapedSearch = escapeRegex(search);
    filter.$or = [
      { name: { $regex: escapedSearch, $options: 'i' } },
      { phone: { $regex: escapedSearch, $options: 'i' } },
      { instagramHandle: { $regex: escapedSearch, $options: 'i' } },
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
    customers: docs.map(toCustomerResponse),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
};

// ─── Update ───────────────────────────────────────────────────────────────────

// Fetches existing customer and merges with patch before validating
// Ensures channel/contact consistency on final merged state
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

  // Merge existing + patch — validates final state, not just the patch
  const merged = {
    name: patch.name ?? existing.name,
    phone: patch.phone ?? existing.phone,
    instagramHandle: patch.instagramHandle ?? existing.instagramHandle,
    contactChannel: patch.contactChannel ?? existing.contactChannel,
    notes: patch.notes ?? existing.notes,
    tags: patch.tags ?? existing.tags,
    address: patch.address ?? existing.address,
  };

  // validatedCustomer — full merged state, not just the patch
  const validatedCustomer = createCustomerSchema.parse(merged);

  try {
    const doc = await CustomerModel.findByIdAndUpdate(
      id,
      {
        $set: {
          name: validatedCustomer.name,
          phone: validatedCustomer.phone,
          instagramHandle: validatedCustomer.instagramHandle,
          contactChannel: validatedCustomer.contactChannel,
          notes: validatedCustomer.notes,
          tags: validatedCustomer.tags,
          address: validatedCustomer.address,
        },
      },
      { new: true, runValidators: true },
    ).lean<CustomerLike | null>();

    if (!doc) throw new NotFoundError('Customer not found');

    logger.info({ customerId: id, contactChannel: doc.contactChannel }, 'Customer updated');

    return toCustomerResponse(doc);
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    return mapDuplicateCustomerError(error);
  }
};

// ─── Deactivate / Activate ────────────────────────────────────────────────────

// Soft deactivation — preferred over hard delete until order references are understood
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