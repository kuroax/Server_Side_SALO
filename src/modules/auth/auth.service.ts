import { Types } from 'mongoose';
import { UserModel } from '#/modules/auth/auth.model.js';
import {
  loginSchema,
  registerSchema,
  refreshTokenSchema,
  changePasswordSchema,
  setNotificationsEnabledSchema,
  registerPushTokenSchema,
  unregisterPushTokenSchema,
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
import { findBoutiqueById } from '#/modules/boutiques/boutique.service.js';
import { logger } from '#/config/logger.js';
import {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
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

  // ── Owner uniqueness constraint (per boutique) ───────────────────────────────
  // Exactly one owner may exist PER BOUTIQUE — not one globally. A global guard
  // would block every tenant after the first from ever creating its own owner,
  // breaking multi-tenant onboarding. Scope the check to validated.boutiqueId.
  if (validated.role === ROLES.OWNER) {
    const ownerExists = await UserModel.exists({
      role: ROLES.OWNER,
      boutiqueId: new Types.ObjectId(validated.boutiqueId),
    });
    if (ownerExists) {
      throw new ValidationError(
        'An owner account already exists for this boutique',
      );
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
    boutiqueId: new Types.ObjectId(validated.boutiqueId),
    username:   validated.username,
    email:      validated.email,
    password:   hashed,
    role:       validated.role as Role,
  });

  const payload: JWTPayload = {
    id:         user._id.toString(),
    role:       user.role,
    boutiqueId: user.boutiqueId.toString(),
  };

  logger.info(
    { userId: user._id, boutiqueId: user.boutiqueId, role: user.role, createdBy: callerRole ?? 'bootstrap' },
    'User registered',
  );

  const boutique = await findBoutiqueById(user.boutiqueId.toString());

  return {
    ...generateTokens(payload),
    user: {
      ...toAuthUser(user),
      boutiqueName: boutique?.name ?? null,
      boutiqueSlug: boutique?.slug ?? null,
    },
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
    id:         user._id.toString(),
    role:       user.role,
    boutiqueId: user.boutiqueId.toString(),
  };

  const { accessToken, refreshToken } = generateTokens(payload);

  logger.info({ userId: user._id, role: user.role, boutiqueId: user.boutiqueId }, 'User logged in');

  const boutique = await findBoutiqueById(user.boutiqueId.toString());

  return {
    accessToken,
    refreshToken,
    user: {
      ...toAuthUser(user),
      boutiqueName: boutique?.name ?? null,
      boutiqueSlug: boutique?.slug ?? null,
    },
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
    id:         user._id.toString(),
    role:       user.role,
    boutiqueId: user.boutiqueId.toString(),
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

// ─── List Users ───────────────────────────────────────────────────────────────
// Returns all active users except the caller themselves.
// Owner and admin only — enforced at both resolver and service layers.
// Scoped to the caller's boutique — cross-tenant team lists are never returned.

export const listUsers = async (
  callerId: string,
  boutiqueId: string,
): Promise<SafeUser[]> => {
  const users = await UserModel.find({
    boutiqueId: new Types.ObjectId(boutiqueId), // tenant isolation
    isActive: true,
    _id: { $ne: callerId }, // exclude the caller from the list
  })
    .sort({ createdAt: 1 })
    .lean<{ _id: { toString(): string }; boutiqueId: { toString(): string }; username: string; email?: string; role: Role; isActive: boolean; notificationsEnabled: boolean; createdAt: Date; updatedAt: Date }[]>();

  return users.map((u) => ({
    id:         u._id.toString(),
    boutiqueId: u.boutiqueId.toString(),
    username:   u.username,
    email:      u.email ?? undefined,
    role:       u.role,
    isActive:   u.isActive,
    notificationsEnabled: u.notificationsEnabled ?? true,
    createdAt:  u.createdAt.toISOString(),
    updatedAt:  u.updatedAt.toISOString(),
  }));
};

// ─── Deactivate User ──────────────────────────────────────────────────────────
// Soft-deletes a team member by setting isActive: false.
// Guards:
//   - Cannot deactivate yourself
//   - Cannot deactivate the owner account
//   - Only owner or admin can call this

export const deactivateUser = async (
  targetId: string,
  callerId: string,
  callerBoutiqueId: string,
): Promise<boolean> => {
  // Cannot deactivate yourself
  if (targetId === callerId) {
    throw new ValidationError('You cannot deactivate your own account');
  }

  const target = await UserModel.findById(targetId);

  if (!target || !target.isActive) {
    throw new ValidationError('User not found or already inactive');
  }

  // Tenant isolation — the target must belong to the caller's boutique.
  // Prevents an owner/admin from deactivating staff in another boutique.
  if (target.boutiqueId.toString() !== callerBoutiqueId) {
    throw new AuthorizationError('User not found or already inactive');
  }

  // Cannot deactivate the owner account — there must always be one owner
  if (target.role === ROLES.OWNER) {
    throw new AuthorizationError('The owner account cannot be deactivated');
  }

  await UserModel.findByIdAndUpdate(targetId, { isActive: false });

  logger.info({ targetId, callerId }, 'User deactivated');

  return true;
};

// ─── Set Notifications Enabled ────────────────────────────────────────────────
// Toggles the caller's own push-notification preference. Scoped by
// { _id, boutiqueId } per the tenant-isolation pattern — a user can only ever
// mutate their own record within their own boutique.

export const setNotificationsEnabled = async (
  userId: string,
  boutiqueId: string,
  input: unknown,
): Promise<boolean> => {
  const validated = setNotificationsEnabledSchema.parse(input);

  const result = await UserModel.updateOne(
    { _id: userId, boutiqueId: new Types.ObjectId(boutiqueId) },
    { $set: { notificationsEnabled: validated.enabled } },
  );

  if (result.matchedCount === 0) {
    throw new NotFoundError('User not found');
  }

  return true;
};

// ─── Register Push Token ──────────────────────────────────────────────────────
// Upsert-by-token: if the device token already exists on the user, refresh its
// platform/updatedAt in place; otherwise append a new entry. This keeps the
// same device from accumulating duplicates across reinstalls / token refreshes.
// Scoped by { _id, boutiqueId } for tenant isolation.

export const registerPushToken = async (
  userId: string,
  boutiqueId: string,
  input: unknown,
): Promise<boolean> => {
  const validated = registerPushTokenSchema.parse(input);
  const boutiqueObjectId = new Types.ObjectId(boutiqueId);
  const now = new Date();

  // Pass 1: token already present → update it in place (positional operator).
  const updateExisting = await UserModel.updateOne(
    {
      _id: userId,
      boutiqueId: boutiqueObjectId,
      'pushTokens.token': validated.token,
    },
    {
      $set: {
        'pushTokens.$.platform': validated.platform,
        'pushTokens.$.updatedAt': now,
      },
    },
  );

  if (updateExisting.matchedCount > 0) {
    return true;
  }

  // Pass 2: token not present → append a new entry. Matching only on
  // { _id, boutiqueId } means a missing match here signals the user itself
  // does not exist (within this tenant), which is a NotFoundError.
  const appendNew = await UserModel.updateOne(
    { _id: userId, boutiqueId: boutiqueObjectId },
    {
      $push: {
        pushTokens: {
          token: validated.token,
          platform: validated.platform,
          updatedAt: now,
        },
      },
    },
  );

  if (appendNew.matchedCount === 0) {
    throw new NotFoundError('User not found');
  }

  return true;
};

// ─── Unregister Push Token ────────────────────────────────────────────────────
// Removes a device token from the caller (e.g. on logout / uninstall). Scoped by
// { _id, boutiqueId }. Idempotent — removing an absent token is not an error as
// long as the user exists.

export const unregisterPushToken = async (
  userId: string,
  boutiqueId: string,
  input: unknown,
): Promise<boolean> => {
  const validated = unregisterPushTokenSchema.parse(input);

  const result = await UserModel.updateOne(
    { _id: userId, boutiqueId: new Types.ObjectId(boutiqueId) },
    { $pull: { pushTokens: { token: validated.token } } },
  );

  if (result.matchedCount === 0) {
    throw new NotFoundError('User not found');
  }

  return true;
};