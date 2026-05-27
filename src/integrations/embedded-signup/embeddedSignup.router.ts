import { Router } from "express";
import {
  embeddedSignupPageHandler,
  embeddedSignupTokenExchangeHandler,
} from "#/integrations/embedded-signup/embeddedSignup.controller.js";

// Single router mounted at "/" in app.ts. Hosts both:
//   GET  /boutique-signup          → public HTML page (no auth)
//   POST /api/boutiques/signup     → token exchange (JWT auth in handler)
//
// Auth is enforced inside the POST controller because there is no existing
// REST-level JWT middleware in this codebase (the WhatsApp router uses a
// shared-secret middleware instead). Keeping the check in the handler also
// makes the 401/403/400 ordering explicit.
export const embeddedSignupRouter = Router();

embeddedSignupRouter.get("/boutique-signup", embeddedSignupPageHandler);

embeddedSignupRouter.post(
  "/api/boutiques/signup",
  embeddedSignupTokenExchangeHandler,
);
