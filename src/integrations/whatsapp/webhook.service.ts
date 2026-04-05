import { CustomerModel } from '#/modules/customers/customer.model.js';
import { OrderModel } from '#/modules/orders/order.model.js';
import { ProductModel } from '#/modules/products/product.model.js';
import {
  ConversationModel,
  MAX_CONVERSATION_TURNS,
} from '#/modules/conversations/conversation.model.js';
import { createOrder } from '#/modules/orders/order.service.js';
import { processMessage } from '#/integrations/whatsapp/claude.service.js';
import { logger } from '#/config/logger.js';
import type { WebhookPayload } from '#/integrations/whatsapp/webhook.validation.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type WebhookResult = {
  reply:    string;
  // When true, n8n should send an owner alert via WhatsApp.
  // n8n already has the Meta credentials — no need to duplicate them here.
  escalate: boolean;
  // Passed through so n8n can include it in the owner alert message.
  customerPhone: string;
  customerName:  string | null;
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

  const customerId   = customer._id.toString();
  const customerName = customer.name !== `WhatsApp ${from}` ? customer.name : null;

  // ── 2. Load conversation history ─────────────────────────────────────────
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
    customerName,
    recentOrder: recentOrder
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
  const newTurns = [
    { role: 'user'      as const, content: message,         createdAt: new Date() },
    { role: 'assistant' as const, content: result.response, createdAt: new Date() },
  ];

  await ConversationModel.findOneAndUpdate(
    { customerId, channel: 'whatsapp' },
    {
      $push: {
        turns: {
          $each:  newTurns,
          $slice: -MAX_CONVERSATION_TURNS,
        },
      },
      $set: { lastMessageAt: new Date() },
    },
    { upsert: true, new: true },
  );

  logger.info(
    { customerId, intent: result.intent, historyTurns: conversationHistory.length },
    'Conversation turn persisted',
  );

  // ── 7. Handle create_order intent ────────────────────────────────────────
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
        // Delegate to the order service — gets the atomic SALO-XXXXXX counter,
        // Zod validation, product snapshot lookup, and financial computation.
        const created = await createOrder(
          {
            customerId,
            channel: 'whatsapp',
            items: resolvedItems.map(item => ({
              productId: item.productId,
              size:      item.size,
              color:     item.color,
              quantity:  item.quantity,
              unitPrice: item.unitPrice,
            })),
            notes: [{
              message: 'Pedido creado automáticamente desde WhatsApp.',
              kind:    'system',
            }],
          },
          null, // no human author — bot-generated order
        );

        logger.info({ orderNumber: created.orderNumber, customerId }, 'Order created from WhatsApp');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to create order from WhatsApp message');
    }
  }

  // ── 8. Return result — escalate flag tells n8n to notify the owner ───────
  const escalate = result.intent === 'needs_human';

  if (escalate) {
    logger.info({ customerId, from }, 'needs_human intent — escalate flag set for n8n');
  }

  return {
    reply:         result.response,
    escalate,
    customerPhone: from,
    customerName,
  };
};