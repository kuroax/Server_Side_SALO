import { Types } from 'mongoose';
import { z } from 'zod';

/**
 * Validates that a value is a string and a valid MongoDB ObjectId format.
 * Use this in every module validation file instead of redefining locally.
 * Prevents malformed IDs from travelling into the service layer and
 * causing Mongoose CastErrors.
 */
export const objectIdSchema = z
  .string({ error: 'Must be a string' })
  .trim()
  .refine(v => Types.ObjectId.isValid(v), { error: 'Invalid ID' });