/**
 * Adds up every provider call that belongs to one charge.
 *
 * Exists because a charge is not a call. The customer pays one price for "a summary", and behind
 * that price `analyzePdfText` may call the model twice (the second attempt exists precisely because
 * the first failed), `reviewDocText` falls back from `generateObject` to `generateText`, and a
 * compare asks the SDK for up to two internal retries by tier. Each call site recorded the usage of
 * whichever call returned last and overwrote the rest, so a run that cost twice what it looked like
 * was recorded at half. Tokens are the one number a margin cannot be estimated without, so they are
 * summed here rather than replaced.
 *
 * Two things this recovers that a plain "usage of the successful call" reading throws away:
 * - A failed `generateObject` still billed for what it generated. `AI_NoObjectGeneratedError`
 *   carries the `usage` of the call that produced the unparseable output, so `addFromError` puts
 *   the wasted tokens on the record instead of losing them.
 * - Which model actually ran. The model is picked by modality (page images go to the dearer model
 *   whatever tier was paid for), so the model on the run's parameters is not always the model that
 *   read the document.
 *
 * What it still cannot see: retries the AI SDK performs internally on transport errors. Those throw
 * inside the SDK and their usage never reaches us. `calls` therefore counts the calls this codebase
 * made, not every HTTP request the SDK sent.
 */
import { costUsdForUsage, joinModelRoute, modelRate } from "@/lib/ai/modelPricing";

/**
 * One charge's total provider usage, in exactly the field names the credit ledger and the AiRun
 * record store, so it can be handed to either without a translation step.
 */
export type AiUsageTotals = {
  provider: string;
  /** The model or models that actually ran, joined by `+` when a charge spanned more than one. */
  modelRoute: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** Part of `promptTokens` the provider billed at its cached rate, when it reported any. */
  cachedInputTokens: number | null;
  /** How many provider calls this codebase made for the charge. Two means the first one did not work. */
  modelCalls: number;
  /** US dollars, or null when any call ran on a model `modelPricing` does not price. */
  costUsdActual: number | null;
};

/** Usage as the AI SDK reports it on a result or on a `NoObjectGeneratedError`. */
type SdkUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
};

/** A non-negative integer, or null: the provider omits fields and occasionally sends junk. */
function tokenCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/** The `usage` hanging off an AI SDK error (`NoObjectGeneratedError`), when it has one. */
function usageFromUnknownError(err: unknown): SdkUsage | null {
  if (!err || typeof err !== "object") return null;
  const usage = (err as { usage?: unknown }).usage;
  return usage && typeof usage === "object" ? (usage as SdkUsage) : null;
}

/** Sum two counts where null means "not reported", so one silent call does not zero a real total. */
function addCounts(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/** Running totals for one model within a charge, kept apart so each is priced at its own rate. */
type PerModel = {
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
};

export type AiUsageAccumulator = {
  /** Record the usage of a call that returned. */
  add(model: string, usage: unknown): void;
  /** Record the usage a failed call still billed for, when the error carries it. */
  addFromError(model: string, err: unknown): void;
  /** The charge's totals, or null when no call ever reported usage. */
  totals(): AiUsageTotals | null;
};

/**
 * Start accumulating usage for one charge.
 *
 * Per model rather than one flat sum, because the cost of a token depends on which model burned it
 * and a charge can span two. The totals it returns are flat (the ledger has one token column), but
 * the dollars are summed per model first, so a summary that fell back from mini to gpt-4o is priced
 * correctly rather than at whichever model is named last.
 */
export function createAiUsageAccumulator(provider = "openai"): AiUsageAccumulator {
  const byModel = new Map<string, PerModel>();
  let calls = 0;

  function record(model: string, usage: SdkUsage | null): void {
    if (!usage) return;
    const prompt = tokenCount(usage.inputTokens);
    const completion = tokenCount(usage.outputTokens);
    const total = tokenCount(usage.totalTokens);
    const cached = tokenCount(usage.cachedInputTokens);
    // A call that reported nothing at all is not evidence of anything, and counting it would make
    // `modelCalls` disagree with the tokens beside it.
    if (prompt === null && completion === null && total === null) return;

    const id = (model ?? "").trim() || "unknown";
    const prev = byModel.get(id) ?? {
      model: id,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      cachedInputTokens: null,
    };
    byModel.set(id, {
      model: id,
      promptTokens: addCounts(prev.promptTokens, prompt),
      completionTokens: addCounts(prev.completionTokens, completion),
      // The provider's own total can exceed input plus output (reasoning and other overhead), so it
      // is carried rather than recomputed, and falls back to the parts when it was not sent.
      totalTokens: addCounts(prev.totalTokens, total ?? addCounts(prompt, completion)),
      cachedInputTokens: addCounts(prev.cachedInputTokens, cached),
    });
    calls += 1;
  }

  return {
    add(model, usage) {
      record(model, usage && typeof usage === "object" ? (usage as SdkUsage) : null);
    },
    addFromError(model, err) {
      record(model, usageFromUnknownError(err));
    },
    totals(): AiUsageTotals | null {
      const buckets = [...byModel.values()];
      if (buckets.length === 0) return null;

      let promptTokens: number | null = null;
      let completionTokens: number | null = null;
      let totalTokens: number | null = null;
      let cachedInputTokens: number | null = null;
      let costUsdActual: number | null = 0;

      for (const b of buckets) {
        promptTokens = addCounts(promptTokens, b.promptTokens);
        completionTokens = addCounts(completionTokens, b.completionTokens);
        totalTokens = addCounts(totalTokens, b.totalTokens);
        cachedInputTokens = addCounts(cachedInputTokens, b.cachedInputTokens);

        // One unpriced model makes the whole charge unpriced. A partial sum would read as a
        // complete one on every report that adds it up, which is the failure this file exists to
        // stop: a number nobody can tell is missing half its cost.
        if (costUsdActual === null) continue;
        if (!modelRate(b.model)) {
          costUsdActual = null;
          continue;
        }
        const usd = costUsdForUsage({
          model: b.model,
          promptTokens: b.promptTokens,
          completionTokens: b.completionTokens,
          cachedInputTokens: b.cachedInputTokens,
        });
        costUsdActual = usd === null ? null : costUsdActual + usd;
      }

      return {
        provider,
        modelRoute: joinModelRoute(buckets.map((b) => b.model)),
        promptTokens,
        completionTokens,
        totalTokens,
        cachedInputTokens,
        modelCalls: calls,
        costUsdActual,
      };
    },
  };
}
