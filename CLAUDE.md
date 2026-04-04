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
│       ├── claude.service.ts         # Claude AI — intent detection + response generation
│       ├── webhook.controller.ts     # Express controller for Meta webhook
│       ├── webhook.router.ts         # /webhook route
│       ├── webhook.service.ts        # Orchestrates bot flow
│       └── webhook.validation.ts     # Zod schemas for Meta payload
├── modules/
│   ├── auth/                         # JWT auth, login, refresh, password
│   ├── conversations/                # Conversation memory for WhatsApp bot
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

- **Deducted** atomically when order moves to `confirmed` (`inventoryApplied = true`)
- **Restored** when order is cancelled or hard-deleted (only if `inventoryApplied === true`)
- Uses `$gte` guard in `findOneAndUpdate` to prevent negative stock — fails with clear error message

### Order number format

`SALO-100001` — globally sequential, collision-safe via MongoDB atomic counter.

### System notes

All service-level events append a system note automatically:

```ts
makeSystemNote("Inventory deducted on order confirmation.");
// { message, createdBy: null, kind: 'system', createdAt: Date }
```

### Revenue stats query

```graphql
revenueStats(months: Int): [MonthRevenue!]!
```

Uses MongoDB aggregation (`$group` by year/month). Excludes cancelled orders. Fills zeroes for months with no sales. Used by the dashboard for the 3-month revenue bar chart.

---

## WhatsApp bot (Luis)

- **Model:** `claude-sonnet-4-20250514`
- **Persona:** warm, uses apodos (bonita, bella, corazón), Spanish only
- **Memory:** 10-turn conversation history via `conversations` collection
- **Escalation:** service returns `escalate: true` → n8n sends owner alert
- **Key rule:** backend never touches the WhatsApp API directly — all Meta credentials live in n8n

Flow: Meta webhook → `webhook.controller` → `webhook.service` → `claude.service` (AI intent + response) → reply via n8n.

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
PORT
```

Never access `process.env` directly outside of `env.ts` — always import the validated config object.

---

## What NOT to do

- Never put business logic in resolvers
- Never put GraphQL types in service files
- Never access `process.env` directly — use `src/config/env.ts`
- Never return raw Mongoose documents from services — always map to safe types
- Never use relative `../../` imports across module boundaries — use `#/` aliases
- Never skip `.js` extension in imports (NodeNext ESM requirement)
- Never redefine `objectIdSchema` — import from `#/shared/validation/common.validation.js`
- Never add `merge: true` to Apollo cache `Query.fields` on the frontend (caused cache corruption)
