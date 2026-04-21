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
import type { WebhookPayload } from '#/integrations/whatsapp/webhook.validation.js';
import type { ClaudeSearchHints } from '#/integrations/whatsapp/claude.service.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type WebhookResult = {
  reply:         string;
  escalate:      boolean;
  customerPhone: string;
  customerName:  string | null;
  productImages: string[];
};

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
  hint:    string,
  catalog: { id: string; name: string; price: number }[],
): { id: string; name: string; price: number } | null {
  const normalized = hint.toLowerCase().trim();
  return (
    catalog.find((p) => p.name.toLowerCase().includes(normalized)) ??
    catalog.find((p) => normalized.includes(p.name.toLowerCase())) ??
    null
  );
}

// Filters the full product list using the hints Claude extracted from the
// customer's message. Matching is intentionally broad — keyword matches
// against name, brand, categoryGroup, and subcategory so "legging" finds
// "Ribbed Sea Coast Cropped Legging" even if the customer only said one word.
function filterProductsBySearchHints(
  products: { _id: { toString(): string }; name: string; brand: string; gender?: string; categoryGroup?: string; subcategory?: string; images?: string[] }[],
  hints:    ClaudeSearchHints,
): string[] {
  const keyword = hints.keyword.toLowerCase().trim();

  const matched = products.filter((p) => {
    // Keyword match — at least one field must contain the keyword
    const fields = [p.name, p.brand, p.categoryGroup ?? '', p.subcategory ?? '']
      .map((f) => f.toLowerCase());
    const keywordMatch = fields.some((f) => f.includes(keyword));
    if (!keywordMatch) return false;

    // Gender match — skip filter if hint is unknown or absent
    if (hints.gender && hints.gender !== 'unknown' && p.gender) {
      if (p.gender !== hints.gender) return false;
    }

    return true;
  });

  // Extract first image from each matched product, drop empties
  return matched
    .map((p) => (p.images as string[] | undefined)?.[0])
    .filter((url): url is string => Boolean(url));
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const handleIncomingMessage = async (
  payload: WebhookPayload,
): Promise<WebhookResult> => {
  const { from, messageType } = payload;

  // ── 1. Identify / create customer ────────────────────────────────────────
  let customer = await CustomerModel.findOne({
    phone:    from,
    isActive: true,
  }).lean();

  if (!customer) {
    customer = await CustomerModel.create({
      name:           `WhatsApp ${from}`,
      phone:          from,
      contactChannel: 'whatsapp',
      gender:         CUSTOMER_GENDERS.UNKNOWN,
      tags:           [],
    });

    logger.info({ phone: from }, 'New customer created from WhatsApp');
  }

  const customerId      = customer._id.toString();
  const customerName    = customer.name !== `WhatsApp ${from}` ? customer.name : null;
  const customerGender  = (customer.gender ?? CUSTOMER_GENDERS.UNKNOWN) as 'female' | 'male' | 'unknown';

  // ── 2. Image message — search inventory by visual similarity ─────────────
  if (messageType === 'image' && payload.imageMediaId) {
    logger.info({ customerId, mediaId: payload.imageMediaId }, 'Image message received — running visual search');

    const { reply, productImages } = await searchProductsByImage(payload.imageMediaId);

    const imageTurns = [
      { role: 'user'      as const, content: '[Imagen enviada por el cliente]', createdAt: new Date() },
      { role: 'assistant' as const, content: reply,                             createdAt: new Date() },
    ];

    await ConversationModel.findOneAndUpdate(
      { customerId, channel: 'whatsapp' },
      {
        $push: { turns: { $each: imageTurns, $slice: -MAX_CONVERSATION_TURNS } },
        $set:  { lastMessageAt: new Date() },
      },
      { upsert: true, new: true },
    );

    return { reply, escalate: false, customerPhone: from, customerName, productImages };
  }

  // ── 3. Text message — Luis flow ───────────────────────────────────────────

  const message = payload.message;

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

  // Fetch products with images — images are not passed to Claude, they are
  // used here for filtering and dispatching back to n8n.
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
      ? { orderNumber: recentOrder.orderNumber, status: recentOrder.status, total: recentOrder.total }
      : null,
    catalog,
    incomingMessage:     message,
    conversationHistory,
    businessInfo:        BUSINESS_INFO,
  });

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
    { customerId, intent: result.intent, historyTurns: conversationHistory.length, customerGender },
    'Conversation turn persisted',
  );

  // ── Handle create_order intent ────────────────────────────────────────────
  if (result.intent === 'create_order' && result.orderHints?.length) {
    try {
      const resolvedItems = result.orderHints
        .map((hint) => {
          const product = findProductByHint(hint.productNameHint, catalog);
          if (!product) {
            logger.warn({ hint: hint.productNameHint }, 'Order hint did not match any catalog product — skipping item');
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
            notes: [{ message: 'Pedido creado automáticamente desde WhatsApp.', kind: 'system' }],
          },
          null,
        );
        logger.info({ orderNumber: created.orderNumber, customerId }, 'Order created from WhatsApp');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to create order from WhatsApp message');
    }
  }

  const escalate = result.intent === 'needs_human';
  if (escalate) {
    logger.info({ customerId, from }, 'needs_human intent — escalate flag set for n8n');
  }

  // ── Resolve product images to return to n8n ───────────────────────────────
  // product_search: filter catalog by Claude's searchHints → send matching images
  // catalog_query:  Luis asked a clarifying question this turn — no images yet
  // all others:     no images
  let productImages: string[] = [];

  if (result.intent === 'product_search' && result.searchHints) {
    productImages = filterProductsBySearchHints(products, result.searchHints);
    logger.info(
      { keyword: result.searchHints.keyword, matches: productImages.length },
      'Product search — returning matched images',
    );
  }

  return { reply: result.response, escalate, customerPhone: from, customerName, productImages };
};