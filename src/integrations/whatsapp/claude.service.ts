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

// Returned by the searchProducts callback.
// name/brand/price are formatted into the tool result text sent back to Claude.
// imageUrl/imageCaption are accumulated into productImages in the agentic loop.
export type ProductSearchItem = {
  name:          string;
  brand:         string;
  price:         number;
  imageUrl?:     string;
  imageCaption?: string;
};

export type SearchProductsFn = (hints: ClaudeSearchHints) => Promise<ProductSearchItem[]>;

// Internal — shape of Claude's JSON output.
type ClaudeJsonResult = {
  intent:       ClaudeIntent;
  response:     string;
  orderHints?:  ClaudeOrderHint[];
  searchHints?: ClaudeSearchHints;
};

// Public — what processMessage returns.
// productImages are populated by the agentic loop during tool calls, not by Claude's JSON.
export type ProcessMessageOutput = ClaudeJsonResult & {
  productImages: Array<{ url: string; caption?: string }>;
};

export type ConversationTurnInput = {
  role:    'user' | 'assistant';
  content: string;
};

export type ClaudeContext = {
  customerName:        string | null;
  customerGender:      'female' | 'male' | 'unknown';
  recentOrder: {
    orderNumber: string;
    status:      string;
    total:       number;
  } | null;
  // Replaces the full catalog injection. Called on-demand by the agentic loop
  // when Claude uses the search_products tool. Only fires when Claude actually
  // needs to search — zero cost for greetings, order status, price queries, etc.
  searchProducts:      SearchProductsFn;
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

// ─── Output schema (validates Claude's JSON) ──────────────────────────────────

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

// No character cap on response — truncation is detected via stop_reason instead.
const claudeResultSchema = z.union([
  z.object({
    intent:      z.literal('create_order'),
    response:    z.string().min(1),
    orderHints:  z.array(orderHintSchema).min(1),
  }),
  z.object({
    // product_search: searchHints is now optional because the actual search
    // is performed via the search_products tool during the agentic loop.
    // productImages are populated by the loop, not by this JSON field.
    intent:      z.literal('product_search'),
    response:    z.string().min(1),
    searchHints: searchHintsSchema.optional(),
  }),
  z.object({
    intent:     z.enum(['catalog_query', 'price_query', 'order_status', 'needs_human', 'general']),
    response:   z.string().min(1),
    orderHints: z.undefined().optional(),
  }),
]);

// ─── Tool input schema ────────────────────────────────────────────────────────

const searchProductsInputSchema = z.object({
  keyword: z.string().min(1),
  gender:  z.enum(['female', 'male', 'unknown']).optional(),
  size:    z.string().optional(),
});

// ─── Tool definition ──────────────────────────────────────────────────────────

const SEARCH_PRODUCTS_TOOL: Anthropic.Tool = {
  name: 'search_products',
  description:
    'Busca productos en el inventario de SALO según criterios del cliente. ' +
    'Úsala cuando el cliente busque un tipo de prenda, marca o descripción específica. ' +
    'El sistema enviará las imágenes de los productos encontrados automáticamente al cliente — ' +
    'tu respuesta solo necesita anunciar que los mostrarás.',
  input_schema: {
    type: 'object' as const,
    properties: {
      keyword: {
        type: 'string',
        description:
          'Tipo de prenda, nombre o marca. Ej: "legging", "crop top", "bra", "short", "Alo", "Lululemon".',
      },
      gender: {
        type: 'string',
        enum: ['female', 'male', 'unknown'],
        description: 'Género del cliente o del producto buscado.',
      },
      size: {
        type: 'string',
        description: 'Talla buscada. Ej: "XS", "S", "M", "L", "XL".',
      },
    },
    required: ['keyword'],
  },
};

// ─── Safe fallback ────────────────────────────────────────────────────────────

const SAFE_FALLBACK: ProcessMessageOutput = {
  intent:        'needs_human',
  response:      'Ahorita te confirmo eso bonita, dame un momento 🙏🏻',
  productImages: [],
};

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

// Raised from 512 to 1024. At 512, product lists with prices and a follow-up
// question routinely exceeded the limit, producing truncated JSON that failed
// parsing and returned SAFE_FALLBACK — appearing as a false escalation.
const MAX_TOKENS = 1024;

// Base timeout for short conversations. Extended dynamically per conversation
// length below — longer history means more input tokens and slower responses.
// MAX_TIMEOUT_MS raised from 20s to 30s to accommodate tool call round trips
// (DB query + second Claude call). In practice tool calls add ~1-2s total.
const BASE_TIMEOUT_MS    = 10_000;
const MAX_TIMEOUT_MS     = 30_000;
const RETRY_DELAY_MS     = 1_000;
const MAX_TOOL_ITERATIONS = 3; // safety cap — Claude should use the tool at most once per message

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

AL CONFIRMAR UN PEDIDO O LISTAR PRECIOS ESPECÍFICOS (create_order, price_query):
Usa el formato con ⭐️ por ítem solo cuando estés confirmando un pedido o respondiendo
una pregunta de precio específica — NO cuando uses search_products:
"⭐️Bra Alo color negro Talla S $2,190\n⭐️Legging Alo color negro Talla S $3,690\nTotal $5,880"

CUANDO LLAMES search_products:
→ NO listes productos manualmente con ⭐️ ni precios.
→ Di únicamente que vas a mostrárselos: "Ahorita te muestro lo que tengo ✨" o "Sipi! Tengo opciones bonitas, te las muestro 🙌🏼"
→ El sistema enviará las imágenes automáticamente con nombre y precio.
→ Nunca dupliques información que el sistema ya enviará.

CUANDO EL CLIENTE CONFIRMA PAGO:
"Mil Gracias!!! Que se te multiplique 70 mil veces 7! 💫"
"Sigo en súper contacto contigo para la entrega! 🙏🏻"

CIERRE: "Es un gusto atenderte 🫶🏼", "Sigo a tus órdenes!", "A tiii! 🙏🏻"

EMOJIS (con moderación): 🙌🏼 🙏🏻 🫶🏼 💫 ⭐️ 🥹 ✨

─── HERRAMIENTA: search_products ──────────────────────────────────────────────

Tienes acceso a la herramienta search_products para buscar en el inventario de SALO.

CUÁNDO USARLA:
→ Cuando el cliente mencione un tipo de prenda, marca o producto específico y ya tengas suficiente información para buscar.
→ Ejemplos: "tienes crop tops", "busco algo de Alo", "quiero leggings talla S", "algo de Lululemon para mujeres".

CUÁNDO NO USARLA:
→ Cuando aún falta información clave (no sabes ni qué tipo de prenda busca). Pregunta primero.
→ Para preguntas de precio de un producto ya conocido — responde directamente con price_query.
→ Para preguntas de pedidos — usa order_status.

FLUJO CORRECTO:
1. Llama search_products con los criterios disponibles.
2. Si encuentras productos: usa intent "product_search" y responde anunciando que los mostrarás.
3. Si no encuentras productos: responde con catalog_query pidiendo más información o sugiere otras opciones.

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
→ Llama search_products. Luego usa intent "product_search".
→ Tu response solo anuncia que los mostrarás — el sistema envía las imágenes automáticamente.

CUANDO AÚN FALTE INFORMACIÓN CLAVE (no sabes ni qué tipo de prenda busca):
→ USA intent "catalog_query" y haz UNA o DOS preguntas cálidas para descubrirlo.

─── MANEJO DE CASOS ESPECÍFICOS ───────────────────────────────────────────────

"Para entrega inmediata" / "en stock" / "disponible hoy":
→ Responde: "Todo lo que te muestro es para entrega inmediata 🙌🏼 ¿Qué tipo de prenda buscas? ¿Qué talla usas?"
→ intent: catalog_query

El cliente dice algo como "quiero un outfit", "busco algo para el gym", "quiero verme bien":
→ Pregunta por tipo de prenda, talla y uso. intent: catalog_query

El cliente ya dio tipo de prenda (aunque sea vago como "tops" o "algo de Alo"):
→ Ya tienes suficiente para buscar. Llama search_products con keyword = lo que mencionó. Luego intent: product_search.

El cliente pregunta el precio de algo:
→ Responde directamente con el precio si lo conoces. intent: price_query. NUNCA escales por precios.

El cliente pregunta por su pedido:
→ Revisa el pedido reciente en el contexto y responde. intent: order_status.

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
- product_search : llamaste search_products y encontraste resultados — anuncia que los mostrarás
- price_query    : cliente pregunta precio de algo — responde directamente
- create_order   : cliente quiere hacer un pedido — necesitas producto + talla + color confirmados
- order_status   : cliente pregunta por su pedido — revisa el contexto y responde
- general        : saludos, preguntas generales, confirmaciones, mensajes que no encajan en otro intent
- needs_human    : situación que requiere decisión humana real (ver criterios arriba)

─── REGLAS DE NEGOCIO ─────────────────────────────────────────────────────────

- Nunca inventes productos — solo menciona lo que search_products devuelva
- Nunca inventes precios — usa solo los precios que search_products devuelva
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

Para intent product_search (úsalo DESPUÉS de llamar search_products):
{
  "intent": "product_search",
  "response": "tu respuesta aquí"
}

Para cualquier otro intent (orderHints PROHIBIDO):
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

// ─── Retry helper ─────────────────────────────────────────────────────────────
// Retries once on transient non-timeout errors (network failures, 5xx, 429).
// Timeout errors are not retried — the caller already waited and adding another
// attempt would double customer-facing latency.

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'TimeoutError') return false;
  if (err instanceof Anthropic.APIError) {
    return [429, 500, 502, 503, 529].includes(err.status);
  }
  return false;
}

// ─── Single API call (with one retry) ────────────────────────────────────────
// Returns the full Anthropic.Message so the agentic loop can inspect
// stop_reason and content blocks (including tool_use) directly.

async function callOnce(
  params: Anthropic.MessageCreateParamsNonStreaming,
  timeoutMs: number,
): Promise<Anthropic.Message> {
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      return await client.messages.create(
        params,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
    } catch (err) {
      const isLast = attempt === 1;

      if (isLast || !isRetryableError(err)) {
        throw err;
      }

      logger.warn(
        { err, attempt },
        'Claude API call failed — retrying after delay',
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  // Unreachable — loop always throws or returns
  throw new Error('callOnce: unreachable');
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────
// Handles tool_use stop_reason by executing the search_products tool and
// feeding results back to Claude. Accumulates productImages across all tool
// calls so they're available alongside the final text response.
//
// MAX_TOOL_ITERATIONS is a safety cap. In practice Claude calls search_products
// at most once per message — the cap prevents runaway loops on unexpected behavior.

type AgenticResult = {
  text:          string;
  stopReason:    string;
  productImages: Array<{ url: string; caption?: string }>;
};

async function runAgenticLoop(
  baseParams: Anthropic.MessageCreateParamsNonStreaming,
  timeoutMs: number,
  searchProducts: SearchProductsFn,
): Promise<AgenticResult> {
  const messages: Anthropic.MessageParam[] = [
    ...(baseParams.messages as Anthropic.MessageParam[]),
  ];
  const accumulatedImages: Array<{ url: string; caption?: string }> = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const message = await callOnce({ ...baseParams, messages }, timeoutMs);

    // Non-tool stop — extract text and return.
    if (message.stop_reason !== 'tool_use') {
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return {
        text,
        stopReason: message.stop_reason ?? 'unknown',
        productImages: accumulatedImages,
      };
    }

    // Append assistant turn (includes tool_use blocks) before processing tools.
    messages.push({ role: 'assistant', content: message.content });

    const toolUseBlocks = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      if (toolUse.name !== 'search_products') {
        // Unknown tool — return an error so Claude can handle gracefully.
        toolResults.push({
          type:        'tool_result',
          tool_use_id: toolUse.id,
          content:     `Error: herramienta '${toolUse.name}' no reconocida.`,
        });
        continue;
      }

      const parsed = searchProductsInputSchema.safeParse(toolUse.input);

      if (!parsed.success) {
        logger.warn(
          { issues: parsed.error.issues, input: toolUse.input },
          'search_products tool call — invalid input from Claude',
        );
        toolResults.push({
          type:        'tool_result',
          tool_use_id: toolUse.id,
          content:     'Error: parámetros de búsqueda inválidos.',
        });
        continue;
      }

      const hints = parsed.data;
      logger.info({ hints, iteration }, 'search_products tool call — querying inventory');

      let items: ProductSearchItem[];
      try {
        items = await searchProducts(hints);
      } catch (err) {
        logger.error({ err, hints }, 'searchProducts callback threw — returning empty result to Claude');
        items = [];
      }

      // Accumulate images — these are returned alongside the final text response
      // and sent to the customer by n8n after Claude finishes.
      for (const item of items) {
        if (item.imageUrl) {
          accumulatedImages.push({ url: item.imageUrl, caption: item.imageCaption });
        }
      }

      const resultText =
        items.length === 0
          ? 'No se encontraron productos con esos criterios. Puedes intentar con otros términos o preguntar por otra prenda.'
          : `Encontré ${items.length} producto(s):\n${items
              .map((p) => `- ${p.name} (${p.brand}) — $${p.price} MXN`)
              .join('\n')}`;

      logger.info(
        { hints, matches: items.length, imagesAccumulated: accumulatedImages.length },
        'search_products tool call — results returned to Claude',
      );

      toolResults.push({
        type:        'tool_result',
        tool_use_id: toolUse.id,
        content:     resultText,
      });
    }

    // Append tool results as a user turn for the next iteration.
    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error('runAgenticLoop: exceeded MAX_TOOL_ITERATIONS without final text response');
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const processMessage = async (
  context: ClaudeContext,
): Promise<ProcessMessageOutput> => {
  const {
    customerName,
    customerGender,
    recentOrder,
    searchProducts,
    incomingMessage,
    conversationHistory,
    businessInfo,
  } = context;

  // Dynamic timeout: longer conversations have more input tokens and take more
  // time. Add 1 second per conversation turn, capped at MAX_TIMEOUT_MS.
  const requestTimeoutMs = Math.min(
    BASE_TIMEOUT_MS + conversationHistory.length * 1_000,
    MAX_TIMEOUT_MS,
  );

  // Context is injected into the system prompt rather than as fake turns.
  // Catalog is no longer injected here — product retrieval is demand-driven
  // via the search_products tool when Claude needs to find products.
  const contextSection = `
─── CONTEXTO ACTUAL ───────────────────────────────────────────────────────────

CLIENTE: ${customerName ?? 'Cliente nueva'}
${buildGenderContext(customerGender)}

PRODUCTOS: Usa la herramienta search_products para buscar en el inventario bajo demanda.
→ No tienes un catálogo predefinido — llama la herramienta cuando el cliente busque algo.
→ Si search_products no devuelve resultados, responde con catalog_query y pide más detalles.

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
- Anticipo mínimo: ${businessInfo.depositPercent}% — liquidar en ${businessInfo.paymentDays} días`;

  const fullSystemPrompt = `${SYSTEM_PROMPT}${contextSection}`;

  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: incomingMessage },
  ];

  logger.info(
    {
      hasRecentOrder:   !!recentOrder,
      historyTurns:     conversationHistory.length,
      customerGender,
      requestTimeoutMs,
    },
    'Calling Claude API (agentic loop)',
  );

  let agenticResult: AgenticResult;

  try {
    agenticResult = await runAgenticLoop(
      {
        model:      CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system:     fullSystemPrompt,
        tools:      [SEARCH_PRODUCTS_TOOL],
        messages,
      },
      requestTimeoutMs,
      searchProducts,
    );
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    const failureReason = isTimeout ? 'api_timeout' : 'api_error';
    logger.error(
      { err, failureReason, historyTurns: conversationHistory.length, requestTimeoutMs },
      isTimeout
        ? 'Claude API timed out — returning safe fallback'
        : 'Claude API call failed — returning safe fallback',
    );
    return SAFE_FALLBACK;
  }

  // Truncation check — stop_reason is the authoritative signal from the API.
  if (agenticResult.stopReason === 'max_tokens') {
    logger.warn(
      {
        failureReason:   'truncated_response',
        stopReason:      agenticResult.stopReason,
        historyTurns:    conversationHistory.length,
        rawTextPreview:  agenticResult.text.slice(0, 200),
      },
      'Claude response was truncated at token limit — increase MAX_TOKENS or reduce prompt size',
    );
    return SAFE_FALLBACK;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(agenticResult.text);
  } catch {
    const rawTextPreview = agenticResult.text.length > 200
      ? `${agenticResult.text.slice(0, 200)}…`
      : agenticResult.text;
    logger.warn(
      { failureReason: 'non_json_response', rawTextPreview, rawTextLength: agenticResult.text.length },
      'Claude returned non-JSON — returning safe fallback',
    );
    return SAFE_FALLBACK;
  }

  const validated = claudeResultSchema.safeParse(parsed);

  if (!validated.success) {
    logger.warn(
      { failureReason: 'schema_validation_failed', issues: validated.error.issues },
      'Claude output failed schema validation — returning safe fallback',
    );
    return SAFE_FALLBACK;
  }

  logger.info(
    {
      intent:        validated.data.intent,
      historyTurns:  conversationHistory.length,
      stopReason:    agenticResult.stopReason,
      productImages: agenticResult.productImages.length,
    },
    'Claude response validated successfully',
  );

  return {
    ...validated.data,
    productImages: agenticResult.productImages,
  };
};