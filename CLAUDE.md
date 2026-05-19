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

GraphQL API backend for SALO — a clothing reseller automation system for a boutique in Guadalajara, Mexico. Handles orders, inventory, customers, products, authentication, and a WhatsApp bot powered by Claude AI ("Luis").

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
npm run build      # tsc + tsc-alias (resolves # path aliases in dist/)
npm run start      # node dist/server.js (production)
npm run typecheck  # tsc --noEmit (type check only)
npm run clean      # rm -rf dist
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
│       ├── buffer.controller.ts      # Express controller for buffer push/claim endpoints
│       ├── buffer.service.ts         # Buffer push/claim logic — MongoDB-backed
│       ├── claude.service.ts         # Claude AI — intent detection + response generation
│       ├── image-search.service.ts   # Visual product search via image media ID
│       ├── logSentImage.controller.ts # Logs sent product images for gallery reply resolution
│       ├── webhook.auth.ts           # requireBufferWebhookSecret middleware
│       ├── webhook.controller.ts     # Express controller for Meta webhook
│       ├── webhook.router.ts         # Mounts all /api/webhooks/whatsapp routes
│       ├── webhook.service.ts        # Orchestrates full bot flow (1900+ lines — FRAGILE)
│       └── webhook.validation.ts     # Zod schemas for Meta payload
├── modules/
│   ├── auth/                         # JWT auth, login, refresh, password
│   ├── conversations/
│   │   ├── conversation-buffer.model.ts  # MongoDB buffer for message accumulation
│   │   └── conversation.model.ts         # Conversation memory (20-turn rolling window)
│   ├── customers/                    # Customer CRUD + lifetimeValue cache
│   ├── inventory/                    # Stock tracking per variant
│   ├── orders/                       # Order lifecycle management
│   ├── products/                     # Product catalog
│   └── sentImages/
│       └── sentImage.model.ts        # Maps WhatsApp message IDs to product captions
│                                     # Used for gallery reply product resolution
├── scripts/
│   └── backfill-inventory.ts         # One-off data migration script
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

Every domain module follows the same 5-file pattern:

```
module.model.ts       # Mongoose schema + model
module.types.ts       # TypeScript types, enums, constants
module.validation.ts  # Zod schemas for all inputs
module.service.ts     # Business logic — only file that touches the DB
module.resolvers.ts   # GraphQL resolvers — auth guards + delegates to service
module.typeDefs.ts    # GraphQL SDL (extends Query / extends Mutation)
```

**Rule:** Resolvers never contain business logic. Services never contain GraphQL types. Validation always lives in the validation file — never inline in the service.

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

The cluster is MongoDB Atlas (`setName` confirmed present). `mongoose.withTransaction()` is supported and used in `order.service.ts` for inventory deduction.

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

These casts are correct — Zod has already validated the values. The assertions only satisfy
Mongoose's generic type checker. Do not remove them.

### Mappers

Every module has a `mapOrder()` / `mapProduct()` etc. function that converts raw `OrderLike` (ObjectIds as `Types.ObjectId`) to `SafeOrder` (all IDs as strings). Resolvers always return mapped types, never raw documents.

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

`updateOrderStatus` rejects `"cancelled"` with a `BadRequestError`. Cancellation must go through `cancelOrder` so inventory restoration and LTV decrement run together.

### Inventory deduction — wrapped in transaction

The `confirmed` transition runs pre-check + deduction inside `mongoose.withTransaction()`. Throws inside the callback abort atomically — no manual per-item rollback needed.

### Optional order schema fields

```ts
outstandingBalance?: number   // Running balance owed — updated manually by owner
trackingNumber?: string       // Carrier guide number
estimatedDelivery?: string    // e.g. "Jueves 8 de mayo"
```

### `safeUpdateLifetimeValue` rules

```ts
// On create (new orders only — not duplicate recovery):
await safeUpdateLifetimeValue(order.customerId, order.total, "Order created");

// On cancel:
await safeUpdateLifetimeValue(
  order.customerId,
  -order.total,
  "Order cancelled",
);

// On hard delete (non-cancelled only):
if (order.status !== "cancelled") {
  await safeUpdateLifetimeValue(
    order.customerId,
    -order.total,
    "Order hard-deleted",
  );
}

// On customer assign (non-cancelled only):
if (order.status !== "cancelled") {
  await safeUpdateLifetimeValue(
    order.customerId,
    order.total,
    "Customer assigned",
  );
}
```

Accepts `Types.ObjectId | null | undefined` — all safe (null/undefined = skip, non-fatal).

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

**Deferred — not yet wired:**

```
ACTIVE_PROMOTION   # Wire to env.ts as z.string().optional() when ready
                   # Used by businessInfo.activePromotion in ClaudeContext
```

**CORS_ORIGINS** is computed from CORS_ORIGIN at startup:

- `"*"` → exports `true` (allow all — development only, blocked in production)
- `"https://a.com,https://b.com"` → exports `string[]`

The `cors()` middleware in `app.ts` receives `CORS_ORIGINS` (typed `string[] | true`), not the raw `CORS_ORIGIN` string.

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

```ts
type ClaudeContext = {
  customerName: string | null;
  customerGender: "female" | "male" | "unknown";
  customerLifetimeValue?: number;
  recentOrder: {
    orderNumber: string;
    status: string;
    total: number;
    outstandingBalance?: number;
    trackingNumber?: string;
    estimatedDelivery?: string;
    items?: OrderItem[];
  } | null;
  searchProducts: SearchProductsFn;
  incomingMessage: string;
  conversationHistory: ConversationTurnInput[];
  businessInfo: {
    showroomAddress: string;
    businessHours: string;
    shippingPrice: number;
    paymentMethods: string;
    depositPercent: number;
    paymentDays: number;
    deliveryInfo: string; // e.g. "3 a 7 dias habiles una vez confirmado el pago"
    activePromotion?: string; // DEFERRED — wire to ACTIVE_PROMOTION env var when ready
  };
};
```

### Image limits

```ts
const MAX_PRODUCTS_PER_SEARCH = 4;
const MAX_IMAGES_PER_PRODUCT = 5; // matches product UI 5-slot design
const MAX_IMAGES_TOTAL = 20; // 4 × 5
```

### Image suppression rule

Product images flow ONLY when `result.intent === "product_search"`. All other intents suppress accumulated images — prevents product gallery during availability checks, payment flows, or context-recall responses.

### ⭐️ format — required for cart extraction

When Luis confirms availability or gives payment info, product lines MUST use:

```
⭐️Jersey Accolade Negro | Talla M | $1,990
```

`extractCartFromHistory()` uses a three-pass approach to find cart items:

1. Primary: scan all assistant turns for ⭐️ lines
2. Secondary: natural language price mentions (only if primary found nothing)
3. Tertiary: `[Producto exacto seleccionado por el cliente: NAME]` tag (only if secondary found nothing)

Missing ⭐️ format = bot asks customer to re-confirm product on receipt — bad UX.

### System tags in conversation history

These tags are injected into stored turns by the backend. Claude reads them for context. Never forward them to the customer.

| Tag                                                                | Location              | Meaning                                                                                    |
| ------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------ |
| `[payment_info_sent]`                                              | End of assistant turn | Bank account info was sent. Used by `hasRecentPaymentInfoContext()` for receipt detection. |
| `[Comprobante de pago enviado por el cliente]`                     | User turn             | Customer sent receipt. Claude must NOT ask which product.                                  |
| `[Productos enviados al cliente en este turn: ...]`                | User turn             | Gallery products shown. Prevents re-searching.                                             |
| `[El cliente esta respondiendo a una imagen del gallery anterior]` | User turn prefix      | Gallery reply — NEVER call `search_products`.                                              |
| `[Producto exacto seleccionado por el cliente: NAME]`              | User turn prefix      | Exact selected product. Respond only about that product.                                   |

### Receipt detection — dual signal

```ts
isLikelyReceipt = isReceiptByContext || isReceiptByCaption;
```

- **Context:** `hasRecentPaymentInfoContext()` finds `[payment_info_sent]` in last 20 turns
- **Caption:** customer text matches receipt phrases

Either signal skips `searchProductsByImage` and routes to receipt acknowledgment.

### JSON sanitizer

`sanitizeJsonNewlines()` — character-by-character state machine that escapes bare `\n`/`\r` inside JSON string values before `JSON.parse`. Prevents SAFE_FALLBACK when Claude generates multi-line ⭐️ summaries. Do NOT replace with a regex approach — regex only handles single newlines per string.

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

### Push body — all fields required

```json
{
  "from": "5213328205715",
  "message": "busco leggings negros",
  "executionId": "179",
  "messageId": "wamid.xxx",
  "messageType": "text",
  "imageMediaId": null,
  "imageCaption": "",
  "contactName": "Axel Monterrubio",
  "timestamp": "1776813588624"
}
```

### Claim success response — all fields required by n8n

```json
{
  "skip": false,
  "shouldRespond": true,
  "mergedMessage": "busco leggings negros\ntalla S",
  "messageCount": 2,
  "messageType": "image",
  "imageMediaId": "wamid.xxx",
  "imageCaption": "",
  "contactName": "Axel Monterrubio"
}
```

`messageType` is `"image"` if ANY buffered message was an image.
`imageMediaId` is the first non-null media ID across all buffered messages.
`shouldRespond: true` is required — n8n checks for it explicitly.

### Timing

- n8n Wait: **60 seconds**
- `ELAPSED_THRESHOLD_MS`: **55,000ms** (5s headroom is intentional — confirmed production bug if removed)
- Testing: set `WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS=5000` and n8n Wait to 5s

---

## Image search service

`searchProductsByImage` returns `Array<{ url: string; caption?: string }>` — not `string[]`.

Empty URL filtering is applied before mapping:

```ts
((p.images ?? []) as string[])
  .filter(
    (url): url is string => typeof url === "string" && url.trim().length > 0,
  )
  .map((url, idx) => ({ url, caption: idx === 0 ? caption : undefined }))
  .slice(0, 5);
```

---

## GraphQL schema structure

All typeDefs use `extend type Query` / `extend type Mutation` — merged in `src/graphql/schema/index.ts`.

---

## Known technical debt (deferred)

| Item                                                                  | Risk                                              | Status                              |
| --------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------- |
| Dedup in Extract Message uses n8n static data                         | Lost on container restart                         | Open                                |
| `recentImageMessageIds` Set in webhook.service.ts                     | Memory growth, not horizontally scalable          | Open                                |
| `searchProductsForClaude` color regex is unanchored                   | Regex special chars in Claude output = MongoError | Open                                |
| `webhook.service.ts` is 1900+ lines, 7+ responsibilities              | High regression risk on any change                | Open — post-launch refactor         |
| Products fetched before intent known                                  | Wasteful at scale                                 | Open                                |
| `extractCartFromHistory` is regex-driven                              | Any prompt change silently regresses receipt acks | Deferred — structural fix post-demo |
| `updateProduct` missing inventory cleanup on variant removal          | Orphaned inventory records                        | Deferred                            |
| Server-side pagination on orders/customers/products                   | Fixed slice limits at scale                       | Deferred                            |
| Conversation control system (bot_active/waiting_owner/human_takeover) | Owner and bot can reply simultaneously            | Deferred post-demo                  |
| `lifetimeValue` semantics = expected revenue, not received            | Differs from dashboard cancelled-order exclusion  | Documented gap                      |
| Token revocation not implemented                                      | Stolen refresh token valid until expiry           | Accepted for V1                     |
| `ACTIVE_PROMOTION` env var not wired                                  | Cannot toggle a promotion without redeploy        | Deferred                            |
| n8n `showroom_visit` has no dedicated escalation branch               | Owner sees generic text                           | Deferred                            |

---

## Security — confirmed clean in audit

- Webhook secret validation: `timingSafeEqual` with length pre-check and 512-byte cap ✅
- MongoDB query injection: all IDs through `objectIdSchema`, filters constructed field-by-field ✅
- API keys in logs: pino redact list covers all sensitive fields, SDK does not log by default ✅
- Unhandled promise rejections: `process.on('unhandledRejection', exit)` in server.ts ✅
- Mass assignment: Zod strips unknown fields on all mutations ✅
- CORS wildcard: rejected in production at startup ✅

**Two areas to watch:**

- Rate limit applies to the webhook — n8n may hit 429 on bursty days (consider per-route exemption)
- Token revocation deferred — stolen refresh token valid until natural expiry

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
