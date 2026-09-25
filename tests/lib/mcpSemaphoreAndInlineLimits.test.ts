/**
 * The two bounds from code review 2026-09-23 M16: how much of an inline PDF this process will hold,
 * decided from the base64 length before decoding, and how many Ghostscript/pdfjs runs may be live.
 */
import { describe, expect, it } from "vitest";

import {
  decodedBytesFromBase64Length,
  INLINE_SEND_MAX_BYTES,
  INLINE_UPLOAD_MAX_BASE64_CHARS,
  INLINE_UPLOAD_MAX_BYTES,
  inlineSendMaxBytes,
} from "../../mcp/src/inlineLimits";
import { optimizeConcurrency } from "../../mcp/src/optimize";
import { Semaphore } from "../../mcp/src/semaphore";
import { resolvePdfSource } from "../../mcp/src/tools/sharePdf";
import { ToolError } from "../../mcp/src/errors";

describe("inline limits", () => {
  it("the base64 ceiling decodes to the byte ceiling, not more", () => {
    expect(decodedBytesFromBase64Length(INLINE_UPLOAD_MAX_BASE64_CHARS)).toBeGreaterThanOrEqual(INLINE_UPLOAD_MAX_BYTES);
    expect(decodedBytesFromBase64Length(INLINE_UPLOAD_MAX_BASE64_CHARS)).toBeLessThan(INLINE_UPLOAD_MAX_BYTES + 8);
    expect(decodedBytesFromBase64Length(4)).toBe(3);
    expect(decodedBytesFromBase64Length(4, 2)).toBe(1);
  });

  it("the send ceiling clears a 4.5 MB function body after base64", () => {
    expect(Math.ceil(INLINE_SEND_MAX_BYTES / 3) * 4).toBeLessThan(4.5 * 1024 * 1024);
    expect(inlineSendMaxBytes("https://www.lnkdrp.com")).toBe(INLINE_SEND_MAX_BYTES);
    expect(inlineSendMaxBytes("http://localhost:3001")).toBe(INLINE_UPLOAD_MAX_BYTES);
  });

  it("an oversized fileBase64 is refused from its length, as too_large", () => {
    const huge = "A".repeat(INLINE_UPLOAD_MAX_BASE64_CHARS + 1);
    try {
      resolvePdfSource({ fileBase64: huge }, "https://www.lnkdrp.com");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("too_large");
      expect((err as ToolError).message).toContain("sourceUrl");
    }
    // At the ceiling it is accepted (and would be decoded later).
    expect(resolvePdfSource({ fileBase64: "A".repeat(INLINE_UPLOAD_MAX_BASE64_CHARS) }, "https://www.lnkdrp.com").kind).toBe("bytes");
  });
});

describe("Semaphore", () => {
  it("runs up to the limit at once and queues the rest in order", async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const gates: Array<() => void> = [];
    const jobs = [0, 1, 2, 3].map((i) =>
      sem.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        order.push(i);
        await new Promise<void>((resolve) => gates.push(resolve));
        running -= 1;
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(sem.running).toBe(2);
    expect(sem.queued).toBe(2);
    expect(order).toEqual([0, 1]);
    gates.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([0, 1, 2]);
    // Let the rest through one at a time; each finish admits the next queued job.
    for (let i = 0; i < 3; i++) {
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(jobs);
    expect(order).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
    expect(sem.running).toBe(0);
  });

  it("releases the slot when the work throws", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(sem.running).toBe(0);
    await expect(sem.run(async () => 1)).resolves.toBe(1);
  });

  it("concurrency comes from the environment with a sane default", () => {
    expect(optimizeConcurrency({} as unknown as NodeJS.ProcessEnv)).toBe(2);
    expect(optimizeConcurrency({ LNKDRP_PDF_OPTIMIZE_CONCURRENCY: "4" } as unknown as NodeJS.ProcessEnv)).toBe(4);
    expect(optimizeConcurrency({ LNKDRP_PDF_OPTIMIZE_CONCURRENCY: "0" } as unknown as NodeJS.ProcessEnv)).toBe(2);
  });
});
