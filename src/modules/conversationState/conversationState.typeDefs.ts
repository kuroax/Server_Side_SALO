export const conversationStateTypeDefs = `#graphql

  enum ConversationMode {
    ai
    human
    paused
  }

  type Conversation {
    id: ID!
    boutiqueId: ID!
    customerPhone: String!
    mode: ConversationMode!
    humanTookOverAt: String
    autoResumeAt: String
    lastMessageAt: String!
    messageCount: Int!
    isActive: Boolean!
  }

  extend type Query {
    conversation(customerPhone: String!): Conversation
    conversations(mode: ConversationMode): [Conversation!]!
  }

  extend type Mutation {
    setConversationMode(
      customerPhone: String!
      mode: ConversationMode!
      autoResumeMinutes: Int
    ): Conversation!

    resumeAI(customerPhone: String!): Conversation!
  }
`;
