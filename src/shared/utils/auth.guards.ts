import { AuthenticationError, AuthorizationError } from '#/shared/errors/index.js';
import type { GraphQLContext } from '#/graphql/context.js';
import type { Role } from '#/modules/auth/auth.types.js';

/**
 * Asserts that the request is authenticated.
 * Throws AuthenticationError if context.user is absent.
 */
export function requireAuth(context: GraphQLContext): void {
  if (!context.user) {
    throw new AuthenticationError('Authentication required.');
  }
}

/**
 * Asserts that the authenticated user holds one of the allowed roles.
 * Calls requireAuth internally — no need to call both.
 */
export function requireRoles(context: GraphQLContext, allowedRoles: Role[]): void {
  requireAuth(context);
  if (!allowedRoles.includes(context.user!.role)) {
    throw new AuthorizationError('You do not have permission to perform this action.');
  }
}