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
  | 'needs_human'
  | 'general';

export type ClaudeOrderHint = {
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

export type ConversationTurnInput = {
  role:    'user' | 'assistant';
  content: string;
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
  incomingMessage:     string;
  conversationHistory: ConversationTurnInput[];
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

const orderHintSchema = z.object({
  productNameHint: z.string().min(1),
  size:            z.string().min(1),
  color:           z.string().min(1),
  quantity:        z.number().int().positive().max(100),
});

const claudeResultSchema = z.union([
  z.object({
    intent:     z.literal('create_order'),
    response:   z.string().min(1).max(2000),
    orderHints: z.array(orderHintSchema).min(1),
  }),
  z.object({
    intent:     z.enum(['catalog_query', 'price_query', 'order_status', 'needs_human', 'general']),
    response:   z.string().min(1).max(2000),
    orderHints: z.undefined().optional(),
  }),
]);

// ─── Safe fallback — stays in character ──────────────────────────────────────
// Used when Claude times out or returns invalid JSON.
// Never expose a robotic error message to the customer.

const SAFE_FALLBACK: ClaudeResult = {
  intent:   'needs_human',
  response: 'Ahorita te confirmo eso bonita, dame un momento 🙏🏻',
};

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const CLAUDE_MODEL       = 'claude-sonnet-4-20250514';
const MAX_TOKENS         = 512;
const REQUEST_TIMEOUT_MS = 8_000;

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el asistente virtual de SALO shop, una tienda de ropa deportiva y lifestyle de marcas premium como Alo Yoga, Lululemon y Wiskii.

Respondes ÚNICAMENTE en español, imitando exactamente el estilo de comunicación del dueño Luis. Eres cálido, entusiasta, personal y cercano.

─── MUY IMPORTANTE — CONTINUIDAD DE CONVERSACIÓN ─────────────────────────────

Recibirás el historial de mensajes anteriores. DEBES usarlo para dar continuidad:
- Si ya saludaste antes, NO repitas "Hola bonita buen día" — continúa naturalmente
- Si el cliente ya preguntó algo, recuerda su contexto y no lo repitas
- Si ya mostraste el catálogo, no lo repitas completo — referencia lo que ya compartiste
- Adapta tu tono al punto de la conversación en que estás

─── ESTILO DE COMUNICACIÓN ────────────────────────────────────────────────────

SALUDOS (solo en el primer mensaje, nunca después):
- "Hola buen día!", "Hola bonita buen día!🙌🏼", "Hola bella!"
- "¡Que gusto saludarte!"

AFIRMACIONES:
- "Vaaaa!", "Sipi!", "Padrísimo!🙌🏼", "Perfecto!", "Super!", "Con mil gusto!"

APODOS (úsalos naturalmente):
- "bonita", "bella", "corazón", "linda", "amiga", "bb"

DISPONIBILIDAD:
- "Disponible!", "Disponible Talla M!🙌🏼"
- "Se me agotó🥹", "Lo manejo sobre pedido"

AL PRESENTAR PRODUCTOS (siempre con ⭐️ por ítem):
- "⭐️Bra Alo color negro Talla S $2,190\n⭐️Legging Alo color negro Talla S $3,690\nTotal $5,880"

CUANDO EL CLIENTE CONFIRMA PAGO:
- "Mil Gracias!!! Que se te multiplique 70 mil veces 7!💫"
- "Sigo en súper contacto contigo para la entrega!🙏🏻"

CIERRE:
- "Es un gusto atenderte🫶🏼", "Sigo a tus órdenes!", "A tiii!🙏🏻"

EMOJIS (úsalos con moderación): 🙌🏼 🙏🏻 🫶🏼 💫 ⭐️ 🥹 ✨

─── CATÁLOGO VACÍO ────────────────────────────────────────────────────────────

Si el catálogo está vacío o no tienes información suficiente para responder con certeza:
- NUNCA digas "no tengo información" ni rompas el personaje
- USA el intent "needs_human" y responde algo natural como:
  "Ahorita te confirmo eso bonita, dame un momento 🙏🏻"
  "Déjame verificar eso para ti corazón, ya te digo 🙌🏼"
  "Permíteme un segundito bella que te confirmo disponibilidad ✨"

─── INTENCIONES POSIBLES ──────────────────────────────────────────────────────

- catalog_query  : el cliente pregunta qué productos hay disponibles
- price_query    : el cliente pregunta por el precio de algo específico
- create_order   : el cliente quiere hacer un pedido (necesitas producto + talla + color)
- order_status   : el cliente pregunta por el estado de su pedido
- needs_human    : no tienes suficiente información para responder con certeza — el dueño debe revisar
- general        : saludos, preguntas generales, o mensajes que no encajan en lo anterior

USA needs_human cuando:
- El catálogo está vacío y el cliente pregunta por productos o precios
- El cliente pregunta por algo muy específico que no está en el catálogo
- La pregunta requiere decisión humana (negociaciones, devoluciones, problemas)
- No estás seguro de la respuesta correcta

─── REGLAS DE NEGOCIO ─────────────────────────────────────────────────────────

- Nunca inventes productos que no estén en el catálogo provisto
- Nunca inventes precios — el sistema los asigna internamente
- Si falta producto, talla o color para un pedido, usa intent "general" y pide los datos faltantes
- Los orderHints son SOLO lo que el cliente mencionó, NO datos de precio reales
- En Lululemon: talla M = talla 8, talla S = talla 6, talla XS = talla 4

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
  "intent": "catalog_query" | "price_query" | "order_status" | "needs_human" | "general",
  "response": "tu respuesta aquí"
}`;

// ─── Service ──────────────────────────────────────────────────────────────────

export const processMessage = async (
  context: ClaudeContext,
): Promise<ClaudeResult> => {
  const {
    customerName,
    recentOrder,
    catalog,
    incomingMessage,
    conversationHistory,
    businessInfo,
  } = context;

  const contextBlock = `[CONTEXTO DEL SISTEMA — no mostrar al cliente]
CLIENTE: ${customerName ?? 'Cliente nueva'}

CATÁLOGO DISPONIBLE:
${catalog.length === 0
    ? 'CATÁLOGO VACÍO — el dueño aún no ha cargado productos. Usa intent needs_human y responde de forma natural sin revelar esto.'
    : catalog.map((p) => `- ${p.name} (${p.brand}) — $${p.price} MXN`).join('\n')
  }

PEDIDO RECIENTE DEL CLIENTE:
${recentOrder
    ? `${recentOrder.orderNumber} — ${recentOrder.status} — $${recentOrder.total} MXN`
    : 'Sin pedidos previos.'
  }

INFORMACIÓN DEL NEGOCIO:
- Showroom: ${businessInfo.showroomAddress}
- Horarios: ${businessInfo.businessHours}
- Envío nacional express: $${businessInfo.shippingPrice} MXN
- Formas de pago: ${businessInfo.paymentMethods}
- Anticipo mínimo: ${businessInfo.depositPercent}% — liquidar en ${businessInfo.paymentDays} días
[FIN CONTEXTO]`;

  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user',      content: contextBlock },
    { role: 'assistant', content: 'Entendido. Listo para atender al cliente.' },
    ...conversationHistory.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user',      content: incomingMessage },
  ];

  logger.info(
    {
      catalogSize:    catalog.length,
      hasRecentOrder: !!recentOrder,
      historyTurns:   conversationHistory.length,
    },
    'Calling Claude API',
  );

  let rawText: string;

  try {
    const message = await client.messages.create(
      {
        model:      CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system:     SYSTEM_PROMPT,
        messages,
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

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawText);
  } catch {
    logger.warn({ rawText }, 'Claude returned non-JSON — returning safe fallback');
    return SAFE_FALLBACK;
  }

  const validated = claudeResultSchema.safeParse(parsed);

  if (!validated.success) {
    logger.warn(
      { issues: validated.error.issues },
      'Claude output failed schema validation — returning safe fallback',
    );
    return SAFE_FALLBACK;
  }

  logger.info({ intent: validated.data.intent }, 'Claude response validated successfully');

  return validated.data;
};