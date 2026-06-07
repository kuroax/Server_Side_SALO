import type { EvalCriteria } from "./types.js";

export const containsText = (text: string): EvalCriteria => ({
  name: `contains "${text}"`,
  description: `Response must contain "${text}"`,
  check: (response) => response.toLowerCase().includes(text.toLowerCase()),
});

export const doesNotContain = (text: string): EvalCriteria => ({
  name: `does not contain "${text}"`,
  description: `Response must NOT contain "${text}"`,
  check: (response) => !response.toLowerCase().includes(text.toLowerCase()),
});

export const intentIs = (expected: string): EvalCriteria => ({
  name: `intent is ${expected}`,
  description: `Claude must return intent: ${expected}`,
  check: (_response, intent) => intent === expected,
});

export const hasImages = (): EvalCriteria => ({
  name: "has product images",
  description: "Response must include at least one product image",
  check: (_r, _i, images) => images > 0,
});

export const noImages = (): EvalCriteria => ({
  name: "no product images",
  description: "Response must NOT include product images",
  check: (_r, _i, images) => images === 0,
});

export const isInSpanish = (): EvalCriteria => ({
  name: "response is in Spanish",
  description: "Response must be in Spanish",
  check: (response) =>
    /[áéíóúüñ¿¡]/i.test(response) || /\b(hola|bonita|tengo|disponible|talla|pedido|envío)\b/i.test(response),
});

export const asksForTalla = (): EvalCriteria => ({
  name: "asks for talla",
  description: "Luis must ask what size the customer wants",
  check: (response) => /talla|medida|qué talla/i.test(response),
});

export const mentionsAnticipo = (): EvalCriteria => ({
  name: "mentions anticipo",
  description: "Luis must mention the deposit amount",
  check: (response) => /30%|anticipo|apartar|liquidar/i.test(response),
});

export const mentionsPrice = (): EvalCriteria => ({
  name: "mentions price",
  description: "Response must include a price in MXN",
  check: (response) => /\$[\d,]+/.test(response),
});

export const doesNotRepeatCatalog = (): EvalCriteria => ({
  name: "does not repeat catalog",
  description: "Luis must NOT show products again if catalog was already shown",
  check: (_r, intent) => intent !== "product_search",
});

export const escalates = (): EvalCriteria => ({
  name: "escalates",
  description: "This message must trigger escalation",
  check: (_r, intent) => intent === "needs_human" || intent === "payment_receipt",
});

export const doesNotEscalate = (): EvalCriteria => ({
  name: "does not escalate",
  description: "This message must NOT escalate",
  check: (_r, intent) => intent !== "needs_human",
});

export const confirmationGateHolds = (): EvalCriteria => ({
  name: "confirmation gate holds",
  description: "Bank image must not be sent — confirmation gate must hold",
  check: (_r, intent, images) => intent !== "payment_info" || images === 0,
});
