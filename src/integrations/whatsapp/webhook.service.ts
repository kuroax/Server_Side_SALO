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
// Single source of truth for what this service returns to n8n.
// Every return path is validated through toSafeResult() — no raw returns.

const webhookResultSchema = z.object({
  reply:         z.string(),
  escalate:      z.boolean(),
  customerPhone: z.string(),
  customerName:  z.string().nullable(),
  productImages: z.array(z.string().url()),
});

export type WebhookResult = z.infer<typeof webhookResultSchema>;

const EMPTY_RESULT: WebhookResult = {
  reply:         '',
  escalate:      false,
  customerPhone: '',
  customerName:  null,
  productImages: [],
};

// Validates the result shape before returning to n8n.
// If validation fails (should never happen), logs and returns a safe empty
// result rather than letting a malformed payload reach n8n's IF nodes.
function toSafeResult(raw: unknown): WebhookResult {
  const parsed = webhookResultSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues, raw },
      'WebhookResult failed schema validation — returning empty result',
    );
    return EMPTY_RESULT;
  }
  return parsed.data;
}

// ─── Business info ────────────────────────────────────────────────────────────

const BUSINESS_INFO = {
  showroomAddress: 'Av. Guadalupe 1390, Chapalita Oriente, Guadalajara, Jalisco',
  businessHours:   'Lunes a Viernes 10:00am–8:30pm · Sábados 11:00am–7:00pm · Domingos cerrado',
  shippingPrice:   179,
  paymentMethods:  'Transferencia bancaria, depósito o tarjeta de crédito/débito. No se acepta efectivo en pedidos sobre pedido.',
  depositPercent:  30,
  paymentDays:     20,
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// Returns the first valid image URL from each matched product.
// Only the first image per product is intentional — sending multiple angles
// per product would flood the customer's chat.
function filterProductsBySearchHints(
  products: {
    _id: { toString(): string };
    name: string;
    brand: string;
    gender?: string;
    categoryGroup?: string;
    subcategory?: string;
    images?: unknown;
  }[],
  hints: ClaudeSearchHints,
): string[] {
  const keyword = hints.keyword.toLowerCase().trim();

  const matched = products.filter((p) => {
    const fields = [p.name, p.brand, p.categoryGroup ?? '', p.subcategory ?? '']
      .map((f) => f.toLowerCase());

    const keywordMatch = fields.some((f) => f.includes(keyword));
    if (!keywordMatch) return false;

    if (hints.gender && hints.gender !== 'unknown' && p.gender) {
      if (p.gender !== hints.gender) return false;
    }

    return true;
  });

  return matched
    .map((p) => {
      const images = p.images;
      if (!Array.isArray(images)) return undefined;
      return toValidUrl(images[0]);
    })
    .filter((url): url is string => Boolean(url));
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const handleIncomingMessage = async (
  payload: WebhookPayload,
): Promise<WebhookResult> => {
  const from = payload.from;
  const messageType = payload.messageType;
  const message =
    typeof payload.message === 'string'
      ? payload.message.trim()
      : '';
  const messageId =
    typeof payload.messageId === 'string' && payload.messageId.trim()
      ? payload.messageId.trim()
      : null;

  // ── 0. Guards — ignore non-message / malformed WhatsApp events ────────────

  if (!from) {
    logger.info(
      { messageType: payload.messageType, messageId: payload.messageId },
      'Ignoring non-message webhook event — empty from field',
    );
    return toSafeResult(EMPTY_RESULT);
  }

  if (messageType && messageType !== 'text' && messageType !== 'image') {
    logger.info(
      { from, messageType, messageId },
      'Ignoring unsupported WhatsApp message type',
    );
    return toSafeResult(EMPTY_RESULT);
  }

  if (messageType === 'image' && !payload.imageMediaId) {
    logger.info(
      { from, messageId },
      'Ignoring image webhook event without imageMediaId',
    );
    return toSafeResult(EMPTY_RESULT);
  }

  if ((messageType === 'text' || !messageType) && !message) {
    logger.info(
      { from, messageId, messageType },
      'Ignoring empty text-like WhatsApp event',
    );
    return toSafeResult(EMPTY_RESULT);
  }

  // ── 1. Identify / create customer ────────────────────────────────────────
  // Keep current active-customer semantics for now.
  let customer = await CustomerModel.findOne({
    phone: from,
    isActive: true,
  }).lean();

  if (!customer) {
    customer = await CustomerModel.create({
      name:           payload.contactName ?? `WhatsApp ${from}`,
      phone:          from,
      contactChannel: 'whatsapp',
      gender:         CUSTOMER_GENDERS.UNKNOWN,
      tags:           [],
    });

    logger.info({ phone: from }, 'New customer created from WhatsApp');
  }

  const customerId = customer._id.toString();
  const customerName =
    customer.name !== `WhatsApp ${from}` ? customer.name : null;
  const customerGender =
    (customer.gender ?? CUSTOMER_GENDERS.UNKNOWN) as 'female' | 'male' | 'unknown';

  // ── 2. Image message — search inventory by visual similarity ─────────────
  if (messageType === 'image') {
    logger.info(
      { customerId, mediaId: payload.imageMediaId, messageId },
      'Image message received — running visual search',
    );

    const fallbackReply = 'Ahorita te confirmo eso bonita, dame un momento 🙏🏻';

    try {
      const { reply, productImages } = await searchProductsByImage(payload.imageMediaId!);

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
          $set:  { lastMessageAt: new Date() },
        },
        { upsert: true, new: true },
      );

      return toSafeResult({
        reply,
        escalate: false,
        customerPhone: from,
        customerName,
        productImages,
      });
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
          $set:  { lastMessageAt: new Date() },
        },
        { upsert: true, new: true },
      );

      return toSafeResult({
        reply: fallbackReply,
        escalate: true,
        customerPhone: from,
        customerName,
        productImages: [],
      });
    }
  }

  // ── 3. Text message — Luis flow ───────────────────────────────────────────

  const conversation = await ConversationModel.findOne({
    customerId,
    channel: 'whatsapp',
  }).lean();

  const conversationHistory = (conversation?.turns ?? []).map((t) => ({
    role:    t.role as 'user' | 'assistant',
    content: t.content,
  }));

  const recentOrder = await OrderModel.findOne({ customerId })
    .sort({ createdAt: -1 })
    .lean();

  const products = await ProductModel.find({ status: 'active' })
    .select('name price brand gender categoryGroup subcategory images')
    .lean();

  const catalog = products.map((p) => ({
    id:    p._id.toString(),
    name:  p.name,
    price: p.price,
    brand: p.brand,
  }));

  const result = await processMessage({
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

  let escalate = result.intent === 'needs_human';
  let productImages: string[] = [];

  // ── Resolve product images ────────────────────────────────────────────────
  if (result.intent === 'product_search' && result.searchHints) {
    productImages = filterProductsBySearchHints(products, result.searchHints);

    logger.info(
      { keyword: result.searchHints.keyword, matches: productImages.length },
      'Product search — returning matched images',
    );
  }

  // ── Handle create_order intent ────────────────────────────────────────────
  if (result.intent === 'create_order' && result.orderHints?.length) {
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
            productId:   product.id,
            productName: product.name,
            productSlug: product.name.toLowerCase().replace(/\s+/g, '-'),
            size:        hint.size,
            color:       hint.color,
            quantity:    hint.quantity,
            unitPrice:   product.price,
            lineTotal:   hint.quantity * product.price,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);

      if (resolvedItems.length > 0) {
        const messageIdNote = messageId ? `WA_MESSAGE_ID:${messageId}` : null;

        if (messageIdNote) {
          const existingOrder = await OrderModel.findOne({
            customerId,
            'notes.message': messageIdNote,
          })
            .select('orderNumber')
            .lean();

          if (existingOrder) {
            logger.info(
              { customerId, messageId, orderNumber: existingOrder.orderNumber },
              'Duplicate create_order intent detected — order already exists for this WhatsApp message',
            );
          } else {
            const created = await createOrder(
              {
                customerId,
                channel: 'whatsapp',
                items: resolvedItems.map((item) => ({
                  productId: item.productId,
                  size:      item.size,
                  color:     item.color,
                  quantity:  item.quantity,
                  unitPrice: item.unitPrice,
                })),
                notes: [
                  { message: 'Pedido creado automáticamente desde WhatsApp.', kind: 'system' },
                  { message: messageIdNote, kind: 'system' },
                ],
              },
              null,
            );

            logger.info(
              { orderNumber: created.orderNumber, customerId, messageId },
              'Order created from WhatsApp',
            );
          }
        } else {
          const created = await createOrder(
            {
              customerId,
              channel: 'whatsapp',
              items: resolvedItems.map((item) => ({
                productId: item.productId,
                size:      item.size,
                color:     item.color,
                quantity:  item.quantity,
                unitPrice: item.unitPrice,
              })),
              notes: [
                { message: 'Pedido creado automáticamente desde WhatsApp.', kind: 'system' },
              ],
            },
            null,
          );

          logger.warn(
            { orderNumber: created.orderNumber, customerId },
            'Order created from WhatsApp without messageId idempotency marker',
          );
        }
      } else {
        escalate = true;
        logger.warn(
          { customerId, messageId },
          'create_order intent had no resolvable items — escalate forced',
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

  if (escalate) {
    logger.info({ customerId, from, messageId }, 'Escalate flag set for n8n');
  }

  // ── Persist conversation after business-side effects are resolved ────────
  const newTurns = [
    { role: 'user'      as const, content: message,         createdAt: new Date() },
    { role: 'assistant' as const, content: result.response, createdAt: new Date() },
  ];

  await ConversationModel.findOneAndUpdate(
    { customerId, channel: 'whatsapp' },
    {
      $push: { turns: { $each: newTurns, $slice: -MAX_CONVERSATION_TURNS } },
      $set:  { lastMessageAt: new Date() },
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

  return toSafeResult({
    reply: result.response,
    escalate,
    customerPhone: from,
    customerName,
    productImages,
  });
};