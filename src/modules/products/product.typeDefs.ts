export const productTypeDefs = `
  # ─── Enums ──────────────────────────────────────────────────────────────────

  enum ProductGender {
    men
    women
  }

  enum ProductSize {
    XS
    S
    M
    L
    XL
    XXL
  }

  enum ProductStatus {
    active
    inactive
  }

  # ─── Types ──────────────────────────────────────────────────────────────────

  type ProductVariant {
    size: ProductSize!
    color: String!
  }

  type Product {
    id: ID!
    name: String!
    slug: String!
    description: String!
    price: Float!
    brand: String!
    gender: ProductGender!
    categoryGroup: String!
    subcategory: String!
    images: [String!]!
    status: ProductStatus!
    variants: [ProductVariant!]!
    createdAt: String!
    updatedAt: String!
  }

  type ProductList {
    products: [Product!]!
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
  }

  # ─── Inputs ─────────────────────────────────────────────────────────────────

  input ProductVariantInput {
    size: ProductSize!
    color: String!
  }

  input CreateProductInput {
    name: String!
    description: String!
    price: Float!
    brand: String!
    gender: ProductGender!
    categoryGroup: String!
    subcategory: String!
    images: [String!]
    status: ProductStatus
    variants: [ProductVariantInput!]
  }

  input UpdateProductInput {
    name: String
    description: String
    price: Float
    brand: String
    gender: ProductGender
    categoryGroup: String
    subcategory: String
    images: [String!]
    status: ProductStatus
    variants: [ProductVariantInput!]
  }

  input ListProductsInput {
    gender: ProductGender
    categoryGroup: String
    subcategory: String
    brand: String
    status: ProductStatus
    page: Int
    limit: Int
  }

  # ─── Queries ────────────────────────────────────────────────────────────────

  extend type Query {
    product(id: ID!): Product!
    productBySlug(slug: String!): Product!
    products(filters: ListProductsInput): ProductList!
  }

  # ─── Mutations ──────────────────────────────────────────────────────────────

  extend type Mutation {
    createProduct(input: CreateProductInput!): Product!
    updateProduct(id: ID!, input: UpdateProductInput!): Product!
    deleteProduct(id: ID!): Boolean!
  }
`;