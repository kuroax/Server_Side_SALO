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

  # Per-tenant business config (prices, hours, shipping). Mirrors
  # BoutiqueBusinessInfo in boutique.types.ts.
  type BoutiqueBusinessInfo {
    showroomAddress: String!
    businessHours:   String!
    shippingPrice:   Float!
    paymentMethods:  String!
    depositPercent:  Float!
    paymentDays:     Int!
    deliveryInfo:    String!
  }

  # Safe boutique shape — accessToken is stripped in the resolver
  # (toSafeBoutique) and is never exposed here.
  type SafeBoutique {
    id:                  ID!
    name:                String!
    slug:                String
    phoneNumberId:       String
    bankAccountImageUrl: String
    onboardingStatus:    String
    businessInfo:        BoutiqueBusinessInfo
    agentConfig:         AgentConfig
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
    # Returns the authenticated user's own boutique. The resolver rejects any
    # id that differs from the JWT boutiqueId — no cross-tenant reads.
    boutique(id: ID!): SafeBoutique
  }

  extend type Mutation {
    updateAgentConfig(input: UpdateAgentConfigInput!): AgentConfig!
    rollbackAgentConfig: AgentConfig!
  }
`;
