import type { Request, Response } from "express";
import { z } from "zod";
import {
  META_APP_ID,
  META_APP_SECRET,
  META_ES_CONFIG_ID,
  SALO_BACKEND_URL,
  SYSTEM_USER_TOKEN,
} from "#/config/env.js";
import { verifyAccessToken } from "#/modules/auth/auth.utils.js";
import { updateBoutiqueCredentials } from "#/modules/boutiques/boutique.service.js";
import { logger } from "#/config/logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// Meta Graph API version used by the Embedded Signup flow. Bump in lockstep
// with the JS SDK FB.init({ version }) literal in the HTML page below.
const GRAPH_API_VERSION = "v21.0";

// Timeout for each individual Meta Graph API call. The code-for-token swap
// must complete within 30s (Meta's TTL) so we keep this well under that.
const META_API_TIMEOUT_MS = 10_000;

// ─── Body schema ──────────────────────────────────────────────────────────────
// Only { code, boutiqueId } come from the client. wabaId and phoneNumberId
// are resolved server-side via debug_token + /{wabaId}/phone_numbers — a
// client-supplied wabaId would be untrusted input.

const signupBodySchema = z.object({
  code: z
    .string({ error: "code is required" })
    .trim()
    .min(1, { error: "code cannot be empty" }),
  boutiqueId: z
    .string({ error: "boutiqueId is required" })
    .trim()
    .min(1, { error: "boutiqueId cannot be empty" })
    .regex(/^[a-f\d]{24}$/i, { error: "boutiqueId must be a valid ObjectId" }),
});

// ─── HTML page handler ────────────────────────────────────────────────────────
// Replaces the old FB.login() popup approach which does not work in a WebView.
// Instead we render a landing page that immediately redirects the WebView to
// Facebook's OAuth URL. Facebook redirects back to /boutique-callback with
// ?code=xxx&state=boutiqueId:token — no popup, no "Cierra esta pestaña" page.

export const embeddedSignupPageHandler = (
  req: Request,
  res: Response,
): void => {
  if (!META_APP_ID || !META_ES_CONFIG_ID) {
    logger.error(
      "Embedded Signup page requested but META_APP_ID or META_ES_CONFIG_ID is not configured",
    );
    res
      .status(503)
      .type("text/plain")
      .send(
        "Embedded Signup is not configured. Set META_APP_ID and META_ES_CONFIG_ID in environment.",
      );
    return;
  }

  const boutiqueId = req.query["boutiqueId"] as string | undefined;

  if (!boutiqueId) {
    res
      .status(400)
      .type("text/html")
      .send(
        renderErrorPage(
          "Parámetros de sesión inválidos. Vuelve a la app e intenta de nuevo.",
        ),
      );
    return;
  }

  // The JWT is no longer passed in the URL. The React Native WebView injects it
  // post-load via window.__SALO_TOKEN__, and the landing page script builds the
  // base64url state param client-side. So we only construct the OAuth base URL
  // here (without the state param) and let the page append &state=... once the
  // token is available.
  const backendUrl =
    SALO_BACKEND_URL ?? "https://serversidesalo-production.up.railway.app";
  const redirectUri = `${backendUrl}/boutique-callback`;

  const oauthUrl = new URL("https://www.facebook.com/dialog/oauth");
  oauthUrl.searchParams.set("client_id", META_APP_ID);
  oauthUrl.searchParams.set("config_id", META_ES_CONFIG_ID);
  oauthUrl.searchParams.set("redirect_uri", redirectUri);
  oauthUrl.searchParams.set("response_type", "code");
  oauthUrl.searchParams.set(
    "scope",
    "whatsapp_business_management,whatsapp_business_messaging",
  );
  oauthUrl.searchParams.set("display", "page");
  oauthUrl.searchParams.set(
    "extras",
    JSON.stringify({
      setup: {},
      featureType: "",
      sessionInfoVersion: "3",
    }),
  );

  // Render a minimal landing page that auto-redirects to Facebook once the
  // WebView-injected token is available.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
  );
  res
    .status(200)
    .type("text/html")
    .send(renderLandingPage(oauthUrl.toString(), boutiqueId));
};

// ─── Callback handler ─────────────────────────────────────────────────────────
// Facebook redirects here after the user completes (or cancels) the flow.
// Exchanges the code server-side, updates the boutique, renders a result page
// that postMessages back to the React Native WebView.

export const embeddedSignupCallbackHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const code = req.query["code"] as string | undefined;
  const stateRaw = req.query["state"] as string | undefined;
  const error = req.query["error"] as string | undefined;

  // ── User cancelled ─────────────────────────────────────────────────────────
  if (error || !code) {
    res
      .status(200)
      .type("text/html")
      .send(
        renderResultPage({
          success: false,
          message:
            "Conexión cancelada. Puedes cerrar esta ventana e intentarlo de nuevo.",
        }),
      );
    return;
  }

  // ── Decode state ───────────────────────────────────────────────────────────
  let boutiqueId: string;
  let token: string;
  try {
    const decoded = JSON.parse(
      Buffer.from(stateRaw ?? "", "base64url").toString("utf-8"),
    );
    boutiqueId = decoded.boutiqueId;
    token = decoded.token;
    if (!boutiqueId || !token) throw new Error("Missing fields");
  } catch {
    res
      .status(200)
      .type("text/html")
      .send(
        renderResultPage({
          success: false,
          message: "Sesión inválida. Vuelve a la app e intenta de nuevo.",
        }),
      );
    return;
  }

  // ── Verify JWT ─────────────────────────────────────────────────────────────
  let user;
  try {
    user = verifyAccessToken(token);
  } catch {
    res
      .status(200)
      .type("text/html")
      .send(
        renderResultPage({
          success: false,
          message:
            "Sesión expirada. Inicia sesión en la app y vuelve a intentarlo.",
        }),
      );
    return;
  }

  if (user.boutiqueId !== boutiqueId) {
    res
      .status(200)
      .type("text/html")
      .send(
        renderResultPage({
          success: false,
          message: "No tienes permiso para conectar esta cuenta.",
        }),
      );
    return;
  }

  if (!META_APP_ID || !META_APP_SECRET) {
    res
      .status(200)
      .type("text/html")
      .send(
        renderResultPage({
          success: false,
          message: "Configuración del servidor incompleta. Contacta a soporte.",
        }),
      );
    return;
  }

  const backendUrl =
    SALO_BACKEND_URL ?? "https://serversidesalo-production.up.railway.app";
  const redirectUri = `${backendUrl}/boutique-callback`;

  // ── Exchange code → token ──────────────────────────────────────────────────
  let accessToken: string;
  try {
    accessToken = await exchangeCodeForAccessToken({
      code,
      appId: META_APP_ID,
      appSecret: META_APP_SECRET,
      redirectUri,
    });
  } catch (err) {
    logger.error(
      { err, boutiqueId },
      "Embedded Signup callback — code-for-token exchange failed",
    );
    res
      .status(200)
      .type("text/html")
      .send(
        renderResultPage({
          success: false,
          message: "Error al conectar con Meta. Vuelve a intentarlo.",
        }),
      );
    return;
  }

  // ── Resolve WABA id ────────────────────────────────────────────────────────
  let wabaId: string;
  try {
    wabaId = await resolveWabaIdFromDebugToken({
      accessToken,
      appId: META_APP_ID,
      appSecret: META_APP_SECRET,
    });
  } catch (err) {
    logger.error(
      { err, boutiqueId },
      "Embedded Signup callback — WABA resolution failed",
    );
    res
      .status(200)
      .type("text/html")
      .send(
        renderResultPage({
          success: false,
          message: "No se pudo identificar tu cuenta de WhatsApp Business.",
        }),
      );
    return;
  }

  // ── Resolve phone number id ────────────────────────────────────────────────
  let phoneNumberId: string;
  try {
    phoneNumberId = await resolveFirstPhoneNumberId({ wabaId, accessToken });
  } catch (err) {
    logger.error(
      { err, boutiqueId, wabaId },
      "Embedded Signup callback — phone number lookup failed",
    );
    res
      .status(200)
      .type("text/html")
      .send(
        renderResultPage({
          success: false,
          message: "La cuenta no tiene un número de teléfono configurado.",
        }),
      );
    return;
  }

  // ── Persist credentials ────────────────────────────────────────────────────
  try {
    const updated = await updateBoutiqueCredentials(boutiqueId, {
      phoneNumberId,
      wabaId,
      accessToken,
      connectedAt: new Date(),
    });
    if (!updated) {
      res
        .status(200)
        .type("text/html")
        .send(
          renderResultPage({
            success: false,
            message: "Boutique no encontrada.",
          }),
        );
      return;
    }
  } catch (err) {
    logger.error(
      { err, boutiqueId },
      "Embedded Signup callback — failed to persist credentials",
    );
    res
      .status(200)
      .type("text/html")
      .send(
        renderResultPage({
          success: false,
          message: "Error al guardar las credenciales. Contacta a soporte.",
        }),
      );
    return;
  }

  logger.info(
    { boutiqueId, wabaId, phoneNumberId, userId: user.id },
    "Embedded Signup callback — boutique connected to WhatsApp Business",
  );

  // Subscribe the WABA to the SALO app so Meta delivers webhooks. Best-effort —
  // never throws and does not block the success response to the WebView.
  await subscribeWabaToApp({ wabaId, boutiqueId });

  res
    .status(200)
    .type("text/html")
    .send(renderResultPage({ success: true, boutiqueId }));
};

// ─── HTML templates ───────────────────────────────────────────────────────────

// Landing page — shows SALO branding then auto-navigates to Facebook once the
// React Native WebView injects the JWT via window.__SALO_TOKEN__. The state
// param (base64url of {boutiqueId, token}) is built client-side so the token
// never travels in the URL of this page.
function renderLandingPage(oauthBaseUrl: string, boutiqueId: string): string {
  const safeOauthBaseUrl = oauthBaseUrl.replace(/'/g, "\'");
  const safeBoutiqueId = boutiqueId.replace(/'/g, "\'");
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>SALO · Conectar WhatsApp Business</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      background: #0A0A0A; color: #FFFFFF;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
    }
    .container { max-width: 420px; width: 100%; padding: 40px 24px; text-align: center; }
    .logo { font-size: 44px; font-weight: 800; letter-spacing: 6px; margin-bottom: 40px; }
    .steps {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 11px; color: #8A8A93; margin-bottom: 48px;
    }
    .step { flex: 1; text-align: center; line-height: 1.3; }
    .step.active { color: #FFFFFF; font-weight: 600; }
    .step-arrow { color: #3A3A42; font-size: 14px; }
    h1 { font-size: 22px; font-weight: 700; margin: 0 0 12px; }
    p { font-size: 14px; line-height: 1.5; color: #B0B0B8; margin: 0 0 32px; }
    .spinner {
      display: inline-block; width: 32px; height: 32px;
      border: 3px solid rgba(124,110,245,0.25); border-top-color: #7C6EF5;
      border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text { font-size: 14px; color: #8A8A93; }
  </style>
</head>
<body>
  <main class="container">
    <div class="logo">SALO</div>
    <div class="steps">
      <span class="step active">Conecta Facebook</span>
      <span class="step-arrow">›</span>
      <span class="step">Selecciona negocio</span>
      <span class="step-arrow">›</span>
      <span class="step">Confirma número</span>
    </div>
    <h1>Conecta tu WhatsApp Business</h1>
    <p>Vincula tu cuenta para que SALO pueda responder a tus clientes automáticamente.</p>
    <div class="spinner"></div>
    <p class="loading-text">Redirigiendo a Facebook…</p>
  </main>
  <script>
    (function() {
      var BOUTIQUE_ID = '${safeBoutiqueId}';
      var BASE_OAUTH_URL = '${safeOauthBaseUrl}';
      var MAX_WAIT_MS = 5000;
      var POLL_INTERVAL_MS = 50;
      var waited = 0;
      var poll;

      function toBase64Url(str) {
        return btoa(str)
          .replace(/\\+/g, '-')
          .replace(/\\//g, '_')
          .replace(/=/g, '');
      }

      function doRedirect(token) {
        var state = toBase64Url(JSON.stringify({
          boutiqueId: BOUTIQUE_ID,
          token: token
        }));
        window.location.href = BASE_OAUTH_URL +
          '&state=' + encodeURIComponent(state);
      }

      window.__SALO_READY__ = function(token) {
        if (poll) clearInterval(poll);
        doRedirect(token);
      };

      poll = setInterval(function() {
        waited += POLL_INTERVAL_MS;
        if (window.__SALO_TOKEN__) {
          clearInterval(poll);
          doRedirect(window.__SALO_TOKEN__);
        } else if (waited >= MAX_WAIT_MS) {
          clearInterval(poll);
          document.body.innerHTML =
            '<div style="color:#ff6b6b;text-align:center;padding:40px;' +
            'font-family:system-ui">' +
            'Error de sesión — vuelve a la app e intenta de nuevo.</div>';
        }
      }, POLL_INTERVAL_MS);
    })();
  </script>
</body>
</html>`;
}

// Result page — shown after /boutique-callback processes the OAuth code.
// Sends postMessage to the React Native WebView on success.
function renderResultPage(
  result:
    | { success: true; boutiqueId: string }
    | { success: false; message: string },
): string {
  const isSuccess = result.success;
  const message = isSuccess
    ? "¡Conexión exitosa!"
    : (result as { success: false; message: string }).message;
  const boutiqueId = isSuccess
    ? (result as { success: true; boutiqueId: string }).boutiqueId
    : "";

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>SALO · ${isSuccess ? "Conexión exitosa" : "Error de conexión"}</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      background: #0A0A0A; color: #FFFFFF;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
    }
    .container { max-width: 420px; width: 100%; padding: 40px 24px; text-align: center; }
    .logo { font-size: 44px; font-weight: 800; letter-spacing: 6px; margin-bottom: 40px; }
    .icon {
      width: 72px; height: 72px; border-radius: 36px;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 24px;
      font-size: 36px;
      background: ${isSuccess ? "rgba(76,217,100,0.15)" : "rgba(255,107,107,0.15)"};
    }
    h1 { font-size: 22px; font-weight: 700; margin: 0 0 12px; color: ${isSuccess ? "#4CD964" : "#FF6B6B"}; }
    p { font-size: 14px; line-height: 1.5; color: #B0B0B8; margin: 0; }
  </style>
</head>
<body>
  <main class="container">
    <div class="logo">SALO</div>
    <div class="icon">${isSuccess ? "✓" : "✕"}</div>
    <h1>${message}</h1>
    ${
      isSuccess
        ? `<p>Tu cuenta de WhatsApp Business ha sido vinculada correctamente.</p>`
        : `<p>Vuelve a la app e intenta de nuevo.</p>`
    }
  </main>
  <script>
    (function() {
      var payload = ${
        isSuccess
          ? `JSON.stringify({ type: 'SIGNUP_SUCCESS', boutiqueId: '${boutiqueId}' })`
          : `JSON.stringify({ type: 'SIGNUP_ERROR', message: '${message.replace(/'/g, "\'")}' })`
      };
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(payload);
      }
      // Fallback: try window.opener for browser-based testing
      if (window.opener && window.opener.postMessage) {
        window.opener.postMessage(JSON.parse(payload), '*');
      }
    })();
  </script>
</body>
</html>`;
}

// Error page — shown for configuration/parameter errors before OAuth starts.
function renderErrorPage(message: string): string {
  return renderResultPage({ success: false, message });
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export const embeddedSignupTokenExchangeHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  // ── JWT auth ─────────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization;
  const bearerToken =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;

  if (!bearerToken) {
    res
      .status(401)
      .json({ success: false, message: "Authentication required" });
    return;
  }

  let user;
  try {
    user = verifyAccessToken(bearerToken);
  } catch {
    res
      .status(401)
      .json({ success: false, message: "Invalid or expired token" });
    return;
  }

  // ── Body validation ──────────────────────────────────────────────────────
  const parsed = signupBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Invalid request body",
    });
    return;
  }

  const { code, boutiqueId } = parsed.data;

  // ── Tenant scope check ───────────────────────────────────────────────────
  // The caller may only connect WhatsApp to a boutique they belong to.
  // Prevents one boutique's owner from hijacking another boutique.
  if (user.boutiqueId !== boutiqueId) {
    logger.warn(
      {
        userId: user.id,
        userBoutiqueId: user.boutiqueId,
        targetBoutiqueId: boutiqueId,
      },
      "Embedded Signup — caller attempted to connect WhatsApp for another boutique",
    );
    res
      .status(403)
      .json({
        success: false,
        message: "Cannot connect WhatsApp for this boutique",
      });
    return;
  }

  // ── Env precondition ─────────────────────────────────────────────────────
  if (!META_APP_ID || !META_APP_SECRET) {
    logger.error(
      "Embedded Signup attempted but META_APP_ID/META_APP_SECRET is not configured",
    );
    res.status(503).json({
      success: false,
      message: "Embedded Signup is not configured on the server",
    });
    return;
  }

  // ── 1. Exchange code → access token (within 30s of FB.login) ─────────────
  let accessToken: string;
  try {
    accessToken = await exchangeCodeForAccessToken({
      code,
      appId: META_APP_ID,
      appSecret: META_APP_SECRET,
    });
  } catch (err) {
    logger.error(
      { err, boutiqueId },
      "Embedded Signup — code-for-token exchange failed",
    );
    res.status(502).json({
      success: false,
      message:
        "No se pudo intercambiar el código con Meta. Vuelve a intentarlo.",
    });
    return;
  }

  // ── 2. Debug token → WABA id ─────────────────────────────────────────────
  let wabaId: string;
  try {
    wabaId = await resolveWabaIdFromDebugToken({
      accessToken,
      appId: META_APP_ID,
      appSecret: META_APP_SECRET,
    });
  } catch (err) {
    logger.error(
      { err, boutiqueId },
      "Embedded Signup — debug_token / WABA resolution failed",
    );
    res.status(502).json({
      success: false,
      message: "No se pudo identificar la cuenta de WhatsApp Business.",
    });
    return;
  }

  // ── 3. List phone numbers under the WABA → first phone number id ─────────
  let phoneNumberId: string;
  try {
    phoneNumberId = await resolveFirstPhoneNumberId({
      wabaId,
      accessToken,
    });
  } catch (err) {
    logger.error(
      { err, boutiqueId, wabaId },
      "Embedded Signup — phone numbers lookup failed",
    );
    res.status(502).json({
      success: false,
      message:
        "La cuenta de WhatsApp Business no tiene un número configurado. Configúralo en Meta y vuelve a intentarlo.",
    });
    return;
  }

  // ── 4. Persist credentials on the boutique document ──────────────────────
  try {
    const updated = await updateBoutiqueCredentials(boutiqueId, {
      phoneNumberId,
      wabaId,
      accessToken,
      connectedAt: new Date(),
    });

    if (!updated) {
      res.status(404).json({ success: false, message: "Boutique not found" });
      return;
    }
  } catch (err) {
    logger.error(
      { err, boutiqueId, wabaId },
      "Embedded Signup — failed to persist boutique credentials",
    );
    res.status(500).json({
      success: false,
      message: "No se pudieron guardar las credenciales. Contacta a soporte.",
    });
    return;
  }

  logger.info(
    { boutiqueId, wabaId, phoneNumberId, userId: user.id },
    "Embedded Signup — boutique connected to WhatsApp Business",
  );

  // Subscribe the WABA to the SALO app so Meta delivers webhooks. Best-effort —
  // never throws and does not block the success response.
  await subscribeWabaToApp({ wabaId, boutiqueId });

  res.status(200).json({ success: true, boutiqueId });
};

// ─── Meta Graph helpers ───────────────────────────────────────────────────────

async function fetchMeta(
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), META_API_TIMEOUT_MS);

  // Endpoint path WITHOUT the query string. Meta Graph URLs carry secrets in the
  // query (client_secret, app access token "APP_ID|APP_SECRET", per-boutique
  // access_token), so no thrown error — and therefore no log — may ever include
  // the full URL or its query params. Only this path is safe to surface.
  let safePath = "(unparseable URL)";
  try {
    safePath = new URL(url).pathname;
  } catch {
    // keep the fallback
  }

  try {
    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        method: init?.method ?? "GET",
        headers: init?.headers,
        signal: controller.signal,
      });
    } catch (err) {
      // Network / abort error — rethrow referencing only the safe path so the
      // raw error (which could, defensively, reference the URL) never leaks.
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Meta Graph API request to ${safePath} failed: ${reason}`);
    }

    const bodyText = await response.text();
    let body: unknown = undefined;
    try {
      body = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      // Non-JSON body — keep undefined; caller will treat as failure if status non-2xx.
    }
    if (!response.ok) {
      // Include status + path + Meta's response body — never the request URL.
      throw new Error(
        `Meta Graph API ${safePath} returned ${response.status}: ${bodyText.slice(0, 500)}`,
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function exchangeCodeForAccessToken(args: {
  code: string;
  appId: string;
  appSecret: string;
  redirectUri?: string;
}): Promise<string> {
  const url = new URL(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`,
  );
  url.searchParams.set("client_id", args.appId);
  url.searchParams.set("client_secret", args.appSecret);
  url.searchParams.set("code", args.code);
  // redirect_uri must match exactly what was sent in the initial OAuth request.
  // Required for the redirect-based flow; omitted in the old popup flow.
  if (args.redirectUri) {
    url.searchParams.set("redirect_uri", args.redirectUri);
  }

  const body = (await fetchMeta(url.toString())) as
    | { access_token?: unknown }
    | undefined;

  const token = body?.access_token;
  if (typeof token !== "string" || !token) {
    throw new Error("Meta Graph response missing access_token");
  }
  return token;
}

async function resolveWabaIdFromDebugToken(args: {
  accessToken: string;
  appId: string;
  appSecret: string;
}): Promise<string> {
  const url = new URL(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/debug_token`,
  );
  url.searchParams.set("input_token", args.accessToken);
  // app access token format: APP_ID|APP_SECRET
  url.searchParams.set("access_token", `${args.appId}|${args.appSecret}`);

  const body = (await fetchMeta(url.toString())) as
    | {
        data?: {
          granular_scopes?: Array<{
            scope?: string;
            target_ids?: string[];
          }>;
        };
      }
    | undefined;

  const scopes = body?.data?.granular_scopes ?? [];
  const whatsappScope = scopes.find(
    (s) => s.scope === "whatsapp_business_management",
  );
  const wabaId = whatsappScope?.target_ids?.[0];

  if (typeof wabaId !== "string" || !wabaId) {
    throw new Error(
      "debug_token did not return a WABA id under whatsapp_business_management scope",
    );
  }
  return wabaId;
}

// Subscribes the boutique's WABA to the SALO Meta app so Meta delivers webhook
// events (messages, statuses) for that account. Best-effort: never throws — a
// failure here must not break the signup flow (the boutique is already
// connected; subscription can be retried later). Uses the platform-level
// SYSTEM_USER_TOKEN, not the per-boutique token.
async function subscribeWabaToApp(args: {
  wabaId: string;
  boutiqueId: string;
}): Promise<void> {
  if (!SYSTEM_USER_TOKEN) {
    logger.warn(
      { boutiqueId: args.boutiqueId, wabaId: args.wabaId },
      "Embedded Signup — SYSTEM_USER_TOKEN not set; skipping WABA app subscription",
    );
    return;
  }

  try {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(
      args.wabaId,
    )}/subscribed_apps`;

    await fetchMeta(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_USER_TOKEN}` },
    });

    logger.info(
      { boutiqueId: args.boutiqueId, wabaId: args.wabaId },
      "Embedded Signup — WABA subscribed to SALO app",
    );
  } catch (err) {
    logger.error(
      { err, boutiqueId: args.boutiqueId, wabaId: args.wabaId },
      "Embedded Signup — WABA app subscription failed (non-blocking)",
    );
  }
}

async function resolveFirstPhoneNumberId(args: {
  wabaId: string;
  accessToken: string;
}): Promise<string> {
  const url = new URL(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(args.wabaId)}/phone_numbers`,
  );
  url.searchParams.set("access_token", args.accessToken);

  const body = (await fetchMeta(url.toString())) as
    | { data?: Array<{ id?: unknown }> }
    | undefined;

  const first = body?.data?.[0]?.id;
  if (typeof first !== "string" || !first) {
    throw new Error("WABA has no phone numbers configured");
  }
  return first;
}
