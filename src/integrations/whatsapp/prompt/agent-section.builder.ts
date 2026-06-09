// ─── Per-tenant agent identity section ────────────────────────────────────────
//
// Builds the opening identity block of the WhatsApp AI system prompt from a
// boutique's agentConfig. This is the ONLY part of the prompt that differs
// between tenants — everything else lives in base.prompt.ts (BASE_PLATFORM_PROMPT)
// and is identical for every boutique.
//
// The returned string replaces the {AGENT_SECTION} token at the top of
// BASE_PLATFORM_PROMPT (see claude.service.ts → processMessage).
//
// The "INSTRUCCIONES DE VENTAS Y ESTILO" section is assembled from the structured
// fields (phrases, discoveryCategories, upsellRules, sizeGuide, customInstructions)
// when any are present. Boutiques not yet migrated fall back to the legacy
// free-form salesInstructions blob. If neither exists, the section is omitted.

export type AgentPhrases = {
  paymentAck?: string; // [FRASE_AGRADECIMIENTO_PAGO]
  orderConfirm?: string; // [FRASE_CONFIRMACION_PEDIDO]
  negativeSticker?: string;
  affirmations?: string;
  closings?: string;
  emojiSet?: string;
};

export type AgentConfig = {
  agentName: string;
  categoryDescription: string;
  brandKnowledge?: string;
  // Structured personality fields.
  phrases?: AgentPhrases;
  discoveryCategories?: string;
  upsellRules?: string;
  sizeGuide?: string;
  customInstructions?: string;
  personalityNotes?: string;
  // Legacy free-form blob — fallback when structured fields are absent.
  salesInstructions?: string;
};

const SALES_HEADING =
  "─── INSTRUCCIONES DE VENTAS Y ESTILO ────────────────────────────";

// Assembles the structured sales fields into the body of the INSTRUCCIONES
// section. Returns "" when no structured field has content — the caller then
// falls back to the legacy salesInstructions blob.
function buildStructuredSalesInstructions(config: AgentConfig): string {
  const { phrases, discoveryCategories, upsellRules, sizeGuide, customInstructions } =
    config;
  const blocks: string[] = [];

  // 1. Phrases — omit any line whose value is absent.
  if (phrases) {
    const lines: string[] = [];
    if (phrases.affirmations) lines.push(`- AFIRMACIONES: ${phrases.affirmations}`);
    if (phrases.emojiSet) lines.push(`- EMOJIS: ${phrases.emojiSet}`);
    if (phrases.closings) lines.push(`- FRASES DE CIERRE: ${phrases.closings}`);
    if (phrases.paymentAck)
      lines.push(`- [FRASE_AGRADECIMIENTO_PAGO] = ${phrases.paymentAck}`);
    if (phrases.orderConfirm)
      lines.push(`- [FRASE_CONFIRMACION_PEDIDO] = ${phrases.orderConfirm}`);
    if (phrases.negativeSticker)
      lines.push(`- STICKER NEGATIVO: ${phrases.negativeSticker}`);
    if (lines.length > 0) blocks.push(`ESTILO Y FRASES:\n${lines.join("\n")}`);
  }

  // 2. Discovery categories.
  if (discoveryCategories) {
    blocks.push(
      `CATEGORÍAS DE PRODUCTOS:\n- [CATEGORÍAS_DEL_CATÁLOGO] = ${discoveryCategories}`,
    );
  }

  // 3. Upsell rules.
  if (upsellRules) {
    blocks.push(`UPSELL Y VENTAS:\n${upsellRules}`);
  }

  // 4. Size guide.
  if (sizeGuide) {
    blocks.push(`RECOMENDACIÓN DE TALLA:\n${sizeGuide}`);
  }

  // 5. Custom instructions.
  if (customInstructions) {
    blocks.push(`INSTRUCCIONES ADICIONALES:\n${customInstructions}`);
  }

  return blocks.join("\n\n");
}

export function buildAgentSection(agentConfig: AgentConfig): string {
  const { agentName, categoryDescription, brandKnowledge, salesInstructions, personalityNotes } =
    agentConfig;

  // Reproduces the original opening paragraph:
  // "Eres Luis, el asistente virtual de SALO shop — una <categoryDescription>."
  let section = `Eres ${agentName}, el asistente virtual de SALO shop — una ${categoryDescription}.`;

  // Brand-specific knowledge (e.g. size-equivalence guides) is referenced by the
  // base prompt under the heading "CONOCIMIENTO DE MARCA".
  if (brandKnowledge) {
    section += `\n\nCONOCIMIENTO DE MARCA:\n${brandKnowledge}`;
  }

  // Sales/style rules — prefer structured fields, fall back to legacy blob,
  // omit the section entirely when neither is present.
  const structured = buildStructuredSalesInstructions(agentConfig);
  if (structured) {
    section += `\n\n${SALES_HEADING}\n${structured}`;
  } else if (salesInstructions) {
    section += `\n\n${SALES_HEADING}\n${salesInstructions}`;
  }

  // Optional extra persona/tone instructions for this specific boutique.
  if (personalityNotes) {
    section += `\n\n${personalityNotes}`;
  }

  return section;
}
