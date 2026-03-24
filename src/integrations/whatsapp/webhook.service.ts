import { CustomerModel } from '#/modules/customers/customer.model.js';
import { OrderModel } from '#/modules/orders/order.model.js';
import { ProductModel } from '#/modules/products/product.model.js';
import {
  ConversationModel,
  MAX_CONVERSATION_TURNS,
} from '#/modules/conversations/conversation.model.js';
import { processMessage } from '#/integrations/whatsapp/claude.service.js';
import { logger } from '#/config/logger.js';
import type { WebhookPayload } from '#/integrations/whatsapp/webhook.validation.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type WebhookResult = {
  reply: string;
};

// ─── Business info ────────────────────────────────────────────────────────────
// Single source of truth for facts the AI uses when answering customers.
// Update here when anything changes — never hardcode these in the system prompt.

const BUSINESS_INFO = {
  showroomAddress: 'Av. Guadalupe 1390, Chapalita Oriente, Guadalajara, Jalisco',
  businessHours:   'Lunes a Viernes 10:00am–8:30pm · Sábados 11:00am–7:00pm · Domingos cerrado',
  shippingPrice:   179,
  paymentMethods:  'Transferencia bancaria, depósito o tarjeta de crédito/débito. No se acepta efectivo en pedidos sobre pedido.',
  depositPercent:  30,
  paymentDays:     20,
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Fuzzy match a product name hint against the catalog.
// Claude may return slightly different capitalization or wording.
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

// ─── Service ──────────────────────────────────────────────────────────────────

export const handleIncomingMessage = async (
  payload: WebhookPayload,
): Promise<WebhookResult> => {
  const { from, message } = payload;

  // ── 1. Identify customer by phone ────────────────────────────────────────
  let customer = await CustomerModel.findOne({
    phone:    from,
    isActive: true,
  }).lean();

  if (!customer) {
    customer = await CustomerModel.create({
      name:           `WhatsApp ${from}`,
      phone:          from,
      contactChannel: 'whatsapp',
      tags:           [],
    });

    logger.info({ phone: from }, 'New customer created from WhatsApp');
  }

  const customerId = customer._id.toString();

  // ── 2. Load conversation history ─────────────────────────────────────────
  // Find or initialize the conversation document for this customer+channel.
  // We use findOne here (not findOneAndUpdate) because we need the existing
  // turns to pass to Claude before we know what to append.
  const conversation = await ConversationModel.findOne({
    customerId,
    channel: 'whatsapp',
  }).lean();

  const conversationHistory = (conversation?.turns ?? []).map((t) => ({
    role:    t.role as 'user' | 'assistant',
    content: t.content,
  }));

  // ── 3. Fetch most recent order for context ───────────────────────────────
  const recentOrder = await OrderModel.findOne({ customerId })
    .sort({ createdAt: -1 })
    .lean();

  // ── 4. Fetch active product catalog ──────────────────────────────────────
  const products = await ProductModel.find({ status: 'active' })
    .select('id name price brand')
    .lean();

  const catalog = products.map((p) => ({
    id:    p._id.toString(),
    name:  p.name,
    price: p.price,
    brand: p.brand,
  }));

  // ── 5. Call Claude ────────────────────────────────────────────────────────
  const result = await processMessage({
    customerName:    customer.name !== `WhatsApp ${from}` ? customer.name : null,
    recentOrder:     recentOrder
      ? {
          orderNumber: recentOrder.orderNumber,
          status:      recentOrder.status,
          total:       recentOrder.total,
        }
      : null,
    catalog,
    incomingMessage:     message,
    conversationHistory,
    businessInfo:        BUSINESS_INFO,
  });

  // ── 6. Persist conversation turn ─────────────────────────────────────────
  // Append the new user message + assistant reply, then trim to the rolling
  // window so the document never grows unboundedly.
  const newTurns = [
    { role: 'user'      as const, content: message,          createdAt: new Date() },
    { role: 'assistant' as const, content: result.response,  createdAt: new Date() },
  ];

  await ConversationModel.findOneAndUpdate(
    { customerId, channel: 'whatsapp' },
    {
      $push: {
        turns: {
          $each:  newTurns,
          // Keep only the last MAX_CONVERSATION_TURNS turns.
          // $slice with a negative value keeps the tail of the array.
          $slice: -MAX_CONVERSATION_TURNS,
        },
      },
      $set: { lastMessageAt: new Date() },
    },
    { upsert: true, new: true },
  );

  logger.info(
    { customerId, historyTurns: conversationHistory.length },
    'Conversation turn persisted',
  );

  // ── 7. Handle create_order intent ─────────────────────────────────────────
  // orderHints from Claude are treated as unverified hints only.
  // All product data (id, name, price) is resolved from our own catalog.
  if (result.intent === 'create_order' && result.orderHints?.length) {
    try {
      const resolvedItems = result.orderHints
        .map((hint) => {
          const product = findProductByHint(hint.productNameHint, catalog);

          if (!product) {
            logger.warn(
              { hint: hint.productNameHint },
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
        const today       = new Date();
        const datePart    = today.toISOString().slice(0, 10).replace(/-/g, '');
        const count       = await OrderModel.countDocuments();
        const orderNumber = `ORD-${datePart}-${String(count + 1).padStart(4, '0')}`;
        const subtotal    = resolvedItems.reduce((sum, i) => sum + i.lineTotal, 0);

        await OrderModel.create({
          orderNumber,
          customerId,
          channel:       'whatsapp',
          status:        'pending',
          paymentStatus: 'unpaid',
          items:         resolvedItems,
          subtotal,
          total:         subtotal,
          notes: [{
            message:   'Pedido creado automáticamente desde WhatsApp.',
            kind:      'system',
            createdAt: new Date().toISOString(),
          }],
        });

        logger.info({ orderNumber, customerId }, 'Order created from WhatsApp');
      } else {
        logger.warn(
          { hints: result.orderHints },
          'No catalog products matched — order not created',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Failed to create order from WhatsApp message');
      // Don't throw — return Claude's response anyway.
    }
  }

  return { reply: result.response };
};