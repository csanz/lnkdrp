import { describe, expect, it } from "vitest";

import {
  OPTIMIZE_MIN_BYTES,
  OPTIMIZE_MIN_SAVING_RATIO,
  decideOptimizedBytes,
  ghostscriptCandidates,
  looksLikePdf,
  shouldOptimize,
} from "../../mcp/src/optimize";

/**
 * The PDF optimizer's decisions (mcp/src/optimize.ts).
 *
 * The part worth testing is not Ghostscript — it is the two pure gates around it, because they are
 * what stops a smaller upload from becoming a worse document. Ghostscript can emit a truncated PDF
 * and still exit 0; the page-count comparison is the only thing between that and a deck that
 * silently loses its last three slides.
 */
describe("shouldOptimize", () => {
  it("skips when the caller said not to", () => {
    const r = shouldOptimize({ sizeBytes: 10 * 1024 * 1024, requested: false });
    expect(r.run).toBe(false);
    expect(r.reason).toContain("optimize: false");
  });

  it("skips a file that is already small", () => {
    const r = shouldOptimize({ sizeBytes: OPTIMIZE_MIN_BYTES - 1, requested: true });
    expect(r.run).toBe(false);
    expect(r.reason).toContain("already under");
  });

  it("runs on a file at or over the threshold", () => {
    expect(shouldOptimize({ sizeBytes: OPTIMIZE_MIN_BYTES, requested: true })).toEqual({ run: true, reason: null });
    expect(shouldOptimize({ sizeBytes: 3_565_890, requested: true }).run).toBe(true);
  });
});

describe("decideOptimizedBytes", () => {
  const pages = { originalPages: 12, optimizedPages: 12 };

  it("accepts a big win and reports the ratio to two decimals", () => {
    const d = decideOptimizedBytes({ originalBytes: 3_565_890, optimizedBytes: 812_345, ...pages });
    expect(d).toEqual({ use: "optimized", ratio: 0.23 });
  });

  it("keeps the original when the output is not smaller", () => {
    const d = decideOptimizedBytes({ originalBytes: 3_000_000, optimizedBytes: 3_400_000, ...pages });
    expect(d).toEqual({ use: "original", reason: "the optimized file was not smaller" });
  });

  it("keeps the original when the saving is too small to be worth a lossy round-trip", () => {
    const barelySmaller = Math.round(3_000_000 * (1 - OPTIMIZE_MIN_SAVING_RATIO / 2));
    const d = decideOptimizedBytes({ originalBytes: 3_000_000, optimizedBytes: barelySmaller, ...pages });
    expect(d.use).toBe("original");
  });

  it("keeps the original when the page count changed, however good the saving looks", () => {
    const d = decideOptimizedBytes({
      originalBytes: 3_000_000,
      optimizedBytes: 100_000,
      originalPages: 12,
      optimizedPages: 9,
    });
    expect(d.use).toBe("original");
    expect(d).toMatchObject({ reason: expect.stringContaining("12 → 9") });
  });

  it("keeps the original when a page count could not be read on either side", () => {
    expect(
      decideOptimizedBytes({ originalBytes: 3_000_000, optimizedBytes: 100_000, originalPages: null, optimizedPages: 12 }).use,
    ).toBe("original");
    expect(
      decideOptimizedBytes({ originalBytes: 3_000_000, optimizedBytes: 100_000, originalPages: 12, optimizedPages: null }).use,
    ).toBe("original");
  });

  it("keeps the original when the optimizer produced nothing", () => {
    const d = decideOptimizedBytes({ originalBytes: 3_000_000, optimizedBytes: 0, ...pages });
    expect(d).toEqual({ use: "original", reason: "the optimizer produced an empty file" });
  });

  it("a single-page document is treated no differently", () => {
    const d = decideOptimizedBytes({ originalBytes: 2_000_000, optimizedBytes: 400_000, originalPages: 1, optimizedPages: 1 });
    expect(d.use).toBe("optimized");
  });
});

describe("looksLikePdf", () => {
  it("accepts the %PDF- signature and nothing else", () => {
    expect(looksLikePdf(Buffer.from("%PDF-1.7\nrest"))).toBe(true);
    expect(looksLikePdf(Buffer.from("<!doctype html>"))).toBe(false);
    expect(looksLikePdf(Buffer.from("%PDF"))).toBe(false); // too short to be sure
    expect(looksLikePdf(Buffer.alloc(0))).toBe(false);
  });
});

describe("ghostscriptCandidates", () => {
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...extra });

  it("puts an explicit LNKDRP_GHOSTSCRIPT first and de-duplicates", () => {
    expect(ghostscriptCandidates(env({ LNKDRP_GHOSTSCRIPT: "/opt/homebrew/bin/gs" }))[0]).toBe("/opt/homebrew/bin/gs");
    expect(ghostscriptCandidates(env({ LNKDRP_GHOSTSCRIPT: "/opt/homebrew/bin/gs" })).filter((c) => c === "/opt/homebrew/bin/gs")).toHaveLength(1);
  });

  it("falls back to PATH and the usual install locations", () => {
    const list = ghostscriptCandidates(env());
    expect(list[0]).toBe("gs");
    expect(list).toContain("/usr/local/bin/gs");
  });
});
