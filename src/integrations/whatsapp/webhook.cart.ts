// ─── Conversation + cart helpers ──────────────────────────────────────────────
// Pure history-parsing helpers extracted from webhook.service.ts. These operate
// only on stored conversation-turn arrays — no DB or external service access.

type ConversationTurn = { role: string; content: string };

// Returns true if the recent conversation contains evidence that Luis already
// sent the bank account / payment data to this customer. Used to classify an
// incoming image as a payment receipt rather than a product photo.
//
// Matches the phrases Luis produces for payment_info intent (see system prompt)
// and the bank account image caption injected by the payment_info handler.
// Scans the last 10 turns — enough to cover a full payment exchange without
// reaching back into an unrelated prior session.
export function hasRecentPaymentInfoContext(turns: ConversationTurn[]): boolean {
  // Check ALL stored turns — not just the last 10.
  // With MAX_CONVERSATION_TURNS = 20 we now keep up to 20 turns in the DB.
  // Hardcoding slice(-10) would miss the [payment_info_sent] sentinel if
  // more than 10 turns arrived after payment_info (follow-up questions about
  // color, delivery, size, etc. between the bank account send and the receipt).
  // Since hasRecentPaymentInfoContext is only a boolean gate (did we ever send
  // payment info in this conversation?), scanning all stored turns is correct.
  const sentinelPattern = /\[payment_info_sent\]/;
  const legacyPattern =
    /datos.*pago|ahorita te mando.*datos|datos para.*dep[oó]sito|datos bancarios|te mando los datos|informaci[oó]n.*pago|bancarios para tu dep[oó]sito|aqu[ií].*te los comparto|aqu[ií].*van los datos/i;
  return turns.some(
    (t) =>
      t.role === "assistant" &&
      (sentinelPattern.test(t.content) || legacyPattern.test(t.content)),
  );
}

// ─── Cart helpers ─────────────────────────────────────────────────────────────

// A parsed product selection extracted from conversation history.
// description is the human-readable product line from Luis's ⭐️ confirmation format.
// price is parsed from the line if present — used for display in the ack message.
export type CartItem = {
  description: string;
  price?: number;
};

// Scans recent assistant turns for ⭐️ lines (Luis's order confirmation format):
//   "⭐️Bra Alo color negro Talla S $2,190"
//   "⭐️ Legging Alo color negro talla S"
// Returns one CartItem per distinct product line, deduplicating across turns
// (Claude sometimes repeats the summary across multiple messages).
//
// This is the backend's "shopping cart" — used on the image receipt path where
// Claude is not in the loop, and as a fallback on the text receipt path when
// Claude provides no orderHints.
export function extractCartFromHistory(turns: ConversationTurn[]): CartItem[] {
  const recentTurns = turns.slice(-15);
  const seen = new Set<string>();
  const items: CartItem[] = [];

  // ── PASS 1: ⭐️ confirmed order lines across ALL turns ──────────────────────────
  // Complete this pass before running any secondary extraction. Previously,
  // secondary ran per-turn inside the loop with "if (items.length === 0)",
  // which caused it to extract from turn A (no ⭐️ yet) while primary later
  // extracted from turn B (⭐️ present) — producing duplicate product entries.
  for (const turn of recentTurns) {
    if (turn.role !== "assistant") continue;
    const starLines = turn.content.match(/⭐️\s*([^\n]+)/g) ?? [];
    for (const raw of starLines) {
      const line = raw.replace(/^⭐️\s*/, "").trim();
      if (/^\[|\bTotal\b/i.test(line)) continue;
      const priceMatch = line.match(/\$\s*([\d,]+)\s*$/);
      const price = priceMatch
        ? parseInt(priceMatch[1].replace(/,/g, ""), 10)
        : undefined;
      const description = line
        .replace(/[-–—]?\s*\$[\d,.\s]+$/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!description || seen.has(description)) continue;
      seen.add(description);
      items.push({ description, price });
    }
  }

  // Primary found items — stop here, do not run secondary/tertiary.
  if (items.length > 0) return items;

  // ── PASS 2: secondary — natural language price mentions ─────────────────────
  // Only runs when PASS 1 found nothing (no ⭐️ lines in any turn).
  // Handles gallery reply → price_query → payment_info flows where create_order
  // was never called, so no ⭐️ lines were produced.
  for (const turn of recentTurns) {
    if (turn.role !== "assistant") continue;
    const priceContextMatch = turn.content.match(
      /(?:el|la|los|disponible\s+el?)\s+([A-Za-záéíóúüñA-ZÁÉÍÓÚÜÑ][A-Za-záéíóúüñA-ZÁÉÍÓÚÜÑ\s]+?)(?:\s+en\s+talla\s+\w+)?\s*[!.]?\s*(?:Está|está|cuesta|vale)\s+a?\s*\$\s*([\d,]+)/i,
    );
    if (priceContextMatch) {
      const description = priceContextMatch[1].trim().replace(/\s+/g, " ");
      const price = parseInt(priceContextMatch[2].replace(/,/g, ""), 10);
      if (description.length > 2 && !seen.has(description)) {
        seen.add(description);
        items.push({ description, price: isNaN(price) ? undefined : price });
        break; // one product from natural language is enough
      }
    }
  }

  if (items.length > 0) return items;

  // ── PASS 3: tertiary — [Producto exacto seleccionado] tag ───────────────────
  // Injected by webhook.service.ts on gallery replies. Most reliable source
  // when the customer sent the receipt before any ⭐️ summary was produced.
  for (const turn of recentTurns) {
    if (turn.role !== "user") continue;
    const tagMatch = turn.content.match(
      /\[Producto exacto seleccionado por el cliente:\s*([^\]]+)\]/,
    );
    if (tagMatch) {
      const productName = tagMatch[1].trim();
      if (productName && !seen.has(productName)) {
        let foundPrice: number | undefined;
        for (const t of recentTurns) {
          if (t.role !== "assistant") continue;
          const priceMatch = t.content.match(/\$\s*([\d,]+)/);
          if (priceMatch) {
            const p = parseInt(priceMatch[1].replace(/,/g, ""), 10);
            if (!isNaN(p) && p > 0) {
              foundPrice = p;
              break;
            }
          }
        }
        seen.add(productName);
        items.push({ description: productName, price: foundPrice });
      }
      break;
    }
  }

  return items;
}
