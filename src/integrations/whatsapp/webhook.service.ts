import mongoose from "mongoose";
import { CustomerModel } from "#/modules/customers/customer.model.js";
import { OrderModel } from "#/modules/orders/order.model.js";
import { ProductModel } from "#/modules/products/product.model.js";
import {
  ConversationModel,
  MAX_CONVERSATION_TURNS,
} from "#/modules/conversations/conversation.model.js";
import { SentImageModel } from "#/modules/sentImages/sentImage.model.js";
import { PendingPaymentModel } from "#/modules/pendingPayments/pendingPayment.model.js";
import { createOrder } from "#/modules/orders/order.service.js";
import { processMessage } from "#/integrations/whatsapp/claude.service.js";
import { searchProductsByImage } from "#/integrations/whatsapp/image-search.service.js";
import { CUSTOMER_GENDERS } from "#/modules/customers/customer.types.js";
import { logger } from "#/config/logger.js";
import {
  findBoutiqueByPhoneNumberId,
  findBoutiqueByPhoneNumberIdWithToken,
} from "#/modules/boutiques/boutique.service.js";
import {
  getCachedBoutique,
  setCachedBoutique,
} from "#/modules/boutiques/boutique.cache.js";
import {
  getConversationMode,
  trackIncomingMessage,
  checkAndApplyAutoResume,
} from "#/modules/conversationState/conversationState.service.js";
import { registerOrUpdateProspect } from "#/modules/prospect/prospect.service.js";
import { sendOwnerAlert } from "#/integrations/whatsapp/alert.service.js";
import type { WebhookPayload } from "#/integrations/whatsapp/webhook.validation.js";

import {
  buildErrorReply,
  buildEscalationMessage,
  buildReceiptAck,
  orderHintsToCart,
  buildPaymentReceiptEscalation,
} from "#/integrations/whatsapp/webhook.escalation.js";

import {
  hasRecentPaymentInfoContext,
  extractCartFromHistory,
} from "#/integrations/whatsapp/webhook.cart.js";

import {
  toValidUrl,
  normalizeProductImages,
  findProductByHint,
  searchProductsForClaude,
} from "#/integrations/whatsapp/webhook.product-search.js";

import {
  productImageSchema,
  ProductImage,
  webhookResultSchema,
  WebhookResult,
  emptyResult,
  toSafeResult,
  processMessageResultSchema,
  ProcessMessageResult,
  imageSearchResultSchema,
  markMessageProcessed,
  unmarkMessageProcessed,
  normalizePhoneForLookup,
} from "#/integrations/whatsapp/webhook.schemas.js";

// ─── Business info ────────────────────────────────────────────────────────────
//
// Per-tenant business config now lives on the boutique document in MongoDB
// (boutique.businessInfo). The hardcoded BUSINESS_INFO constant that used to
// live here was removed when multi-tenant support landed — the handler reads
// the boutique by phoneNumberId at the start of every request and passes
// boutique.businessInfo to ClaudeContext + escalation builders.

// ─── Service ──────────────────────────────────────────────────────────────────

// Tracks whether THIS request inserted the dedup marker, so the wrapper below
// can roll it back if processing throws afterwards.
type DedupMarker = { messageId: string | null; boutiqueId: string | null };

// Thin wrapper around the orchestrator: if processing throws AFTER the dedup
// marker was inserted, delete the marker before rethrowing. Without this, the
// marker is permanent on failure and the n8n retry (controller returns 500 →
// n8n redelivers) is silently dropped as a duplicate. The orchestrator has too
// many success exits to move the marker to the end safely — compensating
// rollback on the single error path is the smaller, safer change.
export const handleIncomingMessage = async (
  payload: WebhookPayload,
): Promise<WebhookResult> => {
  const dedupMarker: DedupMarker = { messageId: null, boutiqueId: null };
  try {
    return await processIncomingMessage(payload, dedupMarker);
  } catch (err) {
    if (dedupMarker.messageId && dedupMarker.boutiqueId) {
      await unmarkMessageProcessed(
        dedupMarker.messageId,
        dedupMarker.boutiqueId,
      );
    }
    throw err;
  }
};

const processIncomingMessage = async (
  payload: WebhookPayload,
  dedupMarker: DedupMarker,
): Promise<WebhookResult> => {
  const rawFrom = payload.from;
  const from = normalizePhoneForLookup(rawFrom);
  const messageType = payload.messageType;
  const message =
    typeof payload.message === "string" ? payload.message.trim() : "";
  // Effective idempotency key. When n8n delivers a merged buffer claim it
  // forwards mergedMessageId — a deterministic hash of the constituent message
  // ids (see buffer.service.ts). A merged claim has no single per-burst
  // messageId, so without this the dedup gate and createOrder's idempotency
  // index would both be inert and an n8n retry could double-process. Prefer
  // mergedMessageId; fall back to the raw messageId for non-buffered deliveries.
  const messageId =
    typeof payload.mergedMessageId === "string" && payload.mergedMessageId.trim()
      ? payload.mergedMessageId.trim()
      : typeof payload.messageId === "string" && payload.messageId.trim()
        ? payload.messageId.trim()
        : null;

  // Detected by Extract Message node when WhatsApp message has context.id
  // (customer replied directly to one of the gallery images). The prefix is
  // prepended in n8n so the backend can gate image suppression independently
  // of Claude's intent decision.
  //
  // TWO detection methods — both checked because the buffer merge (Normalize
  // Claim Response) may concatenate messages in a way that moves the prefix
  // away from position 0, causing startsWith to miss it:
  //
  //   Method A: message starts with the prefix (single message, not buffered)
  //   Method B: contextMessageId is present in the payload (survives buffer
  //             merge because it comes from the WhatsApp API, not text manipulation)
  //
  // Either signal is sufficient — OR logic covers both paths.
  // contextMessageId is set by Extract Message node when the customer replies
  // to a specific WhatsApp message. Defined in WebhookPayload via webhook.validation.ts.
  const contextMessageId =
    typeof payload.contextMessageId === "string" &&
    payload.contextMessageId.trim().length > 0
      ? payload.contextMessageId.trim()
      : null;

  let isGalleryReply =
    message.includes(
      "[El cliente está respondiendo a una imagen del gallery anterior]",
    ) || contextMessageId !== null;

  // ── 0. Guards ─────────────────────────────────────────────────────────────

  if (!from) {
    logger.info(
      {
        rawFrom: payload.from,
        messageType: payload.messageType,
        messageId: payload.messageId,
      },
      "Ignoring non-message webhook event — empty or invalid from field after normalization",
    );
    return emptyResult();
  }

  if (rawFrom && rawFrom !== from) {
    logger.info(
      { rawFrom, normalizedFrom: from, messageId },
      "Normalized WhatsApp phone number",
    );
  }

  if (messageType && messageType !== "text" && messageType !== "image") {
    logger.info(
      { from, messageType, messageId },
      "Ignoring unsupported WhatsApp message type",
    );
    return emptyResult();
  }
  // NOTE: if messageType is undefined (not provided by n8n), the guard above
  // is falsy and execution falls through to the text handler below — treating
  // undefined type as a text message. This is intentional and correct behavior.

  if (messageType === "image" && !payload.imageMediaId) {
    logger.info(
      { from, messageId },
      "Ignoring image webhook event without imageMediaId",
    );
    return emptyResult();
  }

  if ((messageType === "text" || !messageType) && !message) {
    logger.info(
      { from, messageId, messageType },
      "Ignoring empty text-like WhatsApp event",
    );
    return emptyResult();
  }

  // ── 0b. Resolve tenant (boutique) ─────────────────────────────────────────
  // Look up the boutique by the Meta phone_number_id from the payload.
  // phoneNumberId is required to identify the tenant: when it is missing
  // (e.g. an n8n workflow not yet sending it) the message is dropped — we log
  // a warning and return emptyResult() (no reply). The single-tenant fallback
  // to "the only active boutique" has been removed.
  const phoneNumberId = payload.phoneNumberId;
  if (!phoneNumberId) {
    logger.warn(
      { from },
      "[webhook] phoneNumberId missing — cannot identify boutique, skipping message",
    );
    return emptyResult();
  }
  // Check the in-memory cache first to avoid a DB read on every message.
  // On miss, load from DB (with decrypted accessToken) and populate the cache.
  let boutique = getCachedBoutique(phoneNumberId);
  if (!boutique) {
    boutique = await findBoutiqueByPhoneNumberIdWithToken(phoneNumberId);
    if (boutique) {
      setCachedBoutique(phoneNumberId, boutique);
    }
  }

  if (!boutique) {
    logger.error(
      { phoneNumberId, from, messageId },
      "Boutique not found for phoneNumberId — rejecting message",
    );
    return toSafeResult(
      {
        reply: "Lo siento, este servicio no está disponible en este momento.",
        escalate: true,
        customerPhone: from,
        customerName: payload.contactName ?? "Cliente",
        productImages: [],
        escalationMessage: `Mensaje recibido en número no registrado: ${phoneNumberId ?? "(sin phoneNumberId en payload)"}`,
      },
      from,
      payload.contactName ?? null,
    );
  }

  const boutiqueId = boutique._id.toString();

  // ─── Boutique-wide kill switch ────────────────────────────────────────────
  // globalMode "manual" silences the bot for EVERY conversation of this
  // boutique — the owner is handling all chats manually. This runs before the
  // per-conversation conversationMode gate (section 3) because the boutique-wide
  // switch always takes priority. Returns emptyResult so n8n sends nothing.
  if (boutique.globalMode === "manual") {
    logger.info(
      { boutiqueId, from, messageId },
      "Boutique globalMode is manual — bot silent for entire boutique",
    );
    return emptyResult();
  }

  // ─── Idempotency gate ─────────────────────────────────────────────────────
  // Must run before any bookkeeping (prospect bump, message count, etc.)
  // so duplicate deliveries are fully no-ops, not partial side-effects.
  if (messageId && !(await markMessageProcessed(messageId, boutiqueId))) {
    logger.info(
      { messageId, boutiqueId, from },
      "[webhook] duplicate message — skipping before bookkeeping",
    );
    return emptyResult();
  }
  // Marker inserted by this request — record it so the handleIncomingMessage
  // wrapper can roll it back if anything below throws. Duplicate deliveries
  // never reach here, so a failed duplicate can never erase the original marker.
  if (messageId) {
    dedupMarker.messageId = messageId;
    dedupMarker.boutiqueId = boutiqueId;
  }

  // ── 0c. Hybrid pipeline bookkeeping ───────────────────────────────────────
  // Runs for every inbound message (text or image) BEFORE any Claude call.
  // Uses the conversationState (ai/human/paused gate) and prospect (CRM
  // pipeline) modules — both scoped by boutiqueId. The mode gate itself is
  // applied later, at the start of the text flow (section 3).
  //
  // NOTE: Owner-reply detection (coexistence handoff) is intentionally NOT
  // wired here — the normalized n8n payload carries only customer messages
  // (no statuses / recipient_id / business display number), so owner replies
  // from the WhatsApp Business App never reach this endpoint. That requires an
  // n8n change to forward status/echo events first. See report / tech debt.

  // B. Auto-resume: if this conversation was handed to a human with a timer
  //    that has now elapsed, flip it back to "ai" before the mode is read.
  await checkAndApplyAutoResume(boutiqueId, from);

  // C. Register / refresh the prospect, and alert the owner the first time we
  //    ever see this number.
  const { isNew: isNewProspect } = await registerOrUpdateProspect(
    boutiqueId,
    from,
    payload.contactName,
  );

  if (isNewProspect && boutique.ownerPhone && boutique.accessToken) {
    await sendOwnerAlert({
      ownerPhone: boutique.ownerPhone,
      phoneNumberId, // validated non-null above; same value the boutique matched
      accessToken: boutique.accessToken,
      customerPhone: from,
      alertType: "new_prospect",
    });
  } else if (isNewProspect) {
    logger.warn(
      {
        boutiqueId,
        reason: !boutique.ownerPhone
          ? "missing ownerPhone"
          : "missing accessToken",
      },
      "Owner alert skipped — boutique missing required fields",
    );
  }

  // D. Track the inbound message on the conversation-state counter.
  await trackIncomingMessage(boutiqueId, from);

  // ── 1. Identify / create customer ─────────────────────────────────────────

  let customer;
  try {
    customer = await CustomerModel.findOneAndUpdate(
      { boutiqueId, phone: from },
      {
        $setOnInsert: {
          boutiqueId,
          name: payload.contactName ?? `WhatsApp ${from}`,
          phone: from,
          contactChannel: "whatsapp",
          gender: CUSTOMER_GENDERS.UNKNOWN,
          isActive: true,
          tags: [],
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ).lean();
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: number }).code === 11000
    ) {
      // Upsert race: two buffered messages from the same new customer can both
      // miss the findOne and race the insert; the loser gets E11000 on the
      // unique { boutiqueId, phone } index. The customer now exists — fetch it.
      // Same pattern as prospect.service.ts.
      logger.info(
        { boutiqueId, from, messageId },
        "Customer upsert E11000 race — fetching existing document",
      );
      customer = await CustomerModel.findOne({ boutiqueId, phone: from }).lean();
    } else {
      throw err;
    }
  }

  if (!customer) {
    logger.error({ phone: from }, "Customer upsert returned null — unexpected");
    return toSafeResult(emptyResult(), from);
  }

  if (payload.contactName && customer.name === `WhatsApp ${from}`) {
    await CustomerModel.updateOne(
      { _id: customer._id },
      { $set: { name: payload.contactName } },
    );
    customer.name = payload.contactName;
    logger.info(
      { customerId: customer._id.toString(), from },
      "Updated customer placeholder name",
    );
  }

  const customerId = customer._id.toString();
  const customerName =
    customer.name !== `WhatsApp ${from}` ? customer.name : null;
  const customerGender = (customer.gender ?? CUSTOMER_GENDERS.UNKNOWN) as
    | "female"
    | "male"
    | "unknown";

  // ── 1b. Load conversation — used by both image receipt detection and text flow ──
  //
  // Loaded here (before the image/text branch) so the receipt classifier in
  // section 2 can inspect recent turns without a second DB round-trip.
  // The full conversation history window for Claude is assembled in section 3.
  const conversation = await ConversationModel.findOne({
    customerId,
    channel: "whatsapp",
  }).lean();

  const allTurns = conversation?.turns ?? [];
  const lastMessageAt = conversation?.lastMessageAt;

  // ── Method C — refine isGalleryReply using conversation history ───────────
  // Methods A and B (above) cover single-message gallery replies correctly.
  // They fail when multiple rapid messages are buffered together: the buffer
  // merge may drop the [El cliente está respondiendo] prefix AND
  // Normalize Claim Response may not forward contextMessageId correctly.
  //
  // Method C catches the case where:
  //   - recent history shows a [Productos enviados] note (gallery was sent)
  //   - the merged message contains demonstrative language pointing at a
  //     specific product ("me interesa este", "ese suéter", "esta prenda")
  //
  // This is intentionally conservative — requires BOTH signals to avoid
  // false-positives on messages like "quiero ese estilo" with no gallery context.
  if (!isGalleryReply) {
    const hasRecentGallery = allTurns
      .slice(-6)
      .some(
        (t) =>
          t.role === "assistant" &&
          t.content.includes("[Productos enviados al cliente en este turn:"),
      );

    // Word-order variants covered:
    //   "me interesa este" (original), "Este me interesa" (reversed — common customer phrasing)
    //   "que precio tiene / cuesta / vale" (direct price ask about a shown product)
    //   "lo quiero / me lo llevo / lo aparto" (selection confirmation)
    //   "ese suéter / este jersey / esa prenda" (demonstrative + garment noun)
    const hasDemonstrativeProductIntent =
      /\b(este|ese|esta|esa)\s+me\s+interesa\b/i.test(message) || // "Este me interesa"
      /\bme\s+interesa\s+(este|ese|esta|esa)\b/i.test(message) || // "me interesa este"
      /\bqu[eé]\s+precio\b.{0,25}(tiene|cuesta|vale|cobras?)/i.test(message) || // "que precio tiene"
      /\b(lo|la)\s+(quiero|llevo|pido|aparto)\b/i.test(message) || // "lo quiero"
      /\b(este|ese|esta|esa)\b.{0,40}(suéter|jersey|bra|top|legging|producto|prenda|modelo|ropa)/i.test(
        message,
      );

    if (hasRecentGallery && hasDemonstrativeProductIntent) {
      isGalleryReply = true;
      logger.info(
        { customerId, messageId },
        "isGalleryReply=true via Method C (demonstrative language + recent gallery history)",
      );
    }
  }

  // 24h reset: if the customer's last message was over 24 hours ago, treat as
  // a fresh session — don't send yesterday's product gallery context to Claude.
  const isStaleConversation =
    lastMessageAt &&
    Date.now() - new Date(lastMessageAt).getTime() > 24 * 60 * 60 * 1000;

  // ── Hybrid gate ───────────────────────────────────────────────────────────
  // F. Check the conversation mode BEFORE either branch (image or text).
  //    "human"/"paused" → the bot stays silent (owner is handling it, or it is
  //    muted); return an empty result so n8n sends nothing. Only "ai" mode
  //    continues. Auto-resume already ran in section 0c, so an elapsed human
  //    handoff has been flipped back to "ai".
  //
  //    This MUST run before the image branch below: otherwise an incoming image
  //    (receipt ack, escalation, visual search) is processed and returned while
  //    an owner has taken over the conversation, bypassing the handoff. The
  //    boutique-wide globalMode: "manual" switch (section 0b) still runs first;
  //    this adds the per-conversation gate so both kill switches cover images.
  const conversationMode = await getConversationMode(boutiqueId, from);
  if (conversationMode !== "ai") {
    logger.info(
      { boutiqueId, from, messageId, conversationMode },
      "Conversation not in AI mode — skipping (bot stays silent)",
    );
    return emptyResult();
  }

  // ── 2. Image message ──────────────────────────────────────────────────────

  if (messageType === "image") {
    // ── 2a. Payment receipt detection ─────────────────────────────────────
    // An incoming image is treated as a payment receipt if EITHER:
    //
    //   Signal A — Conversation context: a payment_info turn exists in the
    //   last 10 turns (bank account info was recently sent). Detected via
    //   [payment_info_sent] sentinel or legacy phrase patterns.
    //
    //   Signal B — Message caption: the customer's text alongside the image
    //   contains explicit payment language ("aquí está el depósito", "ya pagué",
    //   "comprobante", etc.). This catches cases where the payment_info turn is
    //   outside the detection window or the sentinel is missing (pre-deploy turns).
    //
    // Both signals skip searchProductsByImage, which would otherwise run a
    // catalog search on a bank receipt photo and return 0 results → SAFE_FALLBACK.
    const receiptCaptionPattern =
      /comprobante|ya pagu[eé]|ya deposit[eé]|aqu[ií] est[aá] el dep[oó]sito|aqu[ií] el dep[oó]sito|aqu[ií] el pago|te mand[oé] el dep[oó]sito|hice el dep[oó]sito|hice la transferencia|realic[eé] el pago|ya transfer[ií]/i;
    const isReceiptByContext = hasRecentPaymentInfoContext(allTurns);
    const isReceiptByCaption = receiptCaptionPattern.test(message);
    const isLikelyReceipt = isReceiptByContext || isReceiptByCaption;

    logger.info(
      {
        customerId,
        messageId,
        isReceiptByContext,
        isReceiptByCaption,
        isLikelyReceipt,
      },
      "Payment receipt detection signals",
    );

    if (isLikelyReceipt) {
      logger.info(
        { customerId, mediaId: payload.imageMediaId, messageId },
        "Image message after payment_info context — treating as payment receipt, skipping product search",
      );

      // Extract product selections from conversation history so the ack message
      // shows the customer what they're confirming — not a generic "what do you want?"
      const cart = extractCartFromHistory(allTurns);
      const receiptAck = buildReceiptAck(customerGender, cart);

      logger.info(
        { customerId, cartItems: cart.length },
        "Payment receipt — built cart-aware ack from conversation history",
      );

      // Persist cart for owner-confirm endpoint — same upsert as the
      // Claude text path. Image receipts bypass Claude so this is the
      // only place to write pendingPayments on the image path.
      if (cart.length > 0) {
        await PendingPaymentModel.findOneAndUpdate(
          { boutiqueId, customerPhone: from },
          {
            $set: {
              customerName,
              cart: cart.map((item) => {
                const desc = item.description;

                // Cart extraction uses heuristic regex — items whose ⭐️ line
                // doesn't match the expected format default to size/color "?".
                // ownerConfirm skips "?" items, which can yield an empty cart
                // requiring fully manual order entry. Known limitation.

                // Extract size — matches "Talla S", "Talla XS", "Talla XXL"
                const sizeMatch = desc.match(/\bTalla\s+([A-Z]{1,4})\b/i);
                const size = sizeMatch ? sizeMatch[1].toUpperCase() : "?";

                // Extract color — strategy depends on description format:
                // Pipe-delimited: "... | ALO | Paradise Pink | Talla S | ..."
                //   → take the segment immediately before the "Talla" segment
                // Space-delimited: "... color negro Talla S ..."
                //   → take the word(s) after "color"
                let color = "?";

                if (desc.includes("|")) {
                  // Split on pipe, trim each segment, find the one right before
                  // the segment that starts with "Talla"
                  const segments = desc.split("|").map((s) => s.trim());
                  const tallaIndex = segments.findIndex((s) =>
                    /^Talla\s+/i.test(s),
                  );
                  if (tallaIndex > 0) {
                    color = segments[tallaIndex - 1];
                  }
                } else {
                  // Space-delimited: extract word(s) after "color"
                  const colorMatch = desc.match(
                    /\bcolor\s+([A-Za-záéíóúüñÁÉÍÓÚÜÑ]+(?:\s+[A-Za-záéíóúüñÁÉÍÓÚÜÑ]+)?)\b/i,
                  );
                  if (colorMatch) color = colorMatch[1].trim();
                }

                return {
                  productNameHint: desc,
                  size,
                  color,
                  quantity: 1,
                };
              }),
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            },
          },
          { upsert: true, returnDocument: "after" },
        ).catch((err) => {
          logger.warn(
            { err, boutiqueId, customerPhone: from },
            "pendingPayments upsert failed (image path) — non-critical",
          );
        });
        logger.info(
          { boutiqueId, customerPhone: from, cartItems: cart.length },
          "pendingPayments upsert — cart saved for owner-confirm (image path)",
        );
      }

      // Persist the receipt turn so subsequent text messages have this context.
      // Storing "[Comprobante de pago enviado]" as the user turn prevents Claude
      // from treating the next message as coming out of nowhere.
      await ConversationModel.findOneAndUpdate(
        { customerId, channel: "whatsapp" },
        {
          $push: {
            turns: {
              $each: [
                {
                  role: "user" as const,
                  content: "[Comprobante de pago enviado por el cliente]",
                  createdAt: new Date(),
                },
                {
                  role: "assistant" as const,
                  content: receiptAck,
                  createdAt: new Date(),
                },
              ],
              $slice: -MAX_CONVERSATION_TURNS,
            },
          },
          $set: { lastMessageAt: new Date() },
          $setOnInsert: { boutiqueId: new mongoose.Types.ObjectId(boutiqueId) },
        },
        { upsert: true, returnDocument: "after", runValidators: true },
      );

      // E. Notify the owner that a payment receipt arrived so they can verify
      //    and confirm the order. Non-blocking — sendOwnerAlert never throws.
      //    The customer-facing acknowledgment (receiptAck) is already built
      //    above and returned below, so no separate customer reply is needed.
      if (boutique.ownerPhone && boutique.accessToken) {
        await sendOwnerAlert({
          ownerPhone: boutique.ownerPhone,
          phoneNumberId, // validated non-null above; same value the boutique matched
          accessToken: boutique.accessToken,
          customerPhone: from,
          alertType: "receipt_received",
        });
      } else {
        logger.warn(
          {
            boutiqueId,
            reason: !boutique.ownerPhone
              ? "missing ownerPhone"
              : "missing accessToken",
          },
          "Owner alert skipped — boutique missing required fields",
        );
      }

      return toSafeResult(
        {
          reply: receiptAck,
          escalate: true,
          customerPhone: from,
          customerName,
          productImages: [],
          escalationMessage: buildPaymentReceiptEscalation({
            customerPhone: from,
            customerName,
            cart,
            shippingPrice: boutique.businessInfo.shippingPrice,
          }),
        },
        from,
        customerName,
        customerGender,
      );
    }

    // ── 2b. Gallery reply via image ───────────────────────────────────────────
    // When the customer sends an image while responding to a previous gallery
    // (isGalleryReply=true), they are selecting or asking about a product already
    // shown — NOT doing a new visual search. Calling searchProductsByImage here
    // would re-run the catalog query and return the full gallery again (the exact
    // bug reported: customer says "Este me interesa / Que precio tiene" and gets
    // all products again instead of the specific price).
    //
    // Fix: skip searchProductsByImage, inject the gallery reply tag into the
    // message, and fall through to section 3 (Claude text flow) where the
    // [Productos enviados] note and SentImage lookup resolve the exact product.
    if (isGalleryReply) {
      logger.info(
        { customerId, mediaId: payload.imageMediaId, messageId },
        "Image message is a gallery reply — skipping searchProductsByImage, routing to Claude text flow",
      );
      // Fall through to section 3 below — do NOT return here.
      // incomingMessageForClaude will receive the gallery prefix in section 3.
    } else {
      // ── 2c. Product image search — fresh search (not a gallery reply) ──────

      logger.info(
        { customerId, mediaId: payload.imageMediaId, messageId },
        "Image message — running visual search",
      );

      const fallbackReply = buildErrorReply(customerGender);

      try {
        const rawSearchResult = await searchProductsByImage(
          payload.imageMediaId as string,
          // A boutique matched by an active phoneNumberId is WhatsApp-connected,
          // so its accessToken is present (set alongside phoneNumberId at signup).
          boutique.accessToken as string,
          // Tenant scope — resolved from the boutique document at the top of
          // handleIncomingMessage; keeps visual search within this boutique only.
          boutiqueId,
        );
        const searchResult = imageSearchResultSchema.safeParse(rawSearchResult);
        if (!searchResult.success) {
          throw new Error(
            `searchProductsByImage returned unexpected shape: ${JSON.stringify(searchResult.error.issues)}`,
          );
        }

        const {
          reply,
          productImages: rawProductImages,
          shouldEscalate,
        } = searchResult.data;
        const productImages = normalizeProductImages(rawProductImages);

        // Escalate ONLY on a persistent failure flagged by the search service
        // (network/token/non-JSON vision output). A clean 0-match returns
        // shouldEscalate=false so a normal "no encontré nada" does not alert the
        // owner. Build an escalation message so the owner gets context.
        const imageSearchEscalationMessage = shouldEscalate
          ? buildEscalationMessage({
              customerPhone: from,
              customerName,
              customerMessage: "[Imagen enviada por el cliente]",
              reason:
                "La búsqueda visual por imagen falló de forma persistente (descarga de Meta, token, o salida no-JSON del modelo de visión).",
              suggestedAction:
                "Revisar logs de Railway. Responder al cliente manualmente con productos similares a la imagen enviada.",
            })
          : undefined;

        await ConversationModel.findOneAndUpdate(
          { customerId, channel: "whatsapp" },
          {
            $push: {
              turns: {
                $each: [
                  {
                    role: "user" as const,
                    content: "[Imagen enviada por el cliente]",
                    createdAt: new Date(),
                  },
                  {
                    role: "assistant" as const,
                    content: reply,
                    createdAt: new Date(),
                  },
                ],
                $slice: -MAX_CONVERSATION_TURNS,
              },
            },
            $set: { lastMessageAt: new Date() },
            $setOnInsert: { boutiqueId: new mongoose.Types.ObjectId(boutiqueId) },
          },
          { upsert: true, returnDocument: "after", runValidators: true },
        );

        return toSafeResult(
          {
            reply,
            escalate: shouldEscalate,
            customerPhone: from,
            customerName,
            productImages,
            escalationMessage: imageSearchEscalationMessage,
          },
          from,
          customerName,
        );
      } catch (err) {
        logger.error(
          { err, customerId, mediaId: payload.imageMediaId, messageId },
          "Image search failed",
        );

        await ConversationModel.findOneAndUpdate(
          { customerId, channel: "whatsapp" },
          {
            $push: {
              turns: {
                $each: [
                  {
                    role: "user" as const,
                    content: "[Imagen enviada por el cliente]",
                    createdAt: new Date(),
                  },
                  {
                    role: "assistant" as const,
                    content: fallbackReply,
                    createdAt: new Date(),
                  },
                ],
                $slice: -MAX_CONVERSATION_TURNS,
              },
            },
            $set: { lastMessageAt: new Date() },
            $setOnInsert: { boutiqueId: new mongoose.Types.ObjectId(boutiqueId) },
          },
          { upsert: true, returnDocument: "after", runValidators: true },
        );

        return toSafeResult(
          {
            reply: fallbackReply,
            escalate: true,
            customerPhone: from,
            customerName,
            productImages: [],
            escalationMessage: buildEscalationMessage({
              customerPhone: from,
              customerName,
              customerMessage: "[Imagen enviada por el cliente]",
              reason:
                "La búsqueda visual por imagen falló con un error interno.",
              suggestedAction:
                "Revisar logs de Railway. Responder al cliente manualmente con productos similares a la imagen enviada.",
            }),
          },
          from,
          customerName,
        );
      }
    } // end else — fresh visual search (not a gallery reply)
  }

  // ── 3. Text message — Luis flow ───────────────────────────────────────────
  // The hybrid gate (conversation mode) was already applied above, before the
  // image branch, so both image and text paths are silenced in human/paused
  // mode. Only "ai" mode reaches here.

  // Build the history window for Claude.
  // allTurns and isStaleConversation are already resolved from section 1b.
  const MAX_HISTORY_TURNS_FOR_AI = 10;

  const conversationHistory = isStaleConversation
    ? []
    : allTurns.slice(-MAX_HISTORY_TURNS_FOR_AI).map((t) => ({
        role: t.role as "user" | "assistant",
        content: t.content,
      }));

  if (isStaleConversation) {
    logger.info(
      { customerId, lastMessageAt, messageId },
      "Stale conversation (>24h) — sending empty history to Claude",
    );
  }

  // NOTE: add { customerId: 1, createdAt: -1 } compound index on orders if
  // this sort becomes slow when order volume grows beyond pilot scale.
  // Tenant-scoped: customerId alone could surface another boutique's order
  // (e.g. legacy docs from before the boutiqueId backfill).
  const recentOrder = await OrderModel.findOne({
    customerId,
    boutiqueId: new mongoose.Types.ObjectId(boutiqueId),
  })
    .sort({ createdAt: -1 })
    .lean();

  // ── Exact product resolution via SentImage mapping ────────────────────────
  // When the customer replied to a specific gallery image (isGalleryReply=true
  // and contextMessageId is set), look up the exact product that was in that
  // WhatsApp message. The mapping was stored by the n8n "Log Sent Image" node
  // after each Send Image API response.
  //
  // If a match is found, replace the generic gallery hint in the message with
  // a precise product identifier so Claude answers the exact product — name,
  // price, color — without inferring from the full gallery list.
  //
  // Falls back gracefully: if no mapping exists (feature not yet active, or
  // the image was sent before this feature was deployed), the message remains
  // unchanged and Claude uses the [Productos enviados] note from history.
  let incomingMessageForClaude = message;

  // When the gallery reply was detected via Method C (image message path, no
  // contextMessageId — e.g. customer forwarded a photo + "Este me interesa"),
  // the message doesn't carry the gallery reply prefix that Methods A/B inject.
  // Add it here so Claude's gallery reply protocol fires correctly and it knows
  // to look at [Productos enviados] in history instead of calling search_products.
  if (
    isGalleryReply &&
    !incomingMessageForClaude.includes(
      "[El cliente está respondiendo a una imagen del gallery anterior]",
    ) &&
    !incomingMessageForClaude.includes(
      "[Producto exacto seleccionado por el cliente:",
    )
  ) {
    incomingMessageForClaude = `[El cliente está respondiendo a una imagen del gallery anterior]
${incomingMessageForClaude}`;
    logger.info(
      { customerId, messageId },
      "Injected gallery reply prefix into incomingMessageForClaude (Method C / image path)",
    );
  }

  if (isGalleryReply && contextMessageId) {
    try {
      // sentMessageId is globally unique (set by the Meta API).
      // No boutiqueId filter needed — the ID cannot collide across
      // tenants. If this assumption ever changes, add boutiqueId here.
      const sentImage = await SentImageModel.findOne({
        sentMessageId: contextMessageId,
      }).lean();

      if (sentImage?.caption) {
        // Replace the generic gallery hint with the exact product context.
        // Claude's gallery reply protocol (PASO 1) reads this tag and skips
        // the [Productos enviados] note lookup entirely — one product, direct answer.
        const exactContext = `[Producto exacto seleccionado por el cliente: ${sentImage.caption}]`;
        incomingMessageForClaude = message.replace(
          /\[El cliente está respondiendo a una imagen del gallery anterior\]/,
          exactContext,
        );

        logger.info(
          {
            customerId,
            messageId,
            contextMessageId,
            caption: sentImage.caption,
          },
          "Gallery reply — exact product resolved from SentImage mapping",
        );
      } else {
        logger.info(
          { customerId, messageId, contextMessageId },
          "Gallery reply — no SentImage mapping found, falling back to history inference",
        );
      }
    } catch (err) {
      // Non-fatal: log and continue with the original message.
      // Claude will still answer correctly using the [Productos enviados] note.
      logger.warn(
        { err, customerId, contextMessageId },
        "Gallery reply — SentImage lookup failed, falling back to history inference",
      );
    }
  }

  // Read cached lifetime value from the customer document — free, no extra query.
  // Populated and maintained by order.service.ts on order create/complete/cancel.
  // Undefined for customers with no orders yet (distinct from 0).
  // claude.service.ts buildVipContext uses this to set VIP vs. new-customer tone.
  const customerLifetimeValue: number | undefined =
    typeof customer.lifetimeValue === "number" && customer.lifetimeValue > 0
      ? customer.lifetimeValue
      : undefined;

  const rawResult = await processMessage({
    // Tenant scope — used by claude.service.ts to attribute token usage.
    boutiqueId,
    // Per-tenant agent identity. Mongoose infers string | null | undefined for
    // the optional fields; coerce null → undefined for the ClaudeContext contract.
    agentConfig: {
      agentName: boutique.agentConfig.agentName,
      categoryDescription: boutique.agentConfig.categoryDescription,
      brandKnowledge: boutique.agentConfig.brandKnowledge ?? undefined,
      phrases: boutique.agentConfig.phrases
        ? {
            paymentAck: boutique.agentConfig.phrases.paymentAck ?? undefined,
            orderConfirm: boutique.agentConfig.phrases.orderConfirm ?? undefined,
            negativeSticker:
              boutique.agentConfig.phrases.negativeSticker ?? undefined,
            affirmations: boutique.agentConfig.phrases.affirmations ?? undefined,
            closings: boutique.agentConfig.phrases.closings ?? undefined,
            emojiSet: boutique.agentConfig.phrases.emojiSet ?? undefined,
          }
        : undefined,
      discoveryCategories: boutique.agentConfig.discoveryCategories ?? undefined,
      upsellRules: boutique.agentConfig.upsellRules ?? undefined,
      sizeGuide: boutique.agentConfig.sizeGuide ?? undefined,
      customInstructions: boutique.agentConfig.customInstructions ?? undefined,
      personalityNotes: boutique.agentConfig.personalityNotes ?? undefined,
      // Legacy fallback — used by buildAgentSection only when no structured field
      // is present.
      salesInstructions: boutique.agentConfig.salesInstructions ?? undefined,
    },
    customerName,
    customerGender,
    customerLifetimeValue,
    recentOrder: recentOrder
      ? {
          orderNumber: recentOrder.orderNumber,
          status: recentOrder.status,
          total: recentOrder.total,
          // Pass optional fields if they exist on the order document.
          // These are typed as optional in ClaudeContext so undefined is safe.
          outstandingBalance: (
            recentOrder as unknown as Record<string, unknown>
          ).outstandingBalance as number | undefined,
          trackingNumber: (recentOrder as unknown as Record<string, unknown>)
            .trackingNumber as string | undefined,
          estimatedDelivery: (recentOrder as unknown as Record<string, unknown>)
            .estimatedDelivery as string | undefined,
          // Map order line items to the OrderItem shape expected by Claude.
          // Falls back to undefined if the order model doesn't have an items array.
          items: Array.isArray(
            (recentOrder as unknown as Record<string, unknown>).items,
          )
            ? (
                (recentOrder as unknown as Record<string, unknown>)
                  .items as Array<{
                  productName?: string; // schema field name — NOT "name"
                  size?: string;
                  color?: string;
                  quantity?: number;
                  unitPrice?: number;
                }>
              ).map((i) => ({
                name: i.productName ?? "Producto",
                size: i.size ?? "?",
                color: i.color ?? "?",
                quantity: i.quantity ?? 1,
                price: i.unitPrice ?? 0,
              }))
            : undefined,
        }
      : null,
    searchProducts: (hints) => searchProductsForClaude(boutiqueId, hints),
    incomingMessage: incomingMessageForClaude,
    conversationHistory,
    businessInfo: {
      ...boutique.businessInfo,
      // ClaudeContext expects string | undefined; Mongoose infers
      // string | null | undefined for the schema. Coerce here so a null
      // value in MongoDB doesn't break the type contract.
      activePromotion: boutique.businessInfo.activePromotion ?? undefined,
    },
  });

  const parsedResult = processMessageResultSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    logger.error(
      { issues: parsedResult.error.issues, rawResult, customerId, messageId },
      "processMessage returned unexpected shape — escalating",
    );

    // Persist the failed turn so Luis has context on the next message.
    // Without this, the conversation history has a gap and Luis may re-greet
    // or lose context mid-negotiation.
    const errorReply = buildErrorReply(customerGender);
    await ConversationModel.findOneAndUpdate(
      { customerId, channel: "whatsapp" },
      {
        $push: {
          turns: {
            $each: [
              {
                role: "user" as const,
                content: message,
                createdAt: new Date(),
              },
              {
                role: "assistant" as const,
                content: errorReply,
                createdAt: new Date(),
              },
            ],
            $slice: -MAX_CONVERSATION_TURNS,
          },
        },
        $set: { lastMessageAt: new Date() },
        $setOnInsert: { boutiqueId: new mongoose.Types.ObjectId(boutiqueId) },
      },
      { upsert: true, returnDocument: "after", runValidators: true },
    );

    return toSafeResult(
      {
        reply: errorReply,
        escalate: true,
        customerPhone: from,
        customerName,
        productImages: [],
        escalationMessage: buildEscalationMessage({
          customerPhone: from,
          customerName,
          customerMessage: message,
          reason:
            "Error interno — la respuesta del modelo no cumple el esquema esperado.",
          suggestedAction:
            "Revisar logs de Railway. Responder al cliente manualmente.",
        }),
      },
      from,
      customerName,
    );
  }

  const result: ProcessMessageResult = parsedResult.data;
  let escalate = result.intent === "needs_human";
  // Spread to a new array — prevents mutating result.productImages by reference.
  // payment_info later pushes the bank image into this array; without the spread,
  // that push would corrupt the original processMessage return value.
  const productImages: ProductImage[] = [...result.productImages];

  // ── Product image suppression — only send images for product_search intent ─
  // Product images are accumulated by the agentic loop whenever search_products
  // is called — including availability checks that are internal tool calls
  // (post-cotización protocol, gallery reply resolution, etc.).
  //
  // Sending product images is ONLY correct when the customer explicitly asked
  // to SEE products (catalog browse = product_search intent). For every other
  // intent, accumulated images are a side effect of availability verification
  // and must not flow to the customer:
  //
  //   payment_info  → bank account image is sent separately; product images confuse
  //   price_query   → text answer only
  //   general       → context recall / follow-up; no images unless explicitly asked
  //   catalog_query → asking clarifying question; no images yet
  //   create_order  → order confirmation; no images
  //   order_status  → status text; no images
  //   needs_human   → escalation; no images
  //   etc.
  //
  // This replaces the previous gallery-only guard (isGalleryReply &&
  // intent !== product_search) with a universal rule that is simpler,
  // safer, and correct for all conversation flows including demo stability.
  if (result.intent !== "product_search" && productImages.length > 0) {
    logger.info(
      {
        customerId,
        messageId,
        intent: result.intent,
        suppressedImages: productImages.length,
      },
      "Non-product_search intent — suppressing accumulated product images (availability check or context recall side effect)",
    );
    productImages.length = 0;
  }

  if (result.intent === "product_search") {
    logger.info(
      { matches: productImages.length, customerId, messageId },
      "Product search intent",
    );
    if (productImages.length === 0) {
      // Escalate when product_search returns 0 images.
      // The system prompt instructs Claude to attempt broader searches before
      // returning product_search with 0 results — reaching here means Claude
      // already exhausted its search attempts. Removed the searchHints guard:
      // escalation should fire regardless of whether searchHints is present,
      // since the customer received no products either way.
      //
      // INTENTIONAL — the intent itself is the graceful-handling signal (M-5,
      // tracked tech debt). When Claude handles a no-match gracefully (offers
      // alternatives, asks to clarify) it returns `general` / `catalog_query`,
      // NOT `product_search`, so it never reaches this branch. Returning
      // `product_search` with 0 images means Claude exhausted its searches and
      // still found nothing — a real failure the owner should see. So in
      // practice this escalates only on genuine misses, not graceful answers.
      // (If routing ever changes so graceful no-matches return product_search,
      // revisit this condition — see audit M-5.)
      escalate = true;
      logger.info(
        { customerId, messageId, searchHints: result.searchHints },
        "Product search 0 results — escalating",
      );
    }
  }

  // ── order_summary ─────────────────────────────────────────────────────────
  // Claude compiled the customer's accumulated order list from history.
  // No special backend action needed — Claude's response is the answer.
  // No escalation, no images. Falls through to the persist/return path below.
  if (result.intent === "order_summary") {
    logger.info(
      { customerId, messageId },
      "order_summary intent — passing Claude response through, no backend action required",
    );
  }

  // ── showroom_visit ────────────────────────────────────────────────────────
  // Customer wants to visit in person. Claude already replied with address +
  // hours. Escalate so the owner knows a visit is coming and can prepare.
  if (result.intent === "showroom_visit") {
    escalate = true;
    logger.info(
      { customerId, messageId },
      "showroom_visit intent — escalating so owner is aware of upcoming visit",
    );
  }

  // ── payment_receipt — customer sent or announced a payment comprobante ────
  // Intent set by Claude when the customer says "ya pagué", "aquí está el
  // comprobante", "ya transferí", etc. via text message.
  // (The image-receipt case is handled earlier in section 2a.)
  //
  // Claude's response already contains the cart summary (system prompt instructs
  // it to check history and include a numbered list). We just set escalate and
  // let the escalation builder below use orderHints for the owner message.
  //
  // We do NOT:
  //   - inject the bank account image (already sent in a prior payment_info turn)
  //   - create an order (payment must be verified first — owner confirms manually)
  if (result.intent === "payment_receipt") {
    escalate = true;
    logger.info(
      { customerId, messageId, cartItems: result.orderHints?.length ?? 0 },
      "payment_receipt intent — escalating to owner for payment verification",
    );

    // Persist cart so the owner-confirm endpoint can create the order
    // without re-reading conversation history. Upsert so a second receipt
    // from the same customer overwrites rather than duplicates.
    const pendingCart = result.orderHints?.length
      ? result.orderHints
      : extractCartFromHistory(allTurns).map((item) => ({
          productNameHint: item.description,
          size: "?",
          color: "?",
          quantity: 1,
        }));

    if (pendingCart.length > 0) {
      await PendingPaymentModel.findOneAndUpdate(
        { boutiqueId, customerPhone: from },
        {
          $set: {
            customerName,
            cart: pendingCart,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        },
        { upsert: true, returnDocument: "after" },
      ).catch((err) => {
        logger.warn(
          { err, boutiqueId, customerPhone: from },
          "pendingPayments upsert failed — non-critical, escalation still fires",
        );
      });
      logger.info(
        { boutiqueId, customerPhone: from, cartItems: pendingCart.length },
        "pendingPayments upsert — cart saved for owner-confirm",
      );
    }
  }

  // ── create_order ──────────────────────────────────────────────────────────

  if (result.intent === "create_order") {
    if (!result.orderHints?.length) {
      escalate = true;
      logger.warn(
        { customerId, messageId },
        "create_order without orderHints — escalate forced",
      );
    } else {
      try {
        // Fetch catalog here — only needed for create_order resolution.
        // Previously fetched unconditionally before processMessage, causing
        // a wasted DB round-trip on every greet, search, and general message.
        const catalogForOrders = await ProductModel.find({ boutiqueId, status: "active" })
          .select("name price")
          .lean();
        const catalog = catalogForOrders.map((p) => ({
          id: p._id.toString(),
          name: p.name,
          price: p.price,
        }));

        const resolvedItems = result.orderHints
          .map((hint) => {
            const product = findProductByHint(hint.productNameHint, catalog);
            if (!product) {
              logger.warn(
                { hint: hint.productNameHint, customerId, messageId },
                "Order hint unresolved — skipping item",
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
            "create_order had no resolvable items — escalate forced",
          );
        } else {
          const created = await createOrder(
            {
              boutiqueId,
              customerId,
              channel: "whatsapp",
              items: resolvedItems,
              notes: [
                {
                  message: "Pedido creado automáticamente desde WhatsApp.",
                  kind: "system",
                },
              ],
            },
            null,
            messageId,
          );
          logger.info(
            { orderNumber: created.orderNumber, customerId, messageId },
            "Order created from WhatsApp",
          );
        }
      } catch (err) {
        escalate = true;
        logger.error(
          { err, customerId, from, messageId },
          "Failed to create order — escalate forced",
        );
      }
    }
  }

  // ── payment_info — auto-send bank account image ───────────────────────────
  // When Luis detects a payment/deposit question it returns intent "payment_info".
  // The system injects the bank account image into productImages so the existing
  // image pipeline (IF Has Product Images → Send Image) delivers it automatically.
  // No n8n changes needed — reuses the existing gallery pipeline.
  if (result.intent === "payment_info") {
    // Two-step payment gate (backend enforcement of the PASO 2 rule): only
    // send the bank image after a prior assistant turn carries a ⭐️ order
    // summary, i.e. the explicit confirmation step already happened. The
    // system prompt instructs Claude to confirm first, but a misclassified
    // first payment ask must not leak the bank image early — the text reply
    // still goes through; only the image is gated.
    const hasPriorOrderSummary = conversationHistory.some(
      (turn) => turn.role === "assistant" && turn.content.includes("⭐️"),
    );
    if (boutique.bankAccountImageUrl && hasPriorOrderSummary) {
      productImages.push({
        url: boutique.bankAccountImageUrl,
        caption: "Datos bancarios para tu depósito 🏦",
      });
      logger.info(
        { customerId, messageId, boutiqueId: boutique._id.toString() },
        "payment_info — bank account image injected",
      );
    } else if (boutique.bankAccountImageUrl) {
      logger.info(
        { customerId, messageId, boutiqueId: boutique._id.toString() },
        "payment_info — bank image withheld: no prior ⭐️ order summary in history (two-step gate)",
      );
    } else {
      // Image URL not configured for this boutique — escalate so owner can
      // send details manually. The owner should set bankAccountImageUrl on
      // the boutique document so the bot does this automatically next time.
      escalate = true;
      logger.warn(
        { customerId, messageId, boutiqueId: boutique._id.toString() },
        "payment_info — boutique.bankAccountImageUrl not set, escalating to owner",
      );
    }
  }

  // ── Build escalation message ──────────────────────────────────────────────

  let escalationMessage: string | undefined;

  if (escalate) {
    logger.info({ customerId, from, messageId }, "Escalate flag set for n8n");

    const intent = result.intent;

    // payment_receipt: use the dedicated builder with structured cart.
    // Prefer Claude's orderHints (it already read the conversation history).
    // Fall back to extractCartFromHistory if Claude provided no orderHints.
    if (intent === "payment_receipt") {
      const cart = result.orderHints?.length
        ? orderHintsToCart(result.orderHints)
        : extractCartFromHistory(allTurns);
      escalationMessage = buildPaymentReceiptEscalation({
        customerPhone: from,
        customerName,
        cart,
        shippingPrice: boutique.businessInfo.shippingPrice,
      });
    } else {
      // All other escalation reasons use the general builder
      const searchHints = result.searchHints;
      let reason: string;
      let suggestedAction: string;
      let inventoryResult: string | undefined;

      if (intent === "needs_human") {
        reason =
          "El asistente detectó que la situación requiere una decisión humana.";
        suggestedAction =
          "Revisar el mensaje del cliente y responder directamente.";
      } else if (intent === "showroom_visit") {
        reason = "El cliente quiere visitar el showroom en persona.";
        suggestedAction =
          "Confirmar disponibilidad y preparar la visita. Contactar al cliente para acordar hora si es necesario.";
      } else if (intent === "payment_info") {
        reason =
          "El cliente preguntó por los datos de pago pero la boutique no tiene bankAccountImageUrl configurado.";
        suggestedAction =
          "Enviar los datos bancarios manualmente al cliente. Configurar bankAccountImageUrl en el documento de la boutique en MongoDB para que el bot lo haga automáticamente en el futuro.";
      } else if (
        // Fallback receipt detection: catches edge cases where Claude misclassified
        // a payment text as a different intent but the message clearly references payment.
        // payment_receipt intent is handled above; this catches any remainder.
        /comprobante|transferencia|deposit[eé]|ya pagu[eé]|ya deposit[eé]|te mand[eé]/i.test(
          message,
        )
      ) {
        const cart = extractCartFromHistory(allTurns);
        reason =
          "El cliente posiblemente envió un comprobante de pago — pedido pendiente de confirmación.";
        suggestedAction =
          "Verificar la transferencia en tu cuenta bancaria y confirmar el pedido al cliente por WhatsApp. Preguntarle qué producto, talla y color quiere si no está claro.";
        escalationMessage = buildPaymentReceiptEscalation({
          customerPhone: from,
          customerName,
          cart,
          shippingPrice: boutique.businessInfo.shippingPrice,
        });
      } else if (intent === "product_search" && productImages.length === 0) {
        const keyword = searchHints?.keyword ?? "producto no especificado";
        const size = searchHints?.size;
        const color = searchHints?.color;
        inventoryResult = `No se encontraron productos disponibles que coincidan con "${keyword}"${color ? ` color ${color}` : ""}${size ? ` talla ${size}` : ""}.`;
        reason =
          "El bot no puede confirmar disponibilidad porque el producto no existe actualmente en inventario.";
        suggestedAction = `Responder con una alternativa disponible o confirmar si se puede conseguir "${keyword}"${color ? ` en ${color}` : ""} sobre pedido.`;
      } else if (intent === "create_order") {
        const items =
          result.orderHints
            ?.map(
              (h) => `${h.productNameHint} talla ${h.size} color ${h.color}`,
            )
            .join(", ") ?? "sin detalle";
        reason = `El pedido no pudo crearse automáticamente. Producto(s): ${items}. Posible causa: producto desactivado en catálogo o nombre no reconocido.`;
        suggestedAction =
          "Verificar que el producto está activo en el inventario SALO. Si está activo, crear el pedido manualmente desde la app.";
      } else {
        reason = `Escalación forzada por estado inesperado (intent: ${intent}).`;
        suggestedAction =
          "Revisar logs de Railway y responder al cliente manualmente.";
      }

      // Only build if not already set by the fallback receipt branch above
      if (!escalationMessage) {
        escalationMessage = buildEscalationMessage({
          customerPhone: from,
          customerName,
          customerMessage: message,
          intent,
          searchHints,
          orderHints: result.orderHints,
          inventoryResult,
          reason,
          suggestedAction,
        });
      }
    }
  }

  // ── Persist conversation ──────────────────────────────────────────────────

  // Normalize user content before storing — voice placeholder strings are
  // verbose and pollute Claude's context window when replayed as history.
  // Shorten to a compact form that still signals the message type.
  //
  // SECURITY: strip the [Producto exacto seleccionado por el cliente: ...] tag
  // from customer text before storing. That tag is a backend-injected system
  // marker; extractCartFromHistory (PASS 3) scans USER turns for it. Without
  // this, a customer could type the tag verbatim to inject a fabricated product
  // selection into their own cart (receipt ack, pendingPayments, owner alert).
  const storedUserContent = (
    message.startsWith("[Nota de voz") ? "[Audio]" : message.slice(0, 2000)
  ).replace(
    /\[Producto exacto seleccionado por el cliente:[^\]]*\]/gi,
    "[tag-removido]",
  );

  // When product images are being sent, extract product data from captions and
  // append a structured summary to the assistant turn content.
  //
  // WHY: tool call results (names, prices, colors) are computed in the agentic
  // loop and passed to Claude but only Claude's final text response is persisted.
  // When the customer replies to a gallery image asking "cómo se llama" or
  // "cuánto cuesta", the history has "¡Sipi! Te muestro..." with no product data.
  //
  // The summary is APPENDED to the same assistant turn — NOT stored as a
  // separate turn. Storing it as a separate assistant turn causes two consecutive
  // assistant roles, which the Anthropic API rejects with 400, causing
  // SAFE_FALLBACK on every subsequent gallery reply.
  //
  // Caption format from searchProductsForClaude:
  //   "$1,990 — Jersey Alo Athletic Heather Grey (Alo)"  (first image of product)
  //   ""  (secondary images — no caption)
  // Filtering to non-empty captions gives one line per unique product.
  let storedAssistantContent = result.response;

  // Append sentinel when payment_info fires so hasRecentPaymentInfoContext
  // can reliably detect it on the next turn (receipt image detection).
  // The tag is invisible to Claude — it's only used by the backend guard.
  // This must not be appended to the customer-facing reply — only to the
  // stored conversation turn.
  if (result.intent === "payment_info") {
    storedAssistantContent = result.response + " [payment_info_sent]";
  }

  if (productImages.length > 0 && result.intent === "product_search") {
    const uniqueProducts = productImages
      .filter((img) => img.caption && img.caption.trim() !== "")
      .map((img) => img.caption!.trim());

    if (uniqueProducts.length > 0) {
      const productSummary =
        `\n\n[Productos enviados al cliente en este turn:\n` +
        uniqueProducts.map((p, i) => `${i + 1}. ${p}`).join("\n") +
        `\nEl cliente puede preguntar el nombre o precio de cualquiera de estos.]`;

      storedAssistantContent = result.response + productSummary;

      logger.info(
        { customerId, productsLogged: uniqueProducts.length },
        "Product summary appended to assistant turn for gallery reply resolution",
      );
    }
  }

  await ConversationModel.findOneAndUpdate(
    { customerId, channel: "whatsapp" },
    {
      $push: {
        turns: {
          $each: [
            {
              role: "user" as const,
              content: storedUserContent,
              createdAt: new Date(),
            },
            {
              role: "assistant" as const,
              content: storedAssistantContent,
              createdAt: new Date(),
            },
          ],
          $slice: -MAX_CONVERSATION_TURNS,
        },
      },
      $set: { lastMessageAt: new Date() },
      $setOnInsert: { boutiqueId: new mongoose.Types.ObjectId(boutiqueId) },
    },
    { upsert: true, returnDocument: "after", runValidators: true },
  );

  logger.info(
    {
      customerId,
      intent: result.intent,
      historyTurns: conversationHistory.length,
      customerGender,
      messageId,
    },
    "Conversation turn persisted",
  );

  // ── Persist detected gender ───────────────────────────────────────────────
  // If Claude detected an explicit gender signal in this message (e.g. customer
  // said "soy el que te mandó mensaje" → male), update the customer record so
  // all future conversations start with the correct gender without re-detection.
  if (result.detectedGender && result.detectedGender !== customerGender) {
    await CustomerModel.updateOne(
      { _id: customer._id },
      { $set: { gender: result.detectedGender } },
    ).catch((err) => {
      logger.warn(
        { err, customerId },
        "Failed to persist detected customer gender — non-critical, will retry on next detection",
      );
    });
    logger.info(
      {
        customerId,
        previousGender: customerGender,
        detectedGender: result.detectedGender,
      },
      "Customer gender updated from conversation signal",
    );
  }

  // Guard: never return an empty reply with a valid customerPhone.
  // This combination causes the WhatsApp send node to fail with "text.body is required".
  // If result.response is somehow empty (should not happen after Zod validation),
  // use the gender-aware error reply as a safe fallback.
  const finalReply = result.response.trim() || buildErrorReply(customerGender);

  return toSafeResult(
    {
      reply: finalReply,
      escalate,
      customerPhone: from,
      customerName,
      productImages,
      escalationMessage,
    },
    from,
    customerName,
    customerGender,
  );
};
