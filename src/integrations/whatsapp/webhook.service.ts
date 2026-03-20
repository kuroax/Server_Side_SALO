import { CustomerModel } from '#/modules/customers/customer.model.js';
import { OrderModel } from '#/modules/orders/order.model.js';
import { ProductModel } from '#/modules/products/product.model.js';
import { processMessage } from '#/integrations/whatsapp/claude.service.js';
import { logger } from '#/config/logger.js';
import type { WebhookPayload } from '#/integrations/whatsapp/webhook.validation.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type WebhookResult = {
  reply: string;
};

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

  // ── 2. Fetch most recent order for context ───────────────────────────────
  const recentOrder = await OrderModel.findOne({ customerId: customer._id.toString() })
    .sort({ createdAt: -1 })
    .lean();

  // ── 3. Fetch active product catalog ─────────────────────────────────────
  const products = await ProductModel.find({ status: 'active' })
    .select('id name price brand')
    .lean();

  const catalog = products.map((p) => ({
    id:    p._id.toString(),
    name:  p.name,
    price: p.price,
    brand: p.brand,
  }));

  // ── 4. Call Claude — intent detection + response generation ─────────────
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
    incomingMessage: message,
  });

  // ── 5. Handle create_order intent ────────────────────────────────────────
  // orderHints from Claude are treated as unverified hints only.
  // All product data (id, name, price) is resolved from our own catalog.
  if (result.intent === 'create_order' && result.orderHints?.length) {
    try {
      const resolvedItems = result.orderHints
        .map((hint) => {
          // Resolve product from catalog — never trust Claude's price or ID.
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
            unitPrice:   product.price,           // from catalog, not Claude
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
          customerId:    customer._id.toString(),
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

        logger.info({ orderNumber, customerId: customer._id }, 'Order created from WhatsApp');
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