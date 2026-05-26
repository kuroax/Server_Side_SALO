import {
  findBoutiqueById,
  listBoutiques,
  updateBoutique,
  setBoutiqueGlobalMode,
  type BoutiqueLean,
} from "#/modules/boutiques/boutique.service.js";
import type { GraphQLContext } from "#/graphql/context.js";
import type { Role } from "#/modules/auth/auth.types.js";
import { requireRoles } from "#/shared/utils/auth.guards.js";

// ─── Role constants ───────────────────────────────────────────────────────────

const BOUTIQUE_READERS: Role[] = ["owner", "admin"];
const BOUTIQUE_WRITERS: Role[] = ["owner"];

// ─── Safe shape ───────────────────────────────────────────────────────────────
// Strips accessToken before returning to the GraphQL layer. accessToken is the
// Meta permanent token and must never leave the backend — boutique.model.ts and
// CLAUDE.md both flag this as a non-negotiable rule.

type SafeBoutique = Omit<BoutiqueLean, "accessToken"> & {
  id: string;
};

const toSafeBoutique = (doc: BoutiqueLean): SafeBoutique => {
  const { accessToken: _omit, _id, ...rest } = doc;
  void _omit;
  return {
    ...rest,
    _id,
    id: _id.toString(),
  };
};

// ─── Resolvers ────────────────────────────────────────────────────────────────

export const boutiqueResolvers = {
  Query: {
    boutique: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<SafeBoutique | null> => {
      requireRoles(context, BOUTIQUE_READERS);
      const doc = await findBoutiqueById(args.id);
      return doc ? toSafeBoutique(doc) : null;
    },

    boutiques: async (
      _parent: unknown,
      _args: unknown,
      context: GraphQLContext,
    ): Promise<SafeBoutique[]> => {
      requireRoles(context, BOUTIQUE_READERS);
      const docs = await listBoutiques();
      return docs.map(toSafeBoutique);
    },
  },

  Mutation: {
    updateBoutique: async (
      _parent: unknown,
      args: { id: string; input: unknown },
      context: GraphQLContext,
    ): Promise<SafeBoutique | null> => {
      requireRoles(context, BOUTIQUE_WRITERS);
      const doc = await updateBoutique(args.id, args.input);
      return doc ? toSafeBoutique(doc) : null;
    },

    setBoutiqueGlobalMode: async (
      _parent: unknown,
      args: { id: string; mode: string },
      context: GraphQLContext,
    ): Promise<SafeBoutique | null> => {
      requireRoles(context, BOUTIQUE_WRITERS);
      const doc = await setBoutiqueGlobalMode(args.id, { mode: args.mode });
      return doc ? toSafeBoutique(doc) : null;
    },
  },
};
