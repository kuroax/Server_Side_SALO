# CLAUDE.md — Server_Side_SALO Backend

## Claude Code behavior rules

Read this section first. These rules apply to every task in this repo.

- **Inspect before changing.** Read the relevant file completely before editing it. Never assume its current state from memory.
- **Do not create new files unless explicitly requested.** The module structure is established. New files require a clear reason.
- **Do not change architecture.** The 5-file module pattern, import alias system, and service/resolver separation are intentional and must not be restructured.
- **Do not modify `.env` or `.env.example` to add real secrets.** Add placeholder names only.
- **Do not run `npm run build` or `npm run start` — Railway deploys automatically on push to main.**
- **Do not change any `ClaudeIntent` value without updating `claude.service.ts`, `webhook.service.ts`, and this document.**
- **Do not change the buffer elapsed threshold without also updating the n8n Wait node.**
- **Prefer the smallest safe change.** Production stability beats feature completeness.
- **Run typecheck after every change:** `npm run typecheck`
- **When in doubt, report and ask — do not guess.**

---

## Project overview

GraphQL API backend for SALO — a multi-tenant SaaS platform for clothing boutiques in Mexico. Handles orders, inventory, customers, products, auth, and a WhatsApp AI bot ("Luis") powered by Claude.

**Architecture direction:** Multi-tenant SaaS. Each boutique is a separate tenant stored in the `boutiques` collection with its own Meta credentials, business info, and conversation mode. The first tenant is shopalogdl (manually onboarded). Axel Monterrubio is the developer/founder of Grimorio de Plata, not the boutique owner. Subsequent tenants onboard via WhatsApp Embedded Signup (in development). All domain collections (products, customers, orders, conversations) are scoped by `boutiqueId`.

**Deployed on Railway:** `https://serversidesalo-production.up.railway.app`

---

## Tech stack

| Layer      | Choice                                                              |
| ---------- | ------------------------------------------------------------------- |
| Runtime    | Node.js (ESM, `"type": "module"`)                                   |
| Language   | TypeScript 5, `target: ES2022`, `module: NodeNext`                  |
| API        | Apollo Server 5 + Express 5 + GraphQL 16                            |
| Database   | MongoDB via Mongoose 9 — Atlas replica set (transactions supported) |
| Validation | Zod v4                                                              |
| Auth       | JWT + refresh tokens (bcryptjs)                                     |
| AI         | Anthropic SDK (`@anthropic-ai/sdk`)                                 |
| Logging    | Pino + pino-http                                                    |
| Security   | Helmet, CORS, express-rate-limit                                    |
| Dev        | tsx + nodemon, tsc-alias                                            |

---

## Scripts

```bash
npm run dev        # tsx watch mode — hot reload on src/**/*.ts changes
npm run typecheck  # tsc --noEmit (type check only)
```

---

## Path aliases

Defined in both `package.json#imports` and `tsconfig.json#paths`:

```ts
import { something } from "#/shared/utils/auth.guards.js";
```

Always use `#/` imports, never relative `../../` paths across module boundaries.
Always include the `.js` extension in imports (NodeNext requirement).

---

## Directory structure

```
src/
├── server.ts                         # Entry point — Express + Apollo bootstrap
├── app.ts                            # Express app factory
├── config/
│   ├── db.ts                         # Mongoose connect
│   ├── env.ts                        # Zod-validated env vars — ONLY place to read process.env
│   └── logger.ts                     # Pino logger instance
├── graphql/
│   ├── context.ts                    # GraphQL context type + builder
│   └── schema/index.ts               # Merges all typeDefs + resolvers
├── integrations/
│   └── whatsapp/
│       ├── alert.service.ts          # Owner WhatsApp alerts — direct Graph API (exception)
│       ├── buffer.controller.ts      # Express controller for buffer push/claim endpoints
│       ├── buffer.service.ts         # Buffer push/claim logic — MongoDB-backed
│       ├── claude.service.ts         # Claude AI — intent detection + response generation
│       ├── image-search.service.ts   # Visual product search via image media ID
│       ├── logSentImage.controller.ts # Logs sent product images for gallery reply resolution
│       ├── webhook.auth.ts           # requireBufferWebhookSecret middleware
│       ├── webhook.controller.ts     # Express controller for Meta webhook
│       ├── webhook.router.ts         # Mounts all /api/webhooks/whatsapp routes
│       ├── webhook.service.ts        # Orchestrates full bot flow (1387 lines; helpers extracted)
│       │                                 # Reads boutique by phoneNumberId on every request
│       │                                 # Early-returns (logs warn, no reply) if phoneNumberId absent
│       │                                 # Passes boutique.businessInfo to ClaudeContext
│       ├── webhook.cart.ts           # Cart/history parsers (pure)
│       ├── webhook.escalation.ts     # Escalation + reply builders (pure)
│       ├── webhook.product-search.ts # Product/inventory query layer
│       ├── webhook.schemas.ts        # Webhook I/O Zod schemas, toSafeResult, idempotency
│       └── webhook.validation.ts     # Zod schemas for Meta payload
│                                         # phoneNumberId field added (optional, from metadata)
├── modules/
│   ├── auth/                         # JWT auth, login, refresh, password
│   ├── boutiques/                    # Multi-tenant: one doc per boutique/client
│   │   ├── boutique.model.ts         # Schema: Meta credentials, businessInfo, mode
│   │   ├── boutique.types.ts         # BOUTIQUE_STATUS, CONVERSATION_MODE enums
│   │   ├── boutique.validation.ts    # Zod schemas: create, update, embeddedSignup
│   │   ├── boutique.service.ts       # findByPhoneNumberId, createBoutique, setMode
│   │   ├── boutique.resolvers.ts     # GraphQL — never exposes accessToken
│   │   └── boutique.typeDefs.ts      # GraphQL SDL
│   ├── conversations/
│   │   ├── conversation-buffer.model.ts  # MongoDB buffer for message accumulation
│   │   └── conversation.model.ts         # Conversation memory — now includes boutiqueId
│   │                                     # and mode: "auto" | "manual" for hybrid handoff
│   ├── conversationState/            # Hybrid bot gate (model "ConversationState"): ai|human|paused
│   ├── customers/                    # Customer CRUD + lifetimeValue cache
│   │                                 # boutiqueId scopes all queries and indexes
│   ├── inventory/                    # Stock tracking per variant
│   ├── orders/                       # Order lifecycle management
│   ├── products/                     # Product catalog
│   ├── prospect/                     # WhatsApp lead CRM — pipeline stages, history, notes
│   └── sentImages/
│       └── sentImage.model.ts        # Maps WhatsApp message IDs to product captions
│                                     # Used for gallery reply product resolution
├── scripts/
│   ├── backfill-inventory.ts         # One-off data migration script
│   └── seed-boutique.ts              # Multi-tenant migration — creates first boutique,
│                                     # backfills boutiqueId. Idempotent. Run: npx tsx ...
└── shared/
    ├── errors/                       # Typed error classes (AppError hierarchy)
    ├── models/
    │   └── counter.model.ts          # Atomic sequence counter (order numbers)
    ├── utils/
    │   └── auth.guards.ts            # requireAuth(), requireRoles()
    └── validation/
        └── common.validation.ts      # objectIdSchema + shared Zod primitives
```

---

## Module anatomy

Every domain module follows the same 6-file pattern:

```
module.model.ts       # Mongoose schema + model
module.types.ts       # TypeScript types, enums, constants
module.validation.ts  # Zod schemas for all inputs
module.service.ts     # Business logic — only file that touches the DB
module.resolvers.ts   # GraphQL resolvers — auth guards + delegates to service
module.typeDefs.ts    # GraphQL SDL (extends Query / extends Mutation)
```

Note: some older modules have 5 files (no typeDefs.ts) — don't add it unless you're
modifying that module's GraphQL surface.

**Rule:** Resolvers never contain business logic. Services never contain GraphQL types. Validation always lives in the validation file — never inline in the service.

---

## Multi-tenant architecture

### Boutique as tenant

Every client boutique is a `Boutique` document in MongoDB. It stores:

- Meta credentials: `phoneNumberId`, `wabaId`, `accessToken`
- Business config: `businessInfo` (replaces hardcoded values in webhook.service.ts)
- Hybrid mode: `globalMode: "auto" | "manual"`
- Status: `"active" | "inactive" | "suspended"`

### Tenant isolation

All domain collections carry `boutiqueId: ObjectId (ref: Boutique)`. Every
query MUST filter by `boutiqueId`. Resolvers receive `boutiqueId` from
`context.user.boutiqueId` (signed into the JWT at login) — never from client
GraphQL arguments. Passing `boutiqueId` as a client argument is a security
vulnerability that allows cross-tenant data access.

### Conversation mode (hybrid AI/human)

`conversation.mode` controls per-conversation bot behavior:

- `"auto"` → Luis handles all messages for this customer (default)
- `"manual"` → n8n skips the AI entirely; owner responds manually

Set to `"manual"` automatically when Luis returns `escalate: true`.
Reset to `"auto"` manually by the owner via SALO app.

`boutique.globalMode` is a broader kill switch for the entire boutique.
Per-conversation mode is preferred for targeted handoffs.

### Hybrid bot gate (conversationState module)

Distinct from `conversation.mode`. The `conversationState` module (model
`ConversationState`, keyed by `boutiqueId + customerPhone`) gates replies in
`webhook.service.ts`: `human`/`paused` silence the bot, `ai` lets Luis reply. The
handler runs `checkAndApplyAutoResume` then `getConversationMode` before any
Claude call. Owner alerts use `alert.service.ts`, which calls the WhatsApp Graph
API directly — a deliberate exception (owner alerts only) to the no-direct-Meta rule.

### Webhook lookup

`webhook.service.ts` reads `phoneNumberId` from the incoming n8n payload and
calls `findBoutiqueByPhoneNumberIdWithToken()` to get the boutique document. All
downstream calls (claude.service.ts, etc.) receive `boutique.businessInfo`
instead of hardcoded constants.

### Onboarding

- **Tenant #1 (shopalogdl):** Manually onboarded. `seed-boutique.ts` creates the
  boutique doc and backfills `boutiqueId` on all existing docs.
- **Subsequent tenants:** Onboarded via WhatsApp Embedded Signup (in development).
  Token exchange endpoint: `POST /api/boutiques/signup`. Requires `META_APP_ID`
  and `META_APP_SECRET` in Railway env vars.

---

## Auth pattern

```ts
requireAuth(context); // any authenticated user
requireRoles(context, ["owner", "admin"]); // role whitelist

// Role hierarchy (broadest → narrowest)
// owner > admin > sales | inventory | support
```

Role constants are defined at the top of each resolver file:

```ts
const ORDER_READ_ROLES: Role[] = ["owner", "admin", "sales"];
const ORDER_WRITE_ROLES: Role[] = ["owner", "admin", "sales"];
const ORDER_CANCEL_ROLES: Role[] = ["owner", "admin"];
const ORDER_DELETE_ROLES: Role[] = ["owner"];
```

### JWT payload — includes boutiqueId

```ts
type JWTPayload = {
  id: string;
  role: Role;
  boutiqueId: string; // added for multi-tenancy — resolvers read from here
};
```

`boutiqueId` is signed into the JWT at login. Resolvers extract it from
`context.user.boutiqueId` — they never accept it as a client argument.

---

## Validation pattern (Zod v4)

Every service function receives `input: unknown` and parses it as the first line:

```ts
export async function createOrder(input: unknown, createdBy: string | null) {
  const data = createOrderSchema.parse(input);
}
```

**Zod v4 syntax — use `{ error: }` not `{ message: }`:**

```ts
z.string({ error: "Must be a string" }).min(1, { error: "Required" });
```

Import `objectIdSchema` from `#/shared/validation/common.validation.js` — never redefine it.

---

## Error handling

```ts
throw new NotFoundError("Order not found");
throw new BadRequestError("Cannot transition order from pending to delivered");
throw new AuthenticationError("Invalid token");
throw new AuthorizationError("Insufficient role");
```

All extend `AppError` which Apollo Server maps to GraphQL errors automatically.

---

## MongoDB patterns

### Atlas replica set — transactions supported

MongoDB Atlas (`setName` present). `mongoose.withTransaction()` is used in `order.service.ts` for inventory deduction.

### MongoDB indexes on orders

```js
// channel_sourceMessageId_unique — idempotency for bot-created orders
// customerId_createdAt_desc     — critical for webhook performance
//                                  (full collection scan per message without it)
```

### Always use `.lean()` for reads

```ts
const order = await OrderModel.findById(id).lean<OrderLike>();
```

### Cast through `unknown` for lean documents

Direct cast to `Record<string, unknown>` on a typed document causes `ts(2352)`:

```ts
// CORRECT — double-cast through unknown
(recentOrder as unknown as Record<string, unknown>).trackingNumber as
  | string
  | undefined;
```

### Mongoose strict enum typing

Mongoose 9 enforces strict literal union types on query/create fields. Zod outputs `string`
for validated enum values, which Mongoose rejects. Cast to the domain type at the call site:

```ts
// auth.service.ts — role field
role: validated.role as Role;

// customer.service.ts — tags field
tags: (data.tags ?? []) as CustomerTag[];

// product.service.ts — status field in create()
status: validated.status as ProductStatus;
```

These casts are correct — Zod already validated the values; the assertions only satisfy
Mongoose's type checker. Do not remove them.

### Mappers

Every module has a `mapOrder()` / `mapProduct()` etc. that converts raw `OrderLike` (ObjectIds as `Types.ObjectId`) to `SafeOrder` (IDs as strings). Resolvers return mapped types, never raw documents.

### Atomic sequential order numbers

```ts
const counter = await CounterModel.findOneAndUpdate(
  { _id: "orderNumber" },
  { $inc: { seq: 1 } },
  { new: true, upsert: true },
).lean<{ seq: number } | null>();
// Produces: SALO-100001, SALO-100002, ...
```

---

## Order module specifics

### Status state machine

```
pending → confirmed → processing → shipped → delivered (terminal)
pending → confirmed → processing → cancelled (terminal)
```

### Cancellation — use `cancelOrder` only

`updateOrderStatus` rejects `"cancelled"` (`BadRequestError`). Cancel via `cancelOrder` so inventory restoration and LTV decrement run together.

### Inventory deduction — wrapped in transaction

The `confirmed` transition runs pre-check + deduction inside `mongoose.withTransaction()`. Throws inside the callback abort atomically — no per-item rollback needed.

### Optional order schema fields

```ts
outstandingBalance?: number   // Running balance owed — updated manually by owner
trackingNumber?: string       // Carrier guide number
estimatedDelivery?: string    // e.g. "Jueves 8 de mayo"
```

### `safeUpdateLifetimeValue` rules

Tracks RECEIVED revenue. +total on payment confirmed (`updatePaymentStatus` → `paid`);
−total on cancel only when `paymentStatus` was `paid`. NOT
called on create. `assignCustomerToOrder`/`deleteOrder` still apply status-based ±total
(legacy, not payment-gated — see debt). Accepts `Types.ObjectId | null | undefined` —
null/undefined = skip, non-fatal.

### Field name: `productName`, not `name`

The `orderItemSchema` stores `productName: String`. Any code mapping order items must use `i.productName`, not `i.name`.

---

## Customer module specifics

### Phone normalization

Always normalize to digits-only before any query or upsert. Pre-save hooks do NOT run on `findOneAndUpdate`.

### `lifetimeValue` field

```ts
lifetimeValue?: number   // undefined for new customers — NOT 0
```

**VIP thresholds:**

- `>= $50,000 MXN` → VIP — maximum flexibility, priority treatment
- `>= $10,000 MXN` → returning customer — warm confident tone
- `undefined` / `0` → new customer — standard onboarding

---

## Environment variables

Validated in `src/config/env.ts`. Never access `process.env` directly outside this file.

**Required:**

```
MONGODB_URI
NODE_ENV
PORT
JWT_SECRET                        # min 32 chars, must differ from refresh secret
JWT_REFRESH_SECRET                # min 32 chars
JWT_EXPIRES_IN                    # e.g. 15m
JWT_REFRESH_EXPIRES_IN            # e.g. 7d
ANTHROPIC_API_KEY
WEBHOOK_SECRET                    # min 16 chars — Meta webhook validation
BUFFER_WEBHOOK_SECRET             # min 16 chars — n8n buffer endpoint validation
WHATSAPP_ACCESS_TOKEN             # Meta permanent access token for media downloads
CORS_ORIGIN                       # comma-separated origins or * (blocked in production)
```

**Optional with defaults:**

```
BCRYPT_SALT_ROUNDS                # default 12 (range 10–14)
RATE_LIMIT_WINDOW_MS              # default 900000 (15 min)
RATE_LIMIT_MAX_REQUESTS           # default 100
WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS  # default 55000 — must be < n8n Wait node duration
BANK_ACCOUNT_IMAGE_URL            # Cloudinary URL for bank account image card
```

**Optional — Embedded Signup (add before ES goes live):**

```
META_APP_ID        # Meta App ID: 2300378030444599
                   # Required for Embedded Signup token exchange endpoint
META_APP_SECRET    # From App Dashboard > Basic settings
                   # Used to exchange the 30s code for a long-lived boutique token
SYSTEM_USER_TOKEN  # System User SALO (ID: 61577448959274) master token
                   # Used for platform-level Meta API calls (subscribe WABA, etc.)
```

**Per-boutique credentials (now in MongoDB, not env vars):**

After `seed-boutique.ts` runs, these values live in the `boutiques` collection per
tenant. The env vars below are FALLBACK for the first boutique only:

```
WHATSAPP_ACCESS_TOKEN   # Fallback token for tenant #1 (Axel) only
BANK_ACCOUNT_IMAGE_URL  # Fallback bank image URL for tenant #1 only
```

For all boutiques added via Embedded Signup, credentials live exclusively
in `boutique.accessToken` and `boutique.bankAccountImageUrl`.

**CORS_ORIGINS** is computed from CORS_ORIGIN at startup:

- `"*"` → exports `true` (allow all — development only, blocked in production)
- `"https://a.com,https://b.com"` → exports `string[]`

The `cors()` middleware in `app.ts` receives `CORS_ORIGINS` (typed `string[] | true`), not the raw string.

---

## WhatsApp bot (Luis)

### Identity and persona

- **Model:** `claude-sonnet-4-6`
- **Persona:** warm, casual, boutique salesperson — Spanish only
- **Memory:** 20-turn rolling window (`MAX_CONVERSATION_TURNS = 20`)
- **Brands:** Alo Yoga, Lululemon, Wiskii, 437, Better Me, Skims — all 6 always
- **Backend never calls the WhatsApp API directly** — all Meta credentials are in n8n

### Intent enum — complete

```ts
type ClaudeIntent =
  | "catalog_query" // broad question — ask for specifics, NEVER call search_products
  | "product_search" // search_products tool called and returned results
  | "price_query" // price question — answer directly
  | "create_order" // customer confirmed product + size + color
  | "order_status" // order / shipping / tracking question
  | "order_summary" // customer asks to see full accumulated order list
  | "showroom_visit" // customer wants to visit in person
  | "payment_info" // how/where to pay — bank image sent automatically
  | "payment_receipt" // customer sent a comprobante
  | "needs_human" // requires owner decision
  | "general"; // greetings, reactions, ambiguous
```

Changing this enum requires updating: `claude.service.ts`, `webhook.service.ts`, this document.

### ClaudeContext — current shape

Full type in `claude.service.ts`. Carries `customerName`, `customerGender`, `customerLifetimeValue?`, `recentOrder`, `searchProducts`, `incomingMessage`, `conversationHistory`, and `businessInfo` (`showroomAddress`, `businessHours`, `shippingPrice`, `paymentMethods`, `depositPercent`, `paymentDays`, `deliveryInfo`, `activePromotion?` — `activePromotion` stored per-boutique in `boutique.businessInfo`).

### Image suppression rule

Product images flow ONLY when `result.intent === "product_search"`. Other intents suppress accumulated images — avoids galleries during availability checks, payment flows, or context recall.

### ⭐️ format — required for cart extraction

When Luis confirms availability or gives payment info, product lines MUST use the format `⭐️Jersey Accolade Negro | Talla M | $1,990`. `extractCartFromHistory()` finds cart items in three passes: ⭐️ lines → natural-language price mentions → `[Producto exacto seleccionado por el cliente: NAME]` tag (each only if the prior found nothing). Missing ⭐️ format = bot re-asks product on receipt (bad UX).

### System tags in conversation history

These tags are injected into stored turns by the backend. Claude reads them for context. Never forward them to the customer.

| Tag | Location | Meaning |
| ------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------ |
| `[payment_info_sent]` | End of assistant turn | Bank account info was sent. Used by `hasRecentPaymentInfoContext()` for receipt detection. |
| `[Comprobante de pago enviado por el cliente]` | User turn | Customer sent receipt. Claude must NOT ask which product. |
| `[Productos enviados al cliente en este turn: ...]` | User turn | Gallery products shown. Prevents re-searching. |
| `[El cliente esta respondiendo a una imagen del gallery anterior]` | User turn prefix | Gallery reply — NEVER call `search_products`. |
| `[Producto exacto seleccionado por el cliente: NAME]` | User turn prefix | Exact selected product. Respond only about that product. |

### Receipt detection — dual signal

`isLikelyReceipt` = `hasRecentPaymentInfoContext()` finds `[payment_info_sent]` OR caption matches receipt phrases → skips `searchProductsByImage`, receipt ack.

### JSON sanitizer

`sanitizeJsonNewlines()` escapes bare `\n`/`\r` in JSON strings before `JSON.parse` (prevents SAFE_FALLBACK on ⭐️ summaries). Never replace with regex (NEVER rules).

### Markdown fence stripper

`stripMarkdownFences()` strips ` ```json ``` ` fences and runs BEFORE `sanitizeJsonNewlines()`. Never remove it or reorder the two (see NEVER rules). In `claude.service.ts`.

### JSON reminder injection

`JSON_REMINDER` appended to every user message (last thing Claude reads); keeps JSON on buffered turns. In `claude.service.ts`; never remove.

### Message flow

```
Meta webhook → n8n → POST /api/webhooks/whatsapp
  → webhook.controller → webhook.service → claude.service
  → reply + productImages + escalate + escalationMessage → n8n
  → n8n sends WhatsApp reply / images / bank account image / owner alert
```

---

## WhatsApp buffer system

### Architecture

MongoDB-backed (`conversationbuffers` collection). Survives container restarts.

### Endpoints

Both require `x-webhook-secret` header validated by `requireBufferWebhookSecret`.

```
POST /api/webhooks/whatsapp/buffer/push
POST /api/webhooks/whatsapp/buffer/claim
```

### Push body & claim response

Push + claim payloads are field-exhaustive (n8n contract) — see `buffer.controller.ts`.

`messageType` is `"image"` if ANY buffered message was an image.
`imageMediaId` is the first non-null media ID across all buffered messages.
`shouldRespond: true` is required — n8n checks for it explicitly.

### Timing

n8n Wait **60s**; `ELAPSED_THRESHOLD_MS` **55,000ms** (5s headroom intentional — prod bug if removed). Test: both at 5s.

---

## GraphQL schema structure

All typeDefs use `extend type Query` / `extend type Mutation` — merged in `src/graphql/schema/index.ts`.

---

## Testing

Vitest + supertest + mongodb-memory-server (no Jest — NodeNext ESM). Run `npm test`.

- `src/__tests__/setup.ts` — in-memory MongoDB + env bootstrap; all external APIs mocked.
- `src/__tests__/integration/webhook.test.ts` — 15 tests: gate, prospects, buffer, set-human-mode.
- Fixtures/mocks: seeded boutique, n8n payloads, Claude/alert/image-search stubs.
- Scripts: `test`, `test:watch`, `test:coverage`, `test:integration`.
- Evals: `src/evals/` — offline prompt-quality harness over real processMessage; `npm run eval [-- keyword]`.
- CI: `.github/workflows/ci.yml` — typecheck + integration tests on every PR/push to main.

---

## Known technical debt (deferred)

| Item                                                                                                                 | Risk                                                                                                                            | Status                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Dedup in Extract Message uses n8n static data                                                                        | Lost on container restart                                                                                                       | Open                                                                                                                   |
| `searchProductsForClaude` color regex is unanchored                                                                  | Regex special chars in Claude output = MongoError                                                                               | Open                                                                                                                   |
| `webhook.service.ts` orchestrator ~1387 lines (pure helpers extracted), 7+ responsibilities                                                             | High regression risk on any change                                                                                              | Open — post-launch refactor                                                                                            |
| Products fetched before intent known                                                                                 | Wasteful at scale                                                                                                               | Open                                                                                                                   |
| `extractCartFromHistory` is regex-driven                                                                             | Any prompt change silently regresses receipt acks                                                                               | Deferred — structural fix post-demo                                                                                    |
| `updateProduct` missing inventory cleanup on variant removal                                                         | Orphaned inventory records                                                                                                      | Deferred                                                                                                               |
| Server-side pagination on orders/customers/products                                                                  | Fixed slice limits at scale                                                                                                     | Deferred                                                                                                               |
| Conversation control system (ai/human/paused gate)                                                                  | Owner and bot can reply simultaneously                                                                                          | **In progress** — `conversationState` gate + new-prospect/receipt alerts live; owner auto-takeover detection pending    |
| Token revocation not implemented                                                                                     | Stolen refresh token valid until expiry                                                                                         | Accepted for V1                                                                                                        |
| n8n `showroom_visit` has no dedicated escalation branch                                                              | Owner sees generic text                                                                                                         | Deferred                                                                                                               |
| `order.service.ts` fetchProductSnapshots queries products without `boutiqueId` (by `_id`) | Cross-tenant if a wrong `_id` is passed | **Resolved** — optional `boutiqueId` param added + passed by createOrder/resolvers || n8n SALO Backend node missing `phoneNumberId` in JSON body                                                           | Messages without `phoneNumberId` are dropped (early-return, no reply, WARN logged) — fallback shim removed                                               | **Pending — add `"phoneNumberId": "{{ $json.phoneNumberId }}"` to SALO Backend node body**                             |
| Owner-reply detection not wired (coexistence handoff) | Owner + bot can reply at once; no auto-flip to `human` | Blocked — needs n8n to forward status/echo events with `recipient_id` |
| `human_takeover_needed` / `prospect_stage_changed` alerts defined but never sent | Owner gets no handoff or stage-change notification | Wire call sites on escalate/pause and stage change |
| `alert.service.ts` calls WhatsApp Graph API directly | Breaks "all Meta creds in n8n" invariant; token used in backend | Accepted for owner alerts; revisit if alerts move to n8n |
| Two conversation models (`ConversationState` vs `Conversation`) | Duplicate state; divergent mode semantics (ai/human/paused vs auto/manual) | Consolidate post-MVP |
| `setHumanMode` endpoint has no caller | Endpoint exists but nothing invokes it | Wire n8n/app to call on owner takeover |
| `product_search` 0 results auto-escalates | Conflicts with new text-reply prompt guidance | Reconcile in `webhook.service.ts` |
| browse-all `*` block duplicates the inventory join in `searchProductsForClaude` | Two joins can drift | Refactor to a shared helper |
| Broad/inventory routing now always round-trips to Claude | API cost+latency; depends on model routing | Monitor misroutes and cost |
| `[payment_info_sent]` now fires at PASO 2 (after confirmation) | Early receipt not context-detected | Rely on caption |
| `owner-confirm` needs n8n to parse "CONFIRMAR PAGO" + send secret/creds | Unusable until n8n wired | Wire n8n command parsing |
| Receipt without orderHints stores cart size/color as `?` | owner-confirm can't resolve → manual order | Capture full variant on receipt |
| LOOKUP_BY_BOUTIQUE still used when owner omits phone | Ambiguous if >1 pending (now refused) but single-pending silently picks | Always pass customerPhone in CONFIRMAR PAGO command |
| Receipt color/size parser is heuristic | Wrong/empty color fails inventory match | Capture variant at source |
| Eval hits real `MONGODB_URI` + spends real Claude credits | Prod connection / cost | Gate behind test DB/flag |
| `MOCK_SEARCH_PRODUCTS` ignores keyword (always Jersey) | Weak search coverage | Make it keyword-aware |
| `boutique.accessToken` is select:false but still plaintext in MongoDB | DB breach exposes tokens | Encrypt at rest (AES) before tenant #2 |
| SAFE_FALLBACK now escalates on every path (incl. timeout/api_error) | Owner-alert noise on Claude blips | Retry/dedup before escalating |
| `assignCustomerToOrder`/`deleteOrder` LTV deltas are status-based, not payment-gated | Counts unpaid revenue; inconsistent with received-revenue model | Gate on `paymentStatus === "paid"` |

---

## What NOT to do

- Never put business logic in resolvers
- Never put GraphQL types in service files
- Never access `process.env` directly — use `src/config/env.ts`
- Never return raw Mongoose documents from services — always map to safe types
- Never use relative `../../` imports across module boundaries — use `#/` aliases
- Never skip `.js` extension in imports (NodeNext ESM requirement)
- Never redefine `objectIdSchema` — import from `#/shared/validation/common.validation.js`
- Never change the buffer elapsed threshold without also updating the n8n Wait node
- Never remove `shouldRespond: true` from the claim success response
- Never change `ORDER_NUMBER_PREFIX` without migrating existing order numbers
- Never query `customer.phone` without normalizing to digits-only first
- Never add `sourceMessageId` to `createOrderSchema` — it is a service-layer parameter
- Never add/remove a `ClaudeIntent` without updating all three required places
- Never call `search_products` for `order_summary`
- Never escalate `payment_info` to the owner
- Never leave `/owner-confirm` unauthenticated — it creates orders and sends WhatsApp
- Never accept accessToken or phoneNumberId in the owner-confirm body — read them from the boutique
- Never call createOrder in owner-confirm without first checking for an existing order scoped to the same customerId — guard against double-confirm
- Never read `boutique.accessToken` without `.select("+accessToken")` — it is select:false by default
- Never send the bank image on first payment ask — confirm explicitly (PASO 2) first
- Never cast a Mongoose lean document directly to `Record<string, unknown>` — cast through `unknown`
- Never read `lifetimeValue === 0` as "new customer" — it is `undefined` for new customers
- Never use `i.name` for order items — the schema field is `productName`
- Never hardcode only "Alo Yoga, Lululemon, Wiskii" — current catalog includes 437, Better Me, Skims
- Never replace `sanitizeJsonNewlines()` with a regex approach
- Never suppress images based only on `isGalleryReply` — suppression is intent-based globally
- Never forward `[payment_info_sent]` tag to the customer
- Never pass `CORS_ORIGIN` (raw string) to `cors()` — use `CORS_ORIGINS` (typed `string[] | true`)
- Never add a new cancellation path without running inventory restoration and LTV decrement
- Never use `as never` casts — fix the underlying type instead
- Never query customers, orders, conversations, products, or inventory without
  filtering by `boutiqueId` — cross-boutique data leakage
- Never accept `boutiqueId` as a GraphQL argument from the client — always
  read it from `context.user.boutiqueId` (signed into JWT at login)
- Never expose `boutique.accessToken` in any GraphQL resolver response
- Never put per-boutique config (showroomAddress, shippingPrice, etc.) back in
  env vars — it belongs in `boutique.businessInfo` in MongoDB
- Never add `unique: true` directly on the `phone` or `instagramHandle` fields
  in customer.model.ts — uniqueness is scoped per boutique via compound indexes- Never remove `stripMarkdownFences()` from claude.service.ts
- Never remove the `JSON_REMINDER` injection from claude.service.ts
- Never register a second Mongoose model named `"Conversation"` — the gate model is `ConversationState`
- Never blanket short-circuit image messages — preserve visual search and gallery-reply flows
- Never import from webhook.service.ts directly — use the focused sub-modules (webhook.cart, webhook.escalation, webhook.schemas, webhook.product-search) for their respective concerns
- Never let `sendOwnerAlert` throw or log `accessToken` — alerts must never break the webhook flow
- Never read conversationState mode without first running `checkAndApplyAutoResume`
- Never log `customerPhone` unmasked in `setHumanMode` — mask all but last 4 digits via `maskPhone`
- Never call the real Claude/WhatsApp/Graph API in tests — mock claude/alert/image-search services
- Never set env vars after the imports in `setup.ts` — `env.ts` validates at import and exits on miss
- Never send `imageCaption: null` in a webhook payload — the schema requires a string; use `""`
- Never silence a SAFE_FALLBACK — all failure paths (timeout, api_error, max_tokens, non_json, schema_fail, loop_exhausted) must escalate to the owner
- Never answer size/talla questions in plain text — always JSON (intent: general)
- Never confirm or perform an order cancellation — always escalate (intent: needs_human)
