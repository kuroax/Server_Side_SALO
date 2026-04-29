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
    searchKeywords: [String!]!
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
    # Must be > 0 — GraphQL accepts any Float but service layer enforces min(1).
    price: Float!
    brand: String!
    gender: ProductGender!
    categoryGroup: String!
    subcategory: String!
    images: [String!]
    status: ProductStatus
    variants: [ProductVariantInput!]
    # Optional — auto-populated from subcategory + categoryGroup if omitted.
    searchKeywords: [String!]
  }

  input UpdateProductInput {
    # At least one field must be provided — enforced by service layer validation.
    # An empty input object passes GraphQL validation but will be rejected at runtime.
    name: String
    description: String
    # Must be > 0 if provided — enforced by service layer validation.
    price: Float
    brand: String
    gender: ProductGender
    categoryGroup: String
    subcategory: String
    images: [String!]
    status: ProductStatus
    variants: [ProductVariantInput!]
    # Full array replacement — the entire keyword list is replaced, not merged.
    # Read existing keywords client-side and include them in the update to avoid
    # silently deleting manual keywords. Auto-keywords (subcategory, categoryGroup)
    # are always re-applied by the service layer regardless of what is sent here.
    searchKeywords: [String!]
  }

  input ListProductsInput {
    gender: ProductGender
    # String filters are unconstrained at the GraphQL layer.
    # Empty strings are rejected by service layer validation.
    categoryGroup: String
    subcategory: String
    brand: String
    status: ProductStatus
    page: Int
    limit: Int
  }

  # ─── Queries ────────────────────────────────────────────────────────────────

  extend type Query {
    # Returns null if not found rather than destroying the entire response.
    # Resolvers throw NotFoundError which GraphQL surfaces as a top-level error
    # on non-nullable fields, nulling out sibling fields in the same query.
    product(id: ID!): Product
    productBySlug(slug: String!): Product
    products(filters: ListProductsInput): ProductList!
  }

  # ─── Mutations ──────────────────────────────────────────────────────────────

  extend type Mutation {
    createProduct(input: CreateProductInput!): Product!
    updateProduct(id: ID!, input: UpdateProductInput!): Product!
    # Always returns true on success — throws on failure (not found, dependency error).
    # The false case never occurs in practice; errors surface as GraphQL errors.
    deleteProduct(id: ID!): Boolean!
  }
`;
