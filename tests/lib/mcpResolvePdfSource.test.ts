import { describe, expect, it } from "vitest";

import { isLocalApiUrl, isLocalFileAccessAllowed, resolvePdfSource } from "../../mcp/src/tools/sharePdf";
import { UPLOAD_MAX_BYTES } from "../../src/lib/limits/uploads";
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
    // Base64 for exactly UPLOAD_MAX_BYTES of zero bytes: length is (n/3)*4 for n divisible by 3.
    const n = UPLOAD_MAX_BYTES - (UPLOAD_MAX_BYTES % 3); // nearest multiple of 3, at or under the ceiling
    const base64 = "A".repeat((n / 3) * 4);
    const r = resolvePdfSource({ fileBase64: base64 }, API_URL);
    expect(r.kind).toBe("bytes");
  });

  it("fileBase64 over the decoded-size ceiling is a clean too_large ToolError, not a thrown protocol error", () => {
    const overN = UPLOAD_MAX_BYTES + 3_000; // over the ceiling, unambiguously
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

describe("filePath — the local-file gate", () => {
  const LOCAL = "http://localhost:3001";
  const REMOTE = "https://lnkdrp.com";
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...extra });
  const noFlag = env();
  const withFlag = env({ LNKDRP_ALLOW_LOCAL_FILES: "1" });

  it("recognises the loopback API URLs a local server uses", () => {
    expect(isLocalApiUrl("http://localhost:3001")).toBe(true);
    expect(isLocalApiUrl("http://127.0.0.1:3001")).toBe(true);
    expect(isLocalApiUrl("http://127.1.2.3:3001")).toBe(true);
    expect(isLocalApiUrl("http://app.localhost")).toBe(true);
    expect(isLocalApiUrl("https://lnkdrp.com")).toBe(false);
    expect(isLocalApiUrl("https://localhost.evil.com")).toBe(false);
    expect(isLocalApiUrl("not a url")).toBe(false);
  });

  it("allows local files for a localhost API, or when the operator sets the flag", () => {
    expect(isLocalFileAccessAllowed({ apiUrl: LOCAL, env: noFlag })).toBe(true);
    expect(isLocalFileAccessAllowed({ apiUrl: REMOTE, env: noFlag })).toBe(false);
    expect(isLocalFileAccessAllowed({ apiUrl: REMOTE, env: withFlag })).toBe(true);
    expect(isLocalFileAccessAllowed({ apiUrl: REMOTE, env: env({ LNKDRP_ALLOW_LOCAL_FILES: "0" }) })).toBe(false);
  });

  it("resolves an absolute path against a local server, defaulting the name to its basename", () => {
    const r = resolvePdfSource({ filePath: "/Users/me/Downloads/USAVX DECK.pdf" }, LOCAL, noFlag);
    expect(r).toEqual({ kind: "file", filePath: "/Users/me/Downloads/USAVX DECK.pdf", fileName: "USAVX DECK.pdf" });
  });

  it("lets fileName override the basename", () => {
    const r = resolvePdfSource({ filePath: "/tmp/x.pdf", fileName: "Deck.pdf" }, LOCAL, noFlag);
    expect(r).toEqual({ kind: "file", filePath: "/tmp/x.pdf", fileName: "Deck.pdf" });
  });

  it("refuses a relative path, and says to expand ~ first", () => {
    const err = expectToolError(() => resolvePdfSource({ filePath: "~/Downloads/deck.pdf" }, LOCAL, noFlag));
    expect(err.code).toBe("validation");
    expect(err.message).toContain("absolute");
  });

  it("refuses filePath entirely against a remote API, pointing at sourceUrl", () => {
    const err = expectToolError(() => resolvePdfSource({ filePath: "/tmp/x.pdf" }, REMOTE, noFlag));
    expect(err.code).toBe("validation");
    expect(err.message).toContain("sourceUrl");
    expect(err.message).toContain("LNKDRP_ALLOW_LOCAL_FILES");
  });

  it("accepts the same path once the flag is set", () => {
    expect(resolvePdfSource({ filePath: "/tmp/x.pdf" }, REMOTE, withFlag)).toEqual({
      kind: "file",
      filePath: "/tmp/x.pdf",
      fileName: "x.pdf",
    });
  });

  it("still insists on exactly one source when filePath is combined with another", () => {
    expect(expectToolError(() => resolvePdfSource({ filePath: "/tmp/x.pdf", fileBase64: "AAAA" }, LOCAL, noFlag)).code).toBe("validation");
    expect(expectToolError(() => resolvePdfSource({ filePath: "/tmp/x.pdf", sourceUrl: "https://e.com/a.pdf" }, LOCAL, noFlag)).code).toBe(
      "validation",
    );
  });
});
