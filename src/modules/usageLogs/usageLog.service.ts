import { Types } from "mongoose";
import { UsageLogModel } from "#/modules/usageLogs/usageLog.model.js";

// ─── Pricing ──────────────────────────────────────────────────────────────────
// Approximate public prices for claude-sonnet-4-6, USD per 1M tokens.
// Update these if the default model changes (see CLAUDE_MODEL in claude.service).
const PRICE_INPUT_USD_PER_MTOK = 3.0;
const PRICE_OUTPUT_USD_PER_MTOK = 15.0;

// ─── Usage summary ─────────────────────────────────────────────────────────────
// Aggregates a boutique's Claude usage over the last `months` months.
// Tenant-scoped: every query filters by boutiqueId. Not exposed via GraphQL yet.

export async function getUsageSummary(
  boutiqueId: string,
  months = 1,
): Promise<{
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCalls: number;
  estimatedCostUSD: number;
  periodStart: string;
  periodEnd: string;
  byIntent: Array<{
    intent: string;
    calls: number;
    tokens: number;
    estimatedCostUSD: number;
  }>;
  dailyUsage: Array<{
    date: string;
    calls: number;
    totalTokens: number;
    estimatedCostUSD: number;
  }>;
}> {
  const boutiqueObjectId = new Types.ObjectId(boutiqueId);

  const now = new Date();
  const since = new Date(now);
  since.setMonth(since.getMonth() - months);

  const match = { boutiqueId: boutiqueObjectId, createdAt: { $gte: since } };

  const [totals] = await UsageLogModel.aggregate<{
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCalls: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: null,
        totalInputTokens: { $sum: "$inputTokens" },
        totalOutputTokens: { $sum: "$outputTokens" },
        totalCalls: { $sum: 1 },
      },
    },
  ]);

  const byIntentRaw = await UsageLogModel.aggregate<{
    _id: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    tokens: number;
  }>([
    { $match: match },
    {
      $group: {
        // Logs with no resolved intent (failed calls) bucket under "unknown".
        _id: { $ifNull: ["$intent", "unknown"] },
        calls: { $sum: 1 },
        inputTokens: { $sum: "$inputTokens" },
        outputTokens: { $sum: "$outputTokens" },
        tokens: { $sum: "$totalTokens" },
      },
    },
    { $sort: { tokens: -1 } },
  ]);

  const dailyRaw = await UsageLogModel.aggregate<{
    _id: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        calls: { $sum: 1 },
        inputTokens: { $sum: "$inputTokens" },
        outputTokens: { $sum: "$outputTokens" },
        totalTokens: { $sum: "$totalTokens" },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const totalInputTokens = totals?.totalInputTokens ?? 0;
  const totalOutputTokens = totals?.totalOutputTokens ?? 0;
  const totalTokens = totalInputTokens + totalOutputTokens;
  const totalCalls = totals?.totalCalls ?? 0;

  // Cost splits input vs output — the two prices differ 5×, so a single blended
  // rate would be inaccurate.
  const costUSD = (input: number, output: number): number =>
    (input / 1_000_000) * PRICE_INPUT_USD_PER_MTOK +
    (output / 1_000_000) * PRICE_OUTPUT_USD_PER_MTOK;

  const estimatedCostUSD = costUSD(totalInputTokens, totalOutputTokens);

  const byIntent = byIntentRaw.map((row) => ({
    intent: row._id,
    calls: row.calls,
    tokens: row.tokens,
    estimatedCostUSD: costUSD(row.inputTokens, row.outputTokens),
  }));

  const dailyUsage = dailyRaw.map((row) => ({
    date: row._id,
    calls: row.calls,
    totalTokens: row.totalTokens,
    estimatedCostUSD: costUSD(row.inputTokens, row.outputTokens),
  }));

  // ISO date (YYYY-MM-DD) for the first day of the period and today.
  const periodStart = since.toISOString().slice(0, 10);
  const periodEnd = now.toISOString().slice(0, 10);

  return {
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalCalls,
    estimatedCostUSD,
    periodStart,
    periodEnd,
    byIntent,
    dailyUsage,
  };
}
