import { Router } from "express";
import {
  embeddedSignupPageHandler,
  embeddedSignupCallbackHandler,
  embeddedSignupTokenExchangeHandler,
} from "#/integrations/embedded-signup/embeddedSignup.controller.js";

const router = Router();

// ─── GET /boutique-signup ──────────────────────────────────────────────────────
// Serves a branded landing page that immediately redirects the WebView to
// Facebook's OAuth URL. No auth required — opened by the React Native WebView
// before the user has interacted with the SALO app in this context.
// Query params: boutiqueId (ObjectId)
// Token is injected post-load via window.__SALO_TOKEN__ by
// the React Native WebView's injectedJavaScript.
router.get("/boutique-signup", embeddedSignupPageHandler);

// ─── GET /boutique-callback ────────────────────────────────────────────────────
// Facebook redirects here after the user completes (or cancels) the OAuth flow.
// Exchanges the code server-side, updates the boutique credentials, and renders
// a result page that postMessages back to the React Native WebView.
// Query params: code (OAuth code), state (base64url-encoded {boutiqueId, token})
// No auth header — credentials are encoded in the state param.
router.get("/boutique-callback", embeddedSignupCallbackHandler);

// ─── POST /api/boutiques/signup ────────────────────────────────────────────────
// Legacy popup-based token exchange — kept for backward compatibility and
// direct API testing. In production the redirect flow via /boutique-callback
// is used instead. Requires Bearer JWT in Authorization header.
// Body: { code: string, boutiqueId: string }
router.post("/api/boutiques/signup", embeddedSignupTokenExchangeHandler);

export { router as embeddedSignupRouter };
