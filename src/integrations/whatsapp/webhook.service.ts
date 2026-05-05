import { CustomerModel } from "#/modules/customers/customer.model.js";
import { OrderModel } from "#/modules/orders/order.model.js";
import { ProductModel } from "#/modules/products/product.model.js";
import { InventoryModel } from "#/modules/inventory/inventory.model.js";
import {
  ConversationModel,
  MAX_CONVERSATION_TURNS,
} from "#/modules/conversations/conversation.model.js";
import { SentImageModel } from "#/modules/sentImages/sentImage.model.js";
import { createOrder } from "#/modules/orders/order.service.js";
import { processMessage } from "#/integrations/whatsapp/claude.service.js";
import { searchProductsByImage } from "#/integrations/whatsapp/image-search.service.js";
import { CUSTOMER_GENDERS } from "#/modules/customers/customer.types.js";
import { logger } from "#/config/logger.js";
import { BANK_ACCOUNT_IMAGE_URL } from "#/config/env.js";
import { z } from "zod";
import type { WebhookPayload } from "#/integrations/whatsapp/webhook.validation.js";
import type {
  ClaudeSearchHints,
  ProductSearchItem,
} from "#/integrations/whatsapp/claude.service.js";

// ─── Response schema ──────────────────────────────────────────────────────────

const productImageSchema = z.object({
  url: z.string().url(),
  caption: z.string().optional(),
});

export type ProductImage = z.infer<typeof productImageSchema>;

const webhookResultSchema = z.object({
  reply: z.string(),
  escalate: z.boolean(),
  customerPhone: z.string(),
  customerName: z.string().nullable(),
  productImages: z.array(productImageSchema),
  escalationMessage: z.string().optional(),
});

export type WebhookResult = z.infer<typeof webhookResultSchema>;

// Returns a new object on every call — prevents shared array mutation across
// requests if any caller ever does result.productImages.push(...).
const emptyResult = (): WebhookResult => ({
  reply: "",
  escalate: false,
  customerPhone: "",
  customerName: null,
  productImages: [],
});

function toSafeResult(
  raw: unknown,
  customerPhone = "",
  customerName: string | null = null,
  gender: "female" | "male" | "unknown" = "unknown",
): WebhookResult {
  const parsed = webhookResultSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues, raw },
      "WebhookResult failed schema validation — escalating instead of silent empty",
    );
    return {
      reply: buildErrorReply(gender),
      escalate: true,
      customerPhone,
      customerName,
      productImages: [],
      escalationMessage: buildEscalationMessage({
        customerPhone,
        customerName,
        reason:
          "Error interno de validación — el resultado del procesamiento no cumple el esquema esperado.",
        suggestedAction:
          "Revisar logs de Railway para detalles del error. Responder al cliente manualmente.",
      }),
    };
  }
  return parsed.data;
}

// Gender-aware error reply — used in fallback paths where customerGender
// is already resolved. Prevents female-gendered apologies to male customers.
function buildErrorReply(gender: "female" | "male" | "unknown"): string {
  return gender === "male"
    ? "Lo siento amigo, hubo un problema técnico. Alguien del equipo te contactará pronto 🙏🏻"
    : "Lo siento bonita, hubo un problema técnico. Alguien del equipo te contactará pronto 🙏🏻";
}

// ─── Escalation message builders ─────────────────────────────────────────────

type EscalationContext = {
  customerPhone: string;
  customerName?: string | null;
  customerMessage?: string;
  intent?: string;
  searchHints?: {
    keyword?: string;
    size?: string;
    color?: string;
    gender?: string;
  };
  orderHints?: {
    productNameHint: string;
    size: string;
    color: string;
    quantity: number;
  }[];
  inventoryResult?: string;
  reason: string;
  suggestedAction: string;
};

function buildEscalationMessage(ctx: EscalationContext): string {
  const lines: string[] = ["⚠️ Nueva solicitud requiere atención manual.", ""];

  lines.push(`Cliente: ${ctx.customerPhone}`);
  if (ctx.customerName) lines.push(`Nombre: ${ctx.customerName}`);
  if (ctx.customerMessage) lines.push(`Mensaje: "${ctx.customerMessage}"`);
  if (ctx.searchHints?.keyword)
    lines.push(`Producto solicitado: ${ctx.searchHints.keyword}`);
  if (ctx.searchHints?.color)
    lines.push(`Color solicitado: ${ctx.searchHints.color}`);
  if (ctx.searchHints?.size)
    lines.push(`Talla solicitada: ${ctx.searchHints.size}`);
  if (ctx.searchHints?.gender && ctx.searchHints.gender !== "unknown") {
    lines.push(
      `Género: ${ctx.searchHints.gender === "female" ? "mujer" : "hombre"}`,
    );
  }
  if (ctx.orderHints?.length) {
    const items = ctx.orderHints
      .map(
        (h) =>
          `${h.productNameHint} talla ${h.size} color ${h.color} x${h.quantity}`,
      )
      .join(", ");
    lines.push(`Producto(s) para pedido: ${items}`);
  }
  if (ctx.inventoryResult)
    lines.push(`Resultado de inventario: ${ctx.inventoryResult}`);
  if (ctx.intent) lines.push(`Intención detectada: ${ctx.intent}`);

  lines.push("");
  lines.push(`Motivo de escalación: ${ctx.reason}`);
  lines.push(`Acción sugerida: ${ctx.suggestedAction}`);

  return lines.join("\n");
}

// Dedicated builder for payment receipt escalation — gives the owner a complete
// picture with sale context so they can verify without reading the full chat.
// ─── Conversation helpers ─────────────────────────────────────────────────────

type ConversationTurn = { role: string; content: string };

// Returns true if the recent conversation contains evidence that Luis already
// sent the bank account / payment data to this customer. Used to classify an
// incoming image as a payment receipt rather than a product photo.
//
// Matches the phrases Luis produces for payment_info intent (see system prompt)
// and the bank account image caption injected by the payment_info handler.
// Scans the last 10 turns — enough to cover a full payment exchange without
// reaching back into an unrelated prior session.
function hasRecentPaymentInfoContext(turns: ConversationTurn[]): boolean {
  const recentTurns = turns.slice(-10);
  const paymentPattern =
    /datos.*pago|ahorita te mando.*datos|datos para.*dep[oó]sito|datos bancarios|te mando los datos|informaci[oó]n.*pago|bancarios para tu dep[oó]sito/i;
  return recentTurns.some(
    (t) => t.role === "assistant" && paymentPattern.test(t.content),
  );
}

// ─── Cart helpers ─────────────────────────────────────────────────────────────

// A parsed product selection extracted from conversation history.
// description is the human-readable product line from Luis's ⭐️ confirmation format.
// price is parsed from the line if present — used for display in the ack message.
type CartItem = {
  description: string;
  price?: number;
};

// Scans recent assistant turns for ⭐️ lines (Luis's order confirmation format):
//   "⭐️Bra Alo color negro Talla S $2,190"
//   "⭐️ Legging Alo color negro talla S"
// Returns one CartItem per distinct product line, deduplicating across turns
// (Claude sometimes repeats the summary across multiple messages).
//
// This is the backend's "shopping cart" — used on the image receipt path where
// Claude is not in the loop, and as a fallback on the text receipt path when
// Claude provides no orderHints.
function extractCartFromHistory(turns: ConversationTurn[]): CartItem[] {
  const recentTurns = turns.slice(-15);
  const seen = new Set<string>();
  const items: CartItem[] = [];

  for (const turn of recentTurns) {
    if (turn.role !== "assistant") continue;

    const starLines = turn.content.match(/⭐️\s*([^\n]+)/g) ?? [];
    for (const raw of starLines) {
      const line = raw.replace(/^⭐️\s*/, "").trim();

      // Skip template placeholders ("[Producto]...") and Total lines
      if (/^\[|\bTotal\b/i.test(line)) continue;

      // Extract trailing price: "$2,190" or "— $2,190"
      const priceMatch = line.match(/\$\s*([\d,]+)\s*$/);
      const price = priceMatch
        ? parseInt(priceMatch[1].replace(/,/g, ""), 10)
        : undefined;

      // Strip price suffix and normalize whitespace
      const description = line
        .replace(/[-–—]?\s*\$[\d,.\s]+$/, "")
        .replace(/\s+/g, " ")
        .trim();

      if (!description || seen.has(description)) continue;
      seen.add(description);
      items.push({ description, price });
    }
  }

  return items;
}

// Builds the customer-facing receipt acknowledgment.
// When a cart was found, shows a numbered summary and asks for confirmation —
// the customer never has to repeat what they already said.
// Falls back to a generic ask only when the cart is genuinely empty.
function buildReceiptAck(
  gender: "female" | "male" | "unknown",
  cart: CartItem[],
): string {
  const pronoun = gender === "male" ? "amigo" : "bonita";

  if (cart.length === 0) {
    return (
      `¡Recibido ${pronoun}! 🙌🏼 Ya le avisé al equipo para que verifiquen tu transferencia. ` +
      `En cuanto confirmen, te escribo de inmediato 🙏🏻\n` +
      `¿Me confirmas qué producto, talla y color quieres apartar?`
    );
  }

  const itemLines = cart
    .map((item, i) => {
      const priceStr = item.price
        ? ` — $${item.price.toLocaleString("es-MX")}`
        : "";
      return `${i + 1}. ${item.description}${priceStr}`;
    })
    .join("\n");

  return (
    `¡Recibido ${pronoun}! 🙌🏼 Ya le avisé al equipo para que verifiquen tu transferencia.\n\n` +
    `Tengo esto para apartarte:\n${itemLines}\n\n` +
    `¿Confirmas que está correcto? En cuanto verifiquen el pago te confirmo 🙏🏻`
  );
}

// Converts orderHints (Claude's structured output) to CartItem[] so both the
// Claude-driven text path and the backend-driven image path share the same
// escalation builder signature.
function orderHintsToCart(
  hints: Array<{
    productNameHint: string;
    size: string;
    color: string;
    quantity: number;
  }>,
): CartItem[] {
  return hints.map((h) => ({
    description: `${h.productNameHint} color ${h.color} talla ${h.size}${h.quantity > 1 ? ` x${h.quantity}` : ""}`,
  }));
}

// Dedicated builder for payment receipt escalation.
// cart is either from Claude's orderHints (text path) or extractCartFromHistory
// (image path). Either way the owner gets a structured list without reading the
// full chat.
function buildPaymentReceiptEscalation({
  customerPhone,
  customerName,
  cart,
}: {
  customerPhone: string;
  customerName: string | null;
  cart: CartItem[];
}): string {
  const lines: string[] = [
    "🧾 Comprobante de pago recibido",
    "",
    `Cliente: ${customerName ?? "Sin nombre"} (${customerPhone})`,
    "",
    "Pedido pendiente de verificación:",
  ];

  if (cart.length > 0) {
    for (const item of cart) {
      const priceStr = item.price
        ? ` — $${item.price.toLocaleString("es-MX")}`
        : "";
      lines.push(`  • ${item.description}${priceStr}`);
    }
  } else {
    lines.push(
      "  Sin detalle de productos en el historial — revisar el chat completo.",
    );
  }

  lines.push(
    "",
    "─────────────────────────────────",
    "⚠️  El pedido NO ha sido creado — en espera de verificación de pago.",
    "✅ Verifica la transferencia en tu cuenta bancaria.",
    "✅ Una vez confirmado, respóndele al cliente directamente.",
    "",
    `📱 Ver comprobante: chat de WhatsApp con ${customerPhone}`,
  );

  return lines.join("\n");
}

// ─── Integration boundary schemas ─────────────────────────────────────────────

const processMessageResultSchema = z.object({
  intent: z.enum([
    "catalog_query",
    "product_search",
    "price_query",
    "create_order",
    "order_status",
    "order_summary", // NEW: customer asked for their full accumulated order list
    "showroom_visit", // NEW: customer wants to visit the showroom in person
    "payment_info",
    "payment_receipt",
    "needs_human",
    "general",
  ]),
  response: z.string().min(1),
  searchHints: z
    .object({
      keyword: z.string().min(1),
      gender: z.enum(["female", "male", "unknown"]).optional(),
      size: z.string().optional(),
      color: z.string().optional(),
    })
    .optional(),
  orderHints: z
    .array(
      z.object({
        productNameHint: z.string().min(1),
        size: z.string().min(1),
        color: z.string().min(1),
        quantity: z.number().int().positive(),
      }),
    )
    .optional(),
  productImages: z.array(productImageSchema),
  detectedGender: z.enum(["female", "male"]).optional(),
});

type ProcessMessageResult = z.infer<typeof processMessageResultSchema>;

const imageSearchResultSchema = z.object({
  reply: z.string().min(1),
  // Use productImageSchema instead of z.unknown() — validates URLs and prevents
  // malformed image objects from crashing the WhatsApp send node downstream.
  productImages: z.array(productImageSchema).default([]),
});

// ─── Business info ────────────────────────────────────────────────────────────

const BUSINESS_INFO = {
  showroomAddress:
    "Av. Guadalupe 1390, Chapalita Oriente, Guadalajara, Jalisco",
  businessHours:
    "Lunes a Viernes 10:00am–8:30pm · Sábados 11:00am–7:00pm · Domingos cerrado",
  shippingPrice: 179,
  paymentMethods:
    "Transferencia bancaria, depósito o tarjeta de crédito/débito. No se acepta efectivo en pedidos sobre pedido.",
  depositPercent: 30,
  paymentDays: 20,
  // Set to a non-empty string to have Luis mention the promotion once per
  // conversation when the customer is browsing or hesitating.
  // e.g. "30% Off Alo Yoga hasta el 10 de mayo"
  // Leave undefined or empty string when no promotion is active.
  activePromotion: undefined as string | undefined,
} as const;

// ─── Image message idempotency ────────────────────────────────────────────────

// WARNING: process-local — deduplication breaks if Railway scales to >1 instance.
// Replace with a Redis TTL key or MongoDB TTL collection before horizontal scaling.
const recentImageMessageIds = new Set<string>();
const IMAGE_DEDUP_WINDOW_MS = 5 * 60 * 1000;

function trackImageMessageId(id: string): boolean {
  if (recentImageMessageIds.has(id)) return false;
  recentImageMessageIds.add(id);
  setTimeout(() => recentImageMessageIds.delete(id), IMAGE_DEDUP_WINDOW_MS);
  return true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizePhoneForLookup(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\D+/g, "");
}

function findProductByHint(
  hint: string,
  catalog: { id: string; name: string; price: number }[],
): { id: string; name: string; price: number } | null {
  const normalized = hint.toLowerCase().trim();
  const hintWords = normalized.split(/\s+/).filter(Boolean);

  // Pass 1: substring match — fast path for exact or near-exact names
  const exactMatch =
    catalog.find((p) => p.name.toLowerCase().includes(normalized)) ??
    catalog.find((p) => normalized.includes(p.name.toLowerCase()));
  if (exactMatch) return exactMatch;

  // Pass 2: word-overlap match — handles partial multi-word names.
  // e.g. hint "jersey accolade" matches "Jersey de cuello redondo Accolade"
  // because both words appear somewhere in the product name.
  return (
    catalog.find((p) => {
      const productWords = p.name.toLowerCase().split(/\s+/);
      return hintWords.every((hw) =>
        productWords.some((pw) => pw.includes(hw) || hw.includes(pw)),
      );
    }) ?? null
  );
}

function toValidUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    return undefined;
  }
}

function normalizeProductImages(value: unknown): ProductImage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const url = toValidUrl(item);
      return url ? { url } : undefined;
    })
    .filter((img): img is ProductImage => Boolean(img));
}

// ─── On-demand product search ─────────────────────────────────────────────────
// Called by claude.service.ts only when Claude invokes the search_products tool.
//
// ARCHITECTURE NOTE — why this joins InventoryModel instead of filtering
// products directly:
//
// Before the color migration, color lived in the product name as a suffix
// ("CROP TOP - WHITE") and variant.color was always "default". The old approach
// loaded all active products and filtered by name/brand/categoryGroup.
//
// After the migration, color is a first-class variant field and stock is tracked
// per (productId, size, color) in the inventories collection. The correct query
// for "tienes crop tops en negro talla S" is therefore:
//
//   1. Find products matching the keyword/gender filter (products collection)
//   2. Join with inventories to find which (product, size, color) combinations
//      actually have stock > 0
//   3. Filter by color hint and size hint at the inventory level
//   4. Return one ProductSearchItem per matching in-stock variant, with the
//      product's image and the variant's real color in the caption
//
// This means the bot only shows items that are actually available, and the
// caption accurately reflects color ("Crop Top (Alo) — Blanco — $1,599").

async function searchProductsForClaude(
  hints: ClaudeSearchHints,
): Promise<ProductSearchItem[]> {
  const keyword = hints.keyword.toLowerCase().trim();

  // Guard: empty keyword would throw "text search string is empty" from MongoDB.
  // claude.service.ts validates keyword with min(1) but we defend here too.
  if (!keyword) return [];

  // Step 1: Match products using MongoDB full-text index.
  // The text index covers: name (weight 10), brand (8), searchKeywords (6),
  // subcategory (6), categoryGroup (3), description (1) — with Spanish stemming.
  // This replaces the previous in-memory .filter() which did a full collection
  // scan on every search call and missed subcategory-to-colloquial-term matches
  // (e.g. customer says "sudadera", product is named "Jersey de cuello redondo").
  //
  // Gender normalization: DB stores 'women'/'men', Claude sends 'female'/'male'.
  const productFilter: Record<string, unknown> = {
    status: "active",
    $text: { $search: keyword },
  };

  if (hints.gender && hints.gender !== "unknown") {
    const dbGender = hints.gender === "female" ? "women" : "men";
    productFilter.gender = dbGender;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let products: any[] = [];

  try {
    products = await ProductModel.find(productFilter, {
      score: { $meta: "textScore" },
    })
      .select("name price brand gender categoryGroup subcategory images")
      .sort({ score: { $meta: "textScore" } })
      .limit(20)
      .lean();
  } catch (err: unknown) {
    // If the text index doesn't exist yet (fresh deploy, index still building),
    // MongoDB throws "text index required for $text query". Log clearly and
    // return empty rather than crashing the entire message handler.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("text index required")) {
      logger.error(
        { keyword, err },
        "searchProductsForClaude — text index not ready, returning empty. Check MongoDB index status.",
      );
      return [];
    }
    throw err;
  }

  if (products.length === 0 && productFilter.gender) {
    // Safety net: gender filter returned 0 results.
    // A male customer asking generically ("tienes sudaderas") should see all
    // available products — not 0 results because the catalog is women's clothing.
    // Retry without the gender filter before giving up.
    const filterWithoutGender = { ...productFilter };
    delete filterWithoutGender.gender;
    try {
      products = await ProductModel.find(filterWithoutGender, {
        score: { $meta: "textScore" },
      })
        .select("name price brand gender categoryGroup subcategory images")
        .sort({ score: { $meta: "textScore" } })
        .limit(20)
        .lean();
      if (products.length > 0) {
        logger.info(
          { keyword, removedGender: productFilter.gender },
          "searchProductsForClaude — gender filter returned 0, retried without gender and found results",
        );
      }
    } catch {
      // If retry also fails, fall through to return []
    }
  }

  if (products.length === 0) return [];

  const matchingProductIds = products.map((p) => p._id);

  // Step 2: Query inventory for in-stock variants of matching products.
  // Filter by size and color at the DB level so we don't return zero-stock rows.
  const inventoryFilter: Record<string, unknown> = {
    productId: { $in: matchingProductIds },
    quantity: { $gt: 0 },
  };

  if (hints.size) {
    // inventory.size is stored uppercase via pre-save hook
    inventoryFilter.size = hints.size.trim().toUpperCase();
  }

  if (hints.color) {
    // inventory.color is stored lowercase via pre-save hook
    // Support partial color match: "negro" matches "negro intenso", etc.
    inventoryFilter.color = {
      $regex: hints.color.trim().toLowerCase(),
      $options: "i",
    };
  }

  const inStockInventory = await InventoryModel.find(inventoryFilter)
    .select("productId size color quantity")
    .lean();

  if (inStockInventory.length === 0) return [];

  // Step 3: Build a product lookup map for fast joining
  const productMap = new Map(products.map((p) => [p._id.toString(), p]));

  // Step 4: Deduplicate by product and build one ProductSearchItem per matching
  // product (not per inventory variant).
  //
  // The previous implementation returned one item per in-stock inventory record.
  // For a product with XS/S/M all in stock, this produced 3 items each pointing
  // to product.images[0], causing the first image to be sent 3 times.
  //
  // The correct behaviour:
  //   - One ProductSearchItem per product
  //   - All product images included (not just images[0])
  //   - Caption on the first image identifies the product; subsequent images
  //     carry an empty caption so they arrive as a clean gallery
  //
  // We use a Map keyed by productId to collapse the inventory rows back into
  // one result per product while still reflecting that in-stock variants exist.

  const seenProductIds = new Set<string>();
  const results: ProductSearchItem[] = [];

  for (const inv of inStockInventory) {
    const productIdStr = inv.productId.toString();
    if (seenProductIds.has(productIdStr)) continue;
    seenProductIds.add(productIdStr);

    const product = productMap.get(productIdStr);
    if (!product) continue;

    // Human-readable color: capitalize first letter of each word for display
    const displayColor = inv.color
      .split(" ")
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

    const primaryCaption = `$${product.price.toLocaleString("es-MX")} — ${product.name} ${displayColor} (${product.brand})`;

    // Build one image entry per product photo.
    // First image carries the identifying caption; the rest arrive captionless
    // so WhatsApp groups them into a single gallery without repeated text.
    const images = (product.images ?? [])
      .map((uri: string, index: number) => {
        const url = toValidUrl(uri);
        return url ? { url, caption: index === 0 ? primaryCaption : "" } : null;
      })
      .filter(
        (
          img: { url: string; caption: string } | null,
        ): img is { url: string; caption: string } =>
          img !== null && img !== undefined,
      );

    results.push({
      name: product.name,
      brand: product.brand,
      price: product.price,
      color: displayColor,
      images,
    });
  }

  logger.info(
    {
      keyword,
      gender: hints.gender,
      size: hints.size,
      color: hints.color,
      productMatches: products.length,
      inventoryMatches: inStockInventory.length,
      returned: results.length,
    },
    "searchProductsForClaude — query complete",
  );

  return results;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const handleIncomingMessage = async (
  payload: WebhookPayload,
): Promise<WebhookResult> => {
  const rawFrom = payload.from;
  const from = normalizePhoneForLookup(rawFrom);
  const messageType = payload.messageType;
  const message =
    typeof payload.message === "string" ? payload.message.trim() : "";
  const messageId =
    typeof payload.messageId === "string" && payload.messageId.trim()
      ? payload.messageId.trim()
      : null;

  // Detected by Extract Message node when WhatsApp message has context.id
  // (customer replied directly to one of the gallery images). The prefix is
  // prepended in n8n so the backend can gate image suppression independently
  // of Claude's intent decision.
  //
  // TWO detection methods — both checked because the buffer merge (Normalize
  // Claim Response) may concatenate messages in a way that moves the prefix
  // away from position 0, causing startsWith to miss it:
  //
  //   Method A: message starts with the prefix (single message, not buffered)
  //   Method B: contextMessageId is present in the payload (survives buffer
  //             merge because it comes from the WhatsApp API, not text manipulation)
  //
  // Either signal is sufficient — OR logic covers both paths.
  // contextMessageId is set by Extract Message node when the customer replies
  // to a specific WhatsApp message. Defined in WebhookPayload via webhook.validation.ts.
  const contextMessageId =
    typeof payload.contextMessageId === "string" &&
    payload.contextMessageId.trim().length > 0
      ? payload.contextMessageId.trim()
      : null;

  let isGalleryReply =
    message.includes(
      "[El cliente está respondiendo a una imagen del gallery anterior]",
    ) || contextMessageId !== null;

  // ── 0. Guards ─────────────────────────────────────────────────────────────

  if (!from) {
    logger.info(
      {
        rawFrom: payload.from,
        messageType: payload.messageType,
        messageId: payload.messageId,
      },
      "Ignoring non-message webhook event — empty or invalid from field after normalization",
    );
    return emptyResult();
  }

  if (rawFrom && rawFrom !== from) {
    logger.info(
      { rawFrom, normalizedFrom: from, messageId },
      "Normalized WhatsApp phone number",
    );
  }

  if (messageType && messageType !== "text" && messageType !== "image") {
    logger.info(
      { from, messageType, messageId },
      "Ignoring unsupported WhatsApp message type",
    );
    return emptyResult();
  }
  // NOTE: if messageType is undefined (not provided by n8n), the guard above
  // is falsy and execution falls through to the text handler below — treating
  // undefined type as a text message. This is intentional and correct behavior.

  if (messageType === "image" && !payload.imageMediaId) {
    logger.info(
      { from, messageId },
      "Ignoring image webhook event without imageMediaId",
    );
    return emptyResult();
  }

  if ((messageType === "text" || !messageType) && !message) {
    logger.info(
      { from, messageId, messageType },
      "Ignoring empty text-like WhatsApp event",
    );
    return emptyResult();
  }

  // ── 1. Identify / create customer ─────────────────────────────────────────

  const customer = await CustomerModel.findOneAndUpdate(
    { phone: from },
    {
      $setOnInsert: {
        name: payload.contactName ?? `WhatsApp ${from}`,
        phone: from,
        contactChannel: "whatsapp",
        gender: CUSTOMER_GENDERS.UNKNOWN,
        isActive: true,
        tags: [],
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  ).lean();

  if (!customer) {
    logger.error({ phone: from }, "Customer upsert returned null — unexpected");
    return toSafeResult(emptyResult(), from);
  }

  if (payload.contactName && customer.name === `WhatsApp ${from}`) {
    await CustomerModel.updateOne(
      { _id: customer._id },
      { $set: { name: payload.contactName } },
    );
    customer.name = payload.contactName;
    logger.info(
      { customerId: customer._id.toString(), from },
      "Updated customer placeholder name",
    );
  }

  const customerId = customer._id.toString();
  const customerName =
    customer.name !== `WhatsApp ${from}` ? customer.name : null;
  const customerGender = (customer.gender ?? CUSTOMER_GENDERS.UNKNOWN) as
    | "female"
    | "male"
    | "unknown";

  // ── 1b. Load conversation — used by both image receipt detection and text flow ──
  //
  // Loaded here (before the image/text branch) so the receipt classifier in
  // section 2 can inspect recent turns without a second DB round-trip.
  // The full conversation history window for Claude is assembled in section 3.
  const conversation = await ConversationModel.findOne({
    customerId,
    channel: "whatsapp",
  }).lean();

  const allTurns = conversation?.turns ?? [];
  const lastMessageAt = conversation?.lastMessageAt;

  // ── Method C — refine isGalleryReply using conversation history ───────────
  // Methods A and B (above) cover single-message gallery replies correctly.
  // They fail when multiple rapid messages are buffered together: the buffer
  // merge may drop the [El cliente está respondiendo] prefix AND
  // Normalize Claim Response may not forward contextMessageId correctly.
  //
  // Method C catches the case where:
  //   - recent history shows a [Productos enviados] note (gallery was sent)
  //   - the merged message contains demonstrative language pointing at a
  //     specific product ("me interesa este", "ese suéter", "esta prenda")
  //
  // This is intentionally conservative — requires BOTH signals to avoid
  // false-positives on messages like "quiero ese estilo" with no gallery context.
  if (!isGalleryReply) {
    const hasRecentGallery = allTurns
      .slice(-6)
      .some(
        (t) =>
          t.role === "assistant" &&
          t.content.includes("[Productos enviados al cliente en este turn:"),
      );

    const hasDemonstrativeProductIntent =
      /\bme interesa (este|ese|esta|esa)\b/i.test(message) ||
      /\b(este|ese|esta|esa)\b.{0,40}(suéter|jersey|bra|top|legging|producto|prenda|modelo|ropa)/i.test(
        message,
      );

    if (hasRecentGallery && hasDemonstrativeProductIntent) {
      isGalleryReply = true;
      logger.info(
        { customerId, messageId },
        "isGalleryReply=true via Method C (demonstrative language + recent gallery history)",
      );
    }
  }

  // 24h reset: if the customer's last message was over 24 hours ago, treat as
  // a fresh session — don't send yesterday's product gallery context to Claude.
  const isStaleConversation =
    lastMessageAt &&
    Date.now() - new Date(lastMessageAt).getTime() > 24 * 60 * 60 * 1000;

  // ── 2. Image message ──────────────────────────────────────────────────────

  if (messageType === "image") {
    if (messageId && !trackImageMessageId(messageId)) {
      logger.info(
        { from, messageId, customerId },
        "Duplicate image messageId — skipping",
      );
      return emptyResult();
    }

    // ── 2a. Payment receipt detection ─────────────────────────────────────
    // If the customer was shown bank account data in a recent turn, an incoming
    // image is almost certainly a payment receipt — not a product photo.
    // Skip searchProductsByImage entirely and return a direct acknowledgment.
    //
    // This is checked BEFORE the product search so the receipt is never routed
    // into image-based catalog search, which would return 0 results and produce
    // a generic fallback reply ("Permíteme un momento").
    if (hasRecentPaymentInfoContext(allTurns)) {
      logger.info(
        { customerId, mediaId: payload.imageMediaId, messageId },
        "Image message after payment_info context — treating as payment receipt, skipping product search",
      );

      // Extract product selections from conversation history so the ack message
      // shows the customer what they're confirming — not a generic "what do you want?"
      const cart = extractCartFromHistory(allTurns);
      const receiptAck = buildReceiptAck(customerGender, cart);

      logger.info(
        { customerId, cartItems: cart.length },
        "Payment receipt — built cart-aware ack from conversation history",
      );

      // Persist the receipt turn so subsequent text messages have this context.
      // Storing "[Comprobante de pago enviado]" as the user turn prevents Claude
      // from treating the next message as coming out of nowhere.
      await ConversationModel.findOneAndUpdate(
        { customerId, channel: "whatsapp" },
        {
          $push: {
            turns: {
              $each: [
                {
                  role: "user" as const,
                  content: "[Comprobante de pago enviado por el cliente]",
                  createdAt: new Date(),
                },
                {
                  role: "assistant" as const,
                  content: receiptAck,
                  createdAt: new Date(),
                },
              ],
              $slice: -MAX_CONVERSATION_TURNS,
            },
          },
          $set: { lastMessageAt: new Date() },
        },
        { upsert: true, returnDocument: "after" },
      );

      return toSafeResult(
        {
          reply: receiptAck,
          escalate: true,
          customerPhone: from,
          customerName,
          productImages: [],
          escalationMessage: buildPaymentReceiptEscalation({
            customerPhone: from,
            customerName,
            cart,
          }),
        },
        from,
        customerName,
        customerGender,
      );
    }

    // ── 2b. Product image search (existing flow) ───────────────────────────

    logger.info(
      { customerId, mediaId: payload.imageMediaId, messageId },
      "Image message — running visual search",
    );

    const fallbackReply = buildErrorReply(customerGender);

    try {
      const rawSearchResult = await searchProductsByImage(
        payload.imageMediaId as string,
      );
      const searchResult = imageSearchResultSchema.safeParse(rawSearchResult);
      if (!searchResult.success) {
        throw new Error(
          `searchProductsByImage returned unexpected shape: ${JSON.stringify(searchResult.error.issues)}`,
        );
      }

      const { reply, productImages: rawProductImages } = searchResult.data;
      const productImages = normalizeProductImages(rawProductImages);

      await ConversationModel.findOneAndUpdate(
        { customerId, channel: "whatsapp" },
        {
          $push: {
            turns: {
              $each: [
                {
                  role: "user" as const,
                  content: "[Imagen enviada por el cliente]",
                  createdAt: new Date(),
                },
                {
                  role: "assistant" as const,
                  content: reply,
                  createdAt: new Date(),
                },
              ],
              $slice: -MAX_CONVERSATION_TURNS,
            },
          },
          $set: { lastMessageAt: new Date() },
        },
        { upsert: true, returnDocument: "after" },
      );

      return toSafeResult(
        {
          reply,
          escalate: false,
          customerPhone: from,
          customerName,
          productImages,
        },
        from,
        customerName,
      );
    } catch (err) {
      logger.error(
        { err, customerId, mediaId: payload.imageMediaId, messageId },
        "Image search failed",
      );

      await ConversationModel.findOneAndUpdate(
        { customerId, channel: "whatsapp" },
        {
          $push: {
            turns: {
              $each: [
                {
                  role: "user" as const,
                  content: "[Imagen enviada por el cliente]",
                  createdAt: new Date(),
                },
                {
                  role: "assistant" as const,
                  content: fallbackReply,
                  createdAt: new Date(),
                },
              ],
              $slice: -MAX_CONVERSATION_TURNS,
            },
          },
          $set: { lastMessageAt: new Date() },
        },
        { upsert: true, returnDocument: "after" },
      );

      return toSafeResult(
        {
          reply: fallbackReply,
          escalate: true,
          customerPhone: from,
          customerName,
          productImages: [],
          escalationMessage: buildEscalationMessage({
            customerPhone: from,
            customerName,
            customerMessage: "[Imagen enviada por el cliente]",
            reason: "La búsqueda visual por imagen falló con un error interno.",
            suggestedAction:
              "Revisar logs de Railway. Responder al cliente manualmente con productos similares a la imagen enviada.",
          }),
        },
        from,
        customerName,
      );
    }
  }

  // ── 3. Text message — Luis flow ───────────────────────────────────────────

  // Build the history window for Claude.
  // allTurns and isStaleConversation are already resolved from section 1b.
  const MAX_HISTORY_TURNS_FOR_AI = 10;

  const conversationHistory = isStaleConversation
    ? []
    : allTurns.slice(-MAX_HISTORY_TURNS_FOR_AI).map((t) => ({
        role: t.role as "user" | "assistant",
        content: t.content,
      }));

  if (isStaleConversation) {
    logger.info(
      { customerId, lastMessageAt, messageId },
      "Stale conversation (>24h) — sending empty history to Claude",
    );
  }

  // ── 3a. Broad catalog fast-path ───────────────────────────────────────────
  // Intercepts messages like "que productos tienes disponibles", "que manejas",
  // "que hay", "muestrame todo" BEFORE calling Claude.
  //
  // WHY: Claude sometimes misroutes broad catalog questions — no keyword →
  // tries search_products with vague terms → 0 results → retry → iteration
  // cap → SAFE_FALLBACK. This pattern is 100% predictable so the backend
  // handles it directly with zero API cost and zero failure risk.
  //
  // Pattern: optional greeting + broad availability/catalog question.
  // Does NOT fire when the message contains a specific product noun
  // (suéter, legging, bra, etc.) — those go to Claude normally.
  const specificProductPattern =
    /legging|bra|top|jersey|suéter|sudader|short|jogger|set\b|calcet|sock|chaqueta|playera|blusa|pantalón|hoodie|crop|conjunto|outfit|prenda|\balo\b|lululemon|wiskii/i;

  const broadCatalogPattern =
    /^(?:hola+[!¡]?\s*)?(?:qu[eé]\s+(?:productos?|tienes?|hay|manejas?|vendes?|tienen|tienen\s+disponible)|qu[eé]\s+tienes?|muestrame\s+todo|qu[eé]\s+hay\s+disponible|qu[eé]\s+tienen?\s+disponible|tienen?\s+algo\s+disponible|tienes?\s+algo|qu[eé]\s+venden?)/i;

  const isBroadCatalog =
    broadCatalogPattern.test(message) && !specificProductPattern.test(message);

  if (isBroadCatalog) {
    const catalogReply =
      customerGender === "male"
        ? "¡Hola amigo! Manejamos ropa deportiva y lifestyle de Alo Yoga, Lululemon, Wiskii, 437, Better Me y Skims 🙌🏼 ¿Qué tipo de prenda buscas? ¿Leggings, bra, top, jersey, shorts? ¿Y qué talla manejas?"
        : "¡Hola bonita! Manejamos ropa deportiva y lifestyle de Alo Yoga, Lululemon, Wiskii, 437, Better Me y Skims 🙌🏼 ¿Qué tipo de prenda buscas? ¿Leggings, bra, top, jersey, shorts? ¿Y qué talla manejas?";

    logger.info(
      { customerId, messageId, message },
      "Broad catalog question — fast-path response, skipping Claude",
    );

    await ConversationModel.findOneAndUpdate(
      { customerId, channel: "whatsapp" },
      {
        $push: {
          turns: {
            $each: [
              {
                role: "user" as const,
                content: message,
                createdAt: new Date(),
              },
              {
                role: "assistant" as const,
                content: catalogReply,
                createdAt: new Date(),
              },
            ],
            $slice: -MAX_CONVERSATION_TURNS,
          },
        },
        $set: { lastMessageAt: new Date() },
      },
      { upsert: true, returnDocument: "after" },
    );

    return toSafeResult(
      {
        reply: catalogReply,
        escalate: false,
        customerPhone: from,
        customerName,
        productImages: [],
      },
      from,
      customerName,
      customerGender,
    );
  }

  // NOTE: add { customerId: 1, createdAt: -1 } compound index on orders if
  // this sort becomes slow when order volume grows beyond pilot scale.
  const recentOrder = await OrderModel.findOne({ customerId })
    .sort({ createdAt: -1 })
    .lean();

  // ── Exact product resolution via SentImage mapping ────────────────────────
  // When the customer replied to a specific gallery image (isGalleryReply=true
  // and contextMessageId is set), look up the exact product that was in that
  // WhatsApp message. The mapping was stored by the n8n "Log Sent Image" node
  // after each Send Image API response.
  //
  // If a match is found, replace the generic gallery hint in the message with
  // a precise product identifier so Claude answers the exact product — name,
  // price, color — without inferring from the full gallery list.
  //
  // Falls back gracefully: if no mapping exists (feature not yet active, or
  // the image was sent before this feature was deployed), the message remains
  // unchanged and Claude uses the [Productos enviados] note from history.
  let incomingMessageForClaude = message;

  if (isGalleryReply && contextMessageId) {
    try {
      const sentImage = await SentImageModel.findOne({
        sentMessageId: contextMessageId,
      }).lean();

      if (sentImage?.caption) {
        // Replace the generic gallery hint with the exact product context.
        // Claude's gallery reply protocol (PASO 1) reads this tag and skips
        // the [Productos enviados] note lookup entirely — one product, direct answer.
        const exactContext = `[Producto exacto seleccionado por el cliente: ${sentImage.caption}]`;
        incomingMessageForClaude = message.replace(
          /\[El cliente está respondiendo a una imagen del gallery anterior\]/,
          exactContext,
        );

        logger.info(
          {
            customerId,
            messageId,
            contextMessageId,
            caption: sentImage.caption,
          },
          "Gallery reply — exact product resolved from SentImage mapping",
        );
      } else {
        logger.info(
          { customerId, messageId, contextMessageId },
          "Gallery reply — no SentImage mapping found, falling back to history inference",
        );
      }
    } catch (err) {
      // Non-fatal: log and continue with the original message.
      // Claude will still answer correctly using the [Productos enviados] note.
      logger.warn(
        { err, customerId, contextMessageId },
        "Gallery reply — SentImage lookup failed, falling back to history inference",
      );
    }
  }

  // Compute approximate lifetime value for VIP detection.
  // Aggregates total across all non-cancelled orders for this customer.
  // Single aggregation — result is undefined (not 0) when no orders exist,
  // so claude.service.ts buildVipContext correctly skips the VIP label for new customers.
  let customerLifetimeValue: number | undefined;
  try {
    const ltvAgg = await OrderModel.aggregate([
      { $match: { customerId: customer._id, status: { $ne: "cancelled" } } },
      { $group: { _id: null, total: { $sum: "$total" } } },
    ]);
    if (ltvAgg.length > 0 && ltvAgg[0].total > 0) {
      customerLifetimeValue = ltvAgg[0].total as number;
    }
  } catch (err) {
    // Non-critical — VIP detection degrades gracefully without this value.
    logger.warn(
      { err, customerId },
      "LTV aggregation failed — skipping VIP context",
    );
  }

  const rawResult = await processMessage({
    customerName,
    customerGender,
    customerLifetimeValue,
    recentOrder: recentOrder
      ? {
          orderNumber: recentOrder.orderNumber,
          status: recentOrder.status,
          total: recentOrder.total,
          // Pass optional fields if they exist on the order document.
          // These are typed as optional in ClaudeContext so undefined is safe.
          outstandingBalance: (
            recentOrder as unknown as Record<string, unknown>
          ).outstandingBalance as number | undefined,
          trackingNumber: (recentOrder as unknown as Record<string, unknown>)
            .trackingNumber as string | undefined,
          estimatedDelivery: (recentOrder as unknown as Record<string, unknown>)
            .estimatedDelivery as string | undefined,
          // Map order line items to the OrderItem shape expected by Claude.
          // Falls back to undefined if the order model doesn't have an items array.
          items: Array.isArray(
            (recentOrder as unknown as Record<string, unknown>).items,
          )
            ? (
                (recentOrder as unknown as Record<string, unknown>)
                  .items as Array<{
                  name?: string;
                  size?: string;
                  color?: string;
                  quantity?: number;
                  unitPrice?: number;
                }>
              ).map((i) => ({
                name: i.name ?? "Producto",
                size: i.size ?? "?",
                color: i.color ?? "?",
                quantity: i.quantity ?? 1,
                price: i.unitPrice ?? 0,
              }))
            : undefined,
        }
      : null,
    searchProducts: searchProductsForClaude,
    incomingMessage: incomingMessageForClaude,
    conversationHistory,
    businessInfo: BUSINESS_INFO,
  });

  const parsedResult = processMessageResultSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    logger.error(
      { issues: parsedResult.error.issues, rawResult, customerId, messageId },
      "processMessage returned unexpected shape — escalating",
    );

    // Persist the failed turn so Luis has context on the next message.
    // Without this, the conversation history has a gap and Luis may re-greet
    // or lose context mid-negotiation.
    const errorReply = buildErrorReply(customerGender);
    await ConversationModel.findOneAndUpdate(
      { customerId, channel: "whatsapp" },
      {
        $push: {
          turns: {
            $each: [
              {
                role: "user" as const,
                content: message,
                createdAt: new Date(),
              },
              {
                role: "assistant" as const,
                content: errorReply,
                createdAt: new Date(),
              },
            ],
            $slice: -MAX_CONVERSATION_TURNS,
          },
        },
        $set: { lastMessageAt: new Date() },
      },
      { upsert: true, returnDocument: "after" },
    );

    return toSafeResult(
      {
        reply: errorReply,
        escalate: true,
        customerPhone: from,
        customerName,
        productImages: [],
        escalationMessage: buildEscalationMessage({
          customerPhone: from,
          customerName,
          customerMessage: message,
          reason:
            "Error interno — la respuesta del modelo no cumple el esquema esperado.",
          suggestedAction:
            "Revisar logs de Railway. Responder al cliente manualmente.",
        }),
      },
      from,
      customerName,
    );
  }

  const result: ProcessMessageResult = parsedResult.data;
  let escalate = result.intent === "needs_human";
  // Spread to a new array — prevents mutating result.productImages by reference.
  // payment_info later pushes the bank image into this array; without the spread,
  // that push would corrupt the original processMessage return value.
  const productImages: ProductImage[] = [...result.productImages];

  // ── Gallery reply — suppress images unless Claude explicitly re-searched ───
  // When the customer replies to a gallery image and asks a name/price/info
  // question, Claude may still call search_products (PASO 2c fallback) and
  // accumulate images. But the customer didn't ask for a new gallery — they
  // asked about a specific product they already saw.
  //
  // Rule: if this is a gallery reply AND the intent is not product_search
  // (i.e. Claude answered from history, not from a new search), strip images
  // before returning so n8n's IF Has Product Images branch doesn't fire.
  //
  // If Claude returned product_search intent, it found something new and
  // sending images is intentional — allow it through.
  if (isGalleryReply && result.intent !== "product_search") {
    if (productImages.length > 0) {
      logger.info(
        {
          customerId,
          messageId,
          intent: result.intent,
          suppressedImages: productImages.length,
        },
        "Gallery reply — suppressing product images (customer asked info, not new catalog)",
      );
      productImages.length = 0;
    }
  }

  if (result.intent === "product_search") {
    logger.info(
      { matches: productImages.length, customerId, messageId },
      "Product search intent",
    );
    if (productImages.length === 0) {
      // Escalate when product_search returns 0 images.
      // The system prompt instructs Claude to attempt broader searches before
      // returning product_search with 0 results — reaching here means Claude
      // already exhausted its search attempts. Removed the searchHints guard:
      // escalation should fire regardless of whether searchHints is present,
      // since the customer received no products either way.
      escalate = true;
      logger.info(
        { customerId, messageId, searchHints: result.searchHints },
        "Product search 0 results — escalating",
      );
    }
  }

  // ── order_summary ─────────────────────────────────────────────────────────
  // Claude compiled the customer's accumulated order list from history.
  // No special backend action needed — Claude's response is the answer.
  // No escalation, no images. Falls through to the persist/return path below.
  if (result.intent === "order_summary") {
    logger.info(
      { customerId, messageId },
      "order_summary intent — passing Claude response through, no backend action required",
    );
  }

  // ── showroom_visit ────────────────────────────────────────────────────────
  // Customer wants to visit in person. Claude already replied with address +
  // hours. Escalate so the owner knows a visit is coming and can prepare.
  if (result.intent === "showroom_visit") {
    escalate = true;
    logger.info(
      { customerId, messageId },
      "showroom_visit intent — escalating so owner is aware of upcoming visit",
    );
  }

  // ── payment_receipt — customer sent or announced a payment comprobante ────
  // Intent set by Claude when the customer says "ya pagué", "aquí está el
  // comprobante", "ya transferí", etc. via text message.
  // (The image-receipt case is handled earlier in section 2a.)
  //
  // Claude's response already contains the cart summary (system prompt instructs
  // it to check history and include a numbered list). We just set escalate and
  // let the escalation builder below use orderHints for the owner message.
  //
  // We do NOT:
  //   - inject the bank account image (already sent in a prior payment_info turn)
  //   - create an order (payment must be verified first — owner confirms manually)
  if (result.intent === "payment_receipt") {
    escalate = true;
    logger.info(
      { customerId, messageId, cartItems: result.orderHints?.length ?? 0 },
      "payment_receipt intent — escalating to owner for payment verification",
    );
  }

  // ── create_order ──────────────────────────────────────────────────────────

  if (result.intent === "create_order") {
    if (!result.orderHints?.length) {
      escalate = true;
      logger.warn(
        { customerId, messageId },
        "create_order without orderHints — escalate forced",
      );
    } else {
      try {
        // Fetch catalog here — only needed for create_order resolution.
        // Previously fetched unconditionally before processMessage, causing
        // a wasted DB round-trip on every greet, search, and general message.
        const catalogForOrders = await ProductModel.find({ status: "active" })
          .select("name price")
          .lean();
        const catalog = catalogForOrders.map((p) => ({
          id: p._id.toString(),
          name: p.name,
          price: p.price,
        }));

        const resolvedItems = result.orderHints
          .map((hint) => {
            const product = findProductByHint(hint.productNameHint, catalog);
            if (!product) {
              logger.warn(
                { hint: hint.productNameHint, customerId, messageId },
                "Order hint unresolved — skipping item",
              );
              return null;
            }
            return {
              productId: product.id,
              size: hint.size,
              color: hint.color,
              quantity: hint.quantity,
              unitPrice: product.price,
            };
          })
          .filter((item): item is NonNullable<typeof item> => item !== null);

        if (resolvedItems.length === 0) {
          escalate = true;
          logger.warn(
            { customerId, messageId },
            "create_order had no resolvable items — escalate forced",
          );
        } else {
          const created = await createOrder(
            {
              customerId,
              channel: "whatsapp",
              items: resolvedItems,
              notes: [
                {
                  message: "Pedido creado automáticamente desde WhatsApp.",
                  kind: "system",
                },
              ],
            },
            null,
            messageId,
          );
          logger.info(
            { orderNumber: created.orderNumber, customerId, messageId },
            "Order created from WhatsApp",
          );
        }
      } catch (err) {
        escalate = true;
        logger.error(
          { err, customerId, from, messageId },
          "Failed to create order — escalate forced",
        );
      }
    }
  }

  // ── payment_info — auto-send bank account image ───────────────────────────
  // When Luis detects a payment/deposit question it returns intent "payment_info".
  // The system injects the bank account image into productImages so the existing
  // image pipeline (IF Has Product Images → Send Image) delivers it automatically.
  // No n8n changes needed — reuses the existing gallery pipeline.
  if (result.intent === "payment_info") {
    if (BANK_ACCOUNT_IMAGE_URL) {
      productImages.push({
        url: BANK_ACCOUNT_IMAGE_URL,
        caption: "Datos bancarios para tu depósito 🏦",
      });
      logger.info(
        { customerId, messageId },
        "payment_info — bank account image injected",
      );
    } else {
      // Image URL not configured — escalate so owner can send details manually.
      escalate = true;
      logger.warn(
        { customerId, messageId },
        "payment_info — BANK_ACCOUNT_IMAGE_URL not set, escalating to owner",
      );
    }
  }

  // ── Build escalation message ──────────────────────────────────────────────

  let escalationMessage: string | undefined;

  if (escalate) {
    logger.info({ customerId, from, messageId }, "Escalate flag set for n8n");

    const intent = result.intent;

    // payment_receipt: use the dedicated builder with structured cart.
    // Prefer Claude's orderHints (it already read the conversation history).
    // Fall back to extractCartFromHistory if Claude provided no orderHints.
    if (intent === "payment_receipt") {
      const cart = result.orderHints?.length
        ? orderHintsToCart(result.orderHints)
        : extractCartFromHistory(allTurns);
      escalationMessage = buildPaymentReceiptEscalation({
        customerPhone: from,
        customerName,
        cart,
      });
    } else {
      // All other escalation reasons use the general builder
      const searchHints = result.searchHints;
      let reason: string;
      let suggestedAction: string;
      let inventoryResult: string | undefined;

      if (intent === "needs_human") {
        reason =
          "El asistente detectó que la situación requiere una decisión humana.";
        suggestedAction =
          "Revisar el mensaje del cliente y responder directamente.";
      } else if (intent === "showroom_visit") {
        reason = "El cliente quiere visitar el showroom en persona.";
        suggestedAction =
          "Confirmar disponibilidad y preparar la visita. Contactar al cliente para acordar hora si es necesario.";
      } else if (intent === "payment_info") {
        reason =
          "El cliente preguntó por los datos de pago pero BANK_ACCOUNT_IMAGE_URL no está configurado en Railway.";
        suggestedAction =
          "Enviar los datos bancarios manualmente al cliente. Configurar BANK_ACCOUNT_IMAGE_URL en Railway → Server_Side_SALO → Variables para que el bot lo haga automáticamente en el futuro.";
      } else if (
        // Fallback receipt detection: catches edge cases where Claude misclassified
        // a payment text as a different intent but the message clearly references payment.
        // payment_receipt intent is handled above; this catches any remainder.
        /comprobante|transferencia|deposit[eé]|ya pagu[eé]|ya deposit[eé]|te mand[eé]/i.test(
          message,
        )
      ) {
        const cart = extractCartFromHistory(allTurns);
        reason =
          "El cliente posiblemente envió un comprobante de pago — pedido pendiente de confirmación.";
        suggestedAction =
          "Verificar la transferencia en tu cuenta bancaria y confirmar el pedido al cliente por WhatsApp. Preguntarle qué producto, talla y color quiere si no está claro.";
        escalationMessage = buildPaymentReceiptEscalation({
          customerPhone: from,
          customerName,
          cart,
        });
      } else if (intent === "product_search" && productImages.length === 0) {
        const keyword = searchHints?.keyword ?? "producto no especificado";
        const size = searchHints?.size;
        const color = searchHints?.color;
        inventoryResult = `No se encontraron productos disponibles que coincidan con "${keyword}"${color ? ` color ${color}` : ""}${size ? ` talla ${size}` : ""}.`;
        reason =
          "El bot no puede confirmar disponibilidad porque el producto no existe actualmente en inventario.";
        suggestedAction = `Responder con una alternativa disponible o confirmar si se puede conseguir "${keyword}"${color ? ` en ${color}` : ""} sobre pedido.`;
      } else if (intent === "create_order") {
        const items =
          result.orderHints
            ?.map(
              (h) => `${h.productNameHint} talla ${h.size} color ${h.color}`,
            )
            .join(", ") ?? "sin detalle";
        reason = `El pedido no pudo crearse automáticamente. Producto(s): ${items}. Posible causa: producto desactivado en catálogo o nombre no reconocido.`;
        suggestedAction =
          "Verificar que el producto está activo en el inventario SALO. Si está activo, crear el pedido manualmente desde la app.";
      } else {
        reason = `Escalación forzada por estado inesperado (intent: ${intent}).`;
        suggestedAction =
          "Revisar logs de Railway y responder al cliente manualmente.";
      }

      // Only build if not already set by the fallback receipt branch above
      if (!escalationMessage) {
        escalationMessage = buildEscalationMessage({
          customerPhone: from,
          customerName,
          customerMessage: message,
          intent,
          searchHints,
          orderHints: result.orderHints,
          inventoryResult,
          reason,
          suggestedAction,
        });
      }
    }
  }

  // ── Persist conversation ──────────────────────────────────────────────────

  // Normalize user content before storing — voice placeholder strings are
  // verbose and pollute Claude's context window when replayed as history.
  // Shorten to a compact form that still signals the message type.
  const storedUserContent = message.startsWith("[Nota de voz")
    ? "[Audio]"
    : message;

  // When product images are being sent, extract product data from captions and
  // append a structured summary to the assistant turn content.
  //
  // WHY: tool call results (names, prices, colors) are computed in the agentic
  // loop and passed to Claude but only Claude's final text response is persisted.
  // When the customer replies to a gallery image asking "cómo se llama" or
  // "cuánto cuesta", the history has "¡Sipi! Te muestro..." with no product data.
  //
  // The summary is APPENDED to the same assistant turn — NOT stored as a
  // separate turn. Storing it as a separate assistant turn causes two consecutive
  // assistant roles, which the Anthropic API rejects with 400, causing
  // SAFE_FALLBACK on every subsequent gallery reply.
  //
  // Caption format from searchProductsForClaude:
  //   "$1,990 — Jersey Alo Athletic Heather Grey (Alo)"  (first image of product)
  //   ""  (secondary images — no caption)
  // Filtering to non-empty captions gives one line per unique product.
  let storedAssistantContent = result.response;

  if (productImages.length > 0 && result.intent === "product_search") {
    const uniqueProducts = productImages
      .filter((img) => img.caption && img.caption.trim() !== "")
      .map((img) => img.caption!.trim());

    if (uniqueProducts.length > 0) {
      const productSummary =
        `\n\n[Productos enviados al cliente en este turn:\n` +
        uniqueProducts.map((p, i) => `${i + 1}. ${p}`).join("\n") +
        `\nEl cliente puede preguntar el nombre o precio de cualquiera de estos.]`;

      storedAssistantContent = result.response + productSummary;

      logger.info(
        { customerId, productsLogged: uniqueProducts.length },
        "Product summary appended to assistant turn for gallery reply resolution",
      );
    }
  }

  await ConversationModel.findOneAndUpdate(
    { customerId, channel: "whatsapp" },
    {
      $push: {
        turns: {
          $each: [
            {
              role: "user" as const,
              content: storedUserContent,
              createdAt: new Date(),
            },
            {
              role: "assistant" as const,
              content: storedAssistantContent,
              createdAt: new Date(),
            },
          ],
          $slice: -MAX_CONVERSATION_TURNS,
        },
      },
      $set: { lastMessageAt: new Date() },
    },
    { upsert: true, returnDocument: "after" },
  );

  logger.info(
    {
      customerId,
      intent: result.intent,
      historyTurns: conversationHistory.length,
      customerGender,
      messageId,
    },
    "Conversation turn persisted",
  );

  // ── Persist detected gender ───────────────────────────────────────────────
  // If Claude detected an explicit gender signal in this message (e.g. customer
  // said "soy el que te mandó mensaje" → male), update the customer record so
  // all future conversations start with the correct gender without re-detection.
  if (result.detectedGender && result.detectedGender !== customerGender) {
    await CustomerModel.updateOne(
      { _id: customer._id },
      { $set: { gender: result.detectedGender } },
    ).catch((err) => {
      logger.warn(
        { err, customerId },
        "Failed to persist detected customer gender — non-critical, will retry on next detection",
      );
    });
    logger.info(
      {
        customerId,
        previousGender: customerGender,
        detectedGender: result.detectedGender,
      },
      "Customer gender updated from conversation signal",
    );
  }

  // Guard: never return an empty reply with a valid customerPhone.
  // This combination causes the WhatsApp send node to fail with "text.body is required".
  // If result.response is somehow empty (should not happen after Zod validation),
  // use the gender-aware error reply as a safe fallback.
  const finalReply = result.response.trim() || buildErrorReply(customerGender);

  return toSafeResult(
    {
      reply: finalReply,
      escalate,
      customerPhone: from,
      customerName,
      productImages,
      escalationMessage,
    },
    from,
    customerName,
    customerGender,
  );
};
