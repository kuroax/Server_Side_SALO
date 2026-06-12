import type { Request, Response } from 'express';
import DataLoader from 'dataloader';
import { logger } from '#/config/logger.js';
import { verifyAccessToken } from '#/modules/auth/auth.utils.js';
import type { JWTPayload } from '#/modules/auth/auth.types.js';
import { findCustomerNamesByIds } from '#/modules/customers/customer.service.js';

export interface GraphQLContext {
  req: Request;
  res: Response;
  user: JWTPayload | null;
  // Per-request batch loader: customerId -> customer name (or null if the
  // customer is missing, soft-deleted, or belongs to another tenant). Scoped to
  // a single request so its cache can never leak names across boutiques.
  customerNameLoader: DataLoader<string, string | null>;
}

const extractToken = (req: Request): string | null => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
};

// Builds a customerId -> name loader scoped to the caller's boutique. The
// boutiqueId is read from the verified JWT — NEVER from order/client data — so a
// foreign customerId can never resolve another tenant's customer name. Returns a
// no-op loader (always null) for unauthenticated requests; resolvers that use it
// are already behind auth guards, so this only protects against misuse.
const buildCustomerNameLoader = (
  boutiqueId: string | null,
): DataLoader<string, string | null> =>
  new DataLoader<string, string | null>(async (ids) => {
    if (!boutiqueId) return ids.map(() => null);
    const names = await findCustomerNamesByIds(ids, boutiqueId);
    // DataLoader requires an output array aligned 1:1 with the input keys.
    return ids.map((id) => names.get(id) ?? null);
  });

export const createGraphQLContext = async ({
  req,
  res,
}: {
  req: Request;
  res: Response;
}): Promise<GraphQLContext> => {
  const token = extractToken(req);

  if (!token) {
    return {
      req,
      res,
      user: null,
      customerNameLoader: buildCustomerNameLoader(null),
    };
  }

  try {
    const decoded = verifyAccessToken(token);
    return {
      req,
      res,
      user: decoded,
      customerNameLoader: buildCustomerNameLoader(decoded.boutiqueId),
    };
  } catch (err) {
    logger.warn({ err }, 'Invalid or expired token');
    return {
      req,
      res,
      user: null,
      customerNameLoader: buildCustomerNameLoader(null),
    };
  }
};
