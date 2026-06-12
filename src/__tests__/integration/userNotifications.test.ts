import type { Application } from 'express'
import request from 'supertest'
import { Types } from 'mongoose'
import { describe, it, expect, beforeAll, afterEach } from 'vitest'

import { createApp } from '#/app.js'
import { signAccessToken } from '#/modules/auth/auth.utils.js'
import { UserModel } from '#/modules/auth/auth.model.js'

// ─── Constants ────────────────────────────────────────────────────────────────
const BOUTIQUE_A = new Types.ObjectId('c00000000000000000000001')
const GRAPHQL_URL = '/api/graphql'

let app: Application

// Signs an owner JWT scoped to the given user + boutique — mirrors what login
// issues. The mutations under test read id/boutiqueId straight from this token.
function tokenFor(userId: Types.ObjectId, boutiqueId: Types.ObjectId): string {
  return signAccessToken({
    id: userId.toString(),
    role: 'owner',
    boutiqueId: boutiqueId.toString(),
  })
}

// Seeds a minimal, schema-valid user under `boutiqueId` and returns its id.
async function seedUser(boutiqueId: Types.ObjectId): Promise<Types.ObjectId> {
  const user = await UserModel.create({
    boutiqueId,
    username: `user_${new Types.ObjectId().toString().slice(-6)}`,
    password: 'hashed_placeholder',
    role: 'owner',
  })
  return user._id as Types.ObjectId
}

// Runs an authenticated GraphQL operation and returns the parsed response body.
function gql(query: string, token: string, variables?: Record<string, unknown>) {
  return request(app)
    .post(GRAPHQL_URL)
    .set('Authorization', `Bearer ${token}`)
    .send({ query, variables })
}

beforeAll(async () => {
  app = await createApp()
})

afterEach(async () => {
  await UserModel.deleteMany({})
})

const SET_NOTIFICATIONS = /* GraphQL */ `
  mutation ($enabled: Boolean!) {
    setNotificationsEnabled(enabled: $enabled)
  }
`

const REGISTER_TOKEN = /* GraphQL */ `
  mutation ($input: RegisterPushTokenInput!) {
    registerPushToken(input: $input)
  }
`

const UNREGISTER_TOKEN = /* GraphQL */ `
  mutation ($token: String!) {
    unregisterPushToken(token: $token)
  }
`

describe('User notification preferences & push tokens', () => {
  // ── setNotificationsEnabled toggles the field ───────────────────────────────
  it('setNotificationsEnabled flips the stored preference', async () => {
    const userId = await seedUser(BOUTIQUE_A)
    const token = tokenFor(userId, BOUTIQUE_A)

    const res = await gql(SET_NOTIFICATIONS, token, { enabled: false })

    expect(res.status).toBe(200)
    expect(res.body.errors).toBeUndefined()
    expect(res.body.data.setNotificationsEnabled).toBe(true)

    const after = await UserModel.findById(userId).lean()
    expect(after?.notificationsEnabled).toBe(false)

    // Flip it back on to confirm the toggle works in both directions.
    const res2 = await gql(SET_NOTIFICATIONS, token, { enabled: true })
    expect(res2.body.data.setNotificationsEnabled).toBe(true)
    const after2 = await UserModel.findById(userId).lean()
    expect(after2?.notificationsEnabled).toBe(true)
  })

  // ── registerPushToken adds + upserts without duplicating ────────────────────
  it('registerPushToken adds a token, then upserts the same token in place', async () => {
    const userId = await seedUser(BOUTIQUE_A)
    const token = tokenFor(userId, BOUTIQUE_A)

    // First registration — appends a new entry.
    const res1 = await gql(REGISTER_TOKEN, token, {
      input: { token: 'ExponentPushToken[abc123]', platform: 'ios' },
    })
    expect(res1.status).toBe(200)
    expect(res1.body.errors).toBeUndefined()
    expect(res1.body.data.registerPushToken).toBe(true)

    const afterFirst = await UserModel.findById(userId)
      .select('+pushTokens')
      .lean()
    expect(afterFirst?.pushTokens).toHaveLength(1)
    expect(afterFirst?.pushTokens?.[0]?.token).toBe('ExponentPushToken[abc123]')
    expect(afterFirst?.pushTokens?.[0]?.platform).toBe('ios')
    const firstUpdatedAt = afterFirst?.pushTokens?.[0]?.updatedAt

    // Re-register the SAME token (e.g. reinstall) with a new platform — must
    // update in place, never create a duplicate.
    const res2 = await gql(REGISTER_TOKEN, token, {
      input: { token: 'ExponentPushToken[abc123]', platform: 'android' },
    })
    expect(res2.body.data.registerPushToken).toBe(true)

    const afterSecond = await UserModel.findById(userId)
      .select('+pushTokens')
      .lean()
    expect(afterSecond?.pushTokens).toHaveLength(1) // no duplicate
    expect(afterSecond?.pushTokens?.[0]?.platform).toBe('android') // refreshed
    expect(
      afterSecond?.pushTokens?.[0]?.updatedAt &&
        firstUpdatedAt &&
        afterSecond.pushTokens[0].updatedAt >= firstUpdatedAt,
    ).toBe(true)

    // A genuinely different token DOES append a second entry.
    const res3 = await gql(REGISTER_TOKEN, token, {
      input: { token: 'ExponentPushToken[def456]', platform: 'ios' },
    })
    expect(res3.body.data.registerPushToken).toBe(true)
    const afterThird = await UserModel.findById(userId)
      .select('+pushTokens')
      .lean()
    expect(afterThird?.pushTokens).toHaveLength(2)
  })

  // ── unregisterPushToken removes the entry ───────────────────────────────────
  it('unregisterPushToken removes the matching token', async () => {
    const userId = await seedUser(BOUTIQUE_A)
    const token = tokenFor(userId, BOUTIQUE_A)

    await gql(REGISTER_TOKEN, token, {
      input: { token: 'ExponentPushToken[abc123]', platform: 'ios' },
    })
    await gql(REGISTER_TOKEN, token, {
      input: { token: 'ExponentPushToken[def456]', platform: 'android' },
    })

    const res = await gql(UNREGISTER_TOKEN, token, {
      token: 'ExponentPushToken[abc123]',
    })
    expect(res.status).toBe(200)
    expect(res.body.errors).toBeUndefined()
    expect(res.body.data.unregisterPushToken).toBe(true)

    const after = await UserModel.findById(userId).select('+pushTokens').lean()
    expect(after?.pushTokens).toHaveLength(1)
    expect(after?.pushTokens?.[0]?.token).toBe('ExponentPushToken[def456]')
  })

  // ── pushTokens is never exposed through the GraphQL SafeUser surface ─────────
  it('exposes notificationsEnabled but NOT pushTokens on the me query', async () => {
    const userId = await seedUser(BOUTIQUE_A)
    const token = tokenFor(userId, BOUTIQUE_A)

    await gql(REGISTER_TOKEN, token, {
      input: { token: 'ExponentPushToken[abc123]', platform: 'ios' },
    })

    // notificationsEnabled is a valid SafeUser field and resolves.
    const ok = await gql(
      /* GraphQL */ `
        query {
          me {
            id
            notificationsEnabled
          }
        }
      `,
      token,
    )
    expect(ok.status).toBe(200)
    expect(ok.body.errors).toBeUndefined()
    expect(ok.body.data.me.notificationsEnabled).toBe(true)

    // pushTokens is NOT in the SDL — requesting it is a validation error, proving
    // the field can never leak through any SafeUser-shaped response.
    const leak = await gql(
      /* GraphQL */ `
        query {
          me {
            id
            pushTokens
          }
        }
      `,
      token,
    )
    expect(leak.body.data).toBeUndefined()
    expect(leak.body.errors).toBeDefined()
    expect(JSON.stringify(leak.body.errors)).toContain('pushTokens')
  })
})
