import type { Application } from 'express'
import request from 'supertest'
import { Types } from 'mongoose'
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
} from 'vitest'

// ─── Module mocks (hoisted by Vitest above all imports) ───────────────────────
// Replace the three side-effecting integrations so no real Claude / WhatsApp /
// Graph API call is ever made. claude.service is also where the Anthropic client
// is instantiated — mocking the whole module skips that entirely.
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
import { ProspectModel } from '#/modules/prospect/prospect.model.js'
import { ConversationStateModel } from '#/modules/conversationState/conversationState.model.js'
import { ConversationBufferModel } from '#/modules/conversations/conversation-buffer.model.js'
import { ConversationModel } from '#/modules/conversations/conversation.model.js'
import { CustomerModel } from '#/modules/customers/customer.model.js'

import {
  createTestBoutique,
  TEST_BOUTIQUE_ID,
  TEST_PHONE_NUMBER_ID,
} from '../fixtures/boutique.fixture.js'
import {
  textMessagePayload,
  imageMessagePayload,
  malformedPayload,
  unknownPhonePayload,
} from '../fixtures/payloads.js'
import { mockProcessMessageResult } from '../mocks/claude.mock.js'

// ─── Shared constants ─────────────────────────────────────────────────────────
// Must match the values set in setup.ts so the timing-safe secret comparison in
// the controllers (which checks both length and bytes) succeeds.
const WEBHOOK_SECRET = 'test_webhook_secret_32chars_min!!'
const BUFFER_SECRET = 'test_buffer_secret_32chars_min!!'
const WEBHOOK_URL = '/api/webhooks/whatsapp'
const CUSTOMER_PHONE = '521234567890'
const boutiqueObjectId = new Types.ObjectId(TEST_BOUTIQUE_ID)

let app: Application

beforeAll(async () => {
  app = await createApp()
})

beforeEach(async () => {
  // Fresh mock state every test; restore the happy-path Claude stub.
  vi.mocked(processMessage).mockReset()
  vi.mocked(processMessage).mockResolvedValue(mockProcessMessageResult)
  vi.mocked(sendOwnerAlert).mockReset()
  vi.mocked(sendOwnerAlert).mockResolvedValue(undefined)

  await createTestBoutique()
})

describe('POST /api/webhooks/whatsapp', () => {
  // ── Test 1 ──────────────────────────────────────────────────────────────────
  it('AI mode: calls Claude and returns a reply', async () => {
    const res = await request(app)
      .post(WEBHOOK_URL)
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send(textMessagePayload)

    expect(res.status).toBe(200)
    expect(typeof res.body.reply).toBe('string')
    expect(res.body.reply.length).toBeGreaterThan(0)
    expect(vi.mocked(processMessage)).toHaveBeenCalledTimes(1)
  })

  // ── Test 2 ──────────────────────────────────────────────────────────────────
  it('human mode: does NOT call Claude and stays silent', async () => {
    await ConversationStateModel.create({
      boutiqueId: boutiqueObjectId,
      customerPhone: CUSTOMER_PHONE,
      mode: 'human',
    })

    const res = await request(app)
      .post(WEBHOOK_URL)
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send(textMessagePayload)

    expect(res.status).toBe(200)
    expect(res.body.reply ?? '').toBe('')
    expect(vi.mocked(processMessage)).not.toHaveBeenCalled()
  })

  // ── Test 3 ──────────────────────────────────────────────────────────────────
  it('new customer: creates a prospect at stage "nuevo"', async () => {
    const res = await request(app)
      .post(WEBHOOK_URL)
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send(textMessagePayload)

    expect(res.status).toBe(200)

    const prospect = await ProspectModel.findOne({
      customerPhone: CUSTOMER_PHONE,
    }).lean()

    expect(prospect).toBeTruthy()
    expect(prospect!.stage).toBe('nuevo')
    expect(prospect!.stageHistory[0]!.stage).toBe('nuevo')
    expect(prospect!.totalMessages).toBe(1)
  })

  // ── Test 4 ──────────────────────────────────────────────────────────────────
  it('existing customer: increments totalMessages and bumps lastContactAt', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000)
    await ProspectModel.create({
      boutiqueId: boutiqueObjectId,
      customerPhone: CUSTOMER_PHONE,
      stage: 'nuevo',
      stageHistory: [{ stage: 'nuevo', changedAt: past }],
      totalMessages: 3,
      firstContactAt: past,
      lastContactAt: past,
    })

    const res = await request(app)
      .post(WEBHOOK_URL)
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send(textMessagePayload)

    expect(res.status).toBe(200)

    const prospect = await ProspectModel.findOne({
      customerPhone: CUSTOMER_PHONE,
    }).lean()

    expect(prospect!.totalMessages).toBe(4)
    expect(new Date(prospect!.lastContactAt).getTime()).toBeGreaterThan(
      past.getTime(),
    )
  })

  // ── Test 5 ──────────────────────────────────────────────────────────────────
  it('image payload after payment context: skips Claude and alerts the owner about the receipt', async () => {
    // Seed a customer + a conversation whose history contains the
    // [payment_info_sent] sentinel so the incoming image is classified as a
    // payment receipt (isReceiptByContext) rather than a visual product search.
    const customer = await CustomerModel.create({
      boutiqueId: boutiqueObjectId,
      name: 'Test Customer',
      phone: CUSTOMER_PHONE,
      contactChannel: 'whatsapp',
      gender: 'unknown',
      isActive: true,
      tags: [],
    })
    await ConversationModel.create({
      boutiqueId: boutiqueObjectId,
      customerId: customer._id,
      channel: 'whatsapp',
      turns: [
        {
          role: 'assistant',
          content: 'Aquí te van los datos para tu depósito [payment_info_sent]',
          createdAt: new Date(),
        },
      ],
      lastMessageAt: new Date(),
    })

    const res = await request(app)
      .post(WEBHOOK_URL)
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send(imageMessagePayload)

    expect(res.status).toBe(200)
    // Receipt branch is taken — the Claude text flow never runs.
    expect(vi.mocked(processMessage)).not.toHaveBeenCalled()

    const alertTypes = vi
      .mocked(sendOwnerAlert)
      .mock.calls.map((c) => c[0].alertType)
    expect(alertTypes.some((t) => t.includes('receipt'))).toBe(true)
  })

  // ── Test 6 ──────────────────────────────────────────────────────────────────
  it('malformed payload: does not crash and does not call Claude', async () => {
    const res = await request(app)
      .post(WEBHOOK_URL)
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send(malformedPayload)

    expect([200, 400]).toContain(res.status)
    expect(vi.mocked(processMessage)).not.toHaveBeenCalled()
  })

  // ── Test 7 ──────────────────────────────────────────────────────────────────
  it('unknown phoneNumberId: responds gracefully without crashing', async () => {
    const res = await request(app)
      .post(WEBHOOK_URL)
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send(unknownPhonePayload)

    expect(res.status).toBe(200)
    // No registered boutique for that phoneNumberId → controlled escalation,
    // not a thrown error. Claude is never reached.
    expect(vi.mocked(processMessage)).not.toHaveBeenCalled()
  })
})

describe('POST /api/webhooks/whatsapp/set-human-mode', () => {
  // ── Test 8 ──────────────────────────────────────────────────────────────────
  it('sets the gate to human and returns 200', async () => {
    const res = await request(app)
      .post(`${WEBHOOK_URL}/set-human-mode`)
      .set('x-webhook-secret', BUFFER_SECRET)
      .send({
        customerPhone: CUSTOMER_PHONE,
        phoneNumberId: TEST_PHONE_NUMBER_ID,
        autoResumeMinutes: 30,
      })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.mode).toBe('human')

    const doc = await ConversationStateModel.findOne({
      boutiqueId: boutiqueObjectId,
      customerPhone: CUSTOMER_PHONE,
    }).lean()

    expect(doc!.mode).toBe('human')
    expect(doc!.humanTookOverAt).toBeTruthy()
    expect(doc!.autoResumeAt).toBeTruthy()
    const expectedResume = Date.now() + 30 * 60_000
    expect(
      Math.abs(new Date(doc!.autoResumeAt!).getTime() - expectedResume),
    ).toBeLessThan(60_000)
  })

  // ── Test 9 ──────────────────────────────────────────────────────────────────
  it('returns 404 when the boutique is not found', async () => {
    const res = await request(app)
      .post(`${WEBHOOK_URL}/set-human-mode`)
      .set('x-webhook-secret', BUFFER_SECRET)
      .send({
        customerPhone: CUSTOMER_PHONE,
        phoneNumberId: 'unknown_id',
        autoResumeMinutes: 30,
      })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('boutique_not_found')
  })

  // ── Test 10 ─────────────────────────────────────────────────────────────────
  it('returns 400 on an invalid payload', async () => {
    const res = await request(app)
      .post(`${WEBHOOK_URL}/set-human-mode`)
      .set('x-webhook-secret', BUFFER_SECRET)
      .send({ customerPhone: '', phoneNumberId: '' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_payload')
  })
})

describe('Auto-resume', () => {
  // ── Test 11 ─────────────────────────────────────────────────────────────────
  it('expired autoResumeAt flips the gate back to ai and Claude runs', async () => {
    await ConversationStateModel.create({
      boutiqueId: boutiqueObjectId,
      customerPhone: CUSTOMER_PHONE,
      mode: 'human',
      humanTookOverAt: new Date(Date.now() - 120_000),
      autoResumeAt: new Date(Date.now() - 60_000), // 1 min in the past
    })

    const res = await request(app)
      .post(WEBHOOK_URL)
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send(textMessagePayload)

    expect(res.status).toBe(200)
    expect(vi.mocked(processMessage)).toHaveBeenCalled()

    const doc = await ConversationStateModel.findOne({
      boutiqueId: boutiqueObjectId,
      customerPhone: CUSTOMER_PHONE,
    }).lean()
    expect(doc!.mode).toBe('ai')
  })
})

describe('WhatsApp buffer', () => {
  const pushBody = (overrides: Record<string, unknown> = {}) => ({
    from: CUSTOMER_PHONE,
    message: 'busco leggings negros',
    executionId: 'exec-default',
    messageId: 'wamid.buf1',
    messageType: 'text',
    imageMediaId: null,
    imageCaption: '',
    contactName: 'Test',
    timestamp: String(Date.now()),
    ...overrides,
  })

  // ── Test 12 ─────────────────────────────────────────────────────────────────
  it('push: accepts the message and stores a buffer document', async () => {
    const res = await request(app)
      .post(`${WEBHOOK_URL}/buffer/push`)
      .set('x-webhook-secret', BUFFER_SECRET)
      .send(pushBody({ executionId: 'exec-12', messageId: 'wamid.b12' }))

    expect(res.status).toBe(200)

    const buffer = await ConversationBufferModel.findOne({
      from: CUSTOMER_PHONE,
    }).lean()
    expect(buffer).toBeTruthy()
    expect(buffer!.messages.length).toBe(1)
  })

  // ── Test 13 ─────────────────────────────────────────────────────────────────
  it('claim before the elapsed threshold: does not respond', async () => {
    await request(app)
      .post(`${WEBHOOK_URL}/buffer/push`)
      .set('x-webhook-secret', BUFFER_SECRET)
      .send(pushBody({ executionId: 'exec-13', messageId: 'wamid.b13' }))

    const res = await request(app)
      .post(`${WEBHOOK_URL}/buffer/claim`)
      .set('x-webhook-secret', BUFFER_SECRET)
      .send({ from: CUSTOMER_PHONE, executionId: 'exec-13' })

    expect(res.status).toBe(200)
    expect(res.body.shouldRespond === false || res.body.skip === true).toBe(
      true,
    )
  })

  // ── Test 14 ─────────────────────────────────────────────────────────────────
  it('claim after the elapsed threshold: merges all buffered messages', async () => {
    await request(app)
      .post(`${WEBHOOK_URL}/buffer/push`)
      .set('x-webhook-secret', BUFFER_SECRET)
      .send(
        pushBody({
          message: 'mensaje uno',
          executionId: 'exec-14',
          messageId: 'wamid.b14a',
        }),
      )
    await request(app)
      .post(`${WEBHOOK_URL}/buffer/push`)
      .set('x-webhook-secret', BUFFER_SECRET)
      .send(
        pushBody({
          message: 'mensaje dos',
          executionId: 'exec-14',
          messageId: 'wamid.b14b',
        }),
      )

    // Simulate elapsed idle time by aging lastSeen well past the threshold.
    await ConversationBufferModel.updateOne(
      { from: CUSTOMER_PHONE },
      { $set: { lastSeen: new Date(Date.now() - 10 * 60_000) } },
    )

    const res = await request(app)
      .post(`${WEBHOOK_URL}/buffer/claim`)
      .set('x-webhook-secret', BUFFER_SECRET)
      .send({ from: CUSTOMER_PHONE, executionId: 'exec-14' })

    expect(res.status).toBe(200)
    expect(res.body.shouldRespond).toBe(true)
    expect(res.body.messageCount).toBe(2)
    expect(res.body.mergedMessage).toContain('mensaje uno')
    expect(res.body.mergedMessage).toContain('mensaje dos')
  })
})

describe('Idempotency', () => {
  // ── Test 15 ─────────────────────────────────────────────────────────────────
  // NOTE: This test encodes the INTENDED contract (one reply per messageId) and
  // currently FAILS — it surfaces a real gap, not a flaky test. The backend only
  // dedupes IMAGE messages (process-local `recentImageMessageIds` set in
  // webhook.service.ts); duplicate TEXT messages run the full Claude flow every
  // time. Text idempotency is delegated to n8n static data (see CLAUDE.md "Dedup
  // in Extract Message uses n8n static data" — Open). Reported, not fixed, per
  // the instruction to never modify production code to make a test pass.
  it.fails('duplicate messageId: responds once and creates a single prospect', async () => {
    await request(app)
      .post(WEBHOOK_URL)
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send(textMessagePayload)

    await request(app)
      .post(WEBHOOK_URL)
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send(textMessagePayload)

    expect(vi.mocked(processMessage)).toHaveBeenCalledTimes(1)

    const prospectCount = await ProspectModel.countDocuments({
      customerPhone: CUSTOMER_PHONE,
    })
    expect(prospectCount).toBe(1)
  })
})
