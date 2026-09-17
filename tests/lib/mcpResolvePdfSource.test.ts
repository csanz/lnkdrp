import { describe, expect, it } from "vitest";

import { MAX_INLINE_PDF_BYTES, resolvePdfSource } from "../../mcp/src/tools/sharePdf";
import { ToolError } from "../../mcp/src/errors";

/**
 * `resolvePdfSource` — the exactly-one-of-sourceUrl/fileBase64 gate shared by lnkdrp_share_pdf and
 * lnkdrp_replace_pdf (mt_bJwX4CtmhU). The size ceiling matters here specifically because a live
 * probe caught the Zod schema's own bound firing first and returning a raw protocol error instead
 * of this function's friendly `too_large` — these tests pin the boundary this function itself owns.
 */
const API_URL = "https://lnkdrp.com";

function expectToolError(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error("expected a ToolError");
}

describe("resolvePdfSource", () => {
  it("sourceUrl alone resolves to a validated url", () => {
    const r = resolvePdfSource({ sourceUrl: "https://example.com/a.pdf" }, API_URL);
    expect(r).toEqual({ kind: "url", url: "https://example.com/a.pdf" });
  });

  it("fileBase64 alone resolves to bytes, defaulting the filename", () => {
    const r = resolvePdfSource({ fileBase64: "AAAA" }, API_URL);
    expect(r).toEqual({ kind: "bytes", base64: "AAAA", fileName: "document.pdf" });
  });

  it("fileBase64 keeps a given fileName", () => {
    const r = resolvePdfSource({ fileBase64: "AAAA", fileName: "report.pdf" }, API_URL);
    expect(r).toEqual({ kind: "bytes", base64: "AAAA", fileName: "report.pdf" });
  });

  it("neither given is a validation error", () => {
    const err = expectToolError(() => resolvePdfSource({}, API_URL));
    expect(err.code).toBe("validation");
    expect(err.message).toContain("exactly one");
  });

  it("both given is a validation error", () => {
    const err = expectToolError(() => resolvePdfSource({ sourceUrl: "https://example.com/a.pdf", fileBase64: "AAAA" }, API_URL));
    expect(err.code).toBe("validation");
  });

  it("fileBase64 right at the decoded-size ceiling is accepted", () => {
    // Base64 for exactly MAX_INLINE_PDF_BYTES of zero bytes: length is (n/3)*4 for n divisible by 3.
    const n = MAX_INLINE_PDF_BYTES - (MAX_INLINE_PDF_BYTES % 3); // nearest multiple of 3, at or under the ceiling
    const base64 = "A".repeat((n / 3) * 4);
    const r = resolvePdfSource({ fileBase64: base64 }, API_URL);
    expect(r.kind).toBe("bytes");
  });

  it("fileBase64 over the decoded-size ceiling is a clean too_large ToolError, not a thrown protocol error", () => {
    const overN = MAX_INLINE_PDF_BYTES + 3_000_000; // well over, unambiguous
    const base64 = "A".repeat(Math.ceil(overN / 3) * 4);
    const err = expectToolError(() => resolvePdfSource({ fileBase64: base64 }, API_URL));
    expect(err.code).toBe("too_large");
    expect(err.message).toContain("sourceUrl");
  });

  it("an invalid sourceUrl still fails through validateSourceUrl's own message", () => {
    const err = expectToolError(() => resolvePdfSource({ sourceUrl: "not a url" }, API_URL));
    expect(err.code).toBe("validation");
  });
});

describe("unsupported sources (mt: Google/OneDrive links that can never be a PDF)", () => {
  const API = "http://localhost:3001";
  const reject = (url: string) => expect(() => resolvePdfSource({ sourceUrl: url }, API)).toThrow(/Download|download/);
  const accept = (url: string) => expect(resolvePdfSource({ sourceUrl: url }, API)).toEqual({ kind: "url", url });

  it("refuses Google Docs, Sheets and Slides editor links", () => {
    reject("https://docs.google.com/presentation/d/1e3FoMsTnnQLpga9Hbjro1oOdrYHzPm437mRTLoz0zBU/edit?slide=id.p");
    reject("https://docs.google.com/document/d/abc123/edit");
    reject("https://docs.google.com/spreadsheets/d/abc123/edit#gid=0");
  });

  it("refuses OneDrive and SharePoint links", () => {
    reject("https://onedrive.live.com/?id=root");
    reject("https://1drv.ms/b/s!AabbCc");
    reject("https://contoso-my.sharepoint.com/personal/x/Documents/deck.pdf");
  });

  it("still accepts a Google Drive file link, which the importer really does download", () => {
    accept("https://drive.google.com/file/d/1AbCdEf/view?usp=sharing");
    accept("https://drive.google.com/uc?export=download&id=1AbCdEf");
  });

  it("still accepts a Docs /export URL, which returns a real PDF", () => {
    accept("https://docs.google.com/presentation/d/abc123/export/pdf");
  });

  it("names the way out, so the caller is not left guessing", () => {
    expect(() => resolvePdfSource({ sourceUrl: "https://docs.google.com/presentation/d/x/edit" }, API)).toThrow(/fileBase64/);
  });
});
