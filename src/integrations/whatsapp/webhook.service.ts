import { CustomerModel } from '#/modules/customers/customer.model.js';
import { OrderModel } from '#/modules/orders/order.model.js';
import { ProductModel } from '#/modules/products/product.model.js';
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
import type { ClaudeSearchHints } from '#/integrations/whatsapp/claude.service.js';

// ─── Response schema ──────────────────────────────────────────────────────────

// productImages is an array of objects so n8n can access {{ $json.productImages.url }}
// and {{ $json.productImages.caption }} after Split Out.
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
});

export type WebhookResult = z.infer<typeof webhookResultSchema>;

const EMPTY_RESULT: WebhookResult = {
  reply: '',
  escalate: false,
  customerPhone: '',
  customerName: null,
  productImages: [],
};

// When outbound result validation fails, return a visible escalation instead of
// silent empty. This turns correctness failures into owner alerts rather than
// "Luis just went quiet" incidents that are hard to diagnose in production.
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
      reply: 'Lo siento bonita, hubo un problema técnico. Alguien del equipo te contactará pronto 🙏🏻',
      escalate: true,
      customerPhone,
      customerName,
      productImages: [],
    };
  }
  return parsed.data;
}

// ─── Integration boundary schemas ─────────────────────────────────────────────
// Validates what external services return before their data enters business logic.
// The LLM integration and the image search service are the least stable
// boundaries in the system — a prompt change, model update, or service refactor
// can silently change return shapes. Catching that here prevents undefined
// values from propagating into order creation and product search paths.

const processMessageResultSchema = z.object({
  intent: z.enum(['product_search', 'create_order', 'needs_human', 'general']),
  response: z.string().min(1),
  searchHints: z
    .object({
      keyword: z.string().min(1),
      gender: z.enum(['female', 'male', 'unknown']).optional(),
    })
    .optional(),
  orderHints: z
    .array(
      z.object({
        productNameHint: z.string().min(1),
        size: z.string().optional(),
        color: z.string().optional(),
        quantity: z.number().int().positive(),
      }),
    )
    .optional(),
});

type ProcessMessageResult = z.infer<typeof processMessageResultSchema>;

const imageSearchResultSchema = z.object({
  reply: z.string().min(1),
  // productImages are raw values — URL normalization happens downstream
  productImages: z.array(z.unknown()).default([]),
});

// ─── Business info ────────────────────────────────────────────────────────────
// TODO: Move to a validated env/config or settings collection so business
// changes (hours, address, prices) do not require a code release.

const BUSINESS_INFO = {
  showroomAddress: 'Av. Guadalupe 1390, Chapalita Oriente, Guadalajara, Jalisco',
  businessHours:
    'Lunes a Viernes 10:00am–8:30pm · Sábados 11:00am–7:00pm · Domingos cerrado',
  shippingPrice: 179,
  paymentMethods:
    'Transferencia bancaria, depósito o tarjeta de crédito/débito. No se acepta efectivo en pedidos sobre pedido.',
  depositPercent: 30,
  paymentDays: 20,
} as const;

// ─── Image message idempotency ────────────────────────────────────────────────
// The buffer/claim system deduplicates text messages via executionId ownership.
// Image messages bypass the buffer and go directly to searchProductsByImage, so
// a duplicate webhook delivery from Meta would rerun the search, append
// duplicate conversation turns, and potentially send duplicate replies.
//
// This in-memory set provides a 5-minute dedup window keyed by messageId.
// Acceptable for single-process Railway deployment. Replace with a Redis-backed
// key if the service scales horizontally.

const recentImageMessageIds = new Set<string>();
const IMAGE_DEDUP_WINDOW_MS = 5 * 60 * 1000;

function trackImageMessageId(id: string): boolean {
  if (recentImageMessageIds.has(id)) return false; // duplicate — skip
  recentImageMessageIds.add(id);
  setTimeout(() => recentImageMessageIds.delete(id), IMAGE_DEDUP_WINDOW_MS);
  return true; // new — proceed
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
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    return undefined;
  }
}

// Converts raw image search results into ProductImage objects.
// Caption is omitted — there is no product context available in image search results.
function normalizeProductImages(value: unknown): ProductImage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const url = toValidUrl(item);
      if (!url) return undefined;
      return { url } satisfies ProductImage;
    })
    .filter((img): img is ProductImage => Boolean(img));
}

// Returns the first valid image per matched product as a ProductImage with caption.
// One image per product is intentional — multiple angles would flood the chat.
//
// TODO: This keyword filter is a temporary heuristic. Once the search_products
// tool use is introduced in claude.service.ts, product retrieval becomes
// demand-driven from Claude tool calls and this function should be removed.
function filterProductsBySearchHints(
  products: {
    _id: { toString(): string };
    name: string;
    brand: string;
    price: number;
    gender?: string;
    categoryGroup?: string;
    subcategory?: string;
    images?: unknown;
  }[],
  hints: ClaudeSearchHints,
): ProductImage[] {
  const keyword = hints.keyword.toLowerCase().trim();

  const matched = products.filter((p) => {
    const fields = [p.name, p.brand, p.categoryGroup ?? '', p.subcategory ?? ''].map((f) =>
      f.toLowerCase(),
    );

    const keywordMatch = fields.some((f) => f.includes(keyword));
    if (!keywordMatch) return false;

    if (hints.gender && hints.gender !== 'unknown' && p.gender) {
      if (p.gender !== hints.gender) return false;
    }

    return true;
  });

  return matched.flatMap((p) => {
    const images = p.images;
    if (!Array.isArray(images)) return [];
    const url = toValidUrl(images[0]);
    if (!url) return [];
    const caption = `${p.name} — ${p.brand} $${p.price.toLocaleString('es-MX')}`;
    return [{ url, caption } satisfies ProductImage];
  });
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const handleIncomingMessage = async (
  payload: WebhookPayload,
): Promise<WebhookResult> => {
  const rawFrom = payload.from;
  const from = normalizePhoneForLookup(rawFrom);
  const messageType = payload.messageType;
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  const messageId =
    typeof payload.messageId === 'string' && payload.messageId.trim()
      ? payload.messageId.trim()
      : null;

  // ── 0. Guards — drop malformed and unsupported events early ──────────────

  if (!from) {
    logger.info(
      {
        rawFrom: payload.from,
        messageType: payload.messageType,
        messageId: payload.messageId,
      },
      'Ignoring non-message webhook event — empty or invalid from field after normalization',
    );
    return EMPTY_RESULT;
  }

  if (rawFrom && rawFrom !== from) {
    logger.info(
      { rawFrom, normalizedFrom: from, messageId },
      'Normalized WhatsApp phone number for customer lookup',
    );
  }

  if (messageType && messageType !== 'text' && messageType !== 'image') {
    logger.info(
      { from, messageType, messageId },
      'Ignoring unsupported WhatsApp message type',
    );
    return EMPTY_RESULT;
  }

  if (messageType === 'image' && !payload.imageMediaId) {
    logger.info({ from, messageId }, 'Ignoring image webhook event without imageMediaId');
    return EMPTY_RESULT;
  }

  if ((messageType === 'text' || !messageType) && !message) {
    logger.info(
      { from, messageId, messageType },
      'Ignoring empty text-like WhatsApp event',
    );
    return EMPTY_RESULT;
  }

  // ── 1. Identify / create customer ─────────────────────────────────────────
  // Atomic upsert prevents the race where two concurrent executions for a
  // brand-new customer both attempt create().
  const customer = await CustomerModel.findOneAndUpdate(
    { phone: from },
    {
      $setOnInsert: {
        name: payload.contactName ?? `WhatsApp ${from}`,
        phone: from,
        contactChannel: 'whatsapp',
        gender: CUSTOMER_GENDERS.UNKNOWN,
        isActive: true,
        tags: [],
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  if (!customer) {
    logger.error({ phone: from }, 'Customer upsert returned null — unexpected');
    return toSafeResult(EMPTY_RESULT, from);
  }

  if (customer.isActive === false) {
    logger.warn(
      { customerId: customer._id.toString(), phone: from },
      'Inactive customer record reused for WhatsApp message',
    );
  }

  // ── 1a. Refresh placeholder names ─────────────────────────────────────────
  // $setOnInsert only writes the name on first creation. If a customer was
  // created without a contactName, their record stays as "WhatsApp {from}"
  // indefinitely, degrading personalization. This targeted update refreshes the
  // name only when the stored value is still the system placeholder and a real
  // name arrives. It will not overwrite a name manually corrected in the CRM.
  if (payload.contactName && customer.name === `WhatsApp ${from}`) {
    await CustomerModel.updateOne(
      { _id: customer._id },
      { $set: { name: payload.contactName } },
    );
    customer.name = payload.contactName;
    logger.info(
      { customerId: customer._id.toString(), from },
      'Updated customer placeholder name from incoming contactName',
    );
  }

  const customerId = customer._id.toString();
  const customerName = customer.name !== `WhatsApp ${from}` ? customer.name : null;
  const customerGender = (customer.gender ?? CUSTOMER_GENDERS.UNKNOWN) as
    | 'female'
    | 'male'
    | 'unknown';

  // ── 2. Image message — search inventory by visual similarity ─────────────

  if (messageType === 'image') {
    // Deduplicate image messages before processing. Meta can deliver the same
    // webhook event more than once. The text path is protected by the
    // buffer/claim system. The image path is not — without this guard a
    // duplicate delivery reruns the image search, appends duplicate turns,
    // and may send duplicate replies to the customer.
    if (messageId && !trackImageMessageId(messageId)) {
      logger.info(
        { from, messageId, customerId },
        'Duplicate image messageId — skipping reprocessing',
      );
      return EMPTY_RESULT;
    }

    logger.info(
      { customerId, mediaId: payload.imageMediaId, messageId },
      'Image message received — running visual search',
    );

    const fallbackReply = 'Ahorita te confirmo eso bonita, dame un momento 🙏🏻';

    try {
      const rawSearchResult = await searchProductsByImage(payload.imageMediaId!);

      // Validate the external service response at the boundary before use.
      const searchResult = imageSearchResultSchema.safeParse(rawSearchResult);
      if (!searchResult.success) {
        throw new Error(
          `searchProductsByImage returned unexpected shape: ${JSON.stringify(searchResult.error.issues)}`,
        );
      }

      const { reply, productImages: rawProductImages } = searchResult.data;
      const productImages = normalizeProductImages(rawProductImages);

      if (rawProductImages.length > 0 && productImages.length === 0) {
        logger.warn(
          { customerId, messageId },
          'Image search returned productImages but none were valid absolute URLs',
        );
      }

      const imageTurns = [
        {
          role: 'user' as const,
          content: '[Imagen enviada por el cliente]',
          createdAt: new Date(),
        },
        {
          role: 'assistant' as const,
          content: reply,
          createdAt: new Date(),
        },
      ];

      await ConversationModel.findOneAndUpdate(
        { customerId, channel: 'whatsapp' },
        {
          $push: { turns: { $each: imageTurns, $slice: -MAX_CONVERSATION_TURNS } },
          $set: { lastMessageAt: new Date() },
        },
        { upsert: true, new: true },
      );

      return toSafeResult(
        { reply, escalate: false, customerPhone: from, customerName, productImages },
        from,
        customerName,
      );
    } catch (err) {
      logger.error(
        { err, customerId, mediaId: payload.imageMediaId, messageId },
        'Image search failed — returning fallback response and forcing escalation',
      );

      const fallbackTurns = [
        {
          role: 'user' as const,
          content: '[Imagen enviada por el cliente]',
          createdAt: new Date(),
        },
        {
          role: 'assistant' as const,
          content: fallbackReply,
          createdAt: new Date(),
        },
      ];

      await ConversationModel.findOneAndUpdate(
        { customerId, channel: 'whatsapp' },
        {
          $push: { turns: { $each: fallbackTurns, $slice: -MAX_CONVERSATION_TURNS } },
          $set: { lastMessageAt: new Date() },
        },
        { upsert: true, new: true },
      );

      return toSafeResult(
        {
          reply: fallbackReply,
          escalate: true,
          customerPhone: from,
          customerName,
          productImages: [],
        },
        from,
        customerName,
      );
    }
  }

  // ── 3. Text message — Luis flow ───────────────────────────────────────────

  const conversation = await ConversationModel.findOne({
    customerId,
    channel: 'whatsapp',
  }).lean();

  const conversationHistory = (conversation?.turns ?? []).map((t) => ({
    role: t.role as 'user' | 'assistant',
    content: t.content,
  }));

  const recentOrder = await OrderModel.findOne({ customerId }).sort({ createdAt: -1 }).lean();

  // TODO: This full catalog load runs on every text message and will become the
  // primary latency and token cost problem as inventory grows. Remove this block
  // when search_products tool use is introduced in claude.service.ts and product
  // retrieval becomes demand-driven from Claude tool calls instead of preloaded.
  const products = await ProductModel.find({ status: 'active' })
    .select('name price brand gender categoryGroup subcategory images')
    .lean();

  const catalog = products.map((p) => ({
    id: p._id.toString(),
    name: p.name,
    price: p.price,
    brand: p.brand,
  }));

  const rawResult = await processMessage({
    customerName,
    customerGender,
    recentOrder: recentOrder
      ? {
          orderNumber: recentOrder.orderNumber,
          status: recentOrder.status,
          total: recentOrder.total,
        }
      : null,
    catalog,
    incomingMessage: message,
    conversationHistory,
    businessInfo: BUSINESS_INFO,
  });

  // Validate processMessage result at the integration boundary.
  // A prompt change, model update, or parsing bug can silently change the output
  // shape. Catching it here prevents undefined values from reaching order
  // creation and product search logic below.
  const parsedResult = processMessageResultSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    logger.error(
      { issues: parsedResult.error.issues, rawResult, customerId, messageId },
      'processMessage returned unexpected shape — escalating',
    );
    return toSafeResult(
      {
        reply: 'Lo siento bonita, hubo un error procesando tu mensaje. Alguien del equipo te contactará pronto 🙏🏻',
        escalate: true,
        customerPhone: from,
        customerName,
        productImages: [],
      },
      from,
      customerName,
    );
  }

  const result: ProcessMessageResult = parsedResult.data;

  let escalate = result.intent === 'needs_human';
  let productImages: ProductImage[] = [];

  // ── Resolve product images ────────────────────────────────────────────────
  if (result.intent === 'product_search' && result.searchHints) {
    productImages = filterProductsBySearchHints(products, result.searchHints);
    logger.info(
      { keyword: result.searchHints.keyword, matches: productImages.length },
      'Product search — returning matched images',
    );
  }

  // ── Handle create_order intent ────────────────────────────────────────────
  // NOTE: Order creation from a fuzzy product name hint is a known weakness.
  // The correct long-term design is a two-step confirmation flow: Luis presents
  // the resolved order, customer confirms, then the order is committed. This
  // requires conversation state tracking and n8n workflow changes — tracked as
  // a follow-up task before high-volume production use.
  //
  // createOrder is idempotent via sourceMessageId — duplicate executions are
  // resolved transparently inside order.service.ts.
  if (result.intent === 'create_order') {
    if (!result.orderHints?.length) {
      escalate = true;
      logger.warn(
        { customerId, messageId },
        'create_order intent returned without usable orderHints — escalate forced',
      );
    } else {
      try {
        const resolvedItems = result.orderHints
          .map((hint) => {
            const product = findProductByHint(hint.productNameHint, catalog);
            if (!product) {
              logger.warn(
                { hint: hint.productNameHint, customerId, messageId },
                'Order hint did not match any catalog product — skipping item',
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
            'create_order intent had no resolvable items — escalate forced',
          );
        } else {
          const created = await createOrder(
            {
              customerId,
              channel: 'whatsapp',
              items: resolvedItems,
              notes: [{ message: 'Pedido creado automáticamente desde WhatsApp.', kind: 'system' }],
            },
            null,
            messageId,
          );

          logger.info(
            { orderNumber: created.orderNumber, customerId, messageId },
            messageId
              ? 'Order created from WhatsApp via sourceMessageId idempotency'
              : 'Order created from WhatsApp without sourceMessageId',
          );
        }
      } catch (err) {
        escalate = true;
        logger.error(
          { err, customerId, from, messageId },
          'Failed to create order from WhatsApp message — escalate forced',
        );
      }
    }
  }

  if (escalate) {
    logger.info({ customerId, from, messageId }, 'Escalate flag set for n8n');
  }

  // ── Persist conversation after all business effects are resolved ──────────
  const newTurns = [
    { role: 'user' as const, content: message, createdAt: new Date() },
    { role: 'assistant' as const, content: result.response, createdAt: new Date() },
  ];

  await ConversationModel.findOneAndUpdate(
    { customerId, channel: 'whatsapp' },
    {
      $push: { turns: { $each: newTurns, $slice: -MAX_CONVERSATION_TURNS } },
      $set: { lastMessageAt: new Date() },
    },
    { upsert: true, new: true },
  );

  logger.info(
    {
      customerId,
      intent: result.intent,
      historyTurns: conversationHistory.length,
      customerGender,
      messageId,
    },
    'Conversation turn persisted',
  );

  return toSafeResult(
    {
      reply: result.response,
      escalate,
      customerPhone: from,
      customerName,
      productImages,
    },
    from,
    customerName,
  );
};