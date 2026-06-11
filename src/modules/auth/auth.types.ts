import type { Types } from 'mongoose';

// ─── Roles ────────────────────────────────────────────────────────────────────

export const ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  SALES: 'sales',
  INVENTORY: 'inventory',
  SUPPORT: 'support',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

// ─── User ─────────────────────────────────────────────────────────────────────

export type IUser = {
  boutiqueId: Types.ObjectId;
  username: string;
  email?: string;
  password: string;
  role: Role;
  isActive: boolean;
};

// createdAt and updatedAt serialized as ISO strings before returning to client
export type SafeUser = {
  id: string;
  boutiqueId: string;
  username: string;
  email?: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  // Tenant display info — populated by login/register/me from the boutique doc.
  // Null when the boutique cannot be resolved.
  boutiqueName?: string | null;
  boutiqueSlug?: string | null;
};

// ─── Auth Payloads ────────────────────────────────────────────────────────────

export type AuthPayload = {
  accessToken: string;
  refreshToken: string;
  user: SafeUser;
};

export type RefreshPayload = {
  accessToken: string;
};

export type JWTPayload = {
  id: string;
  role: Role;
  boutiqueId: string;
};