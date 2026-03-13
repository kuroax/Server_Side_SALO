export const inventoryTypeDefs = `#graphql

  type InventoryItem {
    id: ID!
    productId: ID!
    size: String!
    color: String!
    quantity: Int!
    lowStockThreshold: Int!
    isLowStock: Boolean!
    createdAt: String!
    updatedAt: String!
  }

  # ─── Inputs ───────────────────────────────────────────────────────────────────

  input AddStockInput {
    productId: ID!
    size: String!
    color: String!
    quantity: Int!
    lowStockThreshold: Int
  }

  input RemoveStockInput {
    productId: ID!
    size: String!
    color: String!
    quantity: Int!
  }

  input UpdateThresholdInput {
    productId: ID!
    size: String!
    color: String!
    lowStockThreshold: Int!
  }

  # ─── Queries ──────────────────────────────────────────────────────────────────

  extend type Query {
    # Returns all inventory records for a product across all variants
    productInventory(productId: ID!): [InventoryItem!]!

    # Returns all variants at or below their low stock threshold
    # Optionally scoped to a single product
    lowStock(productId: ID): [InventoryItem!]!
  }

  # ─── Mutations ────────────────────────────────────────────────────────────────

  extend type Mutation {
    # Creates record if not exists, increments quantity if exists
    addStock(input: AddStockInput!): InventoryItem!

    # Blocks if quantity would go below zero
    removeStock(input: RemoveStockInput!): InventoryItem!

    # Updates the low stock alert threshold for a specific variant
    updateThreshold(input: UpdateThresholdInput!): InventoryItem!
  }
`;