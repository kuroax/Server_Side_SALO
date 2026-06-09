export const usageLogTypeDefs = `#graphql

  type UsageDailyEntry {
    date: String!
    calls: Int!
    totalTokens: Int!
    estimatedCostUSD: Float!
  }

  type UsageIntentEntry {
    intent: String!
    calls: Int!
    tokens: Int!
    estimatedCostUSD: Float!
  }

  type UsageSummary {
    totalInputTokens:  Int!
    totalOutputTokens: Int!
    totalTokens:       Int!
    totalCalls:        Int!
    estimatedCostUSD:  Float!
    periodStart:       String!
    periodEnd:         String!
    byIntent:          [UsageIntentEntry!]!
    dailyUsage:        [UsageDailyEntry!]!
  }

  extend type Query {
    usageSummary(months: Int): UsageSummary!
  }
`;
