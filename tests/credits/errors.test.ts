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



import { DAILY_CAP_CODE, isDailyCapError } from "@/lib/credits/errors";

describe("daily cap errors", () => {
  test("the daily brake is an out-of-credits class error with its own code", () => {
    const e = new Error("Daily credit cap exceeded");
    expect(isOutOfCreditsError(e)).toBe(true);
    expect(isDailyCapError(e)).toBe(true);
    expect(isDailyCapError(new Error("Insufficient credits"))).toBe(false);
    expect(DAILY_CAP_CODE).toBe("DAILY_CREDIT_CAP");
  });
});
