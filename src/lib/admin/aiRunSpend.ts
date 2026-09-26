/**
 * The spend half of an `AiRun` row, shaped once for both admin routes that serve it.
 *
 * Exists so the list and the detail cannot disagree about what a run cost. They are built field by
 * field (deliberately, so prompt text can never leak through a spread), which means every column
 * has to be repeated in two places, and a column repeated in two places is a column that ends up
 * in one.
 *
 * Nothing here is customer-facing: these are our provider costs, not anyone's price.
 */

/** What a run actually spent, as the admin surfaces read it. */
export type AiRunSpend = {
  /** The model or models that actually ran, which is not always the model that was configured. */
  modelRoute: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  /** Provider calls behind this one run. Above 1 means an attempt failed and was billed for. */
  modelCalls: number | null;
  /** US dollars. Null means not established (unknown model, or no usage reported), never free. */
  costUsdActual: number | null;
};

/** The Mongo projection that fills {@link AiRunSpend}, so the two cannot drift apart. */
export const AI_RUN_SPEND_FIELDS = {
  modelRoute: 1,
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 1,
  cachedInputTokens: 1,
  modelCalls: 1,
  costUsdActual: 1,
} as const;

/** A stored number, or null: rows written before these columns existed have none of them. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Read {@link AiRunSpend} off a lean `AiRun` document. */
export function aiRunSpend(row: Record<string, unknown>): AiRunSpend {
  return {
    modelRoute: typeof row.modelRoute === "string" && row.modelRoute.trim() ? row.modelRoute : null,
    promptTokens: num(row.promptTokens),
    completionTokens: num(row.completionTokens),
    totalTokens: num(row.totalTokens),
    cachedInputTokens: num(row.cachedInputTokens),
    modelCalls: num(row.modelCalls),
    costUsdActual: num(row.costUsdActual),
  };
}
