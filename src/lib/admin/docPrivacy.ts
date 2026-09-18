/**
 * What an admin may see of someone else's document: its metadata, never its contents.
 *
 * Admin pages exist to answer operational questions — did this upload process, how big was it, when
 * was it shared, why did the AI run fail. None of that needs the file. The admin doc and upload
 * routes used to return `blobUrl` (a public Vercel Blob URL: anyone with it reads the PDF),
 * `previewImageUrl`, `firstPagePngUrl`, `rawExtractedText`, `pdfText` and `aiOutput` — the document,
 * its pictures, its full text and the summary written from it. The pages then linked to `/doc/:id`
 * and `/s/:shareId`, so opening a customer's document was one click.
 *
 * Titles and filenames stay: they are how an admin identifies the row being asked about.
 *
 * Presence and size survive redaction because "is there a preview?" and "how big is the text?" are
 * real operational questions that the content itself does not have to answer.
 */

/** Fields that carry document content or a way to fetch it. Never leave the server. */
export const DOC_CONTENT_FIELDS = [
  "blobUrl",
  "blobPathname",
  "previewImageUrl",
  "firstPagePngUrl",
  "extractedTextBlobUrl",
  "extractedTextBlobPathname",
  "rawExtractedText",
  "pdfText",
  "aiOutput",
  "pageSlugs",
] as const;

export type RedactedContent = {
  /** The file exists in storage (its URL is not returned). */
  hasFile: boolean;
  hasPreviewImage: boolean;
  hasFirstPagePng: boolean;
  hasExtractedText: boolean;
  /** Characters of extracted text, so a truncated or empty extraction is still diagnosable. */
  extractedTextChars: number | null;
  hasAiOutput: boolean;
  /** Page count from the stored page list, without the slugs themselves. */
  pageCount: number | null;
};

function textLength(v: unknown): number | null {
  return typeof v === "string" ? v.length : null;
}

/**
 * Strip every content field from one document or upload row and report what was there instead.
 * Returns a new object; the input is untouched.
 */
export function redactDocRow<T extends Record<string, unknown>>(row: T): Omit<T, (typeof DOC_CONTENT_FIELDS)[number]> & { content: RedactedContent } {
  const out: Record<string, unknown> = { ...row };
  const pages = Array.isArray(row.pageSlugs) ? row.pageSlugs.length : null;
  const content: RedactedContent = {
    hasFile: typeof row.blobUrl === "string" && row.blobUrl.length > 0,
    hasPreviewImage: typeof row.previewImageUrl === "string" && row.previewImageUrl.length > 0,
    hasFirstPagePng: typeof row.firstPagePngUrl === "string" && row.firstPagePngUrl.length > 0,
    hasExtractedText:
      (typeof row.rawExtractedText === "string" && row.rawExtractedText.length > 0) ||
      (typeof row.pdfText === "string" && row.pdfText.length > 0) ||
      (typeof row.extractedTextBlobUrl === "string" && row.extractedTextBlobUrl.length > 0),
    extractedTextChars: textLength(row.rawExtractedText) ?? textLength(row.pdfText),
    hasAiOutput: Boolean(row.aiOutput),
    pageCount: pages,
  };
  for (const f of DOC_CONTENT_FIELDS) delete out[f];
  out.content = content;
  return out as Omit<T, (typeof DOC_CONTENT_FIELDS)[number]> & { content: RedactedContent };
}

/** `redactDocRow` over a list. */
export function redactDocRows<T extends Record<string, unknown>>(rows: T[]): ReturnType<typeof redactDocRow<T>>[] {
  return rows.map((r) => redactDocRow(r));
}

/** Shown wherever an admin page would otherwise have offered the document. */
export const ADMIN_NO_CONTENT_NOTE =
  "Document contents are not available in admin: no file, preview, text or AI output. Ask the workspace owner if you need to see it.";
