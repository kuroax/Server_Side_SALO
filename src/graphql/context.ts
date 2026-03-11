import type { Request, Response } from 'express';
import { logger } from '#/config/logger.js';
import { verifyAccessToken } from '#/modules/auth/auth.utils.js';
import type { JWTPayload } from '#/modules/auth/auth.types.js';

export interface GraphQLContext {
  req: Request;
  res: Response;
  user: JWTPayload | null;
}

const extractToken = (req: Request): string | null => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
};

export const createGraphQLContext = async ({
  req,
  res,
}: {
  req: Request;
  res: Response;
}): Promise<GraphQLContext> => {
  const token = extractToken(req);

  if (!token) {
    return { req, res, user: null };
  }

  try {
    const decoded = verifyAccessToken(token);
    return { req, res, user: decoded };
  } catch (err) {
    logger.warn({ err }, 'Invalid or expired token');
    return { req, res, user: null };
  }
};