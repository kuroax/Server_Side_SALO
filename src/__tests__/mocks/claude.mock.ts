// Reference value matching the FINAL webhook HTTP response shape (what
// webhook.controller.ts emits). Useful for documenting the contract; the actual
// reply text below is what asserting tests look for.
export const mockClaudeResponse = {
  reply: 'Hola! Bienvenida a SALO. ¿Qué estás buscando hoy?',
  escalate: false,
  escalationMessage: null,
  productImages: [],
  intent: 'general',
  customerPhone: '521234567890',
}

// What `processMessage` (claude.service.ts) actually returns — this is the shape
// webhook.service.ts consumes and validates with processMessageResultSchema.
// The HTTP `reply` is built from `response`. Used to stub processMessage in
// tests so no real Anthropic API call is ever made.
export const mockProcessMessageResult = {
  intent: 'general' as const,
  response: 'Hola! Bienvenida a SALO. ¿Qué estás buscando hoy?',
  productImages: [] as Array<{ url: string; caption?: string }>,
}
