import bcrypt from 'bcryptjs';
import jwt, { TokenExpiredError, JsonWebTokenError } from 'jsonwebtoken';

import {
  JWT_SECRET,
  JWT_EXPIRES_IN,
  JWT_REFRESH_SECRET,
  JWT_REFRESH_EXPIRES_IN,
  BCRYPT_SALT_ROUNDS,
} from '#/config/env.js';
import type { JWTPayload, AuthPayload, SafeUser } from '#/modules/auth/auth.types.js';
import type { IUserDocument } from '#/modules/auth/auth.model.js';

// ─── Password Helpers ─────────────────────────────────────────────────────────

export const hashPassword = async (plainPassword: string): Promise<string> => {
  return bcrypt.hash(plainPassword, BCRYPT_SALT_ROUNDS);
};

export const comparePassword = async (
  plainPassword: string,
  hashedPassword: string,
): Promise<boolean> => {
  return bcrypt.compare(plainPassword, hashedPassword);
};

// ─── JWT Type Guard ───────────────────────────────────────────────────────────

const isJWTPayload = (value: unknown): value is JWTPayload => {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.id === 'string' &&
    typeof payload.role === 'string'
  );
};

// ─── Token Helpers ────────────────────────────────────────────────────────────

export const signAccessToken = (payload: JWTPayload): string => {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
};

export const signRefreshToken = (payload: JWTPayload): string => {
  return jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
};

const verifyTokenBase = (token: string, secret: string): JWTPayload => {
  try {
    const decoded = jwt.verify(token, secret);
    if (!isJWTPayload(decoded)) {
      throw new Error('MALFORMED_PAYLOAD');
    }
    return decoded;
  } catch (error) {
    if (error instanceof TokenExpiredError) throw new Error('TOKEN_EXPIRED');
    if (error instanceof JsonWebTokenError) throw new Error('TOKEN_INVALID');
    throw error;
  }
};

export const verifyAccessToken = (token: string): JWTPayload => {
  return verifyTokenBase(token, JWT_SECRET);
};

export const verifyRefreshToken = (token: string): JWTPayload => {
  return verifyTokenBase(token, JWT_REFRESH_SECRET);
};

// ─── User Mapper ──────────────────────────────────────────────────────────────

export const toAuthUser = (user: IUserDocument): SafeUser => ({
  id: user._id.toString(),
  username: user.username,
  email: user.email,
  role: user.role,
  isActive: user.isActive,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

// ─── Token Pair ───────────────────────────────────────────────────────────────

export const generateTokens = (
  payload: JWTPayload,
): Pick<AuthPayload, 'accessToken' | 'refreshToken'> => ({
  accessToken: signAccessToken(payload),
  refreshToken: signRefreshToken(payload),
});