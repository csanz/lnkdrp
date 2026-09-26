/**
 * What one model call actually costs us, in dollars.
 *
 * Exists because the price a customer pays for a run is fixed (`creditsForRun`) while what the run
 * costs is not: the model is chosen by modality, not by the tier the customer bought, so a
 * page-image summary and a text-only summary are charged the same credit and bill us ~17x apart on
 * input. Without this table the ledger's `costUsdActual` stays null and every margin statement in
 * the product is an assumption. One table, in one place, so a price change is one edit.
 *
 * PRICES MUST BE RE-CHECKED WHENEVER THE PROVIDER CHANGES THEM. They are a dated snapshot of a
 * published list, not something the code can discover: nothing in the API response says what a
 * token cost. When OpenAI moves a price, or when a new model id starts appearing in `modelRoute`
 * on the admin AI runs page, edit `MODEL_PRICES` and move `MODEL_PRICES_AS_OF` with it.
 *
 * Where these numbers came from, as of the date below:
 * - OpenAI's published list prices for the API, in US dollars per 1,000,000 tokens.
 * - Corroborated inside this repo, twice, by measurements taken against the live API:
 *   `src/lib/ai/docChangeDiff.ts` records that gpt-4o-mini's input price is "16.67x cheaper" than
 *   gpt-4o's (2.50 / 0.15 = 16.67), and `src/lib/ai/visitBrief.ts` records a ~3k-in / ~250-out
 *   brief as "about a cent on gpt-4o" (3000 x 2.50 + 250 x 10.00, per million, is $0.0100).
 *
 * A model this table does not know is not guessed at. `costUsdForUsage` returns null, the tokens
 * are still recorded, and the admin surfaces say how many runs carry no priced cost. A wrong number
 * in a margin report is worse than a missing one, because only the missing one asks to be fixed.
 */

/** The date the rates below were read off the provider's published price list. */
export const MODEL_PRICES_AS_OF = "2026-09-26";

/**
 * US dollars per 1,000,000 tokens for one model.
 *
 * `cachedInput` is a separate rate because the provider bills a prompt prefix it has already seen
 * at a discount, and the AI SDK reports those tokens separately (`usage.cachedInputTokens`). They
 * are part of `inputTokens`, not extra to it, so the cached share is subtracted from the full-rate
 * input before it is priced.
 */
export type ModelRate = {
  inputPerMillionUsd: number;
  cachedInputPerMillionUsd: number;
  outputPerMillionUsd: number;
};

/**
 * Every model the product actually calls, and nothing else.
 *
 * Two entries, because two models is what the repo uses: `modelForCompare` and the summary's
 * modality split both pick between gpt-4o and gpt-4o-mini, the review and the request review are
 * pinned to gpt-4o-mini, and the visit brief runs gpt-4o unless `VISIT_BRIEF_MODEL` overrides it.
 * An override to some third model is exactly the case that must read as "cost not known" rather
 * than be priced off the nearest neighbour.
 */
const MODEL_PRICES: Readonly<Record<string, ModelRate>> = Object.freeze({
  "gpt-4o": { inputPerMillionUsd: 2.5, cachedInputPerMillionUsd: 1.25, outputPerMillionUsd: 10.0 },
  "gpt-4o-mini": { inputPerMillionUsd: 0.15, cachedInputPerMillionUsd: 0.075, outputPerMillionUsd: 0.6 },
});

/** Model ids this table prices, for tests and for admin copy that lists what is covered. */
export function pricedModelIds(): string[] {
  return Object.keys(MODEL_PRICES).sort();
}

/**
 * The base model id behind a dated snapshot id.
 *
 * OpenAI serves both `gpt-4o` and pinned snapshots like `gpt-4o-2024-08-06`, and the SDK reports
 * back whichever was asked for. A snapshot is the same price as its base, so the trailing date is
 * stripped rather than treated as an unknown model. Anything else is left exactly as written: a
 * near-miss must miss.
 */
function baseModelId(model: string): string {
  return model.trim().toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

/**
 * The rate for a model id, or null when this table does not price it.
 *
 * Null is a real answer and callers must carry it through as null rather than as zero: a run whose
 * model we cannot price costs something, and recording zero would quietly inflate every margin.
 */
export function modelRate(model: string | null | undefined): ModelRate | null {
  if (typeof model !== "string" || !model.trim()) return null;
  return MODEL_PRICES[baseModelId(model)] ?? null;
}

/** Token counts for one model call, in the shape the AI SDK reports them. */
export type PricedUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  /** Part of `promptTokens`, billed at the cached rate. Null or 0 when the provider reported none. */
  cachedInputTokens?: number | null;
};

/** Cents are too coarse for one run (a text summary is a tenth of one), so dollars are kept to this many places. */
const COST_DECIMALS = 6;

/** Round a dollar amount to `COST_DECIMALS`, so summing many runs does not accumulate float noise. */
function roundUsd(usd: number): number {
  const factor = 10 ** COST_DECIMALS;
  return Math.round(usd * factor) / factor;
}

/**
 * What one model call cost in US dollars, or null when it cannot be established.
 *
 * Null when the model is not in the table, and null when neither token count was reported: a run
 * with no usage at all is unknown, not free. A reported-but-zero count is a real zero and is priced
 * as such.
 */
export function costUsdForUsage(params: { model: string | null | undefined } & PricedUsage): number | null {
  const rate = modelRate(params.model);
  if (!rate) return null;

  const prompt = finiteNonNegative(params.promptTokens);
  const completion = finiteNonNegative(params.completionTokens);
  if (prompt === null && completion === null) return null;

  const cached = Math.min(finiteNonNegative(params.cachedInputTokens) ?? 0, prompt ?? 0);
  const fullRateInput = (prompt ?? 0) - cached;

  const usd =
    (fullRateInput * rate.inputPerMillionUsd) / 1_000_000 +
    (cached * rate.cachedInputPerMillionUsd) / 1_000_000 +
    ((completion ?? 0) * rate.outputPerMillionUsd) / 1_000_000;

  return roundUsd(usd);
}

/** A token count that is a real, non-negative number, or null. */
function finiteNonNegative(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * The dollar cost implied by a ledger row's own telemetry fields.
 *
 * This is the seam that lets a charge record its cost without every charge site being edited. The
 * ledger already carries `modelRoute`, `promptTokens` and `completionTokens`, written by the four
 * AI call paths in the shapes they each chose; the credit service runs this over that record at
 * settle time and fills `costUsdActual` from it. A caller that computed the cost itself (because it
 * accumulated several calls and knows more than one row of fields can say) passes `costUsdActual`
 * and this leaves it alone.
 *
 * `modelRoute` may name more than one model when a charge spanned calls that went to different
 * ones (see `joinModelRoute`). There is no per-model token split on the row, so the honest answer
 * is null rather than pricing the whole total at one of them.
 */
export function costUsdForLedgerTelemetry(telemetry: Record<string, unknown> | null | undefined): number | null {
  if (!telemetry || typeof telemetry !== "object") return null;
  const existing = telemetry.costUsdActual;
  if (typeof existing === "number" && Number.isFinite(existing) && existing >= 0) return existing;

  const route = typeof telemetry.modelRoute === "string" ? telemetry.modelRoute : null;
  if (!route || route.includes(MODEL_ROUTE_SEPARATOR)) return null;

  return costUsdForUsage({
    model: route,
    promptTokens: finiteNonNegative(telemetry.promptTokens),
    completionTokens: finiteNonNegative(telemetry.completionTokens),
    cachedInputTokens: finiteNonNegative(telemetry.cachedInputTokens),
  });
}

/**
 * How several model ids are written into one `modelRoute` string.
 *
 * A `+` and not a comma, so the field stays one token in a log line and in an admin table cell, and
 * so `costUsdForLedgerTelemetry` can recognise a multi-model route and decline to price it.
 */
export const MODEL_ROUTE_SEPARATOR = "+";

/** The `modelRoute` value for a charge that touched these models, in first-seen order, deduplicated. */
export function joinModelRoute(models: readonly string[]): string {
  const seen: string[] = [];
  for (const m of models) {
    const id = (m ?? "").trim();
    if (id && !seen.includes(id)) seen.push(id);
  }
  return seen.join(MODEL_ROUTE_SEPARATOR);
}
