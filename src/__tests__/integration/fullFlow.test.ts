import type { Application } from 'express'
import request from 'supertest'
import { Types } from 'mongoose'
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from 'vitest'

// ─── Module mocks (hoisted by Vitest above all imports) ───────────────────────
// Same setup as webhook.test.ts: replace the side-effecting integrations so no
// real Claude / WhatsApp / Meta call is ever made. processMessage is mocked per
// turn to drive the journey; searchProductsByImage is mocked (image path never
// hits a real media server). ownerConfirm.service uses global fetch directly,
// so global fetch is stubbed in beforeEach (see below).
vi.mock('#/integrations/whatsapp/claude.service.js', () => ({
  processMessage: vi.fn(),
}))
vi.mock('#/integrations/whatsapp/alert.service.js', () => ({
  sendOwnerAlert: vi.fn(async () => undefined),
}))
vi.mock('#/integrations/whatsapp/image-search.service.js', () => ({
  searchProductsByImage: vi.fn(async () => ({
    reply: 'mock visual search',
    productImages: [],
  })),
}))

import { createApp } from '#/app.js'
import { processMessage } from '#/integrations/whatsapp/claude.service.js'
import { sendOwnerAlert } from '#/integrations/whatsapp/alert.service.js'
import { handleOwnerConfirm } from '#/integrations/whatsapp/ownerConfirm.service.js'
import { BoutiqueModel } from '#/modules/boutiques/boutique.model.js'
import { ProspectModel } from '#/modules/prospect/prospect.model.js'
import { ConversationModel } from '#/modules/conversations/conversation.model.js'
import { CustomerModel } from '#/modules/customers/customer.model.js'
import { ProductModel } from '#/modules/products/product.model.js'
import { InventoryModel } from '#/modules/inventory/inventory.model.js'
import { OrderModel } from '#/modules/orders/order.model.js'
import { PendingPaymentModel } from '#/modules/pendingPayments/pendingPayment.model.js'

// ─── Journey constants ────────────────────────────────────────────────────────
// Must match setup.ts secret values for the timing-safe header comparison.
const WEBHOOK_SECRET = 'test_webhook_secret_32chars_min!!'
const WEBHOOK_URL = '/api/webhooks/whatsapp'

const JOURNEY_BOUTIQUE_ID = '6a15631c074684288beaa0f6'
const JOURNEY_PHONE = '5213328205715'
const JOURNEY_PHONE_NUMBER_ID = 'journey_phone_number_id'
const OWNER_PHONE = '5213000000000'
const ACCESS_TOKEN = 'journey_access_token'
const BANK_IMAGE_URL =
  'https://res.cloudinary.com/test/image/upload/bank-account.png'
const PRODUCT_IMAGE_URL =
  'https://res.cloudinary.com/test/image/upload/jersey-accolade.png'

const boutiqueObjectId = new Types.ObjectId(JOURNEY_BOUTIQUE_ID)

let app: Application

// Shared conversation thread across the ordered it blocks. setup.ts clears all
// collections after every test, so this `let` is the source of truth for the
// journey's history; tests that need prior context re-seed the DB from it.
let conversationTurns: Array<{ role: 'user' | 'assistant'; content: string }> =
  []

// Boutique with the fields this journey exercises: a bank image URL (so
// payment_info injects it instead of escalating) and an owner phone (so the
// new-prospect / receipt alerts fire).
async function createJourneyBoutique(): Promise<void> {
  await BoutiqueModel.create({
    _id: boutiqueObjectId,
    name: 'Frida Boutique',
    phoneNumberId: JOURNEY_PHONE_NUMBER_ID,
    wabaId: 'journey_waba_id',
    accessToken: ACCESS_TOKEN,
    ownerPhone: OWNER_PHONE,
    bankAccountImageUrl: BANK_IMAGE_URL,
    status: 'active',
    globalMode: 'auto',
    businessInfo: {
      showroomAddress: 'Av. Test 123, Guadalajara',
      businessHours: 'Lunes a viernes 10am - 7pm',
      shippingPrice: 179,
      paymentMethods: 'Transferencia bancaria',
      depositPercent: 30,
      paymentDays: 20,
      deliveryInfo: '3 a 7 dias habiles una vez confirmado el pago',
    },
    agentConfig: {
      agentName: 'Luis',
      categoryDescription:
        'tienda de ropa deportiva y lifestyle de marcas premium',
    },
  })
}

// POST a text message to the webhook as the journey customer.
function postText(message: string, messageId: string) {
  return request(app)
    .post(WEBHOOK_URL)
    .set('x-webhook-secret', WEBHOOK_SECRET)
    .send({
      from: JOURNEY_PHONE,
      message,
      messageType: 'text',
      contactName: 'Frida',
      phoneNumberId: JOURNEY_PHONE_NUMBER_ID,
      messageId,
      timestamp: String(Math.floor(Date.now() / 1000)),
      imageMediaId: null,
      imageCaption: '',
      contextMessageId: null,
    })
}

beforeAll(async () => {
  app = await createApp()
})

beforeEach(async () => {
  vi.mocked(processMessage).mockReset()
  vi.mocked(sendOwnerAlert).mockReset()
  vi.mocked(sendOwnerAlert).mockResolvedValue(undefined)

  // Stub global fetch so ownerConfirm.service.sendWhatsAppText never hits the
  // real Graph API. Never call real WhatsApp/Meta.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })),
  )

  await createJourneyBoutique()
})

afterAll(async () => {
  vi.unstubAllGlobals()
  // Belt-and-suspenders cleanup (setup.ts afterEach already clears collections).
  await Promise.all([
    BoutiqueModel.deleteMany({}),
    ProspectModel.deleteMany({}),
    ConversationModel.deleteMany({}),
    CustomerModel.deleteMany({}),
    ProductModel.deleteMany({}),
    InventoryModel.deleteMany({}),
    OrderModel.deleteMany({}),
    PendingPaymentModel.deleteMany({}),
  ])
})

describe('JOURNEY: Frida-style complete purchase flow', () => {
  // ── Test 1 — first contact greeting ─────────────────────────────────────────
  it('1. "Holisssss" — registers prospect and alerts owner', async () => {
    const reply = 'Hola bonita! 🙌🏼 Bienvenida a SALO, ¿qué buscas hoy?'
    vi.mocked(processMessage).mockResolvedValue({
      intent: 'general',
      response: reply,
      productImages: [],
    })

    const res = await postText('Holisssss', 'wamid.journey-1')

    expect(res.status).toBe(200)
    expect(res.body.reply).toContain('Hola')
    expect(res.body.escalate).toBe(false)

    const prospect = await ProspectModel.findOne({
      customerPhone: JOURNEY_PHONE,
    }).lean()
    expect(prospect).toBeTruthy()
    expect(prospect!.stage).toBe('nuevo')

    const alertTypes = vi
      .mocked(sendOwnerAlert)
      .mock.calls.map((c) => c[0].alertType)
    expect(alertTypes).toContain('new_prospect')

    conversationTurns.push(
      { role: 'user', content: 'Holisssss' },
      { role: 'assistant', content: reply },
    )
  })

  // ── Test 2 — browse catalog ─────────────────────────────────────────────────
  it('2. "Quiero ver lo que tienes" — returns product gallery', async () => {
    const reply = 'Ahorita te muestro ✨'
    vi.mocked(processMessage).mockResolvedValue({
      intent: 'product_search',
      response: reply,
      productImages: [
        { url: PRODUCT_IMAGE_URL, caption: 'Jersey Accolade Paradise Pink' },
      ],
    })

    const res = await postText('Quiero ver lo que tienes', 'wamid.journey-2')

    expect(res.status).toBe(200)
    expect(res.body.productImages.length).toBeGreaterThan(0)
    expect(res.body.reply).toContain('muestro')
    expect(res.body.escalate).toBe(false)

    conversationTurns.push(
      { role: 'user', content: 'Quiero ver lo que tienes' },
      { role: 'assistant', content: reply },
    )
  })

  // ── Test 3 — size confirmation (two-step gate holds) ────────────────────────
  it('3. "Talla S" — quotes product and asks to confirm (NOT payment_info)', async () => {
    const reply =
      '¡Sí bonita! ⭐️Jersey Accolade | Paradise Pink | Talla S | $3,390\n' +
      'Total: $3,569\nAnticipo (30%): $1,071\n' +
      '¿Confirmas tu pedido para enviarte los datos de depósito? 🙌🏼'
    vi.mocked(processMessage).mockResolvedValue({
      intent: 'general',
      response: reply,
      productImages: [],
    })

    const res = await postText('Talla S', 'wamid.journey-3')

    expect(res.status).toBe(200)
    expect(res.body.reply).toContain('Confirmas')
    expect(res.body.reply).toContain('⭐️')
    expect(res.body.escalate).toBe(false)
    // intent was "general", not payment_info — so the two-step gate held and no
    // bank image was injected yet.
    expect(res.body.productImages.length).toBe(0)

    conversationTurns.push(
      { role: 'user', content: 'Talla S' },
      { role: 'assistant', content: reply },
    )
  })

  // ── Test 4 — customer confirms → bank image sent ────────────────────────────
  it('4. "Sí confirmo" — injects the bank account image (payment_info)', async () => {
    const reply = '¡Perfecto bonita! Aquí van los datos de depósito 🙌🏼'
    vi.mocked(processMessage).mockResolvedValue({
      intent: 'payment_info',
      response: reply,
      productImages: [],
    })

    const res = await postText('Sí confirmo', 'wamid.journey-4')

    expect(res.status).toBe(200)
    expect(res.body.productImages.length).toBe(1)
    expect(res.body.productImages[0].url).toBe(BANK_IMAGE_URL)
    expect(res.body.escalate).toBe(false)

    // The webhook stores the assistant turn with the [payment_info_sent] sentinel.
    const customer = await CustomerModel.findOne({
      phone: JOURNEY_PHONE,
    }).lean()
    const conversation = await ConversationModel.findOne({
      customerId: customer!._id,
      channel: 'whatsapp',
    }).lean()
    expect(
      conversation!.turns.some((t) => t.content.includes('[payment_info_sent]')),
    ).toBe(true)

    // Mirror the persisted sentinel into the shared thread for Test 5's seed.
    conversationTurns.push(
      { role: 'user', content: 'Sí confirmo' },
      { role: 'assistant', content: `${reply} [payment_info_sent]` },
    )
  })

  // ── Test 5 — receipt image → escalation + pendingPayments ───────────────────
  it('5. receipt image — acks, escalates, saves pendingPayments', async () => {
    // Re-seed the conversation (cleared by afterEach) from the shared thread so
    // the image path sees the ⭐️ line (cart) and the [payment_info_sent]
    // sentinel (receipt-by-context detection).
    const customer = await CustomerModel.create({
      boutiqueId: boutiqueObjectId,
      name: 'Frida',
      phone: JOURNEY_PHONE,
      contactChannel: 'whatsapp',
      gender: 'unknown',
      isActive: true,
      tags: [],
    })
    await ConversationModel.create({
      boutiqueId: boutiqueObjectId,
      customerId: customer._id,
      channel: 'whatsapp',
      turns: conversationTurns.map((t) => ({
        role: t.role,
        content: t.content,
        createdAt: new Date(),
      })),
      lastMessageAt: new Date(),
    })

    const res = await request(app)
      .post(WEBHOOK_URL)
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send({
        from: JOURNEY_PHONE,
        message: '',
        messageType: 'image',
        contactName: 'Frida',
        phoneNumberId: JOURNEY_PHONE_NUMBER_ID,
        messageId: 'wamid.journey-receipt',
        timestamp: String(Math.floor(Date.now() / 1000)),
        imageMediaId: 'media_journey_receipt',
        imageCaption: '',
        contextMessageId: null,
      })

    expect(res.status).toBe(200)
    expect(res.body.reply).toContain('Mil gracias')
    expect(res.body.escalate).toBe(true)
    // processMessage (Claude) is never called on the image receipt path.
    expect(vi.mocked(processMessage)).not.toHaveBeenCalled()

    const alertTypes = vi
      .mocked(sendOwnerAlert)
      .mock.calls.map((c) => c[0].alertType)
    expect(alertTypes.some((t) => t.includes('receipt'))).toBe(true)

    const pending = await PendingPaymentModel.findOne({
      boutiqueId: boutiqueObjectId,
      customerPhone: JOURNEY_PHONE,
    }).lean()
    expect(pending).toBeTruthy()
    expect(pending!.cart.length).toBeGreaterThan(0)
  })

  // ── Test 6 — owner confirm → order created ──────────────────────────────────
  it('6. owner confirm — creates the order and clears pendingPayments', async () => {
    // Seed a clean, resolvable pending payment + matching product/inventory +
    // customer (afterEach cleared Test 5's state).
    const customer = await CustomerModel.create({
      boutiqueId: boutiqueObjectId,
      name: 'Frida',
      phone: JOURNEY_PHONE,
      contactChannel: 'whatsapp',
      gender: 'unknown',
      isActive: true,
      tags: [],
    })
    const product = await ProductModel.create({
      boutiqueId: boutiqueObjectId,
      name: 'Jersey Accolade',
      slug: 'jersey-accolade',
      description: 'Jersey Accolade de Alo Yoga',
      price: 3390,
      brand: 'Alo Yoga',
      gender: 'women',
      categoryGroup: 'tops',
      subcategory: 'jersey',
      status: 'active',
    })
    await InventoryModel.create({
      boutiqueId: boutiqueObjectId,
      productId: product._id,
      size: 'S',
      color: 'paradise pink',
      quantity: 5,
    })
    await PendingPaymentModel.create({
      boutiqueId: boutiqueObjectId,
      customerPhone: JOURNEY_PHONE,
      customerName: 'Frida',
      cart: [
        {
          productNameHint: 'Jersey Accolade',
          size: 'S',
          color: 'Paradise Pink',
          quantity: 1,
        },
      ],
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })

    const result = await handleOwnerConfirm({
      boutiqueId: JOURNEY_BOUTIQUE_ID,
      customerPhone: 'LOOKUP_BY_BOUTIQUE',
      ownerPhone: OWNER_PHONE,
    })

    expect(result.status).toBe('order_created')

    const order = await OrderModel.findOne({ customerId: customer._id }).lean()
    expect(order).toBeTruthy()

    const pendingAfter = await PendingPaymentModel.findOne({
      boutiqueId: boutiqueObjectId,
      customerPhone: JOURNEY_PHONE,
    }).lean()
    expect(pendingAfter).toBeNull()
  })
})

describe('Escalation scenarios', () => {
  // ── Test 7 — price negotiation → needs_human ────────────────────────────────
  it('7. price negotiation triggers escalation', async () => {
    const reply = 'Déjame consultarlo con el equipo 🙌🏼'
    vi.mocked(processMessage).mockResolvedValue({
      intent: 'needs_human',
      response: reply,
      productImages: [],
    })

    const res = await postText('me lo dejas en $2,500 el jersey?', 'wamid.esc-7')

    expect(res.status).toBe(200)
    expect(res.body.escalate).toBe(true)
    expect(res.body.escalationMessage).toMatch(/needs_human|decisión humana/)
    expect(res.body.reply).toContain('equipo')
  })

  // ── Test 8 — product_search with zero results → escalation ──────────────────
  it('8. product search with zero results triggers escalation', async () => {
    vi.mocked(processMessage).mockResolvedValue({
      intent: 'product_search',
      response: 'No tenemos leggings disponibles',
      productImages: [],
    })

    const res = await postText('busco leggings negros talla S', 'wamid.esc-8')

    expect(res.status).toBe(200)
    expect(res.body.escalate).toBe(true)
    // The escalation message echoes the customer message ("…leggings…").
    expect(res.body.escalationMessage).toContain('legging')
    expect(res.body.productImages.length).toBe(0)
  })

  // ── Test 9 — payment_receipt text → escalation + pendingPayments ────────────
  it('9. payment receipt text triggers escalation + pendingPayments', async () => {
    vi.mocked(processMessage).mockResolvedValue({
      intent: 'payment_receipt',
      response: 'Mil gracias!!!',
      orderHints: [
        {
          productNameHint: 'Jersey Accolade',
          size: 'S',
          color: 'Paradise Pink',
          quantity: 1,
        },
      ],
      productImages: [],
    })

    const res = await postText(
      'ya pagué, aquí está mi comprobante',
      'wamid.esc-9',
    )

    expect(res.status).toBe(200)
    expect(res.body.escalate).toBe(true)
    expect(res.body.escalationMessage).toContain('Comprobante')

    // NOTE: the TEXT payment_receipt path escalates via the n8n `escalate` flag
    // and escalationMessage — it does NOT call sendOwnerAlert. Only the IMAGE
    // receipt path sends sendOwnerAlert("receipt_received") (see Test 5). So the
    // owner-notification assertion here is the escalate flag/message above.
    const pending = await PendingPaymentModel.findOne({
      boutiqueId: boutiqueObjectId,
      customerPhone: JOURNEY_PHONE,
    }).lean()
    expect(pending).toBeTruthy()
    expect(pending!.cart[0]!.size).toBe('S')
    expect(pending!.cart[0]!.color).toBe('Paradise Pink')
  })

  // ── Test 10 — showroom visit → escalation ───────────────────────────────────
  it('10. showroom visit triggers escalation', async () => {
    vi.mocked(processMessage).mockResolvedValue({
      intent: 'showroom_visit',
      response: 'Con gusto! Puedes visitarnos en Av. Test 123 🙌🏼',
      productImages: [],
    })

    const res = await postText('puedo ir a probarme la ropa?', 'wamid.esc-10')

    expect(res.status).toBe(200)
    expect(res.body.escalate).toBe(true)
    expect(res.body.escalationMessage).toMatch(/showroom|visita/)
  })

  // ── Test 11 — normal greeting does NOT escalate ─────────────────────────────
  it('11. normal greeting does not escalate', async () => {
    vi.mocked(processMessage).mockResolvedValue({
      intent: 'general',
      response: 'Hola bonita! 🙌🏼',
      productImages: [],
    })

    const res = await postText('Hola', 'wamid.esc-11')

    expect(res.status).toBe(200)
    expect(res.body.escalate).toBe(false)
    expect(res.body.escalationMessage).toBeUndefined()
  })

  // ── Test 12 — payment_info without bankAccountImageUrl → escalation ─────────
  it('12. payment_info without bankAccountImageUrl triggers escalation', async () => {
    // Temporarily remove the bank image URL so payment_info escalates instead of
    // injecting the image.
    await BoutiqueModel.updateOne(
      { _id: boutiqueObjectId },
      { $unset: { bankAccountImageUrl: '' } },
    )

    vi.mocked(processMessage).mockResolvedValue({
      intent: 'payment_info',
      response: 'Aquí va el resumen...',
      productImages: [],
    })

    const res = await postText('a qué cuenta deposito', 'wamid.esc-12')

    expect(res.status).toBe(200)
    expect(res.body.escalate).toBe(true)
    expect(res.body.escalationMessage).toContain('bankAccountImageUrl')

    // Restore (afterEach also clears all collections between tests).
    await BoutiqueModel.updateOne(
      { _id: boutiqueObjectId },
      { $set: { bankAccountImageUrl: BANK_IMAGE_URL } },
    )
  })
})
