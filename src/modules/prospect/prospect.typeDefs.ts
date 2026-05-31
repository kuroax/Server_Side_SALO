export const prospectTypeDefs = `#graphql

  enum ProspectStage {
    nuevo
    interesado
    cotizado
    agendado
    ganado
    perdido
  }

  type StageHistoryEntry {
    stage: ProspectStage!
    changedAt: String!
    note: String
  }

  type Prospect {
    id: ID!
    boutiqueId: ID!
    customerPhone: String!
    customerName: String
    stage: ProspectStage!
    stageHistory: [StageHistoryEntry!]!
    notes: [String!]!
    totalMessages: Int!
    firstContactAt: String!
    lastContactAt: String!
    convertedToCustomerId: ID
    estimatedValue: Float
    tags: [String!]!
    isArchived: Boolean!
  }

  type PipelineSummary {
    nuevo: Int!
    interesado: Int!
    cotizado: Int!
    agendado: Int!
    ganado: Int!
    perdido: Int!
  }

  extend type Query {
    prospects(stage: ProspectStage): [Prospect!]!
    prospect(customerPhone: String!): Prospect
    pipelineSummary: PipelineSummary!
  }

  extend type Mutation {
    advanceProspectStage(
      customerPhone: String!
      stage: ProspectStage!
      note: String
    ): Prospect!

    addProspectNote(
      customerPhone: String!
      note: String!
    ): Prospect!

    convertToCustomer(
      customerPhone: String!
      customerId: ID!
    ): Prospect!
  }
`;
