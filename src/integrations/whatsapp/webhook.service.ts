import { CustomerModel } from '#/modules/customers/customer.model.js';
import { OrderModel } from '#/modules/orders/order.model.js';
import { ProductModel } from '#/modules/products/product.model.js';
import { InventoryModel } from '#/modules/inventory/inventory.model.js';
import {
  ConversationModel,
  MAX_CONVERSATION_TURNS,
} from '#/modules/conversations/conversation.model.js';
import { createOrder } from '#/modules/orders/order.service.js';
import { processMessage } from '#/integrations/whatsapp/claude.service.js';
import { searchProductsByImage } from '#/integrations/whatsapp/image-search.service.js';
import { CUSTOMER_GENDERS } from '#/modules/customers/customer.types.js';
import { logger } from '#/config/logger.js';
import { z } from 'zod';
import type { WebhookPayload } from '#/integrations/whatsapp/webhook.validation.js';
import type {
  ClaudeSearchHints,
  ProductSearchItem,
} from '#/integrations/whatsapp/claude.service.js';

// ─── Response schema ──────────────────────────────────────────────────────────

const productImageSchema = z.object({
  url:     z.string().url(),
  caption: z.string().optional(),
});

export type ProductImage = z.infer<typeof productImageSchema>;

const webhookResultSchema = z.object({
  reply:             z.string(),
  escalate:          z.boolean(),
  customerPhone:     z.string(),
  customerName:      z.string().nullable(),
  productImages:     z.array(productImageSchema),
  escalationMessage: z.string().optional(),
});

export type WebhookResult = z.infer<typeof webhookResultSchema>;

const EMPTY_RESULT: WebhookResult = {
  reply:         '',
  escalate:      false,
  customerPhone: '',
  customerName:  null,
  productImages: [],
};

function toSafeResult(
  raw: unknown,
  customerPhone = '',
  customerName: string | null = null,
): WebhookResult {
  const parsed = webhookResultSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues, raw },
      'WebhookResult failed schema validation — escalating instead of silent empty',
    );
    return {
      reply:             'Lo siento bonita, hubo un problema técnico. Alguien del equipo te contactará pronto 🙏🏻',
      escalate:          true,
      customerPhone,
      customerName,
      productImages:     [],
      escalationMessage: buildEscalationMessage({
        customerPhone,
        customerName,
        reason:          'Error interno de validación — el resultado del procesamiento no cumple el esquema esperado.',
        suggestedAction: 'Revisar logs de Railway para detalles del error. Responder al cliente manualmente.',
      }),
    };
  }
  return parsed.data;
}

// ─── Escalation message builder ───────────────────────────────────────────────

type EscalationContext = {
  customerPhone:    string;
  customerName?:    string | null;
  customerMessage?: string;
  intent?:          string;
  searchHints?:     { keyword?: string; size?: string; color?: string; gender?: string };
  orderHints?:      { productNameHint: string; size: string; color: string; quantity: number }[];
  inventoryResult?: string;
  reason:           string;
  suggestedAction:  string;
};

function buildEscalationMessage(ctx: EscalationContext): string {
  const lines: string[] = ['⚠️ Nueva solicitud requiere atención manual.', ''];

  lines.push(`Cliente: ${ctx.customerPhone}`);
  if (ctx.customerName) lines.push(`Nombre: ${ctx.customerName}`);
  if (ctx.customerMessage) lines.push(`Mensaje: "${ctx.customerMessage}"`);
  if (ctx.searchHints?.keyword) lines.push(`Producto solicitado: ${ctx.searchHints.keyword}`);
  if (ctx.searchHints?.color) lines.push(`Color solicitado: ${ctx.searchHints.color}`);
  if (ctx.searchHints?.size) lines.push(`Talla solicitada: ${ctx.searchHints.size}`);
  if (ctx.searchHints?.gender && ctx.searchHints.gender !== 'unknown') {
    lines.push(`Género: ${ctx.searchHints.gender === 'female' ? 'mujer' : 'hombre'}`);
  }
  if (ctx.orderHints?.length) {
    const items = ctx.orderHints
      .map((h) => `${h.productNameHint} talla ${h.size} color ${h.color} x${h.quantity}`)
      .join(', ');
    lines.push(`Producto(s) para pedido: ${items}`);
  }
  if (ctx.inventoryResult) lines.push(`Resultado de inventario: ${ctx.inventoryResult}`);
  if (ctx.intent) lines.push(`Intención detectada: ${ctx.intent}`);

  lines.push('');
  lines.push(`Motivo de escalación: ${ctx.reason}`);
  lines.push(`Acción sugerida: ${ctx.suggestedAction}`);

  return lines.join('\n');
}

// ─── Integration boundary schemas ─────────────────────────────────────────────

const processMessageResultSchema = z.object({
  intent: z.enum([
    'catalog_query',
    'product_search',
    'price_query',
    'create_order',
    'order_status',
    'needs_human',
    'general',
  ]),
  response:      z.string().min(1),
  searchHints: z
    .object({
      keyword: z.string().min(1),
      gender:  z.enum(['female', 'male', 'unknown']).optional(),
      size:    z.string().optional(),
      color:   z.string().optional(),
    })
    .optional(),
  orderHints: z
    .array(
      z.object({
        productNameHint: z.string().min(1),
        size:            z.string().min(1),
        color:           z.string().min(1),
        quantity:        z.number().int().positive(),
      }),
    )
    .optional(),
  productImages: z.array(productImageSchema),
});

type ProcessMessageResult = z.infer<typeof processMessageResultSchema>;

const imageSearchResultSchema = z.object({
  reply:         z.string().min(1),
  productImages: z.array(z.unknown()).default([]),
});

// ─── Business info ────────────────────────────────────────────────────────────

const BUSINESS_INFO = {
  showroomAddress: 'Av. Guadalupe 1390, Chapalita Oriente, Guadalajara, Jalisco',
  businessHours:
    'Lunes a Viernes 10:00am–8:30pm · Sábados 11:00am–7:00pm · Domingos cerrado',
  shippingPrice:  179,
  paymentMethods:
    'Transferencia bancaria, depósito o tarjeta de crédito/débito. No se acepta efectivo en pedidos sobre pedido.',
  depositPercent: 30,
  paymentDays:    20,
} as const;

// ─── Image message idempotency ────────────────────────────────────────────────

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
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\D+/g, '');
}

function findProductByHint(
  hint: string,
  catalog: { id: string; name: string; price: number }[],
): { id: string; name: string; price: number } | null {
  const normalized = hint.toLowerCase().trim();
  return (
    catalog.find((p) => p.name.toLowerCase().includes(normalized)) ??
    catalog.find((p) => normalized.includes(p.name.toLowerCase())) ??
    null
  );
}

function toValidUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try { new URL(trimmed); return trimmed; } catch { return undefined; }
}

function normalizeProductImages(value: unknown): ProductImage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => { const url = toValidUrl(item); return url ? { url } : undefined; })
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

async function searchProductsForClaude(hints: ClaudeSearchHints): Promise<ProductSearchItem[]> {
  const keyword = hints.keyword.toLowerCase().trim();

  // Step 1: Match products by keyword, brand, category, or subcategory.
  // Gender normalization: DB stores 'women'/'men' (Shopify), Claude sends 'female'/'male'.
  const productFilter: Record<string, unknown> = { status: 'active' };

  if (hints.gender && hints.gender !== 'unknown') {
    const dbGender = hints.gender === 'female' ? 'women' : 'men';
    productFilter.gender = dbGender;
  }

  const products = await ProductModel.find(productFilter)
    .select('name price brand gender categoryGroup subcategory images')
    .lean();

  const matchingProducts = products.filter((p) => {
    const searchableFields = [
      p.name,
      p.brand,
      p.categoryGroup ?? '',
      p.subcategory ?? '',
    ].map((f) => f.toLowerCase());
    return searchableFields.some((f) => f.includes(keyword));
  });

  if (matchingProducts.length === 0) return [];

  const matchingProductIds = matchingProducts.map((p) => p._id);

  // Step 2: Query inventory for in-stock variants of matching products.
  // Filter by size and color at the DB level so we don't return zero-stock rows.
  const inventoryFilter: Record<string, unknown> = {
    productId: { $in: matchingProductIds },
    quantity:  { $gt: 0 },
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
      $options: 'i',
    };
  }

  const inStockInventory = await InventoryModel.find(inventoryFilter)
    .select('productId size color quantity')
    .lean();

  if (inStockInventory.length === 0) return [];

  // Step 3: Build a product lookup map for fast joining
  const productMap = new Map(
    matchingProducts.map((p) => [p._id.toString(), p]),
  );

  // Step 4: Return one ProductSearchItem per in-stock variant.
  // Caption format: price first (matches real Luis sales pattern), then name, color, brand.
  // One image per product — images live at product level, not variant level.
  const results: ProductSearchItem[] = [];

  for (const inv of inStockInventory) {
    const product = productMap.get(inv.productId.toString());
    if (!product) continue;

    const imageUrl = toValidUrl(product.images?.[0]);

    // Human-readable color: capitalize first letter of each word for display
    const displayColor = inv.color
      .split(' ')
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    const caption = `$${product.price.toLocaleString('es-MX')} — ${product.name} ${displayColor} (${product.brand})`;

    results.push({
      name:          product.name,
      brand:         product.brand,
      price:         product.price,
      color:         displayColor,
      imageUrl,
      imageCaption:  caption,
    });
  }

  logger.info(
    {
      keyword,
      gender:           hints.gender,
      size:             hints.size,
      color:            hints.color,
      productMatches:   matchingProducts.length,
      inventoryMatches: inStockInventory.length,
      returned:         results.length,
    },
    'searchProductsForClaude — query complete',
  );

  return results;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const handleIncomingMessage = async (
  payload: WebhookPayload,
): Promise<WebhookResult> => {
  const rawFrom     = payload.from;
  const from        = normalizePhoneForLookup(rawFrom);
  const messageType = payload.messageType;
  const message     = typeof payload.message === 'string' ? payload.message.trim() : '';
  const messageId   =
    typeof payload.messageId === 'string' && payload.messageId.trim()
      ? payload.messageId.trim()
      : null;

  // ── 0. Guards ─────────────────────────────────────────────────────────────

  if (!from) {
    logger.info(
      { rawFrom: payload.from, messageType: payload.messageType, messageId: payload.messageId },
      'Ignoring non-message webhook event — empty or invalid from field after normalization',
    );
    return EMPTY_RESULT;
  }

  if (rawFrom && rawFrom !== from) {
    logger.info({ rawFrom, normalizedFrom: from, messageId }, 'Normalized WhatsApp phone number');
  }

  if (messageType && messageType !== 'text' && messageType !== 'image') {
    logger.info({ from, messageType, messageId }, 'Ignoring unsupported WhatsApp message type');
    return EMPTY_RESULT;
  }

  if (messageType === 'image' && !payload.imageMediaId) {
    logger.info({ from, messageId }, 'Ignoring image webhook event without imageMediaId');
    return EMPTY_RESULT;
  }

  if ((messageType === 'text' || !messageType) && !message) {
    logger.info({ from, messageId, messageType }, 'Ignoring empty text-like WhatsApp event');
    return EMPTY_RESULT;
  }

  // ── 1. Identify / create customer ─────────────────────────────────────────

  const customer = await CustomerModel.findOneAndUpdate(
    { phone: from },
    {
      $setOnInsert: {
        name:           payload.contactName ?? `WhatsApp ${from}`,
        phone:          from,
        contactChannel: 'whatsapp',
        gender:         CUSTOMER_GENDERS.UNKNOWN,
        isActive:       true,
        tags:           [],
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  if (!customer) {
    logger.error({ phone: from }, 'Customer upsert returned null — unexpected');
    return toSafeResult(EMPTY_RESULT, from);
  }

  if (payload.contactName && customer.name === `WhatsApp ${from}`) {
    await CustomerModel.updateOne(
      { _id: customer._id },
      { $set: { name: payload.contactName } },
    );
    customer.name = payload.contactName;
    logger.info({ customerId: customer._id.toString(), from }, 'Updated customer placeholder name');
  }

  const customerId     = customer._id.toString();
  const customerName   = customer.name !== `WhatsApp ${from}` ? customer.name : null;
  const customerGender = (customer.gender ?? CUSTOMER_GENDERS.UNKNOWN) as 'female' | 'male' | 'unknown';

  // ── 2. Image message ──────────────────────────────────────────────────────

  if (messageType === 'image') {
    if (messageId && !trackImageMessageId(messageId)) {
      logger.info({ from, messageId, customerId }, 'Duplicate image messageId — skipping');
      return EMPTY_RESULT;
    }

    logger.info({ customerId, mediaId: payload.imageMediaId, messageId }, 'Image message — running visual search');

    const fallbackReply = 'Ahorita te confirmo eso bonita, dame un momento 🙏🏻';

    try {
      const rawSearchResult = await searchProductsByImage(payload.imageMediaId!);
      const searchResult    = imageSearchResultSchema.safeParse(rawSearchResult);
      if (!searchResult.success) {
        throw new Error(`searchProductsByImage returned unexpected shape: ${JSON.stringify(searchResult.error.issues)}`);
      }

      const { reply, productImages: rawProductImages } = searchResult.data;
      const productImages = normalizeProductImages(rawProductImages);

      await ConversationModel.findOneAndUpdate(
        { customerId, channel: 'whatsapp' },
        {
          $push: { turns: { $each: [
            { role: 'user' as const,      content: '[Imagen enviada por el cliente]', createdAt: new Date() },
            { role: 'assistant' as const, content: reply,                             createdAt: new Date() },
          ], $slice: -MAX_CONVERSATION_TURNS } },
          $set: { lastMessageAt: new Date() },
        },
        { upsert: true, new: true },
      );

      return toSafeResult(
        { reply, escalate: false, customerPhone: from, customerName, productImages },
        from, customerName,
      );
    } catch (err) {
      logger.error({ err, customerId, mediaId: payload.imageMediaId, messageId }, 'Image search failed');

      await ConversationModel.findOneAndUpdate(
        { customerId, channel: 'whatsapp' },
        {
          $push: { turns: { $each: [
            { role: 'user' as const,      content: '[Imagen enviada por el cliente]', createdAt: new Date() },
            { role: 'assistant' as const, content: fallbackReply,                     createdAt: new Date() },
          ], $slice: -MAX_CONVERSATION_TURNS } },
          $set: { lastMessageAt: new Date() },
        },
        { upsert: true, new: true },
      );

      return toSafeResult(
        {
          reply:         fallbackReply,
          escalate:      true,
          customerPhone: from,
          customerName,
          productImages: [],
          escalationMessage: buildEscalationMessage({
            customerPhone: from,
            customerName,
            customerMessage:  '[Imagen enviada por el cliente]',
            reason:           'La búsqueda visual por imagen falló con un error interno.',
            suggestedAction:  'Revisar logs de Railway. Responder al cliente manualmente con productos similares a la imagen enviada.',
          }),
        },
        from, customerName,
      );
    }
  }

  // ── 3. Text message — Luis flow ───────────────────────────────────────────

  const conversation = await ConversationModel.findOne({ customerId, channel: 'whatsapp' }).lean();
  const conversationHistory = (conversation?.turns ?? []).map((t) => ({
    role:    t.role as 'user' | 'assistant',
    content: t.content,
  }));

  const recentOrder = await OrderModel.findOne({ customerId }).sort({ createdAt: -1 }).lean();

  // Minimal catalog for create_order resolution only — heavy fields deferred to searchProductsForClaude
  const catalogForOrders = await ProductModel.find({ status: 'active' }).select('name price').lean();
  const catalog = catalogForOrders.map((p) => ({ id: p._id.toString(), name: p.name, price: p.price }));

  const rawResult = await processMessage({
    customerName,
    customerGender,
    recentOrder: recentOrder
      ? { orderNumber: recentOrder.orderNumber, status: recentOrder.status, total: recentOrder.total }
      : null,
    searchProducts:  searchProductsForClaude,
    incomingMessage: message,
    conversationHistory,
    businessInfo: BUSINESS_INFO,
  });

  const parsedResult = processMessageResultSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    logger.error(
      { issues: parsedResult.error.issues, rawResult, customerId, messageId },
      'processMessage returned unexpected shape — escalating',
    );
    return toSafeResult(
      {
        reply:         'Lo siento bonita, hubo un error procesando tu mensaje. Alguien del equipo te contactará pronto 🙏🏻',
        escalate:      true,
        customerPhone: from,
        customerName,
        productImages: [],
        escalationMessage: buildEscalationMessage({
          customerPhone: from, customerName, customerMessage: message,
          reason:          'Error interno — la respuesta del modelo no cumple el esquema esperado.',
          suggestedAction: 'Revisar logs de Railway. Responder al cliente manualmente.',
        }),
      },
      from, customerName,
    );
  }

  const result: ProcessMessageResult = parsedResult.data;
  let escalate = result.intent === 'needs_human';
  const productImages: ProductImage[] = result.productImages;

  if (result.intent === 'product_search') {
    logger.info({ matches: productImages.length, customerId, messageId }, 'Product search intent');
    if (productImages.length === 0 && result.searchHints) {
      escalate = true;
      logger.info({ customerId, messageId, searchHints: result.searchHints }, 'Product search 0 results — escalating');
    }
  }

  // ── create_order ──────────────────────────────────────────────────────────

  if (result.intent === 'create_order') {
    if (!result.orderHints?.length) {
      escalate = true;
      logger.warn({ customerId, messageId }, 'create_order without orderHints — escalate forced');
    } else {
      try {
        const resolvedItems = result.orderHints
          .map((hint) => {
            const product = findProductByHint(hint.productNameHint, catalog);
            if (!product) {
              logger.warn({ hint: hint.productNameHint, customerId, messageId }, 'Order hint unresolved — skipping item');
              return null;
            }
            return {
              productId: product.id,
              size:      hint.size,
              color:     hint.color,
              quantity:  hint.quantity,
              unitPrice: product.price,
            };
          })
          .filter((item): item is NonNullable<typeof item> => item !== null);

        if (resolvedItems.length === 0) {
          escalate = true;
          logger.warn({ customerId, messageId }, 'create_order had no resolvable items — escalate forced');
        } else {
          const created = await createOrder(
            {
              customerId,
              channel: 'whatsapp',
              items:   resolvedItems,
              notes:   [{ message: 'Pedido creado automáticamente desde WhatsApp.', kind: 'system' }],
            },
            null,
            messageId,
          );
          logger.info({ orderNumber: created.orderNumber, customerId, messageId }, 'Order created from WhatsApp');
        }
      } catch (err) {
        escalate = true;
        logger.error({ err, customerId, from, messageId }, 'Failed to create order — escalate forced');
      }
    }
  }

  // ── Build escalation message ──────────────────────────────────────────────

  let escalationMessage: string | undefined;

  if (escalate) {
    logger.info({ customerId, from, messageId }, 'Escalate flag set for n8n');

    const searchHints = result.searchHints;
    const intent      = result.intent;
    let reason: string;
    let suggestedAction: string;
    let inventoryResult: string | undefined;

    if (intent === 'needs_human') {
      reason          = 'El asistente detectó que la situación requiere una decisión humana.';
      suggestedAction = 'Revisar el mensaje del cliente y responder directamente.';
    } else if (intent === 'product_search' && productImages.length === 0) {
      const keyword = searchHints?.keyword ?? 'producto no especificado';
      const size    = searchHints?.size;
      const color   = searchHints?.color;
      inventoryResult = `No se encontraron productos disponibles que coincidan con "${keyword}"${color ? ` color ${color}` : ''}${size ? ` talla ${size}` : ''}.`;
      reason          = 'El bot no puede confirmar disponibilidad porque el producto no existe actualmente en inventario.';
      suggestedAction = `Responder con una alternativa disponible o confirmar si se puede conseguir "${keyword}"${color ? ` en ${color}` : ''} sobre pedido.`;
    } else if (intent === 'create_order') {
      const items = result.orderHints?.map((h) => `${h.productNameHint} talla ${h.size} color ${h.color}`).join(', ') ?? 'sin detalle';
      reason          = `El pedido no pudo crearse automáticamente. Productos: ${items}.`;
      suggestedAction = 'Verificar disponibilidad y crear el pedido manualmente si corresponde.';
    } else {
      reason          = `Escalación forzada por estado inesperado (intent: ${intent}).`;
      suggestedAction = 'Revisar logs de Railway y responder al cliente manualmente.';
    }

    escalationMessage = buildEscalationMessage({
      customerPhone: from, customerName, customerMessage: message,
      intent, searchHints, orderHints: result.orderHints, inventoryResult, reason, suggestedAction,
    });
  }

  // ── Persist conversation ──────────────────────────────────────────────────

  await ConversationModel.findOneAndUpdate(
    { customerId, channel: 'whatsapp' },
    {
      $push: { turns: { $each: [
        { role: 'user' as const,      content: message,         createdAt: new Date() },
        { role: 'assistant' as const, content: result.response, createdAt: new Date() },
      ], $slice: -MAX_CONVERSATION_TURNS } },
      $set: { lastMessageAt: new Date() },
    },
    { upsert: true, new: true },
  );

  logger.info(
    { customerId, intent: result.intent, historyTurns: conversationHistory.length, customerGender, messageId },
    'Conversation turn persisted',
  );

  return toSafeResult(
    { reply: result.response, escalate, customerPhone: from, customerName, productImages, escalationMessage },
    from, customerName,
  );
};