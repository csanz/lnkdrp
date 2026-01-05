import { describe, expect, test } from "vitest";

import { isOutOfCreditsError } from "@/lib/credits/errors";

describe("credits/errors", () => {
  test("detects out-of-credits style errors", () => {
    expect(isOutOfCreditsError(new Error("Insufficient credits"))).toBe(true);
    expect(isOutOfCreditsError(new Error("On-demand monthly limit exceeded"))).toBe(true);
    expect(isOutOfCreditsError(new Error("Daily credit cap exceeded"))).toBe(true);
    expect(isOutOfCreditsError(new Error("Monthly credit cap exceeded"))).toBe(true);
    expect(isOutOfCreditsError(new Error("Other error"))).toBe(false);
  });
});


