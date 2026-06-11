import Anthropic from "@anthropic-ai/sdk";
import mongoose from "mongoose";
import { z } from "zod";
import { ANTHROPIC_API_KEY } from "#/config/env.js";
import { logger } from "#/config/logger.js";
import { UsageLogModel } from "#/modules/usageLogs/usageLog.model.js";
import { BASE_PLATFORM_PROMPT } from "./prompt/base.prompt.js";
import {
  buildAgentSection,
  type AgentConfig,
} from "./prompt/agent-section.builder.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ClaudeIntent =
  | "catalog_query"
  | "product_search"
  | "price_query"
  | "create_order"
  | "order_status"
  | "order_summary" // Customer asks to see their full accumulated order list
  | "showroom_visit" // Customer wants to visit the showroom in person
  | "payment_info"
  | "payment_receipt"
  | "needs_human"
  | "general";

export type ClaudeOrderHint = {
  productNameHint: string;
  size: string;
  color: string;
  quantity: number;
};

export type ClaudeSearchHints = {
  keyword: string;
  gender?: "female" | "male" | "unknown";
  size?: string;
  color?: string;
};

// Returned by the searchProducts callback.
export type ProductSearchItem = {
  name: string;
  brand: string;
  price: number;
  color: string;
  images: Array<{ url: string; caption: string }>;
};

export type SearchProductsFn = (
  hints: ClaudeSearchHints,
) => Promise<ProductSearchItem[]>;

// Internal — shape of Claude's JSON output.
type ClaudeJsonResult = {
  intent: ClaudeIntent;
  response: string;
  orderHints?: ClaudeOrderHint[];
  detectedGender?: "female" | "male";
};

// Public — what processMessage returns.
export type ProcessMessageOutput = ClaudeJsonResult & {
  productImages: Array<{ url: string; caption?: string }>;
};

export type ConversationTurnInput = {
  role: "user" | "assistant";
  content: string;
};

export type OrderItem = {
  name: string;
  size: string;
  color: string;
  quantity: number;
  price: number;
};

export type ClaudeContext = {
  // Tenant scope — passed from webhook.service.ts. Used to attribute Claude API
  // token usage to the correct boutique (UsageLog).
  boutiqueId: string;
  // Per-tenant agent identity — injected into the platform prompt at runtime.
  // Same shape as boutique.agentConfig in MongoDB.
  agentConfig: AgentConfig;
  customerName: string | null;
  customerGender: "female" | "male" | "unknown";
  // Approximate lifetime spend — used to tailor VIP vs new-customer language
  // and to decide how flexible to be on payment timing.
  customerLifetimeValue?: number;
  recentOrder: {
    orderNumber: string;
    status: string;
    total: number;
    // Running balance after partial payments. Displayed in order_status / order_summary.
    outstandingBalance?: number;
    // Shipping guide number shared with customer.
    trackingNumber?: string;
    // Human-readable estimated delivery date/window, e.g. "Jueves 8 de mayo".
    estimatedDelivery?: string;
    // Itemized list — enables order_summary without re-scanning conversation history.
    items?: OrderItem[];
  } | null;
  searchProducts: SearchProductsFn;
  incomingMessage: string;
  conversationHistory: ConversationTurnInput[];
  // Optional override for the Claude API request timeout (ms). Used by the eval
  // runner, where sequential calls need more headroom than the default.
  requestTimeoutOverrideMs?: number;
  businessInfo: {
    showroomAddress: string;
    businessHours: string;
    shippingPrice: number;
    paymentMethods: string;
    depositPercent: number;
    paymentDays: number;
    // Human-readable delivery information shown when customer asks "¿cuándo llega?" or
    // "¿en cuánto tiempo me llegaría?". Free-text so the owner can express realistic
    // timelines without hardcoding a number.
    // e.g. "3 a 5 días hábiles una vez confirmado el pago"
    deliveryInfo: string;
    // Active promotion to mention proactively when relevant, e.g. "30% Off Alo Yoga hasta el 10 de mayo".
    // Leave undefined/empty when no promotion is active.
    activePromotion?: string;
  };
};

// ─── Output schema (validates Claude's JSON) ──────────────────────────────────

const orderHintSchema = z.object({
  productNameHint: z.string().min(1),
  size: z.string().min(1),
  color: z.string().min(1),
  quantity: z.number().int().positive().max(100),
});

const claudeResultSchema = z.union([
  z.object({
    intent: z.literal("create_order"),
    response: z.string().min(1),
    orderHints: z.array(orderHintSchema).min(1),
    detectedGender: z.enum(["female", "male"]).optional(),
  }),
  z.object({
    intent: z.literal("product_search"),
    response: z.string().min(1),
    detectedGender: z.enum(["female", "male"]).optional(),
  }),
  z.object({
    intent: z.literal("payment_receipt"),
    response: z.string().min(1),
    orderHints: z.array(orderHintSchema).optional(),
    detectedGender: z.enum(["female", "male"]).optional(),
  }),
  z.object({
    intent: z.enum([
      "catalog_query",
      "price_query",
      "order_status",
      "order_summary",
      "showroom_visit",
      "payment_info",
      "needs_human",
      "general",
    ]),
    response: z.string().min(1),
    orderHints: z.undefined().optional(),
    detectedGender: z.enum(["female", "male"]).optional(),
  }),
]);

// ─── Tool input schema ────────────────────────────────────────────────────────

const searchProductsInputSchema = z.object({
  keyword: z.string().trim().min(1).max(80),
  gender: z.enum(["female", "male", "unknown"]).optional(),
  size: z.string().trim().max(20).optional(),
  color: z.string().trim().max(40).optional(),
});

// ─── Tool definition ──────────────────────────────────────────────────────────

const SEARCH_PRODUCTS_TOOL: Anthropic.Tool = {
  name: "search_products",
  description:
    "Busca productos en el inventario de SALO según criterios del cliente. " +
    "Úsala cuando el cliente busque un tipo de prenda, marca, color o descripción específica. " +
    "El sistema enviará las imágenes de los productos encontrados automáticamente al cliente — " +
    "tu respuesta solo necesita anunciar que los mostrarás.",
  input_schema: {
    type: "object" as const,
    properties: {
      keyword: {
        type: "string",
        description:
          "Tipo de producto, nombre o marca. Ej: el tipo de artículo que busca el cliente.",
      },
      gender: {
        type: "string",
        enum: ["female", "male", "unknown"],
        description:
          "Género DEL PRODUCTO buscado — NO el género del cliente. " +
          "SOLO incluir 'female' si el cliente pide EXPLÍCITAMENTE productos para mujer. " +
          "SOLO incluir 'male' si pide EXPLÍCITAMENTE productos para hombre. " +
          "En TODOS los demás casos omitir o usar 'unknown'.",
      },
      size: {
        type: "string",
        description: 'Talla buscada. Ej: "XS", "S", "M", "L".',
      },
      color: {
        type: "string",
        description:
          'Color buscado, si el cliente lo mencionó. Ej: "negro", "blanco", "beige", "burgundy". ' +
          "Omitir si el cliente no especificó color.",
      },
    },
    required: ["keyword"],
  },
};

const BROWSE_ALL_PRODUCTS_TOOL: Anthropic.Tool = {
  name: "browse_all_products",
  description:
    "Returns all products currently in stock. Call this whenever the customer wants to see what is available — including typos, informal phrasing, or any variation of: show me products, send me photos, what do you have, dame lo que tienes, madame los productos, quiero ver inventario, me pasas fotos, qué modelos manejas, tienes algo disponible, manda lo que tengas, quiero mirar lo que tienes. No parameters needed.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

// ─── Safe fallback ────────────────────────────────────────────────────────────

// Every Claude failure path (api_timeout, api_error, tool_loop_exhausted,
// max_tokens, non_json, schema_fail) calls SAFE_FALLBACK(gender, true), so each
// failure escalates to the owner (needs_human alert).
// Trade-off: transient provider blips generate alert noise.
// Future improvement: add a per-boutique circuit breaker or backoff counter
// before escalating on repeated failures. (Tracked tech debt — M-6.)
const SAFE_FALLBACK = (
  gender: "female" | "male" | "unknown" = "unknown",
  shouldEscalate = false,
): ProcessMessageOutput => ({
  intent: shouldEscalate ? "needs_human" : "general",
  response:
    gender === "male"
      ? "Permíteme un momento amigo, ahorita te atiendo 🙏🏻"
      : "Permíteme un momento bonita, ahorita te atiendo 🙏🏻",
  productImages: [],
});

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const CLAUDE_MODEL = "claude-sonnet-4-6";

const MAX_TOKENS = 3072;
const BASE_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 1_000;
const MAX_TOOL_ITERATIONS = 3;

// ─── Gender context builder ───────────────────────────────────────────────────

function buildGenderContext(gender: "female" | "male" | "unknown"): string {
  switch (gender) {
    case "male":
      return 'GÉNERO ALMACENADO: masculino — usa "amigo", tono directo. NUNCA uses "bonita", "bella", "corazón", "linda".';
    case "female":
      return 'GÉNERO ALMACENADO: femenino — usa "bonita", "bella", "corazón", "linda" naturalmente.';
    case "unknown":
    default:
      return 'GÉNERO ALMACENADO: desconocido — usa femenino por defecto ("bonita", "bella") A MENOS QUE detectes una señal masculina explícita en el mensaje actual.';
  }
}

// ─── VIP context builder ──────────────────────────────────────────────────────

function buildVipContext(ltv?: number): string {
  if (!ltv) return "";
  if (ltv >= 50_000) {
    return `\nCLIENTA VIP: Ha comprado $${ltv.toLocaleString("es-MX")} MXN históricamente. Trátala con prioridad máxima, ofrece pagos flexibles sin presionar, y escala cualquier queja o negociación de inmediato.`;
  }
  if (ltv >= 10_000) {
    return `\nCLIENTA RECURRENTE: Ha comprado $${ltv.toLocaleString("es-MX")} MXN históricamente. Tono cálido y confiado, ya se conocen bien.`;
  }
  return "";
}

// ─── Order context builder ────────────────────────────────────────────────────

function buildOrderContext(order: ClaudeContext["recentOrder"]): string {
  if (!order) return "Sin pedidos previos.";

  const lines: string[] = [
    `${order.orderNumber} — ${order.status} — $${order.total.toLocaleString("es-MX")} MXN`,
  ];

  if (order.outstandingBalance !== undefined) {
    lines.push(
      `Saldo pendiente: $${order.outstandingBalance.toLocaleString("es-MX")} MXN`,
    );
  }
  if (order.trackingNumber) {
    lines.push(`Número de guía: ${order.trackingNumber}`);
  }
  if (order.estimatedDelivery) {
    lines.push(`Entrega estimada: ${order.estimatedDelivery}`);
  }
  if (order.items && order.items.length > 0) {
    const itemLines = order.items
      .map(
        (i) =>
          `  ⭐️ ${i.name} color ${i.color} talla ${i.size} x${i.quantity} — $${i.price.toLocaleString("es-MX")}`,
      )
      .join("\n");
    lines.push(`Artículos del pedido:\n${itemLines}`);
  }

  return lines.join("\n");
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error && err.name === "TimeoutError") return false;
  if (err instanceof Anthropic.APIError) {
    return [429, 500, 502, 503, 529].includes(err.status);
  }
  return false;
}

// ─── Single API call (with one retry) ────────────────────────────────────────

async function callOnce(
  params: Anthropic.MessageCreateParamsNonStreaming,
  timeoutMs: number,
): Promise<Anthropic.Message> {
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      return await client.messages.create(params, {
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const isLast = attempt === 1;
      if (isLast || !isRetryableError(err)) throw err;
      logger.warn(
        { err, attempt },
        "Claude API call failed — retrying after delay",
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw new Error("callOnce: unreachable");
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────

type AgenticResult = {
  text: string;
  stopReason: string;
  productImages: Array<{ url: string; caption?: string }>;
  // Accumulated token usage across all loop iterations (input + output per
  // callOnce response). Used for per-boutique usage logging.
  inputTokens: number;
  outputTokens: number;
  toolIterations: number;
};

const MAX_PRODUCTS_PER_SEARCH = 4;
// Matches the 5-image-per-product limit in the product creation UI.
// Raised from 3 so all uploaded images reach the customer.
const MAX_IMAGES_PER_PRODUCT = 5;
// 4 products × 5 images = 20 maximum total images.
const MAX_IMAGES_TOTAL = 20;

// Garment keywords that are tops — triggers set-completion upsell hint
const TOP_KEYWORDS = [
  "bra",
  "top",
  "tank",
  "crop",
  "blusa",
  "camiseta",
  "bodysuit",
  "sports bra",
  "corset",
];

function isTopGarment(keyword: string): boolean {
  const lower = keyword.toLowerCase();
  return TOP_KEYWORDS.some((t) => lower.includes(t));
}

async function runAgenticLoop(
  baseParams: Anthropic.MessageCreateParamsNonStreaming,
  timeoutMs: number,
  searchProducts: SearchProductsFn,
  depositPercent: number,
  paymentDays: number,
  customerGender: "female" | "male" | "unknown",
): Promise<AgenticResult> {
  const messages: Anthropic.MessageParam[] = [
    ...(baseParams.messages as Anthropic.MessageParam[]),
  ];
  const accumulatedImages: Array<{ url: string; caption?: string }> = [];

  // Token + iteration accumulators — summed across every callOnce response in
  // the loop (both tool_use turns and the final text turn).
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let iterationCount = 0;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const message = await callOnce({ ...baseParams, messages }, timeoutMs);

    // usage.input_tokens / output_tokens are always present on non-streaming
    // responses. Accumulate before branching so every call is counted.
    totalInputTokens += message.usage.input_tokens;
    totalOutputTokens += message.usage.output_tokens;
    iterationCount++;

    if (message.stop_reason !== "tool_use") {
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const seenUrls = new Set<string>();
      const dedupedImages = accumulatedImages.filter((img) => {
        if (seenUrls.has(img.url)) return false;
        seenUrls.add(img.url);
        return true;
      });
      return {
        text,
        stopReason: message.stop_reason ?? "unknown",
        productImages: dedupedImages,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        toolIterations: iterationCount,
      };
    }

    messages.push({ role: "assistant", content: message.content });

    const toolUseBlocks = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      if (
        toolUse.name !== "search_products" &&
        toolUse.name !== "browse_all_products"
      ) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Error: herramienta '${toolUse.name}' no reconocida.`,
        });
        continue;
      }

      let hints: ClaudeSearchHints;
      if (toolUse.name === "browse_all_products") {
        // No parameters — browse all active in-stock products. The "*" keyword
        // routes searchProducts (searchProductsForClaude) to its browse-all
        // branch. Gender is applied for catalog relevance, with a no-gender
        // retry on 0 results handled inside the callback.
        hints = { keyword: "*", gender: customerGender };
      } else {
        const parsed = searchProductsInputSchema.safeParse(toolUse.input);
        if (!parsed.success) {
          logger.warn(
            { issues: parsed.error.issues, input: toolUse.input },
            "search_products tool call — invalid input from Claude",
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "Error: parámetros de búsqueda inválidos.",
          });
          continue;
        }
        hints = parsed.data;
      }

      logger.info(
        { hints, iteration, tool: toolUse.name },
        "product tool call — querying inventory",
      );

      let items: ProductSearchItem[];
      try {
        items = await searchProducts(hints);
      } catch (err) {
        logger.error(
          { err, hints },
          "searchProducts callback threw — returning empty result to Claude",
        );
        items = [];
      }

      const depositRate = depositPercent / 100;
      const limitedItems = items.slice(0, MAX_PRODUCTS_PER_SEARCH);

      for (const item of limitedItems) {
        for (const img of item.images.slice(0, MAX_IMAGES_PER_PRODUCT)) {
          if (accumulatedImages.length >= MAX_IMAGES_TOTAL) break;
          accumulatedImages.push({ url: img.url, caption: img.caption });
        }
      }

      // ── Deposit instruction ───────────────────────────────────────────────
      // Single product: quote price and deposit directly.
      // Multiple products: don't quote a specific deposit — ask which one first.
      const setCompletionHint = isTopGarment(hints.keyword)
        ? "\nSET COMPLETION: Este producto es un top/bra/tank. Después de anunciar los resultados, pregunta si quiere también el legging, pants o short a juego."
        : "";

      const sizeWasSpecified = Boolean(hints.size);

      const singleProductInstruction = (p: ProductSearchItem) => {
        const deposit = Math.ceil(p.price * depositRate).toLocaleString(
          "es-MX",
        );
        if (sizeWasSpecified) {
          // The search was an AVAILABILITY CHECK — the customer already saw this
          // product and asked whether size X is in stock. Do NOT announce images.
          // The customer may have also asked for payment info and delivery in the
          // same message. Respond comprehensively and use payment_info intent if
          // the original message contained payment/delivery signals.
          return (
            `DISPONIBILIDAD CONFIRMADA: ${p.name} talla ${hints.size} — $${p.price.toLocaleString("es-MX")} MXN disponible [entrega inmediata]. ` +
            `Anticipo ${depositPercent}% = $${deposit} MXN. Liquidar en ${paymentDays} días. ` +
            `

INSTRUCCIÓN CRÍTICA: El cliente ya vio este producto — NO llames search_products de nuevo. NO anuncies imágenes. ` +
            `Redacta UNA respuesta que cubra TODAS las preguntas del mensaje: disponibilidad ✓, precio, anticipo, entrega, siguiente paso. ` +
            `Si el mensaje contiene "cuenta", "depositar", "dónde pago" o preguntas de entrega → NO uses intent: payment_info todavía. Muestra el resumen del pedido con formato ⭐️ (producto, talla, color, precio, envío, total, anticipo) y termina con "¿Confirmas tu pedido para enviarte los datos de depósito? 🙌🏼". Usa intent: general. El sistema enviará la imagen SOLO después de que el cliente confirme explícitamente en el siguiente turno. ` +
            `Si solo confirmó talla sin pedir datos de pago → usa intent: price_query. ` +
            `Respuesta modelo: "¡Sí bonita, tengo disponible la talla [X]! El [producto] está a $[precio]. Para apartarlo depositas el [%]%, equivalente a $[anticipo], y liquidas dentro de [días] días 🙌🏼 El tiempo de entrega es de [deliveryInfo]. Aquí van los datos 🙌🏼"` +
            setCompletionHint
          );
        }
        // Fresh catalog search — standard gallery announcement
        return (
          `INSTRUCCIÓN: Anuncia que vienen las imágenes y menciona el precio y anticipo: ` +
          `"Puedes ordenar con el ${depositPercent}% equivalente a $${deposit} y liquidar dentro de ${paymentDays} días 🙌🏼". ` +
          `Si quedan pocas unidades (resultado único), añade urgencia: "Es la última disponible en esa talla — apártala ahora 🙏🏻". ` +
          `Si no se mencionó talla, pregúntala.${setCompletionHint}`
        );
      };

      const multiProductInstruction = sizeWasSpecified
        ? // Multiple color variants returned for an availability check.
          // CRITICAL: if the customer already selected a specific product via gallery
          // reply, the [Producto exacto seleccionado por el cliente: NAME] tag will
          // be in the message. In that case, do NOT ask which color they prefer —
          // answer only about the selected product's color, then briefly mention
          // alternatives. If no specific product was selected, ask normally.
          `DISPONIBILIDAD: encontré ${limitedItems.length} variantes disponibles en talla ${hints.size}. ` +
          `INSTRUCCIÓN CRÍTICA: si el mensaje contiene [Producto exacto seleccionado por el cliente: NOMBRE], ` +
          `responde SOLO sobre ese producto/color exacto. NO preguntes cuál color le gusta. ` +
          `Formato: "Sí bonita, en talla [X] tengo disponible el [producto seleccionado]. Está a $[precio]..." ` +
          `Puedes mencionar brevemente otro color DESPUÉS: "También tengo el mismo modelo en [otro color] por si quieres comparar, ` +
          `pero este que elegiste es el [color seleccionado]." ` +
          `Si no hay tag de selección → describe brevemente las opciones y pregunta cuál prefiere. ` +
          `Si el mensaje original pedía datos de pago → usa intent: payment_info.`
        : // Fresh multi-product catalog search
          `INSTRUCCIÓN: Anuncia que vienen las imágenes. NO menciones un anticipo específico todavía — hay varios productos a distintos precios. ` +
          `Pregunta cuál le interesa más: "¿Cuál de estas opciones te llama más la atención? 😊 Cuéntame para darte el detalle del precio y el anticipo."` +
          setCompletionHint;

      // ── Color-swap hint (0 results with color specified) ─────────────────
      const colorSwapHint = hints.color
        ? ` PROTOCOLO DE COLOR: Se especificó color "${hints.color}" pero no hay resultados. ` +
          `Llama search_products INMEDIATAMENTE con el mismo keyword "${hints.keyword}" pero SIN el parámetro color, ` +
          `para mostrar los colores disponibles del mismo producto. ` +
          `En tu respuesta di: "Ese color específico no lo tengo disponible, pero mira qué otros tonos tenemos 🙌🏼"`
        : "";

      const resultText =
        items.length === 0
          ? `Inventario activo: 0 resultados para "${hints.keyword}"` +
            `${hints.size ? ` talla ${hints.size}` : ""}` +
            `${hints.color ? ` color ${hints.color}` : ""}` +
            `${hints.gender && hints.gender !== "unknown" ? ` (${hints.gender})` : ""}.` +
            colorSwapHint +
            (!hints.color
              ? ` INSTRUCCIÓN: NO digas al cliente que estás revisando. ` +
                `Intenta una búsqueda alternativa con término más amplio (sin talla, sin marca). ` +
                `Si la alternativa también devuelve 0, ofrece categoría similar o usa needs_human. ` +
                `NUNCA menciones al dueño ni prometas confirmación futura a menos que uses needs_human.`
              : "")
          : `Encontré ${limitedItems.length} producto(s) disponible(s) [entrega inmediata]:\n${limitedItems
              .map((p) => {
                const deposit = Math.ceil(p.price * depositRate).toLocaleString(
                  "es-MX",
                );
                return `- ${p.name} color ${p.color} (${p.brand}) — $${p.price.toLocaleString("es-MX")} MXN | anticipo ${depositPercent}% = $${deposit}`;
              })
              .join(
                "\n",
              )}\n\n${items.length === 1 ? singleProductInstruction(items[0]) : multiProductInstruction}`;

      logger.info(
        {
          hints,
          matches: items.length,
          imagesAccumulated: accumulatedImages.length,
        },
        "search_products tool call — results returned to Claude",
      );

      // Inject a hard stop into the tool result on the second-to-last iteration
      // (iteration MAX_TOOL_ITERATIONS - 2, zero-indexed). Claude sees this warning
      // when it is called at the final iteration and is forced to respond with text
      // instead of calling a tool again — preventing tool_loop_exhausted on
      // genuine "no inventory" cases like "busco leggings negros talla S".
      const isLastChance = iteration === MAX_TOOL_ITERATIONS - 2;
      const lastChanceWarning = isLastChance
        ? `\n\n⚠️ ÚLTIMA OPORTUNIDAD: No puedes llamar más herramientas después de esta. ` +
          `Tu PRÓXIMA respuesta DEBE ser JSON puro sin tool_use. ` +
          `Si no encontraste el producto solicitado, responde directamente al cliente: ` +
          `informa que no tienes ese producto disponible en este momento, ` +
          `ofrece lo que sí tienes como alternativa, y usa intent: general.`
        : "";

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: resultText + lastChanceWarning,
      });
    }

    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }
  }

  const seenUrls = new Set<string>();
  const dedupedImages = accumulatedImages.filter((img) => {
    if (seenUrls.has(img.url)) return false;
    seenUrls.add(img.url);
    return true;
  });

  if (dedupedImages.length > 0) {
    // Images were accumulated before the loop exhausted — but we have no valid
    // Claude response to pair them with. Sending the hardcoded product_search
    // announcement with images is wrong when the exhaustion happened during a
    // payment or receipt flow. Return SAFE_FALLBACK with no images: the owner
    // escalation will cover any pending action, and the customer gets a neutral
    // "un momento" reply rather than a confusing catalog announcement.
    logger.warn(
      { imagesAccumulated: dedupedImages.length },
      "runAgenticLoop — tool_loop_exhausted with accumulated images, discarding images and returning SAFE_FALLBACK",
    );
    // Return a special sentinel so processMessage can log the exhaustion reason.
    return {
      text: "__TOOL_LOOP_EXHAUSTED_WITH_IMAGES__",
      stopReason: "tool_loop_exhausted",
      productImages: [],
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      toolIterations: iterationCount,
    };
  }

  // Attach the real token usage accumulated across the loop so processMessage's
  // catch can log it instead of zeros — these tokens were genuinely consumed.
  const exhaustionError = new Error(
    "runAgenticLoop: tool_loop_exhausted — exceeded MAX_TOOL_ITERATIONS without final text response",
  ) as Error & {
    inputTokens?: number;
    outputTokens?: number;
    toolIterations?: number;
  };
  exhaustionError.inputTokens = totalInputTokens;
  exhaustionError.outputTokens = totalOutputTokens;
  exhaustionError.toolIterations = iterationCount;
  throw exhaustionError;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const processMessage = async (
  context: ClaudeContext,
): Promise<ProcessMessageOutput> => {
  const {
    agentConfig,
    customerName,
    customerGender,
    customerLifetimeValue,
    recentOrder,
    searchProducts,
    incomingMessage,
    conversationHistory,
    businessInfo,
  } = context;

  // Non-blocking per-boutique usage logger. NEVER awaited and NEVER throws —
  // a failed write must not add latency or break the WhatsApp response. Called
  // on every exit path (success AND SAFE_FALLBACK). On early failures with no
  // completed API call, tokens are 0 and toolIterations defaults to 1.
  //
  // Usage logging is intentionally fire-and-forget (.catch swallows
  // errors) to avoid adding latency to customer responses.
  // Trade-off: a DB hiccup silently drops the record. For metered
  // billing, consider a write-ahead buffer or periodic reconciliation
  // against the Anthropic usage API as a future improvement.
  const logUsage = (args: {
    intent?: ClaudeIntent;
    inputTokens: number;
    outputTokens: number;
    toolIterations: number;
  }): void => {
    UsageLogModel.create({
      boutiqueId: new mongoose.Types.ObjectId(context.boutiqueId),
      model: CLAUDE_MODEL,
      intent: args.intent ?? undefined,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens: args.inputTokens + args.outputTokens,
      toolIterations: args.toolIterations,
      createdAt: new Date(),
    }).catch((err) => {
      logger.warn(
        { err, boutiqueId: context.boutiqueId },
        "UsageLog write failed — non-critical",
      );
    });
  };

  // Timeout: base + fixed headroom for tool calls.
  // A flat +5s (not per-turn) because Claude API latency is dominated by
  // generation time, not context length. Per-turn growth adds 20s at MAX_TURNS
  // and makes WhatsApp UX unacceptably slow.
  const requestTimeoutMs =
    context.requestTimeoutOverrideMs ??
    Math.min(BASE_TIMEOUT_MS + 5_000, MAX_TIMEOUT_MS);

  const sanitizedMessage = incomingMessage.slice(0, 2000);

  // Build active promotion line
  const promotionLine = businessInfo.activePromotion
    ? `\nPROMOCIÓN ACTIVA: ${businessInfo.activePromotion} — menciónala UNA VEZ proactivamente cuando el cliente esté viendo productos o vacilando en comprar.`
    : "";

  // customerName comes from the WhatsApp profile name — attacker-controlled.
  // Strip bracket/brace/angle characters used in prompt-injection attempts and
  // cap the length before it is interpolated into the system prompt.
  const safeCustomerName = customerName
    ? customerName.replace(/[[\]{}<>]/g, "").slice(0, 60).trim() || null
    : null;

  // TRUST BOUNDARIES: customerName is sanitized (safeCustomerName).
  // incomingMessage, conversationHistory, and product tool results
  // are intentionally unsanitized — they are the expected inputs to
  // the model. agentConfig fields are owner-controlled (self-scoped)
  // and length-capped by boutique.validation.ts. The strict JSON
  // output contract (claudeResultSchema) limits the blast radius of
  // any successful injection.
  const contextSection = `
─── CONTEXTO ACTUAL ───────────────────────────────────────────────────────────

CLIENTE: ${safeCustomerName ?? "Cliente nueva"}
${buildGenderContext(customerGender)}${buildVipContext(customerLifetimeValue)}

PRODUCTOS: Usa la herramienta search_products para buscar en el inventario bajo demanda.
→ No tienes un catálogo predefinido — llama la herramienta cuando el cliente busque algo.
→ Puedes filtrar por keyword, gender, size y color.
→ Si search_products no devuelve resultados, intenta una búsqueda más amplia antes de escalar.
→ Cuando el cliente envíe una imagen de un producto sin texto descriptivo claro,
  pregunta: "¿Cuál de estos modelos te llamó la atención? ¿Tienes el nombre o la marca? 🙌🏼"
  y luego busca por keyword aproximado.

PEDIDO RECIENTE DEL CLIENTE:
${buildOrderContext(recentOrder)}

INFORMACIÓN DEL NEGOCIO:
- Showroom: ${businessInfo.showroomAddress}
- Horarios: ${businessInfo.businessHours}
- Envío nacional express: $${businessInfo.shippingPrice} MXN
- Formas de pago: ${businessInfo.paymentMethods}
- Anticipo mínimo: ${businessInfo.depositPercent}% — liquidar en ${businessInfo.paymentDays} días
- Tiempo de entrega: ${businessInfo.deliveryInfo}${promotionLine}`;

  // Inject the per-tenant identity into the boutique-agnostic base prompt, then
  // append the per-request CONTEXT section (business info, customer, order).
  const agentSection = buildAgentSection(agentConfig);
  const fullSystemPrompt =
    BASE_PLATFORM_PROMPT.replace("{AGENT_SECTION}", agentSection) +
    contextSection;

  // Append a hard JSON reminder to every user message before sending to Claude.
  // The system prompt already states the JSON contract, but Claude occasionally
  // breaks it on emotionally-charged or multi-intent buffered messages (e.g.
  // gallery reaction + purchase confirmation + payment question in one turn),
  // responding in plain conversational Spanish instead of JSON. This reminder
  // is injected at the message level — it is the last thing Claude reads before
  // generating its response, making it much harder to ignore.
  // Confirmed failure: Railway logs 2026-05-25 02:24:18 — rawTextPreview showed
  // "¡Qué bonita elección! 😊 Antes de mandarte los da…" (pure text, no JSON).
  const JSON_REMINDER =
    "\n\n⚠️ RECUERDA: Tu respuesta debe ser ÚNICAMENTE JSON puro. Sin texto antes ni después. Sin markdown. Sin explicaciones. Solo el objeto JSON.";

  const messageWithReminder = sanitizedMessage + JSON_REMINDER;

  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: messageWithReminder },
  ];

  logger.info(
    {
      hasRecentOrder: !!recentOrder,
      historyTurns: conversationHistory.length,
      customerGender,
      customerLifetimeValue,
      requestTimeoutMs,
      hasActivePromotion: !!businessInfo.activePromotion,
    },
    "Calling Claude API (agentic loop)",
  );

  let agenticResult: AgenticResult;

  try {
    agenticResult = await runAgenticLoop(
      {
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system: fullSystemPrompt,
        tools: [SEARCH_PRODUCTS_TOOL, BROWSE_ALL_PRODUCTS_TOOL],
        messages,
      },
      requestTimeoutMs,
      searchProducts,
      businessInfo.depositPercent,
      businessInfo.paymentDays,
      customerGender,
    );
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    const isLoopExhausted =
      err instanceof Error && err.message.includes("tool_loop_exhausted");
    const failureReason = isTimeout
      ? "api_timeout"
      : isLoopExhausted
        ? "tool_loop_exhausted"
        : "api_error";
    logger.error(
      {
        err,
        failureReason,
        historyTurns: conversationHistory.length,
        requestTimeoutMs,
      },
      isTimeout
        ? "Claude API timed out — returning safe fallback"
        : isLoopExhausted
          ? "Claude agentic loop exhausted MAX_TOOL_ITERATIONS — returning safe fallback"
          : "Claude API call failed — returning safe fallback",
    );
    // Log the failed call. For tool_loop_exhausted the loop DID consume tokens
    // before throwing — read the accumulators attached to the error so usage is
    // not undercounted. Timeout / api_error paths carry no accumulators and fall
    // back to 0 tokens / 1 iteration (schema floor).
    const accInputTokens =
      (err as { inputTokens?: number }).inputTokens ?? 0;
    const accOutputTokens =
      (err as { outputTokens?: number }).outputTokens ?? 0;
    const accToolIterations =
      (err as { toolIterations?: number }).toolIterations ?? 1;
    logUsage({
      intent: undefined,
      inputTokens: accInputTokens,
      outputTokens: accOutputTokens,
      toolIterations: accToolIterations,
    });
    // Escalate on any failure — silent drops lose sales.
    // tool_loop_exhausted and api_timeout both need owner awareness.
    return SAFE_FALLBACK(customerGender, true);
  }

  if (agenticResult.stopReason === "max_tokens") {
    logger.warn(
      {
        failureReason: "truncated_response",
        stopReason: agenticResult.stopReason,
        historyTurns: conversationHistory.length,
        rawTextPreview: agenticResult.text.slice(0, 200),
      },
      "Claude response was truncated at token limit — increase MAX_TOKENS or reduce prompt size",
    );
    // The API call(s) completed — log the real token usage even though we fall back.
    logUsage({
      intent: undefined,
      inputTokens: agenticResult.inputTokens,
      outputTokens: agenticResult.outputTokens,
      toolIterations: agenticResult.toolIterations,
    });
    // max_tokens: the cart or response was truncated — owner should know.
    return SAFE_FALLBACK(customerGender, true);
  }

  // Handle the tool_loop_exhausted_with_images sentinel: MAX_TOOL_ITERATIONS
  // exhausted with accumulated images but no valid Claude response. Using
  // SAFE_FALLBACK is safer than sending a hardcoded product announcement
  // which would be wrong in payment or receipt flows.
  if (agenticResult.text === "__TOOL_LOOP_EXHAUSTED_WITH_IMAGES__") {
    logger.warn(
      {
        historyTurns: conversationHistory.length,
        failureReason: "tool_loop_exhausted_with_images",
      },
      "Tool loop exhausted with images — discarding images, returning safe fallback",
    );
    logUsage({
      intent: undefined,
      inputTokens: agenticResult.inputTokens,
      outputTokens: agenticResult.outputTokens,
      toolIterations: agenticResult.toolIterations,
    });
    return SAFE_FALLBACK(customerGender, true);
  }

  let parsed: unknown;

  // Pre-process: escape any literal newlines/carriage returns inside JSON string
  // values before parsing. Claude occasionally generates multi-line content
  // (e.g. ⭐️ order summaries) with bare \n characters inside a JSON string
  // instead of the escaped \\n sequence, producing invalid JSON that
  // JSON.parse rejects and triggers SAFE_FALLBACK.
  //
  // A regex-based approach fails when a string contains 2+ newlines because
  // the alternation [^"\\\n] forbids newlines, so the pattern can only match
  // strings with exactly one bare newline. The correct solution is a
  // character-by-character state machine that tracks whether we are inside a
  // quoted string and escapes any bare control characters it encounters there.
  function sanitizeJsonNewlines(raw: string): string {
    let result = "";
    let inString = false;
    let i = 0;
    while (i < raw.length) {
      const char = raw[i];
      if (!inString) {
        if (char === '"') inString = true;
        result += char;
      } else {
        if (char === "\\" && i + 1 < raw.length) {
          // Escape sequence — pass both chars through unchanged so we don't
          // double-escape sequences Claude already escaped correctly.
          result += char + raw[i + 1];
          i++;
        } else if (char === '"') {
          inString = false;
          result += char;
        } else if (char === "\n") {
          result += "\\n";
        } else if (char === "\r") {
          result += "\\r";
        } else {
          result += char;
        }
      }
      i++;
    }
    return result;
  }

  function stripMarkdownFences(raw: string): string {
    return raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
  }

  const sanitizedText = sanitizeJsonNewlines(
    stripMarkdownFences(agenticResult.text),
  );

  try {
    parsed = JSON.parse(sanitizedText);
  } catch {
    const rawTextPreview =
      agenticResult.text.length > 200
        ? `${agenticResult.text.slice(0, 200)}…`
        : agenticResult.text;
    logger.warn(
      {
        failureReason: "non_json_response",
        rawTextPreview,
        rawTextLength: agenticResult.text.length,
        sanitizedPreview: sanitizedText.slice(0, 200),
      },
      "Claude returned non-JSON (after sanitization) — returning safe fallback",
    );
    logUsage({
      intent: undefined,
      inputTokens: agenticResult.inputTokens,
      outputTokens: agenticResult.outputTokens,
      toolIterations: agenticResult.toolIterations,
    });
    // Non-JSON response: Claude broke the contract — owner should know.
    return SAFE_FALLBACK(customerGender, true);
  }

  const validated = claudeResultSchema.safeParse(parsed);

  if (!validated.success) {
    logger.warn(
      {
        failureReason: "schema_validation_failed",
        issues: validated.error.issues,
      },
      "Claude output failed schema validation — returning safe fallback",
    );
    logUsage({
      intent: undefined,
      inputTokens: agenticResult.inputTokens,
      outputTokens: agenticResult.outputTokens,
      toolIterations: agenticResult.toolIterations,
    });
    // Schema validation failed — Claude output was malformed.
    return SAFE_FALLBACK(customerGender, true);
  }

  logger.info(
    {
      intent: validated.data.intent,
      historyTurns: conversationHistory.length,
      stopReason: agenticResult.stopReason,
      productImages: agenticResult.productImages.length,
    },
    "Claude response validated successfully",
  );

  // ─── Hallucinated-promise detection ─────────────────────────────────────────
  const suspiciousPattern =
    /d[eé]j[ae]me?\s+revisar|lo estoy (checando|revisando)|ahorita lo checo|te (confirmo|aviso)|en breve te (digo|confirmo)|estoy revisando disponibilidad|dame un momento|en un momento te/i;
  // payment_info is also excluded because its correct responses often contain
  // "te aviso" and "te confirmo" as part of the payment summary instructions,
  // which would otherwise produce false-positive "hallucinated promise" warnings.
  const isEscalating =
    validated.data.intent === "needs_human" ||
    validated.data.intent === "payment_receipt" ||
    validated.data.intent === "payment_info";
  if (!isEscalating && suspiciousPattern.test(validated.data.response)) {
    logger.warn(
      {
        intent: validated.data.intent,
        responsePreview: validated.data.response.slice(0, 200),
      },
      "[Agent] Hallucinated confirmation promise detected — review system prompt adherence",
    );
  }

  // Success — log the real token usage attributed to the resolved intent.
  logUsage({
    intent: validated.data.intent,
    inputTokens: agenticResult.inputTokens,
    outputTokens: agenticResult.outputTokens,
    toolIterations: agenticResult.toolIterations,
  });

  return {
    ...validated.data,
    productImages: agenticResult.productImages,
  };
};
