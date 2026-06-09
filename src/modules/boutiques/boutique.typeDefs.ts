// GraphQL surface for owner-app editing of the AI agent personality.
// salesInstructions (legacy blob) and previousAgentConfig (rollback snapshot)
// are intentionally NOT exposed to the client.

export const boutiqueTypeDefs = `#graphql

  type AgentPhrases {
    paymentAck:        String
    orderConfirm:      String
    negativeSticker:   String
    affirmations:      String
    closings:          String
    emojiSet:          String
  }

  type AgentConfig {
    agentName:           String!
    categoryDescription: String!
    phrases:             AgentPhrases
    discoveryCategories: String
    upsellRules:         String
    sizeGuide:           String
    brandKnowledge:      String
    customInstructions:  String
    personalityNotes:    String
    version:             Int
    updatedAt:           String
  }

  input AgentPhrasesInput {
    paymentAck:        String
    orderConfirm:      String
    negativeSticker:   String
    affirmations:      String
    closings:          String
    emojiSet:          String
  }

  input UpdateAgentConfigInput {
    agentName:           String
    categoryDescription: String
    phrases:             AgentPhrasesInput
    discoveryCategories: String
    upsellRules:         String
    sizeGuide:           String
    brandKnowledge:      String
    customInstructions:  String
    personalityNotes:    String
  }

  extend type Query {
    myAgentConfig: AgentConfig
  }

  extend type Mutation {
    updateAgentConfig(input: UpdateAgentConfigInput!): AgentConfig!
    rollbackAgentConfig: AgentConfig!
  }
`;
