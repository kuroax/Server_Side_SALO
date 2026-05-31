import {
  addNoteToProspect,
  advanceProspectStage,
  convertProspectToCustomer,
  getPipelineSummary,
  getProspectByPhone,
  getProspectsByBoutique,
} from "./prospect.service.js";
import {
  addNoteSchema,
  advanceStageSchema,
} from "./prospect.validation.js";
import type {
  PipelineSummary,
  ProspectDTO,
  ProspectStage,
} from "./prospect.types.js";
import { objectIdSchema } from "#/shared/validation/common.validation.js";
import type { GraphQLContext } from "#/graphql/context.js";
import type { Role } from "#/modules/auth/auth.types.js";
import { requireAuth, requireRoles } from "#/shared/utils/auth.guards.js";

// ─── Role constants ───────────────────────────────────────────────────────────

const PROSPECT_READERS: Role[] = ["owner", "admin", "sales", "support"];
const PROSPECT_WRITERS: Role[] = ["owner", "admin", "sales"];

// ─── Resolvers ────────────────────────────────────────────────────────────────
// boutiqueId is always read from context.user — never accepted as an argument.

export const prospectResolvers = {
  Query: {
    prospects: (
      _parent: unknown,
      args: { stage?: ProspectStage },
      context: GraphQLContext,
    ): Promise<ProspectDTO[]> => {
      requireAuth(context);
      requireRoles(context, PROSPECT_READERS);
      return getProspectsByBoutique(context.user.boutiqueId, args.stage);
    },

    prospect: (
      _parent: unknown,
      args: { customerPhone: string },
      context: GraphQLContext,
    ): Promise<ProspectDTO | null> => {
      requireAuth(context);
      requireRoles(context, PROSPECT_READERS);
      return getProspectByPhone(context.user.boutiqueId, args.customerPhone);
    },

    pipelineSummary: (
      _parent: unknown,
      _args: unknown,
      context: GraphQLContext,
    ): Promise<PipelineSummary> => {
      requireAuth(context);
      requireRoles(context, PROSPECT_READERS);
      return getPipelineSummary(context.user.boutiqueId);
    },
  },

  Mutation: {
    advanceProspectStage: (
      _parent: unknown,
      args: { customerPhone: string; stage: ProspectStage; note?: string },
      context: GraphQLContext,
    ): Promise<ProspectDTO> => {
      requireAuth(context);
      requireRoles(context, PROSPECT_WRITERS);
      const input = advanceStageSchema.parse({
        ...args,
        boutiqueId: context.user.boutiqueId,
      });
      return advanceProspectStage(
        context.user.boutiqueId,
        input.customerPhone,
        input.stage as ProspectStage,
        input.note,
      );
    },

    addProspectNote: (
      _parent: unknown,
      args: { customerPhone: string; note: string },
      context: GraphQLContext,
    ): Promise<ProspectDTO> => {
      requireAuth(context);
      requireRoles(context, PROSPECT_WRITERS);
      const input = addNoteSchema.parse({
        ...args,
        boutiqueId: context.user.boutiqueId,
      });
      return addNoteToProspect(
        context.user.boutiqueId,
        input.customerPhone,
        input.note,
      );
    },

    convertToCustomer: (
      _parent: unknown,
      args: { customerPhone: string; customerId: string },
      context: GraphQLContext,
    ): Promise<ProspectDTO> => {
      requireAuth(context);
      requireRoles(context, PROSPECT_WRITERS);
      const customerId = objectIdSchema.parse(args.customerId);
      return convertProspectToCustomer(
        context.user.boutiqueId,
        args.customerPhone,
        customerId,
      );
    },
  },
};
