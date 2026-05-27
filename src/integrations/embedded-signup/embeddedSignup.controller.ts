import type { Request, Response } from "express";
import { z } from "zod";
import {
  META_APP_ID,
  META_APP_SECRET,
  META_ES_CONFIG_ID,
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

export const embeddedSignupPageHandler = (
  _req: Request,
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

  // Helmet's default CSP blocks the Facebook SDK + inline scripts. The page
  // is self-contained by requirement, so we relax CSP for this single route
  // to allow connect.facebook.net (SDK) and www.facebook.com (login popup).
  // COEP/COOP must also be relaxed so the FB popup window can interact back.
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://connect.facebook.net",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self' https://graph.facebook.com",
      "frame-src https://www.facebook.com",
      "child-src https://www.facebook.com",
    ].join("; "),
  );
  res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
  res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");

  res.status(200).type("text/html").send(renderSignupPage());
};

// ─── HTML template ────────────────────────────────────────────────────────────
// Self-contained: no external CSS, all assets via the FB CDN. META_APP_ID
// and META_ES_CONFIG_ID are alphanumeric values from env — safe to inline
// inside single-quoted JS string literals.

function renderSignupPage(): string {
  const appId = META_APP_ID ?? "";
  const configId = META_ES_CONFIG_ID ?? "";

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>SALO · Conectar WhatsApp Business</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: #0A0A0A;
      color: #FFFFFF;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
    }
    .container {
      max-width: 420px;
      margin: 0 auto;
      padding: 56px 24px 48px;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .logo {
      font-size: 44px;
      font-weight: 800;
      letter-spacing: 6px;
      color: #FFFFFF;
      text-align: center;
      margin: 0 0 48px;
    }
    .steps {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin: 0 0 56px;
      font-size: 11px;
      color: #8A8A93;
    }
    .step {
      flex: 1;
      text-align: center;
      line-height: 1.3;
    }
    .step.active {
      color: #FFFFFF;
      font-weight: 600;
    }
    .step-arrow {
      color: #3A3A42;
      font-size: 14px;
      line-height: 1;
    }
    .copy {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      text-align: center;
      padding: 0 8px;
    }
    .copy h1 {
      font-size: 22px;
      font-weight: 700;
      margin: 0 0 12px;
    }
    .copy p {
      font-size: 14px;
      line-height: 1.5;
      color: #B0B0B8;
      margin: 0;
    }
    .actions {
      padding-top: 32px;
    }
    button.cta {
      width: 100%;
      background: #7C6EF5;
      color: #FFFFFF;
      font-size: 16px;
      font-weight: 600;
      border: 0;
      border-radius: 14px;
      padding: 16px 20px;
      cursor: pointer;
      transition: opacity 0.15s ease, transform 0.05s ease;
    }
    button.cta:active { transform: scale(0.99); }
    button.cta:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }
    .hint {
      margin: 14px 0 0;
      font-size: 12px;
      color: #6F6F77;
      text-align: center;
      line-height: 1.5;
    }
    .status {
      margin-top: 24px;
      text-align: center;
      font-size: 14px;
      min-height: 22px;
    }
    .status.error { color: #FF6B6B; }
    .status.success { color: #4CD964; font-weight: 600; }
    .spinner {
      display: inline-block;
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255,255,255,0.35);
      border-top-color: #FFFFFF;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      vertical-align: middle;
      margin-right: 8px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main class="container">
    <div class="logo">SALO</div>

    <div class="steps" aria-label="Pasos de conexión">
      <span class="step active">Conecta Facebook</span>
      <span class="step-arrow">›</span>
      <span class="step">Selecciona negocio</span>
      <span class="step-arrow">›</span>
      <span class="step">Confirma número</span>
    </div>

    <section class="copy">
      <h1>Conecta tu WhatsApp Business</h1>
      <p>Vincula la cuenta de WhatsApp Business de tu boutique para que SALO pueda responder a tus clientes automáticamente.</p>
    </section>

    <div class="actions">
      <button class="cta" id="ctaButton" type="button" onclick="launchEmbeddedSignup()">
        Conectar WhatsApp Business
      </button>
      <p class="hint">Inicia sesión con Facebook y selecciona el negocio que quieres vincular. No publicaremos nada en tu nombre.</p>
      <div class="status" id="status" role="status" aria-live="polite"></div>
    </div>
  </main>

  <script>
    window.fbAsyncInit = function () {
      FB.init({
        appId: '${appId}',
        autoLogAppEvents: true,
        xfbml: true,
        version: '${GRAPH_API_VERSION}'
      });
    };
  </script>
  <script async defer src="https://connect.facebook.net/en_US/sdk.js"></script>

  <script>
    var ctaButton = document.getElementById('ctaButton');
    var statusEl = document.getElementById('status');

    function showLoading() {
      ctaButton.disabled = true;
      statusEl.className = 'status';
      statusEl.innerHTML = '<span class="spinner" aria-hidden="true"></span>Conectando…';
    }
    function showError(message) {
      ctaButton.disabled = false;
      statusEl.className = 'status error';
      statusEl.textContent = message;
    }
    function showSuccess() {
      ctaButton.disabled = true;
      statusEl.className = 'status success';
      statusEl.textContent = '✓ ¡Conexión exitosa!';
    }

    function launchEmbeddedSignup() {
      if (typeof FB === 'undefined') {
        showError('No se pudo cargar Facebook. Recarga la página e intenta de nuevo.');
        return;
      }
      FB.login(function (response) {
        if (response && response.authResponse && response.authResponse.code) {
          exchangeToken(response.authResponse.code);
        } else {
          showError('Inicio de sesión cancelado');
        }
      }, {
        config_id: '${configId}',
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: '',
          sessionInfoVersion: '3'
        }
      });
    }

    async function exchangeToken(code) {
      showLoading();
      var params = new URLSearchParams(window.location.search);
      var boutiqueId = params.get('boutiqueId');
      var token = params.get('token');

      if (!boutiqueId || !token) {
        showError('Falta información de la sesión. Vuelve a abrir el enlace desde la app SALO.');
        return;
      }

      try {
        var response = await fetch('/api/boutiques/signup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify({ code: code, boutiqueId: boutiqueId })
        });

        var result = {};
        try { result = await response.json(); } catch (e) { /* ignore */ }

        if (response.ok && result && result.success) {
          showSuccess();
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'SIGNUP_SUCCESS',
              boutiqueId: boutiqueId
            }));
          }
        } else {
          showError((result && result.message) || 'Error al conectar');
        }
      } catch (err) {
        showError('Error de red. Verifica tu conexión e intenta de nuevo.');
      }
    }
  </script>
</body>
</html>`;
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
    res.status(401).json({ success: false, message: "Invalid or expired token" });
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
      { userId: user.id, userBoutiqueId: user.boutiqueId, targetBoutiqueId: boutiqueId },
      "Embedded Signup — caller attempted to connect WhatsApp for another boutique",
    );
    res
      .status(403)
      .json({ success: false, message: "Cannot connect WhatsApp for this boutique" });
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
    logger.error({ err, boutiqueId }, "Embedded Signup — code-for-token exchange failed");
    res.status(502).json({
      success: false,
      message: "No se pudo intercambiar el código con Meta. Vuelve a intentarlo.",
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
    logger.error({ err, boutiqueId }, "Embedded Signup — debug_token / WABA resolution failed");
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

  res.status(200).json({ success: true, boutiqueId });
};

// ─── Meta Graph helpers ───────────────────────────────────────────────────────

async function fetchMeta(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), META_API_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const bodyText = await response.text();
    let body: unknown = undefined;
    try {
      body = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      // Non-JSON body — keep undefined; caller will treat as failure if status non-2xx.
    }
    if (!response.ok) {
      throw new Error(
        `Meta Graph API returned ${response.status}: ${bodyText.slice(0, 500)}`,
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
}): Promise<string> {
  const url = new URL(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`,
  );
  url.searchParams.set("client_id", args.appId);
  url.searchParams.set("client_secret", args.appSecret);
  url.searchParams.set("code", args.code);

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
