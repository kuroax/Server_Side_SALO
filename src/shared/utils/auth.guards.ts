import { AuthenticationError, AuthorizationError } from '#/shared/errors/index.js';
import type { GraphQLContext } from '#/graphql/context.js';
import type { Role } from '#/modules/auth/auth.types.js';

/**
 * Asserts that the request is authenticated.
 * Written as a TypeScript assertion function so callers get proper
 * type narrowing — context.user is guaranteed non-null after this call,
 * removing the need for ! in any caller.
 */
export function requireAuth(
  context: GraphQLContext,
): asserts context is GraphQLContext & { user: NonNullable<GraphQLContext['user']> } {
  if (!context.user) {
    throw new AuthenticationError('Authentication required.');
  }
}

/**
 * Asserts that the authenticated user holds one of the allowed roles.
 * Calls requireAuth internally — no need to call both.
 *
 * allowedRoles is readonly — authorization rules are configuration,
 * not mutable data.
 *
 * Fails fast on an empty allowedRoles array — an empty list is almost
 * always a misconfiguration and would silently deny everyone otherwise.
 */
export function requireRoles(
  context: GraphQLContext,
  allowedRoles: readonly Role[],
): void {
  if (allowedRoles.length === 0) {
    throw new Error('requireRoles must be called with at least one allowed role.');
  }

  requireAuth(context); // narrows context.user to non-null via assertion function

  if (!allowedRoles.includes(context.user.role)) { // no ! needed — narrowed above
    throw new AuthorizationError('You do not have permission to perform this action.');
  }
}