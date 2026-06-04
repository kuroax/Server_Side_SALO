import { TEST_PHONE_NUMBER_ID } from './boutique.fixture.js'

// Normalized payload from n8n — the exact shape the backend webhook receives
// (already extracted from the raw Meta envelope by the n8n Extract Message node).

export const textMessagePayload = {
  from: '521234567890',
  message: 'Hola, busco leggings',
  messageType: 'text',
  contactName: 'Test Customer',
  phoneNumberId: TEST_PHONE_NUMBER_ID,
  messageId: 'wamid.test123',
  timestamp: String(Math.floor(Date.now() / 1000)),
  imageMediaId: null,
  // The webhook schema (webhook.validation.ts) types imageCaption as
  // `z.string().default("")` — it rejects null. n8n sends "" (see the buffer
  // push contract in CLAUDE.md), so the fixture matches that real shape.
  imageCaption: '',
  contextMessageId: null,
}

export const imageMessagePayload = {
  ...textMessagePayload,
  messageType: 'image',
  message: '[Imagen enviada por cliente sin texto.]',
  messageId: 'wamid.image456',
  imageMediaId: 'media_id_789',
  imageCaption: '',
}

export const malformedPayload = {
  from: '',
  message: '',
  messageType: 'unknown',
  phoneNumberId: '',
}

export const unknownPhonePayload = {
  ...textMessagePayload,
  phoneNumberId: 'unknown_phone_id_000',
}
