import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '#/config/env.js';
import type { SafeUser, JWTPayload } from '#/modules/auth/auth.types.js';
import type { IUserDocument } from '#/modules/auth/auth.model.js';

// ─── Password ─────────────────────────────────────────────────────────────────

export const hashPassword = (password: string): Promise<string> => {
  return bcrypt.hash(password, 12);
};

export const comparePassword = (
  password: string,
  hash: string,
): Promise<boolean> => {
  return bcrypt.compare(password, hash);
};

// ─── Tokens ───────────────────────────────────────────────────────────────────

export const signAccessToken = (payload: JWTPayload): string => {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
};

export const signRefreshToken = (payload: JWTPayload): string => {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
};

export const verifyTokenBase = (
  token: string,
  secret: string,
): JWTPayload => {
  try {
    return jwt.verify(token, secret) as JWTPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new Error('Token expired');
    }
    if (err instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid token');
    }
    throw err;
  }
};

export const generateTokens = (payload: JWTPayload) => ({
  accessToken: signAccessToken(payload),
  refreshToken: signRefreshToken(payload),
});

// ─── Mapper ───────────────────────────────────────────────────────────────────

export const toAuthUser = (user: IUserDocument): SafeUser => ({
  id: user._id.toString(),
  username: user.username,
  email: user.email,
  role: user.role,
  isActive: user.isActive,
  createdAt: user.createdAt instanceof Date
    ? user.createdAt.toISOString()
    : new Date(user.createdAt).toISOString(),
  updatedAt: user.updatedAt instanceof Date
    ? user.updatedAt.toISOString()
    : new Date(user.updatedAt).toISOString(),
});