import { describe, expect, it } from "vitest";

import { buildDocBlobPathname, safeTimestamp } from "../../src/lib/blob/clientUpload";

describe("clientUpload", () => {
  it("safeTimestamp is URL/path safe (no ':' or '.')", () => {
    const ts = safeTimestamp();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ts).not.toContain(":");
    expect(ts).not.toContain(".");
  });

  it("buildDocBlobPathname is deterministic with an explicit timestamp and sanitizes filename", () => {
    const pathname = buildDocBlobPathname({
      docId: "doc123",
      uploadId: "upload456",
      fileName: " ../weird\\path/..//my file (final).PDF ",
      timestamp: "2025-01-01T00-00-00-000Z",
    });

    expect(pathname).toBe(
      "docs/doc123/uploads/upload456/2025-01-01T00-00-00-000Z-.-weird-path-.-my-file-final-.PDF",
    );
  });
});


