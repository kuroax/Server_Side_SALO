export const orderTypeDefs = /* #graphql */ `
  # ─── Enums ───────────────────────────────────────────────────────────────────

  enum OrderStatus {
    pending
    confirmed
    processing
    shipped
    delivered
    cancelled
  }

  enum PaymentStatus {
    unpaid
    partial
    paid
  }

  enum OrderChannel {
    whatsapp
    instagram
    manual
  }

  enum OrderNoteKind {
    internal
    system
    customer_message
  }

  # ─── Types ────────────────────────────────────────────────────────────────────

  type OrderNote {
    message:   String!
    createdBy: ID          # null for system/bot-generated notes
    kind:      OrderNoteKind!
    createdAt: String!
  }

  type OrderItemSnapshot {
    productId:   ID!
    productName: String!
    productSlug: String!
    size:        String!
    color:       String!
    quantity:    Int!
    unitPrice:   Float!
    lineTotal:   Float!
  }

  type Order {
    id:               ID!
    orderNumber:      String!
    customerId:       ID           # nullable — bot may not yet have resolved the customer
    channel:          OrderChannel!
    status:           OrderStatus!
    paymentStatus:    PaymentStatus!
    items:            [OrderItemSnapshot!]!
    notes:            [OrderNote!]!
    subtotal:         Float!       # sum of lineTotals (pre-discount)
    total:            Float!       # post-discount / post-tax (equals subtotal in V1)
    inventoryApplied: Boolean!
    createdAt:        String!
    updatedAt:        String!
  }

  # ─── Inputs ───────────────────────────────────────────────────────────────────

  # productName and productSlug are omitted — the service fetches them from the
  # product record at creation time. Client input is not trusted for snapshot data.
  input OrderItemInput {
    productId: ID!
    size:      String!
    color:     String!
    quantity:  Int!
    unitPrice: Float!
  }

  input OrderNoteInput {
    message: String!
    kind:    OrderNoteKind!
  }

  input CreateOrderInput {
    customerId: ID             # optional — null for first-contact bot flows
    channel:    OrderChannel!
    items:      [OrderItemInput!]!
    notes:      [OrderNoteInput!]
  }

  input UpdateOrderStatusInput {
    orderId: ID!
    status:  OrderStatus!
  }

  input UpdatePaymentStatusInput {
    orderId:       ID!
    paymentStatus: PaymentStatus!
  }

  input AddOrderNoteInput {
    orderId: ID!
    note:    OrderNoteInput!
  }

  input CancelOrderInput {
    orderId: ID!
  }

  input DeleteOrderInput {
    orderId: ID!
  }

  input AssignCustomerToOrderInput {
    orderId:    ID!
    customerId: ID!
  }

  input OrderFilterInput {
    customerId:    ID
    status:        OrderStatus
    paymentStatus: PaymentStatus
    channel:       OrderChannel
    limit:         Int
    skip:          Int
  }

  # ─── Queries ──────────────────────────────────────────────────────────────────

  extend type Query {
    "Fetch a single order by ID. Requires authentication."
    order(orderId: ID!): Order

    "Fetch a single order by its human-readable order number. Requires authentication."
    orderByOrderNumber(orderNumber: String!): Order

    "List orders with optional filters and pagination. Requires authentication."
    orders(filter: OrderFilterInput): [Order!]!

    "All orders for a specific customer. Requires authentication."
    customerOrders(customerId: ID!): [Order!]!
  }

  # ─── Mutations ────────────────────────────────────────────────────────────────

  extend type Mutation {
    "Create a new order. customerId may be null for first-contact bot flows. Requires owner / admin / sales."
    createOrder(input: CreateOrderInput!): Order!

    "Update the fulfilment status of an order. Requires owner / admin / sales."
    updateOrderStatus(input: UpdateOrderStatusInput!): Order!

    "Update the payment status of an order. Requires owner / admin / sales."
    updatePaymentStatus(input: UpdatePaymentStatusInput!): Order!

    "Cancel an order. Cannot cancel shipped or delivered orders. Requires owner / admin."
    cancelOrder(input: CancelOrderInput!): Order!

    "Append a note to an order. Requires owner / admin / sales."
    addOrderNote(input: AddOrderNoteInput!): Order!

    "Resolve a null customerId to a confirmed customer record (bot post-identification flow). Requires owner / admin / sales."
    assignCustomerToOrder(input: AssignCustomerToOrderInput!): Order!

    "Permanently delete an order from the database. Restores inventory if applied. Owner only."
    deleteOrder(input: DeleteOrderInput!): Boolean!
  }
`;