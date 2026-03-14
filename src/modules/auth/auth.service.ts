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
//
// Bootstrap rule: the very first registration is free — creates the owner account.
// After that, ALL registrations require an authenticated owner or admin (enforced
// at the resolver layer). The service adds a second enforcement layer:
//
// 1. Only one owner may ever exist — prevents privilege escalation via API.
// 2. callerRole is passed from the resolver (context.user?.role ?? null).
//    If the service is ever called from a non-resolver context without a caller,
//    the privilege check still holds.

export const register = async (
  input: unknown,
  callerRole: Role | null = null,
): Promise<AuthPayload> => {
  const validated = registerSchema.parse(input);

  // ── Owner uniqueness constraint ──────────────────────────────────────────────
  // Exactly one owner may exist in the system. This is enforced here regardless
  // of who is calling — even another owner cannot create a second owner.
  if (validated.role === ROLES.OWNER) {
    const ownerExists = await UserModel.exists({ role: ROLES.OWNER });
    if (ownerExists) {
      throw new ValidationError('An owner account already exists');
    }
  }

  // ── Post-bootstrap caller check ──────────────────────────────────────────────
  // After the owner bootstrap, no account can be created without an authenticated
  // owner or admin. The resolver enforces this too, but the service is the
  // authoritative boundary — it must not trust that the resolver will always run.
  const userCount = await UserModel.countDocuments();
  if (userCount > 0 && callerRole !== ROLES.OWNER && callerRole !== ROLES.ADMIN) {
    throw new ValidationError('Only an owner or admin can create new accounts');
  }

  // ── Duplicate check ──────────────────────────────────────────────────────────
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
    id:   user._id.toString(),
    role: user.role,
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
  }).select('+password');

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
    id:   user._id.toString(),
    role: user.role,
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

  const user = await UserModel.findById(payload.id);

  if (!user || !user.isActive) {
    throw new AuthenticationError('User not found or inactive');
  }

  // TODO (Phase B): Check user.tokenVersion === payload.tokenVersion here
  // for full server-side revocation. Implement alongside frontend silent refresh.

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

  const user = await UserModel.findById(userId).select('+password');

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

  await UserModel.findByIdAndUpdate(userId, { password: hashed });

  // TODO (Phase B): Increment user.tokenVersion here to invalidate all
  // outstanding refresh tokens after a password change.

  logger.info({ userId }, 'Password changed successfully');
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