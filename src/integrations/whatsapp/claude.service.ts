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
  customerName:    string | null;
  recentOrder:     {
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
};

// ─── Output schema ────────────────────────────────────────────────────────────
// Validates Claude's JSON response at runtime. Rejects invalid shapes instead
// of trusting TypeScript casts. Server-side source of truth for all business data.

const orderHintSchema = z.object({
  productNameHint: z.string().min(1),
  size:            z.string().min(1),
  color:           z.string().min(1),
  quantity:        z.number().int().positive().max(100),
});

const claudeResultSchema = z.object({
  intent: z.enum([
    'catalog_query',
    'price_query',
    'create_order',
    'order_status',
    'general',
  ]),
  response:   z.string().min(1).max(2000),
  orderHints: z.array(orderHintSchema).optional(),
}).refine(
  // orderHints must only appear on create_order intent.
  (data) => data.intent !== 'create_order' || (data.orderHints && data.orderHints.length > 0),
  { message: 'create_order intent requires at least one orderHint' }
);

// ─── Safe fallback ────────────────────────────────────────────────────────────
// Used when Claude returns invalid JSON or a schema-invalid response.
// Never pass raw model output to users on failure.

const SAFE_FALLBACK: ClaudeResult = {
  intent:   'general',
  response: 'Disculpa, no pude procesar tu mensaje. ¿Puedes reformularlo?',
};

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Model name in a constant — easier to rotate across environments.
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS   = 512; // JSON-only response — 1024 is excessive for this use case.

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el asistente virtual de SALO, una tienda de ropa.
Respondes ÚNICAMENTE en español, de forma amigable y concisa.

Tu trabajo es:
1. Detectar la intención del mensaje del cliente
2. Responder de forma natural y útil

INTENCIONES POSIBLES:
- catalog_query: el cliente pregunta por productos disponibles
- price_query: el cliente pregunta por el precio de algo
- create_order: el cliente quiere hacer un pedido (menciona producto + talla + color)
- order_status: el cliente pregunta por su pedido
- general: saludos, preguntas generales, o mensajes que no encajan en lo anterior

REGLAS:
- Nunca inventes productos que no estén en el catálogo
- Nunca inventes precios — el sistema los asigna internamente
- Si falta información para un pedido (producto, talla o color), usa intent "general" y pide los datos faltantes
- Los orderHints son SOLO referencias de lo que el cliente mencionó, NO precios reales

FORMATO DE RESPUESTA — JSON estricto, sin markdown, sin texto extra:
{
  "intent": "catalog_query" | "price_query" | "create_order" | "order_status" | "general",
  "response": "tu respuesta en español aquí",
  "orderHints": [
    {
      "productNameHint": "nombre aproximado del producto mencionado",
      "size": "talla mencionada",
      "color": "color mencionado",
      "quantity": 1
    }
  ]
}

orderHints SOLO se incluye cuando intent === "create_order" y tienes todos los datos necesarios.`;

// ─── Service ──────────────────────────────────────────────────────────────────

export const processMessage = async (
  context: ClaudeContext,
): Promise<ClaudeResult> => {
  const { customerName, recentOrder, catalog, incomingMessage } = context;

  const userContent = `CLIENTE: ${customerName ? `"${customerName}"` : 'Cliente nuevo'}

CATÁLOGO:
${catalog.length === 0
    ? 'Sin productos disponibles.'
    : catalog.map((p) => `- ${p.name} (${p.brand}) — $${p.price} MXN`).join('\n')
  }

PEDIDO RECIENTE:
${recentOrder
    ? `${recentOrder.orderNumber} — ${recentOrder.status} — $${recentOrder.total} MXN`
    : 'Sin pedidos previos.'
  }

MENSAJE: "${incomingMessage}"`;

  logger.info(
    { catalogSize: catalog.length, hasRecentOrder: !!recentOrder },
    'Calling Claude API',
  );

  // ── API call with try/catch — provider failures return safe fallback ───────
  let rawText: string;

  try {
    const message = await client.messages.create({
      model:    CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system:   SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    rawText = message.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('');
  } catch (err) {
    logger.error({ err }, 'Claude API call failed — returning safe fallback');
    return SAFE_FALLBACK;
  }

  // ── JSON parse ────────────────────────────────────────────────────────────
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawText);
  } catch {
    logger.warn('Claude returned non-JSON — returning safe fallback');
    return SAFE_FALLBACK;
  }

  // ── Schema validation — reject invalid shapes ─────────────────────────────
  const validated = claudeResultSchema.safeParse(parsed);

  if (!validated.success) {
    logger.warn(
      { issues: validated.error.issues },
      'Claude output failed schema validation — returning safe fallback',
    );
    return SAFE_FALLBACK;
  }

  logger.info({ intent: validated.data.intent }, 'Claude response validated successfully');

  return validated.data as ClaudeResult;
};