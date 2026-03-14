export const customerTypeDefs = `#graphql

  enum CustomerChannel {
    whatsapp
    instagram
    both
  }

  enum CustomerTag {
    vip
    wholesale
    problematic
    regular
  }

  type Customer {
    id: ID!
    name: String!
    phone: String
    instagramHandle: String
    contactChannel: CustomerChannel!
    notes: String
    tags: [CustomerTag!]!
    address: String
    isActive: Boolean!
    createdAt: String!
    updatedAt: String!
  }

  type CustomerList {
    customers: [Customer!]!
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
  }

  # ─── Inputs ───────────────────────────────────────────────────────────────────

  input CreateCustomerInput {
    name: String!
    phone: String
    instagramHandle: String
    contactChannel: CustomerChannel!
    notes: String
    tags: [CustomerTag!]
    address: String
  }

  input UpdateCustomerInput {
    name: String
    phone: String
    instagramHandle: String
    contactChannel: CustomerChannel
    notes: String
    tags: [CustomerTag!]
    address: String
  }

  input ListCustomersInput {
    page: Int
    limit: Int
    contactChannel: CustomerChannel
    tags: [CustomerTag!]
    isActive: Boolean
    search: String
  }

  # ─── Queries ──────────────────────────────────────────────────────────────────

  extend type Query {
    # Returns a single customer by ID
    customer(id: ID!): Customer!

    # Returns a customer by phone — null if not found (for bot lookups)
    customerByPhone(phone: String!): Customer

    # Returns paginated customer list with optional filters
    customers(input: ListCustomersInput): CustomerList!
  }

  # ─── Mutations ────────────────────────────────────────────────────────────────

  extend type Mutation {
    createCustomer(input: CreateCustomerInput!): Customer!

    updateCustomer(id: ID!, input: UpdateCustomerInput!): Customer!

    # Soft deactivation — preferred over hard delete
    deactivateCustomer(id: ID!): Customer!

    activateCustomer(id: ID!): Customer!
  }
`;