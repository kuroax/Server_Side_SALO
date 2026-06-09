import {
  findBoutiqueById,
  listBoutiques,
  updateBoutique,
  setBoutiqueGlobalMode,
  updateAgentConfig,
  rollbackAgentConfig,
  type BoutiqueLean,
} from "#/modules/boutiques/boutique.service.js";
import { invalidateBoutiqueCache } from "#/modules/boutiques/boutique.cache.js";
import type { GraphQLContext } from "#/graphql/context.js";
import type { Role } from "#/modules/auth/auth.types.js";
import { requireAuth, requireRoles } from "#/shared/utils/auth.guards.js";
import { NotFoundError } from "#/shared/errors/index.js";

// ─── Role constants ───────────────────────────────────────────────────────────

const BOUTIQUE_READERS: Role[] = ["owner", "admin"];
const BOUTIQUE_WRITERS: Role[] = ["owner"];
// Owners and admins may edit the AI personality; only owners may roll back.
const AGENT_CONFIG_WRITERS: Role[] = ["owner", "admin"];
const AGENT_CONFIG_ROLLBACK: Role[] = ["owner"];

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

// ─── Agent config (owner-app AI personality editor) ─────────────────────────────
// boutiqueId ALWAYS comes from context.user (JWT) — never from client args.
// previousAgentConfig (rollback snapshot) and salesInstructions (legacy blob)
// are never returned to the client.

type AgentConfigGraphQL = {
  agentName: string;
  categoryDescription: string;
  phrases: BoutiqueLean["agentConfig"]["phrases"] | null;
  discoveryCategories: string | null;
  upsellRules: string | null;
  sizeGuide: string | null;
  brandKnowledge: string | null;
  customInstructions: string | null;
  personalityNotes: string | null;
  version: number | null;
  updatedAt: string | null;
};

const toAgentConfigGraphQL = (doc: BoutiqueLean): AgentConfigGraphQL => {
  const ac = doc.agentConfig;
  return {
    agentName: ac.agentName,
    categoryDescription: ac.categoryDescription,
    phrases: ac.phrases ?? null,
    discoveryCategories: ac.discoveryCategories ?? null,
    upsellRules: ac.upsellRules ?? null,
    sizeGuide: ac.sizeGuide ?? null,
    brandKnowledge: ac.brandKnowledge ?? null,
    customInstructions: ac.customInstructions ?? null,
    personalityNotes: ac.personalityNotes ?? null,
    version: doc.agentConfigVersion ?? null,
    updatedAt: doc.agentConfigUpdatedAt
      ? new Date(doc.agentConfigUpdatedAt).toISOString()
      : null,
  };
};

export const agentConfigResolvers = {
  Query: {
    myAgentConfig: async (
      _parent: unknown,
      _args: unknown,
      context: GraphQLContext,
    ): Promise<AgentConfigGraphQL | null> => {
      requireAuth(context);
      const doc = await findBoutiqueById(context.user.boutiqueId);
      return doc ? toAgentConfigGraphQL(doc) : null;
    },
  },

  Mutation: {
    updateAgentConfig: async (
      _parent: unknown,
      args: { input: unknown },
      context: GraphQLContext,
    ): Promise<AgentConfigGraphQL> => {
      requireAuth(context);
      requireRoles(context, AGENT_CONFIG_WRITERS);
      const doc = await updateAgentConfig(
        context.user.boutiqueId,
        args.input,
        context.user.id,
      );
      if (!doc) {
        throw new NotFoundError("Boutique not found");
      }
      // Drop the cached config so the next WhatsApp message uses the new one.
      invalidateBoutiqueCache(context.user.boutiqueId);
      return toAgentConfigGraphQL(doc);
    },

    rollbackAgentConfig: async (
      _parent: unknown,
      _args: unknown,
      context: GraphQLContext,
    ): Promise<AgentConfigGraphQL> => {
      requireAuth(context);
      requireRoles(context, AGENT_CONFIG_ROLLBACK);
      const doc = await rollbackAgentConfig(
        context.user.boutiqueId,
        context.user.id,
      );
      if (!doc) {
        throw new NotFoundError("Boutique not found");
      }
      invalidateBoutiqueCache(context.user.boutiqueId);
      return toAgentConfigGraphQL(doc);
    },
  },
};
