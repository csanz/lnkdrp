import { describe, expect, it } from "vitest";

import { DOC_CONTENT_FIELDS, redactDocRow, redactDocRows } from "@/lib/admin/docPrivacy";

/**
 * Admin sees a document's metadata, never the document. The admin doc and upload routes used to
 * return the file URL (a public blob link), the preview images, the extracted text and the AI
 * output, so reading a customer's document was one request.
 */
describe("redactDocRow", () => {
  const row = {
    id: "doc1",
    title: "Series A deck",
    status: "ready",
    sizeBytes: 12345,
    blobUrl: "https://blob.example.com/secret.pdf",
    blobPathname: "org/doc/secret.pdf",
    previewImageUrl: "https://blob.example.com/p.png",
    firstPagePngUrl: "https://blob.example.com/1.png",
    extractedTextBlobUrl: "https://blob.example.com/t.txt",
    extractedTextBlobPathname: "org/doc/t.txt",
    rawExtractedText: "the whole document text",
    pdfText: "the whole document text",
    aiOutput: { summary: "what the document says" },
    pageSlugs: ["a", "b", "c"],
  };

  it("removes every content field", () => {
    const out = redactDocRow(row) as Record<string, unknown>;
    for (const f of DOC_CONTENT_FIELDS) expect(out[f], f).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("blob.example.com");
    expect(JSON.stringify(out)).not.toContain("the whole document text");
    expect(JSON.stringify(out)).not.toContain("what the document says");
  });

  it("keeps the metadata an admin needs to identify and diagnose the row", () => {
    const out = redactDocRow(row);
    expect(out.title).toBe("Series A deck");
    expect(out.status).toBe("ready");
    expect(out.sizeBytes).toBe(12345);
  });

  it("reports what was there instead of the content itself", () => {
    const out = redactDocRow(row);
    expect(out.content).toEqual({
      hasFile: true,
      hasPreviewImage: true,
      hasFirstPagePng: true,
      hasExtractedText: true,
      extractedTextChars: "the whole document text".length,
      hasAiOutput: true,
      pageCount: 3,
    });
  });

  it("an empty row reports nothing stored rather than throwing", () => {
    const out = redactDocRow({});
    expect(out.content.hasFile).toBe(false);
    expect(out.content.extractedTextChars).toBeNull();
    expect(out.content.pageCount).toBeNull();
  });

  it("does not mutate its input", () => {
    const input = { ...row };
    redactDocRow(input);
    expect(input.blobUrl).toBe("https://blob.example.com/secret.pdf");
  });

  it("redacts a list", () => {
    const out = redactDocRows([row, row]);
    expect(out).toHaveLength(2);
    expect(JSON.stringify(out)).not.toContain("blob.example.com");
  });
});
