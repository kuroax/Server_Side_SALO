# CLAUDE.md — Server_Side_SALO Backend

## Project overview

GraphQL API backend for SALO — a clothing reseller automation system for a boutique in Guadalajara, Mexico. Handles orders, inventory, customers, products, authentication, and a WhatsApp bot powered by Claude AI ("Luis").

**Deployed on Railway:** `https://serversidesalo-production.up.railway.app`

---

## Tech stack

| Layer      | Choice                                             |
| ---------- | -------------------------------------------------- |
| Runtime    | Node.js (ESM, `"type": "module"`)                  |
| Language   | TypeScript 5, `target: ES2022`, `module: NodeNext` |
| API        | Apollo Server 5 + Express 5 + GraphQL 16           |
| Database   | MongoDB via Mongoose 9                             |
| Validation | Zod v4                                             |
| Auth       | JWT + refresh tokens (bcryptjs)                    |
| AI         | Anthropic SDK (`@anthropic-ai/sdk`)                |
| Logging    | Pino + pino-http                                   |
| Security   | Helmet, CORS, express-rate-limit                   |
| Dev        | tsx + nodemon, tsc-alias                           |

---

## Scripts

```bash
npm run dev        # tsx watch mode — hot reload on src/**/*.ts changes
npm run build      # tsc + tsc-alias (resolves # path aliases in dist/)
npm run start      # node dist/server.js (production)
npm run typecheck  # tsc --noEmit (no emit, type check only)
npm run clean      # rm -rf dist
```

---

## Path aliases

Defined in both `package.json#imports` and `tsconfig.json#paths`:

```ts
import { something } from "#/shared/utils/auth.guards.js"; // maps to src/shared/utils/auth.guards.ts
```

Always use `#/` imports, never relative `../../` paths across module boundaries. Always include the `.js` extension in imports (NodeNext requirement).

---

## Directory structure

```
src/
├── server.ts                         # Entry point — Express + Apollo bootstrap
├── app.ts                            # Express app factory
├── config/
│   ├── db.ts                         # Mongoose connect
│   ├── env.ts                        # Zod-validated env vars
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
│       ├── webhook.auth.ts           # requireBufferWebhookSecret middleware
│       ├── webhook.controller.ts     # Express controller for Meta webhook
│       ├── webhook.router.ts         # Mounts all /api/webhooks/whatsapp routes
│       ├── webhook.service.ts        # Orchestrates bot flow
│       └── webhook.validation.ts     # Zod schemas for Meta payload
├── modules/
│   ├── auth/                         # JWT auth, login, refresh, password
│   ├── conversations/
│   │   ├── conversation-buffer.model.ts  # MongoDB buffer for message accumulation
│   │   └── conversation.model.ts         # Conversation memory for WhatsApp bot
│   ├── customers/                    # Customer CRUD
│   ├── inventory/                    # Stock tracking per variant
│   ├── orders/                       # Order lifecycle management
│   └── products/                     # Product catalog
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
// In resolvers — always first line of every resolver
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
  const data = createOrderSchema.parse(input); // throws ZodError on invalid input
  // ... rest of logic uses typed `data`
}
```

Shared primitives live in `src/shared/validation/common.validation.ts` — import `objectIdSchema` from there, never redefine it.

Zod v4 uses `{ error: 'message' }` instead of `{ message: 'message' }` in validators:

```ts
z.string({ error: "Must be a string" }).min(1, { error: "Required" });
```

---

## Error handling

Use typed error classes from `#/shared/errors/index.js`:

```ts
throw new NotFoundError("Order not found");
throw new BadRequestError("Cannot transition order from pending to delivered");
throw new AuthenticationError("Invalid token");
throw new AuthorizationError("Insufficient role");
```

All extend `AppError` which Apollo Server picks up and maps to GraphQL errors automatically.

---

## MongoDB patterns

### Atomic sequential order numbers

```ts
// counters collection: { _id: 'orderNumber', seq: 100000 }
// Seed: db.counters.insertOne({ _id: 'orderNumber', seq: 100000 })
const counter = await CounterModel.findOneAndUpdate(
  { _id: "orderNumber" },
  { $inc: { seq: 1 } },
  { new: true, upsert: true },
).lean<{ seq: number } | null>();
// Produces: SALO-100001, SALO-100002, ...
```

### Always use `.lean()` for reads

```ts
const order = await OrderModel.findById(id).lean<OrderLike>();
```

### Always use typed lean generics

Define a `*Like` type matching the raw Mongoose document shape and pass it as the generic to `.lean<T>()`.

### Casting lean documents to extended shapes

When the webhook reads optional fields from a strongly-typed Mongoose lean document,
cast through `unknown` first — direct `as Record<string, unknown>` on a typed document
causes `ts(2352)`:

```ts
// WRONG — ts(2352): Index signature missing
(recentOrder as Record<string, unknown>).trackingNumber(
  // CORRECT — double-cast through unknown
  recentOrder as unknown as Record<string, unknown>,
).trackingNumber as string | undefined;
```

### Mappers

Every module has a `mapOrder()` / `mapProduct()` etc. function that converts raw `OrderLike` (ObjectIds as `Types.ObjectId`) to `SafeOrder` (all IDs as strings). Resolvers always return mapped types, never raw documents.

---

## Order module specifics

### Status state machine

```
pending → confirmed → processing → shipped → delivered (terminal)
pending → confirmed → processing → cancelled (terminal)
```

Enforced via `VALID_TRANSITIONS` map — `assertValidTransition()` throws `BadRequestError` on illegal moves.

### Inventory lifecycle

Inventory is reserved when an order moves to `confirmed` and released on `cancelled`. The `inventoryApplied` boolean on the order document guards against double-decrement. Gates V2 RESERVE/RELEASE operations.

### Order schema — current fields

The order schema includes three fulfillment fields added to support the Luis bot's
`order_status` and `order_summary` intents. They are all optional (`default: undefined`)
so existing orders are unaffected:

```ts
outstandingBalance?: number   // Running balance owed. Updated by owner on each partial payment.
                              // Bot says "Tu saldo pendiente es $X" when present.

trackingNumber?: string       // Carrier guide number. Set by owner when package ships.
                              // Bot surfaces this when customer asks "¿ya mandaste?"

estimatedDelivery?: string    // Free-text delivery window, e.g. "Jueves 8 de mayo".
                              // Kept as string (not Date) to match how the owner communicates.
```

**When adding items to the order schema, note the field is `productName`, not `name`.**
The `orderItemSchema` stores `productName: String` (a snapshot of the product name at
time of order). Any code that maps order items to Claude's `OrderItem` shape must use
`i.productName`, not `i.name`.

### Updating `outstandingBalance` correctly

`outstandingBalance` is NOT computed automatically. The owner updates it manually each
time they confirm a transfer. The formula is:

```
outstandingBalance = order.total - sum(all confirmed payments received)
```

Update via:

```ts
await OrderModel.findByIdAndUpdate(orderId, {
  $set: { outstandingBalance: remainingAmount },
});
```

### MongoDB indexes on orders

Verify all three indexes exist after deploy:

```js
db.orders.getIndexes();
// Expected:
// { key: { _id: 1 } }                                          — default
// { key: { channel: 1, sourceMessageId: 1 }, unique: true,
//   partialFilterExpression: { sourceMessageId: { $type: 'string' } },
//   name: 'channel_sourceMessageId_unique' }                   — idempotency
// { key: { customerId: 1, createdAt: -1 },
//   name: 'customerId_createdAt_desc' }                        — webhook perf
```

The `customerId_createdAt_desc` index is critical — `webhook.service.ts` runs
`OrderModel.findOne({ customerId }).sort({ createdAt: -1 })` on every incoming
WhatsApp message. Without this index MongoDB does a full collection scan per message.

---

## Customer module specifics

### Phone normalization

```ts
const normalizedPhone = from.replace(/\D/g, '');

await CustomerModel.findOneAndUpdate(
  { phone: normalizedPhone },
  { $setOnInsert: { name, phone: normalizedPhone, contactChannel: 'whatsapp', ... } },
  { upsert: true, new: true, setDefaultsOnInsert: true },
);
```

`$setOnInsert` only writes on document creation — existing customers are never modified by this operation.

### Customer schema — current fields

The customer schema includes a `lifetimeValue` field added to support VIP detection
in the Luis bot without running an aggregation on every WhatsApp message:

```ts
lifetimeValue?: number   // Cached sum of all non-cancelled order totals (MXN).
                         // undefined for customers with no orders yet — NOT 0.
                         // Updated by order.service.ts on order create/complete/cancel.
```

**VIP thresholds used by Luis (`buildVipContext` in `claude.service.ts`):**

- `≥ $50,000 MXN` → VIP: maximum payment flexibility, priority treatment
- `≥ $10,000 MXN` → returning customer: warm confident tone
- `undefined` / `0` → new customer: standard onboarding tone

### Maintaining `lifetimeValue` in `order.service.ts`

This field is a write-through cache — it must be updated whenever an order changes total:

```ts
// On order created or completed — increment:
await CustomerModel.updateOne(
  { _id: customerId },
  { $inc: { lifetimeValue: order.total } },
);

// On order cancelled — decrement:
await CustomerModel.updateOne(
  { _id: customerId },
  { $inc: { lifetimeValue: -order.total } },
);
```

Without these writes, `lifetimeValue` stays `undefined` forever and VIP detection
never activates — even for Natalia-tier customers with $150k+ in orders.

### MongoDB indexes on customers

```js
db.customers.getIndexes();
// Expected:
// { key: { _id: 1 } }
// { key: { phone: 1 }, unique: true, sparse: true }
// { key: { instagramHandle: 1 }, unique: true, sparse: true }
// { key: { isActive: 1, contactChannel: 1 } }
// { key: { tags: 1 } }
// { key: { lifetimeValue: -1 } }    — dashboard sort + future VIP queries
```

---

## WhatsApp bot (Luis)

### Identity and persona

- **Model:** `claude-sonnet-4-20250514`
- **Persona:** warm, casual, boutique salesperson — Spanish only
- **Gender-adaptive tone:**
  - Female / unknown → `"bonita"`, `"bella"`, `"corazón"`, `"linda"`
  - Male (explicit signal detected) → `"amigo"`, `"bro"`, never feminine nicknames
- **Gender detection:** real-time from message content, not just stored `customer.gender`
- **Memory:** 10-turn conversation history via `conversations` collection
- **Escalation:** service returns `escalate: true` → n8n sends owner alert
- **Key rule:** backend never touches the WhatsApp API directly — all Meta credentials live in n8n

### Brands handled

Luis knows and searches for: **Alo Yoga, Lululemon, Wiskii, 437, Better Me, Skims**.
Do not hardcode a shorter list anywhere — all 6 brands must appear in catalog replies
and any brand-list strings in the codebase.

### Lululemon sizing convention

Luis applies this automatically when sizing guidance is needed:

- `XS` = talla 4
- `S` = talla 6
- `M` = talla 8

### Intent system — complete enum

`ClaudeIntent` in `claude.service.ts` has exactly these values:

```ts
type ClaudeIntent =
  | "catalog_query" // Customer asked broadly what the store carries — ask for specifics
  | "product_search" // search_products tool was called and returned results
  | "price_query" // Customer asked for a price — answer directly
  | "create_order" // Customer confirmed a product + size + color — create the order
  | "order_status" // Customer asked about their order, shipping, or tracking
  | "order_summary" // Customer asked to see their full accumulated order list
  | "showroom_visit" // Customer wants to visit the boutique in person
  | "payment_info" // Customer asked how/where to pay — send banking image
  | "payment_receipt" // Customer announced or sent a payment comprobante
  | "needs_human" // Requires owner decision (negotiation, dispute, tight delivery)
  | "general"; // Greetings, reactions, ambiguous messages
```

**Never add or remove intents from this enum without updating ALL of the following:**

1. `claude.service.ts` — `ClaudeIntent` type + `claudeResultSchema` Zod union
2. `webhook.service.ts` — `processMessageResultSchema` Zod enum + intent handler blocks
3. This document

### ClaudeContext shape — complete current definition

```ts
type ClaudeContext = {
  customerName: string | null;
  customerGender: "female" | "male" | "unknown";
  customerLifetimeValue?: number; // From customer.lifetimeValue — drives VIP tone
  recentOrder: {
    orderNumber: string;
    status: string;
    total: number;
    outstandingBalance?: number; // Remaining balance after partial payments
    trackingNumber?: string; // Carrier guide number — shown in order_status
    estimatedDelivery?: string; // Human-readable delivery window
    items?: OrderItem[]; // Line items — powers order_summary
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
    activePromotion?: string; // e.g. "30% Off Alo Yoga hasta el 10 de mayo"
    // Currently hardcoded undefined in BUSINESS_INFO.
    // DEFERRED: wire to ACTIVE_PROMOTION env var.
  };
};

type OrderItem = {
  name: string; // Maps from orderItemSchema.productName — NOT productName.name
  size: string;
  color: string;
  quantity: number;
  price: number; // Maps from orderItemSchema.unitPrice
};
```

### Sales behavior — key techniques baked into the system prompt

The following behaviors are intentional and must not be regressed by prompt edits:

| Technique                  | Trigger                                                   | Behavior                                                                                             |
| -------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Scarcity close             | `search_products` returns 1 result                        | Adds urgency: "última disponible — apártala ahora 🙏🏻"                                                |
| Set completion upsell      | Customer selects a top / bra / tank                       | Bot asks if they want the matching bottom (legging / pants / short) and searches for it              |
| Color swap protocol        | 0 results with color specified                            | Re-calls `search_products` without color, frames as "ese color no está, pero mira qué tonos tenemos" |
| Color recommendation       | Customer hesitates between two colors                     | Recommends the scarcer / newer color explicitly                                                      |
| Delivery urgency detection | Customer mentions a trip/event/date                       | Bot commits to ship date or escalates if date is too tight                                           |
| Negotiation detection      | "cerramos en X", "me lo dejas en X", "me haces descuento" | Always `needs_human` — never accept or reject on bot's own                                           |
| Partial payment acceptance | Customer offers partial deposit                           | Bot accepts warmly: "con $X te la aparto 🙌🏼"                                                         |
| Accessory upsell           | Order about to be confirmed                               | Offers calcetas / guantes / viseras as add-on — one item only                                        |
| Emotional close            | After `create_order`                                      | "Todo lo que escogiste está divino! Te va a encantar! ✨"                                            |
| Promotion mention          | `activePromotion` is set                                  | Mentioned once per conversation when customer is browsing or hesitating                              |

### Intent handling rules — must not change without review

- `catalog_query` → never calls `search_products`. Always asks what type of garment.
- `payment_info` → never escalates to owner. System sends banking image automatically.
- `payment_receipt` with 8+ items → does NOT list all items (hallucination risk). Defers to owner.
- `needs_human` → fires for: negotiation, dispute, tight delivery date, post-delivery exchange, showroom visit coordination.
- `showroom_visit` → escalates so owner knows a visit is coming. Claude already replied with address + hours.
- `order_summary` → compiles from `recentOrder.items` if available, otherwise scans conversation history. Never calls `search_products`.
- `general` → stickers, reactions, ambiguous messages — continue the sale naturally.

### Message flow

```
Meta webhook → n8n (Extract + Accumulate + Wait + Check & Merge)
  → POST /api/webhooks/whatsapp
  → webhook.controller → webhook.service → claude.service
  → reply + productImages + escalate returned to n8n
  → n8n sends WhatsApp reply / images / owner alert
```

---

## WhatsApp buffer system

### Why it exists

Customers send multiple short messages in rapid succession ("hola" → "busco leggings" → "negros talla S"). Without buffering, each message would trigger an independent Claude call with incomplete context. The buffer collects all fragments within a 60-second window and merges them into one coherent message before calling Claude.

### Architecture

The buffer lives in MongoDB (`conversationbuffers` collection), not in n8n static data. This means it survives container restarts and is inspectable.

### Buffer endpoints

Both require the `x-webhook-secret` header validated by `requireBufferWebhookSecret` middleware in `webhook.auth.ts`.

```
POST /api/webhooks/whatsapp/buffer/push
POST /api/webhooks/whatsapp/buffer/claim
```

#### Push — request body

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

#### Push — response

```json
{ "ok": true, "duplicate": false }
```

or if messageId already buffered:

```json
{ "ok": true, "duplicate": true }
```

#### Claim — request body

```json
{
  "from": "5213328205715",
  "executionId": "179"
}
```

#### Claim — response when skipping

```json
{ "skip": true, "reason": "not_owner" }
```

Possible skip reasons: `buffer_not_found`, `elapsed_too_short`, `not_owner`, `empty_merged_message`, `claim_not_granted`.

#### Claim — response when claiming successfully

```json
{
  "skip": false,
  "shouldRespond": true,
  "mergedMessage": "busco leggings negros\ntalla S",
  "messageCount": 2
}
```

**The `shouldRespond` field is required.** n8n's Check & Merge node checks for it explicitly. If absent, the node returns `shouldRespond: false` and the bot never replies.

### Ownership token pattern

Every push overwrites `ownerExecutionId` with the current n8n execution ID. The last execution to push owns the buffer. When claim runs, it only succeeds if `ownerExecutionId === currentExecutionId`. Earlier executions self-discard silently.

This is implemented atomically via `findOneAndDelete` with all conditions in the query filter — no separate find + delete steps.

### Timing — 60s Wait / 55s threshold

- n8n Wait node: **60 seconds**
- `ELAPSED_THRESHOLD_MS`: **55,000ms** (configurable via env var)
- The 5-second gap is headroom for n8n scheduling jitter

If the threshold equals the Wait duration exactly, the claim check fires at `elapsed ≈ 59,980ms` due to scheduling, fails `elapsed >= 55000`, and the message is silently dropped. This was a confirmed production bug — the gap is intentional and must be maintained.

For testing: set `WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS=5000` and the n8n Wait node to 5 seconds.

### MongoDB indexes on conversationbuffers

Three indexes — verify all exist after deploy:

```js
db.conversationbuffers.getIndexes();
// Expected:
// { key: { _id: 1 } }                                          — default
// { key: { from: 1 }, unique: true, name: 'from_unique' }      — one buffer per sender
// { key: { lastSeen: 1 }, expireAfterSeconds: 86400, name: 'lastSeen_ttl_24h' } — auto-cleanup
```

If TTL index is missing, create it manually:

```js
db.conversationbuffers.createIndex(
  { lastSeen: 1 },
  { expireAfterSeconds: 86400, name: "lastSeen_ttl_24h" },
);
```

---

## GraphQL schema structure

All typeDefs use `extend type Query` / `extend type Mutation` — merged in `src/graphql/schema/index.ts`. The base `Query` and `Mutation` types are defined once in the schema index.

---

## Environment variables

Validated via Zod in `src/config/env.ts`. Required vars (see `.env.example`):

```
MONGODB_URI
JWT_SECRET
JWT_REFRESH_SECRET
ANTHROPIC_API_KEY
WEBHOOK_SECRET
BUFFER_WEBHOOK_SECRET
PORT
```

Optional vars with defaults:

```
WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS   # Default: 55000. Set to 5000 for local testing.
```

**Deferred — not yet wired (planned):**

```
ACTIVE_PROMOTION   # e.g. "30% Off Alo Yoga hasta el 10 de mayo"
                   # When set, Luis mentions it once per conversation while customer browses.
                   # Currently hardcoded as undefined in BUSINESS_INFO in webhook.service.ts.
                   # To activate: add to env.ts (z.string().optional()), import in webhook.service.ts,
                   # assign to businessInfo.activePromotion. No code change needed after that.
```

Never access `process.env` directly outside of `env.ts` — always import the validated config object. Exception: `buffer.service.ts` reads `WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS` directly at module load time since it is intentionally runtime-configurable without a full env validation cycle.

---

## Known technical debt

| Item                                                      | Risk                                                              | Status                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Dedup in Extract Message uses n8n static data             | Lost on container restart — Meta retries may reprocess            | Open — move to MongoDB with unique messageId index                               |
| Only first product image per item sent                    | Customer sees one angle only                                      | Intentional — revisit if UX requires it                                          |
| Products fetched unconditionally before intent known      | Wasteful for general/order_status intents                         | Open — add pagination or lazy fetch when catalog exceeds ~500 items              |
| Customer creation race condition                          | Two concurrent executions for new customer could collide          | **Resolved** — atomic upsert with `$setOnInsert`                                 |
| Order idempotency was note-based                          | Non-atomic check, notes overloaded as idempotency keys            | **Resolved** — `sourceMessageId` compound unique index on orders                 |
| LTV computed via aggregation on every WhatsApp message    | Full orders collection scan per request at scale                  | **Resolved** — cached as `customer.lifetimeValue`, updated by `order.service.ts` |
| `activePromotion` requires code change + Railway redeploy | Cannot toggle a sale without a deploy                             | **Deferred** — wire to `ACTIVE_PROMOTION` env var when ready                     |
| n8n `showroom_visit` escalation has no dedicated branch   | Owner sees generic wall of text instead of "confirm visit" prompt | **Deferred** — add IF node in n8n routing on escalationMessage content           |

---

## What NOT to do

- Never put business logic in resolvers
- Never put GraphQL types in service files
- Never access `process.env` directly — use `src/config/env.ts` (see exception above)
- Never return raw Mongoose documents from services — always map to safe types
- Never use relative `../../` imports across module boundaries — use `#/` aliases
- Never skip `.js` extension in imports (NodeNext ESM requirement)
- Never redefine `objectIdSchema` — import from `#/shared/validation/common.validation.js`
- Never add `merge: true` to Apollo cache `Query.fields` on the frontend (caused cache corruption)
- Never change the buffer elapsed threshold without also updating the n8n Wait node — they must stay in sync with at least 5 seconds of headroom
- Never remove the `shouldRespond: true` field from the claim success response — n8n depends on it explicitly
- Never change `ORDER_NUMBER_PREFIX` without migrating all existing `orderNumber` values in MongoDB
- Never query or write `customer.phone` without normalizing to digits-only first — pre-save hooks do not run on `findByIdAndUpdate` or `findOneAndUpdate`
- Never add `sourceMessageId` to `createOrderSchema` — it is a service-layer parameter, not a client input field
- Never add or remove a `ClaudeIntent` value without updating `claude.service.ts`, `webhook.service.ts`, and this document
- Never call `search_products` for `order_summary` — compile from `recentOrder.items` or conversation history
- Never escalate `payment_info` to the owner — the system handles it automatically
- Never cast a Mongoose lean document directly to `Record<string, unknown>` — cast through `unknown` first to avoid `ts(2352)`
- Never read `customer.lifetimeValue` as `0` to mean "new customer" — it is `undefined` for customers with no orders; `0` is a genuinely zero-sum order
- Never reference order item names as `i.name` — the schema field is `productName` (snapshot field)
- Never hardcode only "Alo Yoga, Lululemon, Wiskii" as the brand list — the current catalog includes **437, Better Me, and Skims** as well
