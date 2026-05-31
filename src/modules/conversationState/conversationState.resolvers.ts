import {
  getConversation,
  listConversations,
  setConversationMode,
} from "./conversationState.service.js";
import { setModeInputSchema } from "./conversationState.validation.js";
import type {
  ConversationMode,
  ConversationStateDTO,
} from "./conversationState.types.js";
import type { GraphQLContext } from "#/graphql/context.js";
import type { Role } from "#/modules/auth/auth.types.js";
import { requireAuth, requireRoles } from "#/shared/utils/auth.guards.js";

// ─── Role constants ───────────────────────────────────────────────────────────

const CONVERSATION_READERS: Role[] = ["owner", "admin", "sales", "support"];
const CONVERSATION_WRITERS: Role[] = ["owner", "admin", "support"];

// ─── Resolvers ────────────────────────────────────────────────────────────────
// boutiqueId is always read from context.user — never accepted as an argument.

export const conversationStateResolvers = {
  Query: {
    conversation: (
      _parent: unknown,
      args: { customerPhone: string },
      context: GraphQLContext,
    ): Promise<ConversationStateDTO | null> => {
      requireAuth(context);
      requireRoles(context, CONVERSATION_READERS);
      return getConversation(context.user.boutiqueId, args.customerPhone);
    },

    conversations: (
      _parent: unknown,
      args: { mode?: ConversationMode },
      context: GraphQLContext,
    ): Promise<ConversationStateDTO[]> => {
      requireAuth(context);
      requireRoles(context, CONVERSATION_READERS);
      return listConversations(context.user.boutiqueId, args.mode);
    },
  },

  Mutation: {
    setConversationMode: (
      _parent: unknown,
      args: {
        customerPhone: string;
        mode: ConversationMode;
        autoResumeMinutes?: number;
      },
      context: GraphQLContext,
    ): Promise<ConversationStateDTO> => {
      requireAuth(context);
      requireRoles(context, CONVERSATION_WRITERS);
      const input = setModeInputSchema.parse(args);
      return setConversationMode(
        context.user.boutiqueId,
        input.customerPhone,
        input.mode,
        input.autoResumeMinutes,
      );
    },

    resumeAI: (
      _parent: unknown,
      args: { customerPhone: string },
      context: GraphQLContext,
    ): Promise<ConversationStateDTO> => {
      requireAuth(context);
      requireRoles(context, CONVERSATION_WRITERS);
      return setConversationMode(
        context.user.boutiqueId,
        args.customerPhone,
        "ai",
      );
    },
  },
};
