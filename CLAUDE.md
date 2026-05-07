# CLAUDE.md — Server_Side_SALO Backend

## Claude Code behavior rules

Read this section first. These rules govern how Claude Code must behave in this repo.

- **Inspect before changing.** Read the relevant file completely before editing it. Never assume its current state from memory.
- **Do not create new files unless explicitly requested.** The module structure is established. New files require a clear reason.
- **Do not change architecture.** The 5-file module pattern, import alias system, and service/resolver separation are intentional and must not be restructured.
- **Do not modify `.env` or `.env.example` to add real secrets.** Add placeholder names only.
- **Do not run `npm run build` or `npm run start` — Railway deploys automatically on push to main.**
- **Do not change the buffer elapsed threshold without also noting the n8n Wait node must change too.**
- **Do not change any `ClaudeIntent` value without updating `claude.service.ts`, `webhook.service.ts`, and this document.**
- **Prefer the smallest safe change.** Production stability beats feature completeness.
- **When in doubt, report and ask — do not guess.**

---

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
npm run dev        # tsx watch mode
npm run build      # tsc + tsc-alias
npm run start      # node dist/server.js (production)
npm run typecheck  # tsc --noEmit
npm run clean      # rm -rf dist
```

---

## Path aliases

```ts
import { something } from "#/shared/utils/auth.guards.js";
```

Always use `#/` imports, never relative `../../` paths across module boundaries. Always include the `.js` extension in imports (NodeNext requirement).

---

## Directory structure

```
src/
├── server.ts
├── app.ts
├── config/
│   ├── db.ts
│   ├── env.ts                        # Zod-validated env vars — only place to read process.env
│   └── logger.ts
├── graphql/
│   ├── context.ts
│   └── schema/index.ts
├── integrations/
│   └── whatsapp/
│       ├── buffer.controller.ts      # Express controller for buffer push/claim
│       ├── buffer.service.ts         # Buffer push/claim logic — MongoDB-backed
│       ├── claude.service.ts         # Claude AI — intent detection + response generation
│       ├── image-search.service.ts   # Visual product search via image media ID
│       ├── logSentImage.controller.ts # Logs sent product images for gallery reply resolution
│       ├── webhook.auth.ts           # requireBufferWebhookSecret middleware
│       ├── webhook.controller.ts     # Express controller for Meta webhook
│       ├── webhook.router.ts         # Mounts all /api/webhooks/whatsapp routes
│       ├── webhook.service.ts        # Orchestrates full bot flow
│       └── webhook.validation.ts     # Zod schemas for Meta payload
├── modules/
│   ├── auth/
│   ├── conversations/
│   │   ├── conversation-buffer.model.ts
│   │   └── conversation.model.ts         # 20-turn rolling window (MAX_CONVERSATION_TURNS = 20)
│   ├── customers/
│   ├── inventory/
│   ├── orders/
│   ├── products/
│   └── sentImages/
│       └── sentImage.model.ts        # Maps WhatsApp message IDs to product captions
│                                     # Used for gallery reply product resolution
├── scripts/
│   └── backfill-inventory.ts
└── shared/
    ├── errors/
    ├── models/
    │   └── counter.model.ts
    ├── utils/
    │   └── auth.guards.ts
    └── validation/
        └── common.validation.ts
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
module.typeDefs.ts    # GraphQL SDL
```

Resolvers never contain business logic. Services never contain GraphQL types.

---

## Auth pattern

```ts
requireAuth(context);
requireRoles(context, ["owner", "admin"]);
// Role hierarchy: owner > admin > sales | inventory | support
```

---

## Validation pattern (Zod v4)

```ts
export async function createOrder(input: unknown, createdBy: string | null) {
  const data = createOrderSchema.parse(input);
}
```

Zod v4 syntax — `{ error: }` not `{ message: }`:

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

---

## MongoDB patterns

### Lean reads

```ts
const order = await OrderModel.findById(id).lean<OrderLike>();
```

Always use typed lean generics. Cast through `unknown` when needed:

```ts
(recentOrder as unknown as Record<string, unknown>).trackingNumber as
  | string
  | undefined;
```

### Mappers

Every module has a mapper (`mapOrder()`, `mapProduct()`, etc.) that converts ObjectIds to strings. Resolvers always return mapped types.

---

## Order module

### Status state machine

```
pending → confirmed → processing → shipped → delivered (terminal)
pending → confirmed → processing → cancelled (terminal)
```

### Key schema fields

```ts
outstandingBalance?: number   // Running balance owed. Updated by owner manually.
trackingNumber?: string       // Carrier guide number.
estimatedDelivery?: string    // e.g. "Jueves 8 de mayo"
```

**Field name is `productName`, not `name`.** Order items use `i.productName`, never `i.name`.

### `safeUpdateLifetimeValue` in order.service.ts

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
```

Accepts `Types.ObjectId | null | undefined` — all are safe (null/undefined = skip, non-fatal).

### MongoDB indexes on orders

```js
// channel_sourceMessageId_unique — idempotency
// customerId_createdAt_desc — critical for webhook perf (full scan per message without it)
```

---

## Customer module

### Phone normalization

Always normalize to digits-only before any query or upsert. Pre-save hooks do NOT run on `findOneAndUpdate`.

### lifetimeValue field

```ts
lifetimeValue?: number   // undefined for new customers, NOT 0
```

VIP thresholds: `>= $50,000` → VIP, `>= $10,000` → returning customer, `undefined/0` → new.

---

## WhatsApp bot (Luis)

### Core facts

- **Model:** `claude-sonnet-4-20250514`
- **Language:** Spanish only
- **Memory:** 20-turn rolling window (`MAX_CONVERSATION_TURNS = 20`)
- **Backend never calls WhatsApp API** — all Meta credentials are in n8n

### Brands

Luis knows: **Alo Yoga, Lululemon, Wiskii, 437, Better Me, Skims** — all 6, always.

### Intent enum — complete

```ts
type ClaudeIntent =
  | "catalog_query" // Broad question — ask for specifics, NEVER call search_products
  | "product_search" // search_products was called and returned results
  | "price_query" // Price question — answer directly
  | "create_order" // Customer confirmed product + size + color
  | "order_status" // Order / shipping / tracking question
  | "order_summary" // Customer asks to see full accumulated order list
  | "showroom_visit" // Customer wants to visit in person
  | "payment_info" // How/where to pay — bank image sent automatically
  | "payment_receipt" // Customer sent a comprobante
  | "needs_human" // Requires owner decision
  | "general"; // Greetings, reactions, ambiguous
```

Changing this enum requires updating: `claude.service.ts`, `webhook.service.ts`, this document.

### ClaudeContext — complete current shape

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
    activePromotion?: string; // DEFERRED: wire to ACTIVE_PROMOTION env var
  };
};
```

### System tags in conversation history

These tags are injected into stored turns by the backend. Claude reads them for context. Never forward them to the customer.

| Tag                                                                | Location              | Meaning                                                                                    |
| ------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------ |
| `[payment_info_sent]`                                              | End of assistant turn | Bank account info was sent. Used by `hasRecentPaymentInfoContext()` for receipt detection. |
| `[Comprobante de pago enviado por el cliente]`                     | User turn             | Customer sent receipt image. Claude must NOT ask which product.                            |
| `[Productos enviados al cliente en este turn: ...]`                | User turn             | Gallery products shown. Claude uses to avoid re-searching.                                 |
| `[El cliente esta respondiendo a una imagen del gallery anterior]` | User turn prefix      | Gallery reply. NEVER call `search_products`.                                               |
| `[Producto exacto seleccionado por el cliente: NAME]`              | User turn prefix      | Exact selected product. Respond only about that product.                                   |

### ⭐️ format — required for cart extraction

When Luis confirms availability or gives payment info, product lines MUST use this format:

```
⭐️Jersey Accolade Negro | Talla M | $1,990
```

`extractCartFromHistory()` scans for this pattern (three-pass: ⭐️ → natural language → tag-based). Missing ⭐️ format = bot asks customer to re-confirm product — bad UX.

### Image suppression rule

Product images flow ONLY when `result.intent === "product_search"`. All other intents suppress accumulated images. This is enforced in `webhook.service.ts` after the Claude call returns.

### Receipt detection — dual signal

`isLikelyReceipt = isReceiptByContext || isReceiptByCaption`

- **Context:** `hasRecentPaymentInfoContext()` finds `[payment_info_sent]` in last 20 turns
- **Caption:** customer text matches receipt phrases ("aqui esta el deposito", "ya pague", etc.)

Either signal skips `searchProductsByImage` and routes to receipt acknowledgment.

### JSON sanitizer

`sanitizeJsonNewlines()` — character-by-character state machine that escapes bare `
`/`
` inside JSON string values before `JSON.parse`. Prevents SAFE_FALLBACK when Claude generates multi-line ⭐️ summaries. Do NOT replace with regex — regex only handles single newlines.

### Message flow

```
Meta webhook → n8n → POST /api/webhooks/whatsapp
  → webhook.controller → webhook.service → claude.service
  → reply + productImages + escalate + escalationMessage → n8n
  → n8n sends WhatsApp reply / images / bank account image / owner alert
```

---

## WhatsApp buffer system

### Buffer endpoints

Both require `x-webhook-secret` header.

```
POST /api/webhooks/whatsapp/buffer/push
POST /api/webhooks/whatsapp/buffer/claim
```

### Push body — all 9 fields required

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

### Claim success response — all fields required in n8n

```json
{
  "skip": false,
  "shouldRespond": true,
  "mergedMessage": "busco leggings negros
talla S",
  "messageCount": 2,
  "messageType": "image",
  "imageMediaId": "wamid.xxx",
  "imageCaption": "",
  "contactName": "Axel Monterrubio"
}
```

`messageType` is `"image"` if ANY buffered message was an image — critical for receipt detection when customer sends image then text in same burst. `imageMediaId` is the first non-null media ID across all buffered messages.

### Timing

- n8n Wait: **60 seconds**
- `ELAPSED_THRESHOLD_MS`: **55,000ms** (5s headroom is intentional — confirmed production bug if removed)
- Testing: set `WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS=5000` and n8n Wait to 5s

---

## GraphQL schema structure

All typeDefs use `extend type Query` / `extend type Mutation` — merged in `src/graphql/schema/index.ts`.

---

## Environment variables

Validated in `src/config/env.ts`. Required:

```
MONGODB_URI
JWT_SECRET
JWT_REFRESH_SECRET
ANTHROPIC_API_KEY
WEBHOOK_SECRET
BUFFER_WEBHOOK_SECRET
BANK_ACCOUNT_IMAGE_URL        # WhatsApp-accessible URL for bank account image
PORT
```

Optional:

```
WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS   # Default: 55000
```

Deferred:

```
ACTIVE_PROMOTION   # Wire to env.ts as z.string().optional() when ready
```

---

## Known technical debt

| Item                                          | Risk                               | Status                   |
| --------------------------------------------- | ---------------------------------- | ------------------------ |
| Dedup in Extract Message uses n8n static data | Lost on container restart          | Open                     |
| Only first product image sent                 | One angle only                     | Intentional              |
| Products fetched before intent known          | Wasteful at scale                  | Open                     |
| Customer creation race condition              | Concurrent collision               | **Resolved**             |
| Order idempotency was note-based              | Non-atomic                         | **Resolved**             |
| LTV via aggregation per message               | Collection scan at scale           | **Resolved**             |
| `activePromotion` requires deploy             | Cannot toggle sale                 | **Deferred**             |
| `showroom_visit` has no dedicated n8n branch  | Generic escalation text            | **Deferred**             |
| Conversation control system not built         | Owner and bot reply simultaneously | **Deferred (post-demo)** |

---

## What NOT to do

- Never put business logic in resolvers
- Never put GraphQL types in service files
- Never access `process.env` directly — use `env.ts`
- Never return raw Mongoose documents from services
- Never use relative `../../` imports across module boundaries
- Never skip `.js` extension in imports
- Never redefine `objectIdSchema`
- Never change the buffer elapsed threshold without also updating the n8n Wait node
- Never remove `shouldRespond: true` from claim success response
- Never change `ORDER_NUMBER_PREFIX` without migrating existing order numbers
- Never query `customer.phone` without normalizing to digits-only first
- Never add `sourceMessageId` to `createOrderSchema`
- Never add/remove `ClaudeIntent` without updating all three places
- Never call `search_products` for `order_summary`
- Never escalate `payment_info` to the owner
- Never cast lean document directly to `Record<string, unknown>` — cast through `unknown`
- Never read `lifetimeValue === 0` as "new customer" — it is `undefined` for new customers
- Never use `i.name` for order items — field is `productName`
- Never hardcode "Alo Yoga, Lululemon, Wiskii" without also including 437, Better Me, Skims
- Never replace `sanitizeJsonNewlines()` with a regex approach
- Never suppress images based only on `isGalleryReply` — suppression is intent-based globally
- Never forward `[payment_info_sent]` tag to the customer
