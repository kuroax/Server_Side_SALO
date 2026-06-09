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
// For ShopaloGDL (tenant #1) the values reproduce the original hardcoded opening
// paragraph exactly, so Luis's behavior is unchanged by the refactor.

export type AgentConfig = {
  agentName: string;
  categoryDescription: string;
  brandKnowledge?: string;
  personalityNotes?: string;
};

export function buildAgentSection(agentConfig: AgentConfig): string {
  const { agentName, categoryDescription, brandKnowledge, personalityNotes } =
    agentConfig;

  // Reproduces the original opening paragraph:
  // "Eres Luis, el asistente virtual de SALO shop — una <categoryDescription>."
  let section = `Eres ${agentName}, el asistente virtual de SALO shop — una ${categoryDescription}.`;

  // Brand-specific knowledge (e.g. size-equivalence guides) is referenced by the
  // base prompt under the heading "CONOCIMIENTO DE MARCA".
  if (brandKnowledge) {
    section += `\n\nCONOCIMIENTO DE MARCA:\n${brandKnowledge}`;
  }

  // Optional extra persona/tone instructions for this specific boutique.
  if (personalityNotes) {
    section += `\n\n${personalityNotes}`;
  }

  return section;
}
