import type { Application } from 'express'
import request from 'supertest'
import { Types } from 'mongoose'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'

import { createApp } from '#/app.js'
import { signAccessToken } from '#/modules/auth/auth.utils.js'
import { BoutiqueModel } from '#/modules/boutiques/boutique.model.js'
import { CustomerModel } from '#/modules/customers/customer.model.js'
import { OrderModel } from '#/modules/orders/order.model.js'

// ─── Constants ──────────────────────────────────────────────────────────────────
// Two tenants so cross-boutique isolation can be exercised. Fixed ObjectIds let
// the JWT, the seeds, and the assertions all reference the same boutique.
const BOUTIQUE_A = new Types.ObjectId('b00000000000000000000001')
const BOUTIQUE_B = new Types.ObjectId('b00000000000000000000002')
const GRAPHQL_URL = '/api/graphql'

let app: Application
let counter = 100_000

// Mints a unique order number per seeded order (the schema enforces uniqueness).
const nextOrderNumber = () => `SALO-${++counter}`

// Signs an owner JWT scoped to the given boutique — mirrors what login issues.
function tokenFor(boutiqueId: Types.ObjectId): string {
  return signAccessToken({
    id: new Types.ObjectId().toString(),
    role: 'owner',
    boutiqueId: boutiqueId.toString(),
  })
}

// Seeds a minimal, schema-valid order for `customerId` under `boutiqueId`.
async function seedOrder(
  boutiqueId: Types.ObjectId,
  customerId: Types.ObjectId | null,
): Promise<string> {
  const order = await OrderModel.create({
    orderNumber: nextOrderNumber(),
    boutiqueId,
    customerId,
    channel: 'manual',
    status: 'pending',
    paymentStatus: 'unpaid',
    items: [
      {
        productId: new Types.ObjectId(),
        productName: 'Jersey Accolade',
        productSlug: 'jersey-accolade',
        size: 'M',
        color: 'negro',
        quantity: 1,
        unitPrice: 1990,
        lineTotal: 1990,
      },
    ],
    subtotal: 1990,
    total: 1990,
    inventoryApplied: false,
  })
  return order._id.toString()
}

// Runs an authenticated GraphQL query and returns the parsed response body.
function gql(query: string, token: string, variables?: Record<string, unknown>) {
  return request(app)
    .post(GRAPHQL_URL)
    .set('Authorization', `Bearer ${token}`)
    .send({ query, variables })
}

const ORDER_QUERY = /* GraphQL */ `
  query ($orderId: ID!) {
    order(orderId: $orderId) {
      id
      customerId
      customerName
    }
  }
`

async function seedBoutiques(): Promise<void> {
  for (const _id of [BOUTIQUE_A, BOUTIQUE_B]) {
    await BoutiqueModel.create({
      _id,
      name: `Boutique ${_id.toString().slice(-1)}`,
      phoneNumberId: `pnid_${_id.toString()}`,
      wabaId: `waba_${_id.toString()}`,
      accessToken: 'seed_access_token',
      ownerPhone: '521111111111',
      status: 'active',
      globalMode: 'auto',
      businessInfo: {
        showroomAddress: 'Av. Test 123, Guadalajara',
        businessHours: 'Lunes a viernes 10am - 7pm',
        shippingPrice: 150,
        paymentMethods: 'Transferencia bancaria',
        depositPercent: 50,
        paymentDays: 3,
        deliveryInfo: '3 a 7 dias habiles una vez confirmado el pago',
      },
      agentConfig: {
        agentName: 'Luis',
        categoryDescription: 'tienda de ropa premium',
      },
    })
  }
}

beforeAll(async () => {
  app = await createApp()
})

beforeEach(async () => {
  await seedBoutiques()
})

afterAll(async () => {
  await Promise.all([
    BoutiqueModel.deleteMany({}),
    CustomerModel.deleteMany({}),
    OrderModel.deleteMany({}),
  ])
})

describe('Order.customerName field resolver (DataLoader)', () => {
  // ── The key regression test ─────────────────────────────────────────────────
  // The frontend used to display names from a capped LIST_CUSTOMERS page (≤100).
  // A customer beyond that page (#103 of 105) was unresolvable client-side. The
  // server-side resolver must return the correct name regardless of position.
  it('resolves customerName for a customer beyond the old 100-item page cap', async () => {
    // Seed 105 customers; the order references the 103rd (index 102) — well
    // outside any legacy 100-item page.
    const customerDocs = await CustomerModel.insertMany(
      Array.from({ length: 105 }, (_, i) => ({
        boutiqueId: BOUTIQUE_A,
        name: `Cliente ${String(i + 1).padStart(3, '0')}`,
        phone: `52133300${String(i).padStart(4, '0')}`,
        contactChannel: 'whatsapp',
        gender: 'unknown',
        isActive: true,
        tags: [],
      })),
    )

    const target = customerDocs[102]! // Cliente 103
    const orderId = await seedOrder(BOUTIQUE_A, target._id as Types.ObjectId)

    const res = await gql(ORDER_QUERY, tokenFor(BOUTIQUE_A), { orderId })

    expect(res.status).toBe(200)
    expect(res.body.errors).toBeUndefined()
    expect(res.body.data.order.customerId).toBe(
      (target._id as Types.ObjectId).toString(),
    )
    expect(res.body.data.order.customerName).toBe('Cliente 103')
  })

  // ── Cross-tenant isolation ──────────────────────────────────────────────────
  // A customer living in Boutique B must NEVER have its name resolved through an
  // order in Boutique A. The loader is scoped by the JWT boutiqueId, so the
  // foreign id falls out of the tenant-filtered query → customerName is null.
  it('never resolves a customerName across boutique boundaries', async () => {
    const foreignCustomer = await CustomerModel.create({
      boutiqueId: BOUTIQUE_B,
      name: 'Cliente De Otra Boutique',
      phone: '5213399999999',
      contactChannel: 'whatsapp',
      gender: 'unknown',
      isActive: true,
      tags: [],
    })

    // An order in Boutique A that (incorrectly) references Boutique B's customer.
    const orderId = await seedOrder(
      BOUTIQUE_A,
      foreignCustomer._id as Types.ObjectId,
    )

    const res = await gql(ORDER_QUERY, tokenFor(BOUTIQUE_A), { orderId })

    expect(res.status).toBe(200)
    expect(res.body.errors).toBeUndefined()
    // customerId is still echoed (it lives on the order), but the NAME must not
    // leak from the other tenant.
    expect(res.body.data.order.customerId).toBe(
      (foreignCustomer._id as Types.ObjectId).toString(),
    )
    expect(res.body.data.order.customerName).toBeNull()
  })

  // ── Null / missing customer ─────────────────────────────────────────────────
  // An order whose customerId points to a non-existent customer document must
  // resolve customerName to null without throwing.
  it('resolves customerName to null when the referenced customer does not exist', async () => {
    const orderId = await seedOrder(BOUTIQUE_A, new Types.ObjectId())

    const res = await gql(ORDER_QUERY, tokenFor(BOUTIQUE_A), { orderId })

    expect(res.status).toBe(200)
    expect(res.body.errors).toBeUndefined()
    expect(res.body.data.order.customerName).toBeNull()
  })
})
