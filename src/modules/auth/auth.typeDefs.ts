export const authTypeDefs = `
  # ─── Enums ──────────────────────────────────────────────────────────────────

  enum Role {
    owner
    admin
    sales
    inventory
    support
  }

  # ─── Types ──────────────────────────────────────────────────────────────────

  type User {
    id: ID!
    boutiqueId: ID!
    username: String!
    email: String
    role: Role!
    isActive: Boolean!
    notificationsEnabled: Boolean!
    createdAt: String!
    updatedAt: String!
    # Tenant display info — only populated by the me query (loaded from the
    # boutique document). Null on User objects returned by login/register.
    boutiqueName: String
    boutiqueSlug: String
  }

  type AuthPayload {
    accessToken: String!
    refreshToken: String!
    user: User!
  }

  type RefreshPayload {
    accessToken: String!
  }

  # ─── Inputs ─────────────────────────────────────────────────────────────────

  # boutiqueId is required only on the bootstrap call (first owner).
  # For subsequent registrations the resolver overrides this with the caller's
  # boutiqueId, so any client-supplied value here is ignored.
  input RegisterInput {
    boutiqueId: ID
    username: String!
    password: String!
    email: String
    role: Role!
  }

  input LoginInput {
    username: String!
    password: String!
  }

  input RefreshTokenInput {
    refreshToken: String!
  }

  input ChangePasswordInput {
    currentPassword: String!
    newPassword: String!
    confirmPassword: String!
  }

  # platform must be "ios" or "android" — validated server-side via Zod.
  input RegisterPushTokenInput {
    token: String!
    platform: String!
  }

  # ─── Queries ────────────────────────────────────────────────────────────────

  extend type Query {
    me: User
    # Returns all active team members. Owner and admin only.
    listUsers: [User!]!
  }

  # ─── Mutations ──────────────────────────────────────────────────────────────

  extend type Mutation {
    register(input: RegisterInput!): AuthPayload!
    login(input: LoginInput!): AuthPayload!
    refreshToken(input: RefreshTokenInput!): RefreshPayload!
    changePassword(input: ChangePasswordInput!): Boolean!
    # Toggles the caller's own push-notification preference.
    setNotificationsEnabled(enabled: Boolean!): Boolean!
    # Registers/refreshes a device push token for the caller (upsert by token).
    registerPushToken(input: RegisterPushTokenInput!): Boolean!
    # Removes a device push token from the caller (e.g. on logout/uninstall).
    unregisterPushToken(token: String!): Boolean!
    logout: Boolean!
    # Soft-deletes a team member (sets isActive: false). Owner and admin only.
    # Cannot deactivate yourself or the owner account.
    deactivateUser(id: ID!): Boolean!
  }
`;