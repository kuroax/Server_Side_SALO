import { logger } from "#/config/logger.js";

// ─── Owner alert service ────────────────────────────────────────────────────
//
// Sends a short WhatsApp text notification to the boutique owner's PERSONAL
// number when something needs their attention (new lead, payment receipt,
// handoff, pipeline movement).
//
// NOTE: This is a deliberate, narrow exception to the usual rule that the
// backend never calls the WhatsApp Cloud API directly (normally n8n owns that).
// Owner alerts are an internal, out-of-band signal — not part of the customer
// reply flow — so they are sent here using the boutique's own credentials.
//
// This service MUST NEVER throw: an alert failure can never be allowed to break
// the main webhook flow. All errors are caught and logged, then swallowed.
// It also MUST NEVER log the accessToken.

const GRAPH_API_VERSION = "v20.0";

export type AlertType =
  | "new_prospect"
  | "receipt_received"
  | "human_takeover_needed"
  | "prospect_stage_changed";

export interface AlertPayload {
  ownerPhone: string; // owner's personal WA number (receives the alert)
  phoneNumberId: string; // boutique Cloud API phone number ID (sends it)
  accessToken: string; // boutique accessToken — never log this
  customerPhone: string;
  alertType: AlertType;
  context?: Record<string, string>;
}

// Strip everything except digits — WhatsApp expects a bare MSISDN.
const toDigits = (value: string): string => value.replace(/\D/g, "");

const buildMessage = (payload: AlertPayload): string => {
  const { customerPhone, alertType, context } = payload;

  switch (alertType) {
    case "new_prospect":
      return (
        `🔔 *Nuevo prospecto*\n` +
        `Número: ${customerPhone}\n` +
        `Luis está atendiendo la conversación.`
      );
    case "receipt_received":
      return (
        `💳 *Comprobante recibido*\n` +
        `Cliente: ${customerPhone}\n` +
        `Verifica el pago y confirma el pedido.`
      );
    case "human_takeover_needed":
      return (
        `🙋 *Atención requerida*\n` +
        `Cliente: ${customerPhone}\n` +
        `Luis pausó la conversación y necesita que respondas.`
      );
    case "prospect_stage_changed":
      return (
        `📊 *Prospecto avanzó*\n` +
        `Cliente: ${customerPhone}\n` +
        `Etapa: ${context?.stage ?? "actualizada"}.`
      );
    default:
      // Exhaustive in practice; defensive fallback keeps this total.
      return `🔔 Notificación\nCliente: ${customerPhone}`;
  }
};

export const sendOwnerAlert = async (payload: AlertPayload): Promise<void> => {
  try {
    const to = toDigits(payload.ownerPhone);

    if (!to) {
      logger.warn(
        { alertType: payload.alertType },
        "[alert.service] Skipping alert — ownerPhone empty after normalization",
      );
      return;
    }

    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${payload.phoneNumberId}/messages`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${payload.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: buildMessage(payload) },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "<unreadable>");
      logger.error(
        {
          alertType: payload.alertType,
          status: response.status,
          phoneNumberId: payload.phoneNumberId,
          errorBody,
        },
        "[alert.service] Owner alert failed (non-2xx response)",
      );
      return;
    }

    logger.info(
      { alertType: payload.alertType, phoneNumberId: payload.phoneNumberId },
      "[alert.service] Owner alert sent",
    );
  } catch (err) {
    // Never rethrow — alert failures must not break the webhook flow.
    logger.error(
      { err, alertType: payload.alertType },
      "[alert.service] Owner alert threw — swallowed",
    );
  }
};
