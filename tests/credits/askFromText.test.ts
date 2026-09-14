import { describe, expect, test } from "vitest";

import { extractDollarAmounts, findRaiseAmount, resolveAsk } from "@/lib/ai/askFromText";

const memo =
  "Each aircraft covers approximately 2,400 square kilometers per day at an estimated $65 per flight hour, " +
  "compared with approximately $1,500 per hour for the patrol helicopter. Our current target cost is approximately " +
  "$12,000 per aircraft, compared with approximately $17 million for an MQ-9.";

describe("ask from text", () => {
  test("reads commas and word units", () => {
    expect(extractDollarAmounts(memo)).toEqual(["$65", "$1,500", "$12,000", "$17 million"]);
  });

  test("unit prices and comparisons are not an ask", () => {
    expect(findRaiseAmount(memo)).toBeNull();
    expect(resolveAsk("", memo)).toBe("");
    expect(resolveAsk("$65", memo)).toBe("");
  });

  test("an amount stated as a raise is the ask, with its purpose when given", () => {
    const deck = "Traction: $40K MRR. We are raising $2M to expand sales into three new markets. Burn is $80K per month.";
    expect(findRaiseAmount(deck)).toBe("$2M");
    expect(resolveAsk("", deck)).toBe("$2M to expand sales into three new markets.");
    expect(resolveAsk("$2M", deck)).toBe("$2M to expand sales into three new markets.");
    expect(resolveAsk("Raising a $2M seed round to expand sales", deck)).toBe("Raising a $2M seed round to expand sales");
  });

  test("a seed round mentioned after the amount counts", () => {
    expect(findRaiseAmount("Closing $1.5 million seed round in Q4.")).toBe("$1.5 million");
  });
});
