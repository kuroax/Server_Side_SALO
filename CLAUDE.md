Never access `process.env` directly outside of `env.ts` — always import the validated config object. Exception: `buffer.service.ts` reads `WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS` directly at module load time since it is intentionally runtime-configurable without a full env validation cycle.

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
