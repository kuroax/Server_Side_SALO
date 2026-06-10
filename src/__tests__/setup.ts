// ─── Test environment variables ───────────────────────────────────────────────
//
// Set BEFORE any module that transitively imports `#/config/env.js` is loaded.
// env.ts validates process.env at import time and calls process.exit(1) on any
// missing/invalid var — which would kill the Vitest worker. Every required key
// from env.ts must therefore be present here.
//
// This file (setupFiles) is evaluated before the test files import the app, and
// it only imports mongoose / mongodb-memory-server / vitest — none of which load
// env.ts — so these assignments are in place by the time env.ts first runs.
process.env.NODE_ENV = 'test'
process.env.PORT = '4001'
// Required by env.ts. Never actually dialed — the in-memory server URI below is
// what Mongoose connects to. Kept as a syntactically valid placeholder only.
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/salo_test'
process.env.JWT_SECRET = 'test_jwt_secret_at_least_32_chars'
process.env.JWT_REFRESH_SECRET = 'test_jwt_refresh_secret_32_chars'
process.env.JWT_EXPIRES_IN = '15m'
process.env.JWT_REFRESH_EXPIRES_IN = '7d'
process.env.ANTHROPIC_API_KEY = 'test_anthropic_key'
process.env.WEBHOOK_SECRET = 'test_webhook_secret_32chars_min!!'
process.env.BUFFER_WEBHOOK_SECRET = 'test_buffer_secret_32chars_min!!'
process.env.WHATSAPP_ACCESS_TOKEN = 'test_whatsapp_token'
// 32-byte AES-256 key as 64 hex chars — fixed test value so encrypt/decrypt of
// boutique.accessToken round-trips deterministically against the in-memory DB.
process.env.BOUTIQUE_TOKEN_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
process.env.CORS_ORIGIN = '*'
// Match production timing so buffer claim semantics are exercised realistically.
process.env.WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS = '55000'

// Single-node replica set (not standalone) — production is an Atlas replica
// set and the code under test uses transactions (order confirm inventory
// deduction, ownerConfirm duplicate guard), which standalone mongod rejects.
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import { beforeAll, afterAll, afterEach } from 'vitest'

let mongod: MongoMemoryReplSet

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  const uri = mongod.getUri()
  await mongoose.connect(uri)
})

afterEach(async () => {
  // Clear all collections between tests — guaranteed clean state without
  // tearing down indexes (which persist on the still-registered models).
  const collections = mongoose.connection.collections
  for (const key in collections) {
    await collections[key].deleteMany({})
  }

  // Reset the module-level boutique config cache so a boutique loaded in one
  // test never leaks into the next. Dynamic import keeps this file's top-level
  // imports free of any module that touches #/config/env.js before env is set.
  const { clearBoutiqueCache } = await import(
    '#/modules/boutiques/boutique.cache.js'
  )
  clearBoutiqueCache()
})

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})
