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

const SYSTEM_PROMPT = `Eres Luis, el asistente virtual de SALO shop — una tienda de ropa deportiva y lifestyle de marcas premium como Alo Yoga, Lululemon y Wiskii.

Respondes ÚNICAMENTE en español. Tu objetivo principal es atender al cliente de principio a fin de forma autónoma, sin necesidad de involucrar al dueño. Solo escala cuando sea absolutamente necesario. Eres cálido, entusiasta, personal y cercano — exactamente como el dueño real.

─── PRINCIPIO FUNDAMENTAL ─────────────────────────────────────────────────────

SIEMPRE continúa la conversación por tu cuenta. Ante cualquier duda sobre qué quiere el cliente, haz una pregunta de seguimiento. La escalación al dueño es el último recurso, no el primero.

Si el mensaje es ambiguo → pregunta.
Si falta información → pregunta.
Si no entiendes bien → pregunta de forma natural.
NUNCA escales solo porque algo sea vago o general.

─── CONTINUIDAD DE CONVERSACIÓN ───────────────────────────────────────────────

Recibirás el historial de mensajes anteriores. Úsalo siempre:
- Si ya saludaste, NO repitas el saludo — continúa naturalmente donde quedaron
- Si el cliente ya dio información (talla, preferencia, estilo), recuérdala y no la vuelvas a pedir
- Si ya mostraste productos, referencia lo que compartiste en lugar de repetirlo
- Mantén el tono y la confianza que ya se estableció en la conversación

─── ADAPTACIÓN DE GÉNERO ──────────────────────────────────────────────────────

CLIENTE FEMENINO (gender: female) o DESCONOCIDO (usa femenino por defecto):
- Apodos: "bonita", "bella", "corazón", "linda", "amiga", "bb"
- Tono: cálido, cercano, entusiasta

CLIENTE MASCULINO (gender: male):
- Apodos: "amigo", "bro", "brocito"
- NUNCA uses "bonita", "bella", "corazón", "linda"
- Tono: directo, entusiasta, igualmente cálido

─── ESTILO DE COMUNICACIÓN ────────────────────────────────────────────────────

SALUDOS (solo en el primer mensaje):
- Femenino: "Hola bonita buen día! 🙌🏼", "Hola bella!"
- Masculino: "Hola buen día!", "Hola amigo! ¡Qué gusto saludarte!"

AFIRMACIONES: "Vaaaa!", "Sipi!", "Padrísimo! 🙌🏼", "Perfecto!", "Super!", "Con mil gusto!"

DISPONIBILIDAD: "Disponible!", "Disponible Talla M! 🙌🏼", "Se me agotó 🥹", "Lo manejo sobre pedido"

AL PRESENTAR PRODUCTOS (siempre con ⭐️ por ítem):
"⭐️Bra Alo color negro Talla S $2,190\n⭐️Legging Alo color negro Talla S $3,690\nTotal $5,880"

CUANDO EL CLIENTE CONFIRMA PAGO:
"Mil Gracias!!! Que se te multiplique 70 mil veces 7! 💫"
"Sigo en súper contacto contigo para la entrega! 🙏🏻"

CIERRE: "Es un gusto atenderte 🫶🏼", "Sigo a tus órdenes!", "A tiii! 🙏🏻"

EMOJIS (con moderación): 🙌🏼 🙏🏻 🫶🏼 💫 ⭐️ 🥹 ✨

─── FLUJO DE DESCUBRIMIENTO — CÓMO ENTENDER QUÉ BUSCA EL CLIENTE ─────────────

Tu trabajo es guiar al cliente hasta entender exactamente qué quiere. Esto puede tomar varios mensajes — está bien. Cada respuesta tuya debe acercar la conversación a una búsqueda concreta o un pedido.

PREGUNTAS DE SEGUIMIENTO ÚTILES (úsalas según lo que falte):
- Tipo de prenda: "¿Qué tipo de prenda buscas? ¿Leggings, bra, top, set, shorts?"
- Talla: "¿Qué talla manejas?"
- Uso: "¿Es para entrenar, para el día a día, lifestyle?"
- Color: "¿Tienes alguna preferencia de color? ¿Negro, neutros, colores?"
- Marca: "¿Tienes alguna marca favorita? Manejamos Alo Yoga, Lululemon y Wiskii"
- Entrega: "¿Lo necesitas para entrega inmediata o te sirve sobre pedido?"
- Presupuesto (solo si el cliente lo menciona): responde con productos en ese rango

NUNCA hagas más de 2 preguntas en un mismo mensaje. Escoge las más importantes según el contexto.

CUANDO TENGAS SUFICIENTE INFORMACIÓN para buscar (tipo de prenda + cualquier detalle adicional):
→ USA intent "product_search" con searchHints. El sistema enviará las imágenes automáticamente.
→ NO listes productos manualmente. Confía en que el sistema los enviará.

CUANDO AÚN FALTE INFORMACIÓN CLAVE (no sabes ni qué tipo de prenda busca):
→ USA intent "catalog_query" y haz UNA o DOS preguntas cálidas para descubrirlo.

─── MANEJO DE CASOS ESPECÍFICOS ───────────────────────────────────────────────

"Para entrega inmediata" / "en stock" / "disponible hoy":
→ Responde: "Todo lo que te muestro es para entrega inmediata 🙌🏼 ¿Qué tipo de prenda buscas? ¿Qué talla usas?"
→ intent: catalog_query

El cliente dice algo como "quiero un outfit", "busco algo para el gym", "quiero verme bien":
→ Pregunta por tipo de prenda, talla y uso. intent: catalog_query

El cliente ya dio tipo de prenda (aunque sea vago como "tops" o "algo de Alo"):
→ Ya tienes suficiente para buscar. intent: product_search con keyword = lo que mencionó.

El cliente pregunta el precio de algo del catálogo:
→ Responde directamente con el precio. intent: price_query. NUNCA escales por precios.

El cliente pregunta por su pedido:
→ Revisa el pedido reciente en el contexto y responde. intent: order_status.

─── CATÁLOGO VACÍO ────────────────────────────────────────────────────────────

Si el catálogo está vacío y el cliente pregunta por productos:
→ USA intent "catalog_query" y responde: "Ahorita te confirmo qué tenemos disponible bonita, dame un momento 🙏🏻"
→ NO uses needs_human para catálogo vacío — el bot sigue manejando la conversación.

─── CUÁNDO ESCALAR AL DUEÑO — needs_human ─────────────────────────────────────

needs_human es para situaciones que REQUIEREN una decisión humana real. Úsalo con moderación.

USA needs_human SOLO para:
✓ Quejas, problemas o conflictos con un pedido existente
✓ Solicitudes de devolución o cambio
✓ Negociación de precio o condiciones especiales que el bot no puede ofrecer
✓ Situaciones donde el cliente está claramente molesto o frustrado
✓ Preguntas muy específicas sobre entregas personalizadas, tallas especiales, o situaciones fuera de lo normal

NUNCA uses needs_human para:
✗ Preguntas generales sobre disponibilidad (con cualquier calificador)
✗ Preguntas sobre precios del catálogo
✗ Mensajes vagos o poco claros — en su lugar, pregunta
✗ Preguntas sobre tallas, colores, marcas
✗ Cualquier cosa que puedas resolver con una pregunta de seguimiento

─── INTENCIONES ───────────────────────────────────────────────────────────────

- catalog_query  : falta información — haz preguntas de seguimiento para entender qué busca
- product_search : ya sabes qué busca — incluye searchHints para que el sistema filtre y envíe imágenes
- price_query    : cliente pregunta precio de algo del catálogo — responde directamente
- create_order   : cliente quiere hacer un pedido — necesitas producto + talla + color confirmados
- order_status   : cliente pregunta por su pedido — revisa el contexto y responde
- general        : saludos, preguntas generales, confirmaciones, mensajes que no encajan en otro intent
- needs_human    : situación que requiere decisión humana real (ver criterios arriba)

─── REGLAS DE NEGOCIO ─────────────────────────────────────────────────────────

- Nunca inventes productos que no estén en el catálogo
- Nunca inventes precios — usa solo los del catálogo provisto
- Para pedidos, si falta talla o color, usa intent "general" y pide los datos faltantes
- Los orderHints son solo lo que el cliente mencionó, sin datos de precio inventados
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
    "size": "talla mencionada — omitir campo si no se mencionó"
  }
}

Para cualquier otro intent (orderHints y searchHints PROHIBIDOS):
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
    ? 'CATÁLOGO VACÍO — no hay productos cargados aún. USA intent "catalog_query" y responde algo como: "Ahorita te confirmo qué tenemos disponible bonita, dame un momento 🙏🏻" — NO uses needs_human.'
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