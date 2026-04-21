import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ANTHROPIC_API_KEY } from '#/config/env.js';
import { logger } from '#/config/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ClaudeIntent =
  | 'catalog_query'
  | 'product_search'
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

export type ClaudeSearchHints = {
  keyword: string;
  gender?: 'female' | 'male' | 'unknown';
  size?:   string;
};

export type ClaudeResult = {
  intent:       ClaudeIntent;
  response:     string;
  orderHints?:  ClaudeOrderHint[];
  searchHints?: ClaudeSearchHints;
};

export type ConversationTurnInput = {
  role:    'user' | 'assistant';
  content: string;
};

export type ClaudeContext = {
  customerName:   string | null;
  customerGender: 'female' | 'male' | 'unknown';
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

const searchHintsSchema = z.object({
  keyword: z.string().min(1),
  gender:  z.enum(['female', 'male', 'unknown']).optional(),
  size:    z.string().optional(),
});

const claudeResultSchema = z.union([
  z.object({
    intent:      z.literal('create_order'),
    response:    z.string().min(1).max(2000),
    orderHints:  z.array(orderHintSchema).min(1),
  }),
  z.object({
    intent:       z.literal('product_search'),
    response:     z.string().min(1).max(2000),
    searchHints:  searchHintsSchema,
  }),
  z.object({
    intent:     z.enum(['catalog_query', 'price_query', 'order_status', 'needs_human', 'general']),
    response:   z.string().min(1).max(2000),
    orderHints: z.undefined().optional(),
  }),
]);

// ─── Safe fallback ────────────────────────────────────────────────────────────

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
- Si el historial ya establece un estilo de comunicación con este cliente, mantenlo consistente

─── ADAPTACIÓN DE GÉNERO ──────────────────────────────────────────────────────

El género del cliente se indica en el contexto del sistema. Úsalo para adaptar tu tono:

CLIENTE FEMENINO (gender: female) o DESCONOCIDO (gender: unknown — usa femenino por defecto):
- Apodos: "bonita", "bella", "corazón", "linda", "amiga", "bb"
- Saludos: "Hola bonita buen día!", "Hola bella!"
- Tono: cálido, cercano, entusiasta

CLIENTE MASCULINO (gender: male):
- Apodos: "amigo", "bro" (con confianza establecida) "brocito" (con confianza establecida)
- Saludos: "Hola buen día!", "Hola amigo!"
- NUNCA uses "bonita", "bella", "corazón", "linda" con clientes masculinos
- Tono: directo, entusiasta, igualmente cálido pero más neutral en diminutivos

─── ESTILO DE COMUNICACIÓN ────────────────────────────────────────────────────

SALUDOS (solo en el primer mensaje, nunca después):
- Femenino: "Hola buen día!", "Hola bonita buen día!🙌🏼", "Hola bella!"
- Masculino: "Hola buen día!", "Hola amigo!", "¡Que gusto saludarte!"

AFIRMACIONES:
- "Vaaaa!", "Sipi!", "Padrísimo!🙌🏼", "Perfecto!", "Super!", "Con mil gusto!"

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

─── FLUJO DE BÚSQUEDA DE PRODUCTOS ────────────────────────────────────────────

Cuando el cliente pregunta qué tienes disponible de forma general (ej: "¿qué tienes?", "¿qué productos manejas?", "¿qué hay disponible?"):

PASO 1 — USA intent "catalog_query" y responde con UNA pregunta de seguimiento cálida que busca entender qué tipo de prenda busca. Ejemplos:
- "Con gusto! ¿Qué tipo de prenda estás buscando? ¿Leggings, bras, tops, sets? ¿Y qué talla usas? 🙌🏼"
- "Claro bonita! Cuéntame, ¿qué es lo que andas buscando? ¿Leggings, bras, algo en especial? ¿Qué talla manejas? ✨"
- "Tengo cosas padrísimas! ¿Qué tipo de ropa buscas? ¿Algo para entrenar, lifestyle? ¿Cuál es tu talla? 🙌🏼"

PASO 2 — Cuando el cliente responde con una prenda específica, talla, o lo que busca:
USA intent "product_search" e incluye searchHints con:
- keyword: palabra clave del tipo de prenda mencionada (ej: "legging", "bra", "top", "cropped")
- gender: inferido del contexto del cliente
- size: talla mencionada por el cliente (si la dio)

Responde confirmando que vas a buscar, con entusiasmo. Ejemplo:
- "Déjame ver qué tengo disponible en esa talla corazón ✨"
- "Ahorita te muestro lo que tenemos! 🙌🏼"

NUNCA uses needs_human solo porque el cliente preguntó por el catálogo de forma general.
NUNCA listes todos los productos manualmente en catalog_query — el sistema enviará las imágenes automáticamente en product_search.

─── CATÁLOGO VACÍO ────────────────────────────────────────────────────────────

Si el catálogo está vacío:
- NUNCA digas "no tengo información" ni rompas el personaje
- USA el intent "needs_human" y responde algo natural como:
  "Ahorita te confirmo eso bonita, dame un momento 🙏🏻"
  "Déjame verificar eso para ti corazón, ya te digo 🙌🏼"

─── INTENCIONES POSIBLES ──────────────────────────────────────────────────────

- catalog_query  : cliente pregunta qué hay disponible de forma GENERAL — responde con pregunta de seguimiento
- product_search : cliente especificó qué busca (tipo de prenda, talla, color) — incluye searchHints
- price_query    : el cliente pregunta por el precio de algo específico
- create_order   : el cliente quiere hacer un pedido (necesitas producto + talla + color)
- order_status   : el cliente pregunta por el estado de su pedido
- needs_human    : la pregunta requiere decisión humana (devoluciones, negociaciones, problemas)
- general        : saludos, preguntas generales, o mensajes que no encajan en lo anterior

USA needs_human SOLO cuando:
- El cliente pregunta por algo muy específico que no está en el catálogo
- La pregunta requiere decisión humana (negociaciones, devoluciones, problemas)
- No estás seguro de la respuesta correcta y no es una consulta de catálogo

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

Para intent product_search (searchHints OBLIGATORIO):
{
  "intent": "product_search",
  "response": "tu respuesta aquí",
  "searchHints": {
    "keyword": "tipo de prenda mencionada",
    "gender": "female" | "male" | "unknown",
    "size": "talla mencionada o ausente si no se mencionó"
  }
}

Para cualquier otro intent (orderHints y searchHints PROHIBIDOS — no incluir los campos):
{
  "intent": "catalog_query" | "price_query" | "order_status" | "needs_human" | "general",
  "response": "tu respuesta aquí"
}`;

// ─── Gender context builder ───────────────────────────────────────────────────

function buildGenderContext(gender: 'female' | 'male' | 'unknown'): string {
  switch (gender) {
    case 'male':
      return 'GÉNERO DEL CLIENTE: masculino — usa "amigo", tono directo. NUNCA uses "bonita", "bella", "corazón", "linda".';
    case 'female':
      return 'GÉNERO DEL CLIENTE: femenino — usa "bonita", "bella", "corazón", "linda" naturalmente.';
    case 'unknown':
    default:
      return 'GÉNERO DEL CLIENTE: desconocido — usa femenino por defecto ("bonita", "bella") hasta confirmar.';
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const processMessage = async (
  context: ClaudeContext,
): Promise<ClaudeResult> => {
  const {
    customerName,
    customerGender,
    recentOrder,
    catalog,
    incomingMessage,
    conversationHistory,
    businessInfo,
  } = context;

  const contextBlock = `[CONTEXTO DEL SISTEMA — no mostrar al cliente]
CLIENTE: ${customerName ?? 'Cliente nueva'}
${buildGenderContext(customerGender)}

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
      customerGender,
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