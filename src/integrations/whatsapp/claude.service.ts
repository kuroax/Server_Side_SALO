import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ANTHROPIC_API_KEY } from '#/config/env.js';
import { logger } from '#/config/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ClaudeIntent =
  | 'catalog_query'
  | 'price_query'
  | 'create_order'
  | 'order_status'
  | 'general';

export type ClaudeOrderHint = {
  // These are HINTS from the model — treated as unverified user input.
  // webhook.service.ts reconciles them against the real catalog before
  // creating any order. Never trust price or productId from this object.
  productNameHint: string;
  size:            string;
  color:           string;
  quantity:        number;
};

export type ClaudeResult = {
  intent:      ClaudeIntent;
  response:    string;
  orderHints?: ClaudeOrderHint[];
};

export type ClaudeContext = {
  customerName: string | null;
  recentOrder: {
    orderNumber: string;
    status:      string;
    total:       number;
  } | null;
  catalog: {
    id:    string;
    name:  string;
    price: number;
    brand: string;
  }[];
  incomingMessage: string;
  // ── Dynamic business facts ─────────────────────────────────────────────────
  // Passed at call time so they never go stale inside the system prompt.
  businessInfo: {
    showroomAddress: string;
    businessHours:   string;
    shippingPrice:   number;
    paymentMethods:  string;
    depositPercent:  number;
    paymentDays:     number;
  };
};

// ─── Output schema ────────────────────────────────────────────────────────────
// FIX 1: Bidirectional orderHints contract via z.union().
//   create_order  → orderHints required, non-empty
//   all others    → orderHints must be absent (undefined)
// Previously a one-way .refine() allowed non-create_order intents to
// silently carry orderHints, which was inconsistent with the contract.

const orderHintSchema = z.object({
  productNameHint: z.string().min(1),
  size:            z.string().min(1),
  color:           z.string().min(1),
  quantity:        z.number().int().positive().max(100),
});

const claudeResultSchema = z.union([
  // Branch 1: create_order — orderHints required and non-empty
  z.object({
    intent:     z.literal('create_order'),
    response:   z.string().min(1).max(2000),
    orderHints: z.array(orderHintSchema).min(1),
  }),
  // Branch 2: all other intents — orderHints must be absent
  z.object({
    intent:     z.enum(['catalog_query', 'price_query', 'order_status', 'general']),
    response:   z.string().min(1).max(2000),
    orderHints: z.undefined().optional(),
  }),
]);

// ─── Safe fallback ────────────────────────────────────────────────────────────

const SAFE_FALLBACK: ClaudeResult = {
  intent:   'general',
  response: 'Disculpa, no pude procesar tu mensaje. ¿Puedes reformularlo?',
};

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS   = 512;

// FIX 3: Timeout — WhatsApp webhooks must respond quickly.
// If Claude hangs past this threshold Meta will retry the webhook,
// causing duplicate messages. 8s leaves margin before typical proxy limits.
const REQUEST_TIMEOUT_MS = 8_000;

// ─── System prompt ────────────────────────────────────────────────────────────
// Persona/tone instructions are kept here (stable, brand-driven).
// Unstable business facts (address, hours, pricing) are injected at call
// time via userContent so they never go stale inside this constant.

const SYSTEM_PROMPT = `Eres el asistente virtual de SALO shop, una tienda de ropa deportiva y lifestyle de marcas premium como Alo Yoga, Lululemon y Wiskii.

Respondes ÚNICAMENTE en español, imitando exactamente el estilo de comunicación del dueño Luis. Eres cálido, entusiasta, personal y cercano.

─── ESTILO DE COMUNICACIÓN ────────────────────────────────────────────────────

SALUDOS:
- "Hola buen día!", "Hello!", "Hola bonita buen día!🙌🏼", "Hola bella!"
- "¡Que gusto saludarte!", "¡Que gusto volverte a saludar!"

AFIRMACIONES:
- "Vaaaa!", "Sipi!", "Padrísimo!🙌🏼", "Perfecto!", "Super!", "Con mil gusto!"

APODOS (úsalos naturalmente):
- "bonita", "bella", "corazón", "linda", "amiga", "bb"

DISPONIBILIDAD:
- "Disponible!", "Disponible Talla M!🙌🏼"
- "Se me agotó🥹", "Lo manejo sobre pedido"

AL PRESENTAR PRODUCTOS Y PEDIDOS (siempre con ⭐️ por ítem):
- "⭐️Bra Alo color negro Talla S $2,190\n⭐️Legging Alo color negro Talla S $3,690\nTotal $5,880"

CUANDO EL CLIENTE CONFIRMA PAGO:
- "Mil Gracias!!! Que se te multiplique 70 mil veces 7!💫"
- "Sigo en súper contacto contigo para la entrega!🙏🏻"

CUANDO HAY DEMORA O PROBLEMA:
- "Disculpa la demora!", "Ntp corazón!", "Sigo en súper contacto contigo🙏🏻"

CIERRE:
- "Es un gusto atenderte🫶🏼", "Sigo a tus órdenes!", "A tiii!🙏🏻"

EMOJIS DE LUIS (úsalos con moderación): 🙌🏼 🙏🏻 🫶🏼 💫 ⭐️ 🥹 ✨

─── INTENCIONES POSIBLES ──────────────────────────────────────────────────────

- catalog_query : el cliente pregunta qué productos hay disponibles
- price_query   : el cliente pregunta por el precio de algo específico
- create_order  : el cliente quiere hacer un pedido (necesitas producto + talla + color)
- order_status  : el cliente pregunta por el estado de su pedido
- general       : saludos, preguntas generales, o mensajes que no encajan en lo anterior

─── REGLAS DE NEGOCIO ─────────────────────────────────────────────────────────

- Nunca inventes productos que no estén en el catálogo provisto
- Nunca inventes precios — el sistema los asigna internamente
- Si falta producto, talla o color para un pedido, usa intent "general" y pide los datos faltantes
- Los orderHints son SOLO lo que el cliente mencionó, NO datos de precio reales
- En Lululemon: talla M equivale a talla 8, talla S a talla 6, etc.

─── CONTRATO DE RESPUESTA — JSON ESTRICTO ─────────────────────────────────────

Sin markdown. Sin texto antes o después del JSON. Sin comentarios.

Para intent create_order (orderHints OBLIGATORIO y no vacío):
{
  "intent": "create_order",
  "response": "tu respuesta aquí",
  "orderHints": [
    {
      "productNameHint": "nombre aproximado del producto mencionado",
      "size": "talla mencionada",
      "color": "color mencionado",
      "quantity": 1
    }
  ]
}

Para cualquier otro intent (orderHints PROHIBIDO — no incluir el campo):
{
  "intent": "catalog_query" | "price_query" | "order_status" | "general",
  "response": "tu respuesta aquí"
}`;

// ─── Service ──────────────────────────────────────────────────────────────────

export const processMessage = async (
  context: ClaudeContext,
): Promise<ClaudeResult> => {
  const { customerName, recentOrder, catalog, incomingMessage, businessInfo } = context;

  // FIX 4: Business facts injected dynamically — never hardcoded in the prompt.
  // If address, hours, or pricing change, only the caller needs updating.
  const userContent = `CLIENTE: ${customerName ? `"${customerName}"` : 'Cliente nueva'}

CATÁLOGO DISPONIBLE:
${catalog.length === 0
    ? 'Sin productos disponibles en este momento.'
    : catalog.map((p) => `- ${p.name} (${p.brand}) — $${p.price} MXN`).join('\n')
  }

PEDIDO RECIENTE DEL CLIENTE:
${recentOrder
    ? `${recentOrder.orderNumber} — ${recentOrder.status} — $${recentOrder.total} MXN`
    : 'Sin pedidos previos.'
  }

INFORMACIÓN DEL NEGOCIO (usa estos datos exactos al responder):
- Showroom: ${businessInfo.showroomAddress}
- Horarios: ${businessInfo.businessHours}
- Envío nacional express: $${businessInfo.shippingPrice} MXN
- Formas de pago: ${businessInfo.paymentMethods}
- Anticipo mínimo: ${businessInfo.depositPercent}% — liquidar en ${businessInfo.paymentDays} días

MENSAJE DEL CLIENTE: "${incomingMessage}"`;

  logger.info(
    { catalogSize: catalog.length, hasRecentOrder: !!recentOrder },
    'Calling Claude API',
  );

  // ── API call with timeout + try/catch ─────────────────────────────────────
  // FIX 3: AbortSignal.timeout() cancels the request if Claude doesn't respond
  // within REQUEST_TIMEOUT_MS, preventing duplicate WhatsApp messages from
  // Meta's webhook retries on slow responses.
  let rawText: string;

  try {
    const message = await client.messages.create(
      {
        model:      CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system:     SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: userContent }],
      },
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );

    rawText = message.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('');
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    logger.error(
      { err, isTimeout },
      isTimeout
        ? 'Claude API timed out — returning safe fallback'
        : 'Claude API call failed — returning safe fallback',
    );
    return SAFE_FALLBACK;
  }

  // ── JSON parse ────────────────────────────────────────────────────────────
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawText);
  } catch {
    logger.warn({ rawText }, 'Claude returned non-JSON — returning safe fallback');
    return SAFE_FALLBACK;
  }

  // ── Schema validation ─────────────────────────────────────────────────────
  const validated = claudeResultSchema.safeParse(parsed);

  if (!validated.success) {
    logger.warn(
      { issues: validated.error.issues },
      'Claude output failed schema validation — returning safe fallback',
    );
    return SAFE_FALLBACK;
  }

  logger.info({ intent: validated.data.intent }, 'Claude response validated successfully');

  // FIX 2: Removed unnecessary `as ClaudeResult` cast.
  // z.union() infers the correct type — the cast was a code smell
  // suggesting distrust of the validator. Zod's output is already typed.
  return validated.data;
};