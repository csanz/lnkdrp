import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/pdf/renderPage", () => ({ openPdfDocument: vi.fn() }));

import { attachPageContext, computeChangedPages } from "@/lib/history/changedPages";
import { NO_CHANGE_SUMMARY } from "@/lib/ai/docChangeSummary";
import {
  PAGE_FINGERPRINT_HEX_LENGTH,
  PAGE_FINGERPRINT_MAX_DISTANCE,
  computePageFingerprint,
  fingerprintDistance,
  fingerprintsDiffer,
} from "@/lib/history/pageFingerprint";

/** A slide-like picture: a heading bar, a body block and a chart-ish column on a page. */
function slideSvg(params: { page: string; bar: number; barY: number; block: string; blockX: number; column: number }): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270">
       <rect width="480" height="270" fill="${params.page}"/>
       <rect x="32" y="${params.barY}" width="${params.bar}" height="26" fill="#111827"/>
       <rect x="${params.blockX}" y="82" width="240" height="120" fill="${params.block}"/>
       <circle cx="380" cy="120" r="46" fill="#f97316"/>
       <rect x="330" y="180" width="${params.column}" height="52" fill="#0ea5e9"/>
     </svg>`,
  );
}

/** Encode a slide SVG as JPEG at the given quality, the way the processing job does. */
async function jpeg(svg: Buffer, quality: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(svg).flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true }).toBuffer();
}

const SAME = slideSvg({ page: "#ffffff", bar: 300, barY: 28, block: "#e5e7eb", blockX: 32, column: 100 });
/** A different slide of the same deck: dark page, re-laid-out blocks. */
const DIFFERENT = slideSvg({ page: "#0f172a", bar: 120, barY: 210, block: "#f8fafc", blockX: 180, column: 20 });

describe("page fingerprints", () => {
  it("is a fixed-length hex string", async () => {
    const fp = await computePageFingerprint(await jpeg(SAME, 78));
    expect(fp).toMatch(/^[0-9a-f]+$/);
    expect(fp).toHaveLength(PAGE_FINGERPRINT_HEX_LENGTH);
  });

  it("identical bytes give an identical fingerprint", async () => {
    const bytes = await jpeg(SAME, 78);
    expect(await computePageFingerprint(bytes)).toBe(await computePageFingerprint(Buffer.from(bytes)));
  });

  it("re-encoding the same picture stays under the threshold", async () => {
    // The MCP re-optimizes every PDF before upload and the processing job re-renders every page, so
    // the same slide comes back as different bytes on every run. That must not read as a change.
    const a = await computePageFingerprint(await jpeg(SAME, 88));
    const b = await computePageFingerprint(await jpeg(SAME, 38));
    expect(fingerprintDistance(a, b)).toBeLessThanOrEqual(PAGE_FINGERPRINT_MAX_DISTANCE);
    expect(fingerprintsDiffer(a, b)).toBe(false);
  });

  it("a genuinely different slide is well over the threshold", async () => {
    const a = await computePageFingerprint(await jpeg(SAME, 78));
    const b = await computePageFingerprint(await jpeg(DIFFERENT, 78));
    expect(fingerprintDistance(a, b)!).toBeGreaterThan(PAGE_FINGERPRINT_MAX_DISTANCE * 2);
    expect(fingerprintsDiffer(a, b)).toBe(true);
  });

  it("is not comparable when a side is missing or malformed", () => {
    expect(fingerprintDistance("ff00", null)).toBeNull();
    expect(fingerprintDistance("ff00", "")).toBeNull();
    expect(fingerprintDistance("ff00", "zzzz")).toBeNull();
    expect(fingerprintDistance("ff00", "ff0000")).toBeNull();
    expect(fingerprintsDiffer("ff00", undefined)).toBeNull();
  });

  it("returns null for bytes it cannot decode", async () => {
    expect(await computePageFingerprint(Buffer.from("not an image"))).toBeNull();
  });
});

const TEXT = [
  { page_number: 1, text: "Cover" },
  { page_number: 2, text: "Coverage and cost" },
];

/** 64 hex chars, `flips` bits away from `base`. */
function nudged(base: string, flips: number): string {
  const bytes = base.match(/../g)!.map((h) => Number.parseInt(h, 16));
  for (let i = 0; i < flips; i++) bytes[i % bytes.length] ^= 1 << Math.floor(i / bytes.length);
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}
const FP_A = "0".repeat(PAGE_FINGERPRINT_HEX_LENGTH);
const FP_B = "f".repeat(PAGE_FINGERPRINT_HEX_LENGTH);

describe("computeChangedPages with fingerprints", () => {
  it("reports nothing when the pages only got re-encoded", () => {
    const pages = computeChangedPages({
      prevPages: TEXT,
      newPages: TEXT,
      // Same picture, new bytes: hashes differ, fingerprints are a few bits apart.
      prevSlideNodes: [
        { pageNumber: 1, imageHash: "h1", imageFingerprint: FP_A, thumbUrl: "p1" },
        { pageNumber: 2, imageHash: "h2", imageFingerprint: FP_A, thumbUrl: "p2" },
      ],
      nextSlideNodes: [
        { pageNumber: 1, imageHash: "h1-new", imageFingerprint: nudged(FP_A, PAGE_FINGERPRINT_MAX_DISTANCE), thumbUrl: "n1" },
        { pageNumber: 2, imageHash: "h2-new", imageFingerprint: FP_A, thumbUrl: "n2" },
      ],
    });
    expect(pages).toEqual([]);
  });

  it("still reports a page whose picture really changed", () => {
    const pages = computeChangedPages({
      prevPages: TEXT,
      newPages: TEXT,
      prevSlideNodes: [{ pageNumber: 2, imageHash: "h2", imageFingerprint: FP_A, thumbUrl: "p2" }],
      nextSlideNodes: [{ pageNumber: 2, imageHash: "h2", imageFingerprint: FP_B, thumbUrl: "n2" }],
    });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ pageNumber: 2, imageChanged: true, previousImageUrl: "p2", newImageUrl: "n2" });
  });

  it("falls back to the exact hash when one side has no fingerprint (uploads from before this change)", () => {
    const pages = computeChangedPages({
      prevPages: TEXT,
      newPages: TEXT,
      prevSlideNodes: [
        { pageNumber: 1, imageHash: "same", thumbUrl: "p1" },
        { pageNumber: 2, imageHash: "old", thumbUrl: "p2" },
      ],
      nextSlideNodes: [
        { pageNumber: 1, imageHash: "same", imageFingerprint: FP_A, thumbUrl: "n1" },
        { pageNumber: 2, imageHash: "new", imageFingerprint: FP_A, thumbUrl: "n2" },
      ],
    });
    expect(pages.map((p) => p.pageNumber)).toEqual([2]);
    expect(pages[0].imageChanged).toBe(true);
  });

  it("says nothing either way when a page has no image on one side", () => {
    const pages = computeChangedPages({
      prevPages: TEXT,
      newPages: [TEXT[0], { page_number: 2, text: "Coverage, cost and timeline" }],
      prevSlideNodes: [],
      nextSlideNodes: [{ pageNumber: 2, imageHash: "h2", imageFingerprint: FP_B, thumbUrl: "n2" }],
    });
    expect(pages.map((p) => p.pageNumber)).toEqual([2]);
    expect(pages[0].imageChanged).toBeNull();
  });
});

describe("a no-change diff never gains pages", () => {
  it("drops page rows a compare tried to attach to the no-change record", () => {
    const diff = { summary: NO_CHANGE_SUMMARY, changes: [], pagesThatChanged: [{ pageNumber: 3, summary: "Pricing changed" }] } as never;
    const out = attachPageContext(diff, [
      { pageNumber: 3, previousText: "", newText: "", previousImageUrl: "p3", newImageUrl: "n3", imageChanged: true },
      { pageNumber: 5, previousText: "", newText: "", previousImageUrl: "p5", newImageUrl: "n5", imageChanged: true },
    ]) as { summary: string; pagesThatChanged: unknown[] };
    expect(out.summary).toBe(NO_CHANGE_SUMMARY);
    expect(out.pagesThatChanged).toEqual([]);
  });
});
