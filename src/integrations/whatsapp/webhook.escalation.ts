// ─── Escalation + reply builders ──────────────────────────────────────────────
// Pure message-formatting helpers extracted from webhook.service.ts.

import type { CartItem } from "#/integrations/whatsapp/webhook.cart.js";

// Gender-aware error reply — used in fallback paths where customerGender
// is already resolved. Prevents female-gendered apologies to male customers.
export function buildErrorReply(gender: "female" | "male" | "unknown"): string {
  return gender === "male"
    ? "Lo siento amigo, hubo un problema técnico. Alguien del equipo te contactará pronto 🙏🏻"
    : "Lo siento bonita, hubo un problema técnico. Alguien del equipo te contactará pronto 🙏🏻";
}

// ─── Escalation message builders ─────────────────────────────────────────────

export type EscalationContext = {
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

export function buildEscalationMessage(ctx: EscalationContext): string {
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

// Builds the customer-facing receipt acknowledgment.
// When a cart was found, shows a numbered summary and asks for confirmation —
// the customer never has to repeat what they already said.
// Falls back to a generic ask only when the cart is genuinely empty.
export function buildReceiptAck(
  gender: "female" | "male" | "unknown",
  cart: CartItem[],
): string {
  // Use the real Luis receipt acknowledgment phrase — taken directly from
  // real customer chats. Warm, enthusiastic, uniquely SALO.
  const gratitude = "Mil gracias!!! Que se te multiplique 70 mil veces 7! 💫";

  if (cart.length === 0) {
    // No product context found — acknowledge warmly, do NOT ask which product.
    // The context fallback below (tertiary in extractCartFromHistory) should
    // rarely reach here after the tertiary tag-based extraction was added.
    // If it does, just acknowledge without asking — the owner escalation covers it.
    return (
      `${gratitude}\n\n` +
      `Ya recibí tu comprobante. Déjame revisar el depósito y, ` +
      `en cuanto esté confirmado, te aviso para continuar con tu pedido 🙏🏻`
    );
  }

  const itemLines = cart
    .map((item) => {
      const priceStr = item.price
        ? ` $${item.price.toLocaleString("es-MX")}`
        : "";
      return `⭐️${item.description}${priceStr}`;
    })
    .join("\n");

  return (
    `${gratitude}\n\n` +
    `Ya recibí tu comprobante. Déjame revisar el depósito y, ` +
    `en cuanto esté confirmado, te aviso para continuar con tu pedido 🙏🏻\n\n` +
    `${itemLines}`
  );
}

// Converts orderHints (Claude's structured output) to CartItem[] so both the
// Claude-driven text path and the backend-driven image path share the same
// escalation builder signature.
export function orderHintsToCart(
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
export function buildPaymentReceiptEscalation({
  customerPhone,
  customerName,
  cart,
  shippingPrice,
}: {
  customerPhone: string;
  customerName: string | null;
  cart: CartItem[];
  shippingPrice: number;
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
    // Financial summary — helps the owner verify the deposit amount immediately
    const subtotal = cart.reduce((s, i) => s + (i.price ?? 0), 0);
    if (subtotal > 0) {
      const total = subtotal + shippingPrice;
      const expectedDeposit = Math.ceil(total * 0.3);
      lines.push(
        "",
        `  Subtotal:              $${subtotal.toLocaleString("es-MX")}`,
        `  Envío nacional:       $${shippingPrice.toLocaleString("es-MX")}`,
        `  Total:                 $${total.toLocaleString("es-MX")}`,
        `  Primer pago esperado:  $${expectedDeposit.toLocaleString("es-MX")} (30%)`,
      );
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
