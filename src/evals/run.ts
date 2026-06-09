import "dotenv/config";
import mongoose from "mongoose";
import { env } from "#/config/env.js";
import { processMessage } from "#/integrations/whatsapp/claude.service.js";
import { scenarios } from "./scenarios.js";
import type { EvalScenarioResult, EvalTurnResult } from "./types.js";

// Minimal mock context — eval uses real Claude but fake boutique/customer data.
// agentConfig reproduces ShopaloGDL's original hardcoded identity so eval
// scenarios exercise the same prompt Luis ran before the refactor.
const MOCK_AGENT_CONFIG = {
  agentName: "Luis",
  categoryDescription:
    "tienda de ropa deportiva y lifestyle de marcas premium como Alo Yoga, Lululemon, Wiskii, 437, Better Me y Skims",
  brandKnowledge:
    "En Lululemon: talla M = talla 8, talla S = talla 6, talla XS = talla 4",
};

const MOCK_BUSINESS_INFO = {
  showroomAddress: "Guadalajara, Jalisco",
  businessHours: "Lunes a Sábado 10am - 7pm",
  shippingPrice: 179,
  paymentMethods: "Transferencia bancaria",
  depositPercent: 30,
  paymentDays: 20,
  deliveryInfo: "3 a 5 días hábiles",
};

const MOCK_SEARCH_PRODUCTS = async () => [
  {
    name: "Jersey de cuello redondo Accolade",
    brand: "Alo",
    price: 3390,
    color: "Paradise Pink",
    images: [
      {
        url: "https://res.cloudinary.com/salo-app03/image/upload/v1/jersey.jpg",
        caption: "$3,390 — Jersey de cuello redondo Accolade (Alo)",
      },
    ],
  },
];

async function runScenario(scenario: typeof scenarios[0]): Promise<EvalScenarioResult> {
  const turnResults: EvalTurnResult[] = [];
  let conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i];

    // Use injected prior history if provided, otherwise use accumulated history
    const historyForThisTurn = turn.priorHistory ?? conversationHistory;

    let result;
    try {
      result = await processMessage({
        agentConfig: MOCK_AGENT_CONFIG,
        customerName: "Gisell Parra",
        customerGender: "female",
        recentOrder: null,
        searchProducts: turn.searchProductsOverride ?? MOCK_SEARCH_PRODUCTS,
        incomingMessage: turn.customerMessage,
        conversationHistory: historyForThisTurn,
        businessInfo: MOCK_BUSINESS_INFO,
        requestTimeoutOverrideMs: 45000,
      });
    } catch (err) {
      console.error(`  ERROR on turn ${i + 1}:`, err);
      turnResults.push({
        turn: i + 1,
        customerMessage: turn.customerMessage,
        response: "ERROR",
        intent: "error",
        productImages: 0,
        escalate: false,
        results: turn.criteria.map((c) => ({ criterion: c.name, passed: false, description: c.description })),
        passed: false,
      });
      continue;
    }

    const criteriaResults = turn.criteria.map((criterion) => ({
      criterion: criterion.name,
      passed: criterion.check(result.response, result.intent, result.productImages.length),
      description: criterion.description,
    }));

    const turnPassed = criteriaResults.every((r) => r.passed);

    turnResults.push({
      turn: i + 1,
      customerMessage: turn.customerMessage,
      response: result.response,
      intent: result.intent,
      productImages: result.productImages.length,
      escalate: result.intent === "needs_human",
      results: criteriaResults,
      passed: turnPassed,
    });

    // Accumulate history for next turn
    conversationHistory = [
      ...historyForThisTurn,
      { role: "user" as const, content: turn.customerMessage },
      { role: "assistant" as const, content: result.response },
    ];
  }

  const passed = turnResults.filter((t) => t.passed).length;
  const total = turnResults.length;

  return {
    scenario: scenario.name,
    turns: turnResults,
    passed,
    total,
    score: `${passed}/${total} (${Math.round((passed / total) * 100)}%)`,
  };
}

function printResults(results: EvalScenarioResult[]) {
  const totalPassed = results.reduce((sum, r) => sum + r.passed, 0);
  const totalTests = results.reduce((sum, r) => sum + r.total, 0);
  const overallScore = Math.round((totalPassed / totalTests) * 100);

  console.log("\n" + "=".repeat(60));
  console.log("SALO CONVERSATION EVAL RESULTS");
  console.log("=".repeat(60));

  for (const scenarioResult of results) {
    const icon = scenarioResult.passed === scenarioResult.total ? "✅" : "❌";
    console.log(`\n${icon} ${scenarioResult.scenario} — ${scenarioResult.score}`);

    for (const turn of scenarioResult.turns) {
      if (!turn.passed) {
        console.log(`   Turn ${turn.turn}: "${turn.customerMessage}"`);
        console.log(`   Intent: ${turn.intent} | Images: ${turn.productImages}`);
        console.log(`   Response preview: ${turn.response.slice(0, 120)}...`);
        for (const r of turn.results) {
          if (!r.passed) {
            console.log(`   ❌ FAIL: ${r.criterion} — ${r.description}`);
          }
        }
      }
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`OVERALL: ${totalPassed}/${totalTests} criteria passed (${overallScore}%)`);
  console.log("=".repeat(60) + "\n");

  if (overallScore < 80) {
    console.log("⚠️  Score below 80% — review system prompt before deploying.\n");
    process.exit(1);
  } else {
    console.log("✅ Score 80%+ — prompt quality acceptable.\n");
  }
}

async function main() {
  // Connect to MongoDB (needed for any DB-touching code paths)
  await mongoose.connect(env.MONGODB_URI);

  // Optional filter: npx tsx src/evals/run.ts talla
  // Runs only scenarios whose name contains the keyword (case-insensitive)
  const filterKeyword = process.argv[2]?.toLowerCase();
  const filteredScenarios = filterKeyword
    ? scenarios.filter((s) => s.name.toLowerCase().includes(filterKeyword))
    : scenarios;

  if (filterKeyword && filteredScenarios.length === 0) {
    console.log(`\nNo scenarios match "${filterKeyword}". Available scenarios:\n`);
    scenarios.forEach((s) => console.log(`  - ${s.name}`));
    process.exit(1);
  }

  console.log(
    filterKeyword
      ? `\nRunning ${filteredScenarios.length} scenario(s) matching "${filterKeyword}"...`
      : `\nRunning ${filteredScenarios.length} eval scenarios with real Claude API...`
  );
  console.log("This uses real API credits. Each scenario = 1-2 Claude calls.\n");

  const results: EvalScenarioResult[] = [];

  for (const scenario of filteredScenarios) {
    process.stdout.write(`  Running: ${scenario.name}... `);
    const result = await runScenario(scenario);
    const icon = result.passed === result.total ? "✅" : "❌";
    console.log(`${icon} ${result.score}`);
    results.push(result);
  }

  await mongoose.disconnect();
  printResults(results);
}

main().catch((err) => {
  console.error("Eval runner failed:", err);
  process.exit(1);
});
