import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '#/config/env.js';
import { logger } from '#/config/logger.js';

export interface AuthUser {
  id: string;
  role: string;
}

export interface GraphQLContext {
  req: Request;
  res: Response;
  user: AuthUser | null;
}

const extractToken = (req: Request): string | null => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
};

const isAuthUser = (value: unknown): value is AuthUser => {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.id === 'string' &&
    typeof payload.role === 'string'
  );
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
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!isAuthUser(decoded)) {
      logger.warn('JWT payload shape is invalid');
      return { req, res, user: null };
    }
    return { req, res, user: decoded };
  } catch (err) {
    logger.warn({ err }, 'Invalid or expired token');
    return { req, res, user: null };
  }
};