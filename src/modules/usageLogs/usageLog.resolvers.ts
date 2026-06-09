import { getUsageSummary } from "./usageLog.service.js";
import type { GraphQLContext } from "#/graphql/context.js";
import { requireAuth } from "#/shared/utils/auth.guards.js";

// ─── Resolvers ────────────────────────────────────────────────────────────────
// boutiqueId is always read from context.user — never accepted as an argument.
// Owners and admins both see their own boutique's usage, never another
// boutique's, so no additional role check is needed beyond authentication.

export const usageLogResolvers = {
  Query: {
    usageSummary: (
      _parent: unknown,
      args: { months?: number },
      context: GraphQLContext,
    ) => {
      requireAuth(context);
      return getUsageSummary(context.user.boutiqueId, args.months ?? 1);
    },
  },
};
