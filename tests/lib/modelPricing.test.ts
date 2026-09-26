/**
 * The price table is the only thing standing between "we recorded tokens" and "we know what a run
 * cost", and every failure mode it has is silent: a wrong rate produces a plausible number, and a
 * missing model priced at zero produces a margin report that reads healthy because half its cost
 * is invisible.
 *
 * So these pin the three decisions that cannot be checked by looking at the output:
 * - the two rates themselves, against the measurements already written down in this repo,
 * - that an unknown model is null and never zero,
 * - that cached input tokens are a discount on the input already counted, not an extra charge.
 */
import { describe, expect, test } from "vitest";

import {
  MODEL_PRICES_AS_OF,
  costUsdForLedgerTelemetry,
  costUsdForUsage,
  joinModelRoute,
  modelRate,
  pricedModelIds,
} from "@/lib/ai/modelPricing";

describe("the rates", () => {
  test("gpt-4o-mini input is 16.67x cheaper than gpt-4o, as docChangeDiff measured", () => {
    // `src/lib/ai/docChangeDiff.ts` records the ratio from a run against the live API on
    // 2026-09-22. If a rate is edited without the other, this is what notices.
    const big = modelRate("gpt-4o");
    const mini = modelRate("gpt-4o-mini");
    expect(big).not.toBeNull();
    expect(mini).not.toBeNull();
    expect(big!.inputPerMillionUsd / mini!.inputPerMillionUsd).toBeCloseTo(16.67, 2);
  });

  test("a 3k-in, 250-out visit brief costs about a cent on gpt-4o, as visitBrief says it does", () => {
    const usd = costUsdForUsage({ model: "gpt-4o", promptTokens: 3000, completionTokens: 250 });
    expect(usd).toBeCloseTo(0.01, 4);
  });

  test("the table is dated, so nobody has to guess how old the numbers are", () => {
    expect(MODEL_PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("prices exactly the models the repo calls, and nothing it does not", () => {
    expect(pricedModelIds()).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });
});

describe("a model the table does not know", () => {
  test("is null, not zero", () => {
    expect(modelRate("claude-3-opus")).toBeNull();
    expect(costUsdForUsage({ model: "claude-3-opus", promptTokens: 10_000, completionTokens: 900 })).toBeNull();
  });

  test("a near-miss misses: a longer id is not silently matched to its prefix", () => {
    expect(modelRate("gpt-4o-mini-audio-preview")).toBeNull();
  });

  test("but a dated snapshot of a known model is the same model at the same price", () => {
    expect(modelRate("gpt-4o-2024-08-06")).toEqual(modelRate("gpt-4o"));
  });
});

describe("what counts as usage", () => {
  test("no tokens at all is unknown, not free", () => {
    expect(costUsdForUsage({ model: "gpt-4o", promptTokens: null, completionTokens: null })).toBeNull();
  });

  test("a reported zero is a real zero", () => {
    expect(costUsdForUsage({ model: "gpt-4o", promptTokens: 0, completionTokens: 0 })).toBe(0);
  });

  test("cached input is a discount on tokens already counted, never an extra charge", () => {
    const plain = costUsdForUsage({ model: "gpt-4o", promptTokens: 1_000_000, completionTokens: 0 });
    const cached = costUsdForUsage({
      model: "gpt-4o",
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    expect(plain).toBe(2.5);
    // Half price for the whole prompt, not 2.50 plus 1.25.
    expect(cached).toBe(1.25);
  });

  test("more cached tokens than prompt tokens cannot make a run cheaper than free", () => {
    const usd = costUsdForUsage({
      model: "gpt-4o",
      promptTokens: 100,
      completionTokens: 0,
      cachedInputTokens: 10_000,
    });
    expect(usd).toBeGreaterThan(0);
  });
});

describe("pricing a ledger row from its own telemetry", () => {
  test("prices a single-model row", () => {
    const usd = costUsdForLedgerTelemetry({
      modelRoute: "gpt-4o-mini",
      promptTokens: 40_000,
      completionTokens: 1_000,
    });
    // 40,000 x 0.15 + 1,000 x 0.60, per million.
    expect(usd).toBeCloseTo(0.0066, 6);
  });

  test("leaves a cost the caller already computed alone", () => {
    const usd = costUsdForLedgerTelemetry({
      modelRoute: "gpt-4o",
      promptTokens: 1_000,
      completionTokens: 10,
      costUsdActual: 0.4242,
    });
    expect(usd).toBe(0.4242);
  });

  test("declines to price a charge that spanned two models, because the row cannot say which burned what", () => {
    const usd = costUsdForLedgerTelemetry({
      modelRoute: joinModelRoute(["gpt-4o-mini", "gpt-4o"]),
      promptTokens: 50_000,
      completionTokens: 900,
    });
    expect(usd).toBeNull();
  });

  test("declines a row with no model and a row with no tokens", () => {
    expect(costUsdForLedgerTelemetry({ promptTokens: 10, completionTokens: 1 })).toBeNull();
    expect(costUsdForLedgerTelemetry({ modelRoute: "gpt-4o" })).toBeNull();
    expect(costUsdForLedgerTelemetry(null)).toBeNull();
  });
});

describe("joinModelRoute", () => {
  test("deduplicates and keeps first-seen order, so one model stays one plain id", () => {
    expect(joinModelRoute(["gpt-4o-mini", "gpt-4o-mini"])).toBe("gpt-4o-mini");
    expect(joinModelRoute(["gpt-4o-mini", "gpt-4o", "gpt-4o-mini"])).toBe("gpt-4o-mini+gpt-4o");
  });
});
