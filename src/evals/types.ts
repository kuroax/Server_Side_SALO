export type EvalCriteria = {
  name: string;
  description: string;
  check: (response: string, intent: string, productImages: number) => boolean;
};

export type EvalTurn = {
  customerMessage: string;
  criteria: EvalCriteria[];
  // Optional: inject prior conversation history for this turn
  priorHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  // Optional: override the search-products mock for this turn (e.g. empty results)
  searchProductsOverride?: () => Promise<any[]>;
};

export type EvalScenario = {
  name: string;
  description: string;
  turns: EvalTurn[];
};

export type EvalTurnResult = {
  turn: number;
  customerMessage: string;
  response: string;
  intent: string;
  productImages: number;
  escalate: boolean;
  results: Array<{ criterion: string; passed: boolean; description: string }>;
  passed: boolean;
};

export type EvalScenarioResult = {
  scenario: string;
  turns: EvalTurnResult[];
  passed: number;
  total: number;
  score: string;
};
