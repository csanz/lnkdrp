import { describe, expect, it } from "vitest";

import {
  BROWSER_DIRECT_UPLOAD_MAX_BYTES,
  UPLOAD_BASE64_SCHEMA_MAX_CHARS,
  UPLOAD_MAX_BASE64_CHARS,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_LABEL,
  formatMaxBytesMb,
} from "../../src/lib/limits/uploads";

/**
 * The upload limits module (src/lib/limits/uploads.ts) — the one place the size ceiling is written
 * down, after it had been written down four times with three different numbers.
 *
 * What is worth pinning here is the derived arithmetic: `UPLOAD_MAX_BASE64_CHARS` is what both the
 * MCP tools and `import-bytes` use to reject an oversized payload from a string's length alone, so
 * it must be at least as large as any base64 encoding of a file at the limit — a ceiling that is
 * one character too tight would refuse a legal file with a "too large" message.
 */
describe("upload limits", () => {
  it("is 50MB", () => {
    expect(UPLOAD_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(UPLOAD_MAX_LABEL).toBe("50MB");
  });

  it("the base64 ceiling really fits a file of exactly UPLOAD_MAX_BYTES", () => {
    // Base64 is 4 characters per 3 bytes, padded up to a multiple of 4.
    const encodedLength = Math.ceil(UPLOAD_MAX_BYTES / 3) * 4;
    expect(UPLOAD_MAX_BASE64_CHARS).toBeGreaterThanOrEqual(encodedLength);
  });

  it("the base64 ceiling is not wildly generous either", () => {
    // Under 5% of slack: enough for padding, not enough to smuggle a much bigger file past it.
    expect(UPLOAD_MAX_BASE64_CHARS).toBeLessThan(Math.ceil(UPLOAD_MAX_BYTES / 3) * 4 * 1.05);
  });

  it("encoding a real buffer at the limit stays inside the ceiling", () => {
    // 3MB sample, scaled: the ratio is what matters and a 50MB buffer in a unit test is wasteful.
    const sample = Buffer.alloc(3 * 1024 * 1024);
    const ratio = sample.toString("base64").length / sample.byteLength;
    expect(Math.ceil(UPLOAD_MAX_BYTES * ratio)).toBeLessThanOrEqual(UPLOAD_MAX_BASE64_CHARS);
  });

  it("the Zod backstop is looser than the real gate, so the friendly error wins", () => {
    // If these were equal, an over-limit call would die as a raw "-32602 Input validation error"
    // instead of reaching resolvePdfSource's `too_large` message. Measured live; see the module.
    expect(UPLOAD_BASE64_SCHEMA_MAX_CHARS).toBeGreaterThan(UPLOAD_MAX_BASE64_CHARS);
  });

  it("the browser's direct-to-Blob upload stays larger — it never passes through a function body", () => {
    expect(BROWSER_DIRECT_UPLOAD_MAX_BYTES).toBeGreaterThan(UPLOAD_MAX_BYTES);
  });

  it("formats whole megabytes, rounding down so copy never overstates the limit", () => {
    expect(formatMaxBytesMb(50 * 1024 * 1024)).toBe("50MB");
    expect(formatMaxBytesMb(50 * 1024 * 1024 - 1)).toBe("49MB");
    expect(formatMaxBytesMb(0)).toBe("0MB");
  });
});
