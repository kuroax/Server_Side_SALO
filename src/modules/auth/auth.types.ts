// ─── Roles ───────────────────────────────────────────────────────────────────

export const ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  SALES: 'sales',
  INVENTORY: 'inventory',
  SUPPORT: 'support',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

// ─── User ────────────────────────────────────────────────────────────────────

export interface IUser {
  _id: string;
  username: string;
  email?: string;
  password: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Auth Payloads ───────────────────────────────────────────────────────────

export interface LoginInput {
  username: string;
  password: string;
}

export interface RegisterInput {
  username: string;
  email?: string;
  password: string;
  role: Role;
}

export interface AuthPayload {
  accessToken: string;
  refreshToken: string;
  user: Omit<IUser, 'password'>;
}

export interface RefreshPayload {
  accessToken: string;
}

// ─── JWT ─────────────────────────────────────────────────────────────────────

export interface JWTPayload {
  id: string;
  role: Role;
}