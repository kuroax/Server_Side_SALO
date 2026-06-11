import mongoose from "mongoose";
import { z } from "zod";
import { logger } from "#/config/logger.js";
import {
  PendingPaymentModel,
  type IPendingPayment,
} from "#/modules/pendingPayments/pendingPayment.model.js";
import {
  createOrder,
  updateOrderStatus,
  updatePaymentStatus,
} from "#/modules/orders/order.service.js";
import type { SafeOrder } from "#/modules/orders/order.types.js";
import { OrderModel } from "#/modules/orders/order.model.js";
import { CustomerModel } from "#/modules/customers/customer.model.js";
import { InventoryModel } from "#/modules/inventory/inventory.model.js";
import { ProductModel } from "#/modules/products/product.model.js";
import { BoutiqueModel } from "#/modules/boutiques/boutique.model.js";

// Escape regex metacharacters so Claude-derived strings are safe in $regex queries.
const escapeRegex = (str: string): string =>
  str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
  | { status: "unauthorized" }
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
  // boutiqueId is supplied in the request body and authenticated
  // only by the shared BUFFER_WEBHOOK_SECRET + ownerPhone match.
  // Defense-in-depth improvement: resolve boutiqueId server-side
  // from the ownerPhone instead of trusting the body value.
  const { boutiqueId, customerPhone, ownerPhone } = input;

  // Look up boutique credentials server-side — never accept tokens from the caller.
  const boutique = await BoutiqueModel.findOne({
    _id: new mongoose.Types.ObjectId(boutiqueId),
    status: "active",
  })
    .select("+accessToken")
    .lean();

  if (!boutique) {
    logger.warn({ boutiqueId }, "ownerConfirm — boutique not found or inactive");
    return { status: "error", reason: "Boutique not found" };
  }

  // Authorization: the shared webhook secret only proves the request came from
  // n8n — it does NOT prove the caller is THIS boutique's owner. Verify the
  // supplied ownerPhone matches the boutique's stored ownerPhone (digits-only)
  // so a secret holder cannot confirm payments for an arbitrary boutiqueId.
  const normalizedIncoming = ownerPhone.replace(/\D/g, "");
  const normalizedStored = boutique.ownerPhone?.replace(/\D/g, "");
  if (!normalizedStored || normalizedIncoming !== normalizedStored) {
    logger.warn({ boutiqueId }, "owner-confirm: ownerPhone mismatch");
    return { status: "unauthorized" };
  }

  // Confirming a payment sends a WhatsApp message to the customer, which needs
  // the boutique's Meta credentials. A boutique whose WhatsApp is not yet
  // connected (no phoneNumberId/accessToken) cannot run this flow.
  if (!boutique.accessToken || !boutique.phoneNumberId) {
    logger.warn(
      { boutiqueId },
      "ownerConfirm — boutique has no WhatsApp credentials (not connected)",
    );
    return { status: "error", reason: "Boutique WhatsApp not connected" };
  }

  const accessToken = boutique.accessToken;
  const phoneNumberId = boutique.phoneNumberId;
  const boutiqueObjectId = new mongoose.Types.ObjectId(boutiqueId);

  // 1. Find the pending payment record (boutique-scoped).
  // The owner MUST specify the customer phone. The previous "LOOKUP_BY_BOUTIQUE"
  // sentinel auto-resolved to the single / most-recent pending payment when the
  // phone was omitted — but with exactly one pending payment it picked blindly,
  // and when two customers' deposits overlap in time that recency pick is a coin
  // flip that can confirm the WRONG order (deducting inventory + crediting LTV
  // for the wrong customer). Require an explicit phone instead, regardless of how
  // many pending payments exist.
  if (!customerPhone || customerPhone === "LOOKUP_BY_BOUTIQUE") {
    logger.warn(
      { boutiqueId },
      "ownerConfirm — customerPhone required, refusing blind auto-resolve",
    );
    return {
      status: "error",
      reason:
        "customerPhone required — cannot auto-resolve without it. Reply with: CONFIRMAR PAGO {customerPhone}",
    };
  }

  const pending: IPendingPayment | null = await PendingPaymentModel.findOne({
    boutiqueId: new mongoose.Types.ObjectId(boutiqueId),
    customerPhone,
  }).lean();

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
      name: { $regex: escapeRegex(hint.productNameHint), $options: "i" },
      status: "active",
    }).lean();

    if (!product) continue;

    // inventory.size is stored uppercase, color lowercase (pre-save hooks).
    const inventory = await InventoryModel.findOne({
      boutiqueId: boutiqueObjectId,
      productId: product._id,
      size: hint.size.trim().toUpperCase(),
      color: { $regex: escapeRegex(hint.color.trim().toLowerCase()), $options: "i" },
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

  // 4. Duplicate guard + order creation — atomic.
  // Guard against duplicate orders if the owner confirms twice.
  // Scope-safe guard: same boutique + same customer + a still-open order
  // (pending/confirmed) created within the last 24h. This replaces the old
  // notes.message regex, which both false-positived (a returning customer's
  // old order matched and silently dropped the new sale) and false-negatived
  // (auto-created orders have no phone in their notes, so duplicates slipped
  // through). The 24h window + non-cancelled status closes both gaps.
  //
  // The guard read and the order insert run inside ONE transaction so two
  // concurrent CONFIRMAR PAGO messages cannot both pass the findOne check and
  // create two orders — the second transaction sees the first one's committed
  // order (or aborts on write conflict and retries via withTransaction).
  type TxOutcome =
    | { kind: "duplicate"; orderNumber: string }
    | { kind: "created"; order: SafeOrder };

  let outcome: TxOutcome;
  const session = await mongoose.startSession();
  try {
    outcome = await session.withTransaction(
      async (): Promise<TxOutcome> => {
        const existingOrder = await OrderModel.findOne({
          boutiqueId: boutiqueObjectId,
          customerId: customer._id,
          status: { $in: ["pending", "confirmed"] },
          createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        })
          .session(session)
          .lean();
        if (existingOrder) {
          return {
            kind: "duplicate",
            orderNumber: existingOrder.orderNumber,
          };
        }

        const order = await createOrder(
          {
            boutiqueId,
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
          session,
        );
        return { kind: "created", order };
      },
    );
  } catch (err) {
    logger.error(
      { err, resolvedCustomerPhone, boutiqueId },
      "ownerConfirm — createOrder failed",
    );
    return {
      status: "error",
      reason: err instanceof Error ? err.message : "unknown",
    };
  } finally {
    await session.endSession();
  }

  if (outcome.kind === "duplicate") {
    logger.warn(
      { boutiqueId, resolvedCustomerPhone, orderNumber: outcome.orderNumber },
      "ownerConfirm — duplicate confirm detected, order already exists",
    );
    // Delete the pending payment so this guard triggers only once.
    await PendingPaymentModel.deleteOne({
      boutiqueId: boutiqueObjectId,
      customerPhone: resolvedCustomerPhone,
    }).catch((err) => {
      logger.warn(
        { err, boutiqueId, resolvedCustomerPhone },
        "ownerConfirm — pendingPayment delete failed (duplicate path) — TTL will expire it",
      );
    });
    return { status: "order_created", orderNumber: outcome.orderNumber };
  }

  const created = outcome.order;

  logger.info(
    { orderNumber: created.orderNumber, resolvedCustomerPhone, boutiqueId },
    "ownerConfirm — order created",
  );

  // 5. The owner just verified the deposit, so reflect that on the order:
  //    paid (credits customer lifetimeValue) then confirmed (deducts inventory
  //    inside its own transaction). Best-effort: the order already exists and
  //    the payment IS verified — a bookkeeping failure here (e.g. stock sold
  //    out between resolution and confirm) leaves the order pending/paid for
  //    the owner to resolve in the app, and must not report the confirm as
  //    failed or block the customer notification.
  try {
    await updatePaymentStatus(
      { orderId: created.id, paymentStatus: "paid" },
      boutiqueId,
    );
    await updateOrderStatus(
      { orderId: created.id, status: "confirmed" },
      boutiqueId,
    );
  } catch (err) {
    logger.error(
      { err, orderNumber: created.orderNumber, boutiqueId },
      "ownerConfirm — order created but paid/confirmed transition failed — resolve manually in the app",
    );
  }

  // 6. Delete the pending payment to prevent duplicates.
  await PendingPaymentModel.deleteOne({
    boutiqueId: boutiqueObjectId,
    customerPhone: resolvedCustomerPhone,
  }).catch((err) => {
    logger.warn(
      { err, boutiqueId, resolvedCustomerPhone },
      "ownerConfirm — pendingPayment delete failed — duplicate guard still covers re-confirms",
    );
  });

  // 7. Notify the customer.
  await sendWhatsAppText(
    phoneNumberId,
    accessToken,
    resolvedCustomerPhone,
    `¡Tu pago fue confirmado! 🙌🏼 Tu pedido ${created.orderNumber} está en proceso. Te avisamos en cuanto vaya en camino 🙏🏻`,
  );

  return { status: "order_created", orderNumber: created.orderNumber };
};
