import mongoose from "mongoose";
import { z } from "zod";
import { logger } from "#/config/logger.js";
import {
  PendingPaymentModel,
  type IPendingPayment,
} from "#/modules/pendingPayments/pendingPayment.model.js";
import { createOrder } from "#/modules/orders/order.service.js";
import { OrderModel } from "#/modules/orders/order.model.js";
import { CustomerModel } from "#/modules/customers/customer.model.js";
import { InventoryModel } from "#/modules/inventory/inventory.model.js";
import { ProductModel } from "#/modules/products/product.model.js";
import { BoutiqueModel } from "#/modules/boutiques/boutique.model.js";

// ─── Input schema ─────────────────────────────────────────────────────────────

export const ownerConfirmSchema = z.object({
  boutiqueId: z.string().min(1),
  customerPhone: z.string().min(1),
  ownerPhone: z.string().min(1),
});

export type OwnerConfirmInput = z.infer<typeof ownerConfirmSchema>;

// ─── Result ───────────────────────────────────────────────────────────────────

export type OwnerConfirmResult =
  | { status: "order_created"; orderNumber: string }
  | { status: "no_pending_payment" }
  | { status: "customer_not_found" }
  | { status: "error"; reason: string };

const GRAPH_API_VERSION = "v20.0";

// Order item shape expected by createOrderSchema (order.validation.ts).
// size/color are normalized to canonical casing by the schema; we resolve
// productId + unitPrice from the live product record here.
type ResolvedItem = {
  productId: string;
  size: string;
  color: string;
  quantity: number;
  unitPrice: number;
};

// Direct Graph API send — same deliberate exception as alert.service.ts (owner/
// out-of-band notifications). Never throws; never logs the accessToken.
async function sendWhatsAppText(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
): Promise<void> {
  try {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    });
  } catch (err) {
    logger.warn(
      { err, to },
      "ownerConfirm — failed to send customer WhatsApp notification",
    );
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export const handleOwnerConfirm = async (
  input: OwnerConfirmInput,
): Promise<OwnerConfirmResult> => {
  const { boutiqueId, customerPhone } = input;

  // Look up boutique credentials server-side — never accept tokens from the caller.
  const boutique = await BoutiqueModel.findOne({
    _id: new mongoose.Types.ObjectId(boutiqueId),
    status: "active",
  }).lean();

  if (!boutique) {
    logger.warn({ boutiqueId }, "ownerConfirm — boutique not found or inactive");
    return { status: "error", reason: "Boutique not found" };
  }

  const accessToken = boutique.accessToken;
  const phoneNumberId = boutique.phoneNumberId;
  const boutiqueObjectId = new mongoose.Types.ObjectId(boutiqueId);

  // 1. Find the pending payment record (boutique-scoped).
  // If customerPhone is "LOOKUP_BY_BOUTIQUE", find the most recent pending
  // payment for this boutique — used when the owner confirms via natural
  // language ("ya confirmé el pago") without specifying the customer phone.
  let pending: IPendingPayment | null = null;

  if (customerPhone === "LOOKUP_BY_BOUTIQUE") {
    // Guard: refuse when multiple pending payments exist for this boutique.
    // Picking the wrong customer with real money is worse than returning an error.
    const pendingCount = await PendingPaymentModel.countDocuments({
      boutiqueId: new mongoose.Types.ObjectId(boutiqueId),
    });
    if (pendingCount > 1) {
      logger.warn(
        { boutiqueId, pendingCount },
        "ownerConfirm — LOOKUP_BY_BOUTIQUE refused: multiple pending payments exist, specify customerPhone",
      );
      return {
        status: "error",
        reason: `Ambiguous: ${pendingCount} pending payments exist for this boutique. Reply with: CONFIRMAR PAGO {customerPhone}`,
      };
    }
    pending = await PendingPaymentModel.findOne({
      boutiqueId: new mongoose.Types.ObjectId(boutiqueId),
    })
      .sort({ createdAt: -1 })
      .lean();
  } else {
    pending = await PendingPaymentModel.findOne({
      boutiqueId: new mongoose.Types.ObjectId(boutiqueId),
      customerPhone,
    }).lean();
  }

  if (!pending) {
    logger.info(
      { boutiqueId, customerPhone },
      "ownerConfirm — no pending payment found, possible duplicate confirm",
    );
    return { status: "no_pending_payment" };
  }

  // Use the resolved customerPhone from the pending document going forward
  const resolvedCustomerPhone = pending.customerPhone;

  // 2. Find the customer record.
  // Lookup by boutiqueId + phone. Customers created before the boutiqueId
  // backfill migration may not have boutiqueId set and will return null here.
  const customer = await CustomerModel.findOne({
    boutiqueId: new mongoose.Types.ObjectId(boutiqueId),
    phone: resolvedCustomerPhone,
  }).lean();
  if (!customer) {
    logger.warn({ resolvedCustomerPhone }, "ownerConfirm — customer not found");
    return { status: "customer_not_found" };
  }

  // 3. Resolve cart hints to real product + in-stock variant, building the
  //    order item shape createOrder expects ({ productId, size, color,
  //    quantity, unitPrice }).
  const resolvedItems: ResolvedItem[] = [];

  for (const hint of pending.cart) {
    if (hint.size === "?" || hint.color === "?") {
      // Cart was extracted from history without full detail — skip resolution
      // and let the owner create the order manually from the app if needed.
      logger.warn(
        { hint },
        "ownerConfirm — cart item missing size/color, skipping resolution",
      );
      continue;
    }

    const product = await ProductModel.findOne({
      boutiqueId: boutiqueObjectId,
      name: { $regex: hint.productNameHint, $options: "i" },
      status: "active",
    }).lean();

    if (!product) continue;

    // inventory.size is stored uppercase, color lowercase (pre-save hooks).
    const inventory = await InventoryModel.findOne({
      boutiqueId: boutiqueObjectId,
      productId: product._id,
      size: hint.size.trim().toUpperCase(),
      color: { $regex: hint.color.trim().toLowerCase(), $options: "i" },
      quantity: { $gt: 0 },
    }).lean();

    if (!inventory) continue;

    resolvedItems.push({
      productId: product._id.toString(),
      size: hint.size,
      color: hint.color,
      quantity: hint.quantity,
      unitPrice: product.price,
    });
  }

  if (resolvedItems.length === 0) {
    logger.warn(
      { boutiqueId, resolvedCustomerPhone, cartItems: pending.cart.length },
      "ownerConfirm — no cart items could be resolved to in-stock products",
    );
    return { status: "error", reason: "no resolvable cart items" };
  }

  try {
    // Guard against duplicate orders if owner confirms twice.
    // Check if an order already exists for this customer that was created
    // from a pendingPayment (notes contain the customer phone).
    // Scoped to this boutique via customerId to avoid cross-tenant matches.
    // Find the customer first (already resolved above), then scope the order.
    const existingOrder = customer
      ? await OrderModel.findOne({
          customerId: customer._id,
          "notes.message": { $regex: resolvedCustomerPhone, $options: "i" },
        }).lean()
      : null;
    if (existingOrder) {
      logger.warn(
        { boutiqueId, resolvedCustomerPhone, existingOrderId: existingOrder._id },
        "ownerConfirm — duplicate confirm detected, order already exists",
      );
      // Delete the pending payment so this guard triggers only once
      await PendingPaymentModel.deleteOne({
        boutiqueId: new mongoose.Types.ObjectId(boutiqueId),
        customerPhone: resolvedCustomerPhone,
      });
      return { status: "order_created", orderNumber: existingOrder.orderNumber };
    }

    // 4. Create the order. createOrder(input, createdBy, sourceMessageId).
    const created = await createOrder(
      {
        customerId: customer._id.toString(),
        channel: "whatsapp",
        items: resolvedItems,
        notes: [
          {
            message: `Pago confirmado manualmente por el dueño. Cliente: ${resolvedCustomerPhone}.`,
            kind: "system",
          },
        ],
      },
      null,
      null,
    );

    logger.info(
      { orderNumber: created.orderNumber, resolvedCustomerPhone, boutiqueId },
      "ownerConfirm — order created",
    );

    // 5. Delete the pending payment to prevent duplicates.
    await PendingPaymentModel.deleteOne({
      boutiqueId: boutiqueObjectId,
      customerPhone: resolvedCustomerPhone,
    });

    // 6. Notify the customer.
    await sendWhatsAppText(
      phoneNumberId,
      accessToken,
      resolvedCustomerPhone,
      `¡Tu pago fue confirmado! 🙌🏼 Tu pedido ${created.orderNumber} está en proceso. Te avisamos en cuanto vaya en camino 🙏🏻`,
    );

    return { status: "order_created", orderNumber: created.orderNumber };
  } catch (err) {
    logger.error(
      { err, resolvedCustomerPhone, boutiqueId },
      "ownerConfirm — createOrder failed",
    );
    return {
      status: "error",
      reason: err instanceof Error ? err.message : "unknown",
    };
  }
};
