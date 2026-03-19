import { UserModel } from '#/modules/auth/auth.model.js';
import {
  loginSchema,
  registerSchema,
  refreshTokenSchema,
  changePasswordSchema,
} from '#/modules/auth/auth.validation.js';
import type {
  AuthPayload,
  RefreshPayload,
  JWTPayload,
  Role,
  SafeUser,
} from '#/modules/auth/auth.types.js';
import { ROLES } from '#/modules/auth/auth.types.js';
import {
  hashPassword,
  comparePassword,
  generateTokens,
  signAccessToken,
  verifyRefreshToken,
  toAuthUser,
} from '#/modules/auth/auth.utils.js';
import { logger } from '#/config/logger.js';
import {
  AuthenticationError,
  ValidationError,
} from '#/shared/errors/index.js';

// ─── Register ─────────────────────────────────────────────────────────────────

export const register = async (
  input: unknown,
  callerRole: Role | null = null,
): Promise<AuthPayload> => {
  const validated = registerSchema.parse(input);

  if (validated.role === ROLES.OWNER) {
    const ownerExists = await UserModel.exists({ role: ROLES.OWNER });
    if (ownerExists) {
      throw new ValidationError('An owner account already exists');
    }
  }

  const userCount = await UserModel.countDocuments();
  if (userCount > 0 && callerRole !== ROLES.OWNER && callerRole !== ROLES.ADMIN) {
    throw new ValidationError('Only an owner or admin can create new accounts');
  }

  const existingUser = await UserModel.findOne({
    $or: [
      { username: validated.username },
      ...(validated.email ? [{ email: validated.email }] : []),
    ],
  });

  if (existingUser) {
    if (existingUser.username === validated.username) {
      throw new ValidationError('Username is already taken');
    }
    throw new ValidationError('Email is already in use');
  }

  const hashed = await hashPassword(validated.password);

  const user = await UserModel.create({
    username: validated.username,
    email:    validated.email,
    password: hashed,
    role:     validated.role,
  });

  const payload: JWTPayload = {
    id:           user._id.toString(),
    role:         user.role,
    tokenVersion: 0,
  };

  logger.info(
    { userId: user._id, role: user.role, createdBy: callerRole ?? 'bootstrap' },
    'User registered',
  );

  return {
    ...generateTokens(payload),
    user: toAuthUser(user),
  };
};

// ─── Login ────────────────────────────────────────────────────────────────────

export const login = async (input: unknown): Promise<AuthPayload> => {
  const validated = loginSchema.parse(input);

  const user = await UserModel.findOne({
    username: validated.username,
    isActive: true,
  }).select('+password +tokenVersion');

  if (!user) {
    throw new AuthenticationError('Invalid credentials');
  }

  const isPasswordValid = await comparePassword(
    validated.password,
    user.password,
  );

  if (!isPasswordValid) {
    throw new AuthenticationError('Invalid credentials');
  }

  const payload: JWTPayload = {
    id:           user._id.toString(),
    role:         user.role,
    tokenVersion: user.tokenVersion,
  };

  const { accessToken, refreshToken } = generateTokens(payload);

  logger.info({ userId: user._id, role: user.role }, 'User logged in');

  return {
    accessToken,
    refreshToken,
    user: toAuthUser(user),
  };
};

// ─── Refresh Token ────────────────────────────────────────────────────────────

export const refreshToken = async (input: unknown): Promise<RefreshPayload> => {
  const validated = refreshTokenSchema.parse(input);

  let payload: JWTPayload;

  try {
    payload = verifyRefreshToken(validated.refreshToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid token';
    throw new AuthenticationError(message);
  }

  const user = await UserModel.findById(payload.id).select('+tokenVersion');

  if (!user || !user.isActive) {
    throw new AuthenticationError('User not found or inactive');
  }

  // Server-side revocation check — rejects tokens issued before logout or
  // password change. payload.tokenVersion may be undefined for old tokens
  // issued before this feature was deployed; treat those as invalid.
  if (payload.tokenVersion === undefined || payload.tokenVersion !== user.tokenVersion) {
    throw new AuthenticationError('Session expired. Please log in again.');
  }

  const accessToken = signAccessToken({
    id:   user._id.toString(),
    role: user.role,
  });

  logger.info({ userId: user._id }, 'Access token refreshed');

  return { accessToken };
};

// ─── Change Password ──────────────────────────────────────────────────────────

export const changePassword = async (
  userId: string,
  input: unknown,
): Promise<void> => {
  const validated = changePasswordSchema.parse(input);

  const user = await UserModel.findById(userId).select('+password +tokenVersion');

  if (!user || !user.isActive) {
    throw new AuthenticationError('User not found or inactive');
  }

  const isPasswordValid = await comparePassword(
    validated.currentPassword,
    user.password,
  );

  if (!isPasswordValid) {
    throw new AuthenticationError('Current password is incorrect');
  }

  const hashed = await hashPassword(validated.newPassword);

  // Increment tokenVersion alongside password update — invalidates all
  // outstanding refresh tokens issued before this change.
  await UserModel.findByIdAndUpdate(userId, {
    password: hashed,
    $inc:     { tokenVersion: 1 },
  });

  logger.info({ userId }, 'Password changed — tokenVersion incremented');
};

// ─── Logout ───────────────────────────────────────────────────────────────────
// Increments tokenVersion to invalidate all outstanding refresh tokens.
// The client is responsible for clearing its local tokens.

export const logoutUser = async (userId: string): Promise<void> => {
  await UserModel.findByIdAndUpdate(userId, {
    $inc: { tokenVersion: 1 },
  });

  logger.info({ userId }, 'User logged out — tokenVersion incremented');
};

// ─── Get Current User ─────────────────────────────────────────────────────────

export const getCurrentUser = async (
  userId: string,
): Promise<SafeUser | null> => {
  const user = await UserModel.findById(userId);

  if (!user || !user.isActive) {
    return null;
  }

  return toAuthUser(user);
};