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

  enum CustomerGender {
    female
    male
    unknown
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
    gender: CustomerGender!
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
    gender: CustomerGender
  }

  input UpdateCustomerInput {
    name: String
    phone: String
    instagramHandle: String
    contactChannel: CustomerChannel
    notes: String
    tags: [CustomerTag!]
    address: String
    gender: CustomerGender
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
    customer(id: ID!): Customer!
    customerByPhone(phone: String!): Customer
    customers(input: ListCustomersInput): CustomerList!
  }

  # ─── Mutations ────────────────────────────────────────────────────────────────

  extend type Mutation {
    createCustomer(input: CreateCustomerInput!): Customer!
    updateCustomer(id: ID!, input: UpdateCustomerInput!): Customer!
    deactivateCustomer(id: ID!): Customer!
    activateCustomer(id: ID!): Customer!
  }
`;