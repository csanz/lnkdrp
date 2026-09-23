/**
 * A one-line-per-page outline of a document, for the visit brief.
 *
 * `Doc.extractedText` is the whole document as one string, with no page boundaries, so nothing in
 * the product could say what was *on* page 7 — only that page 7 was read. The compare feature
 * already extracts text per page with pdfjs (`extractPdfTextByPage`); this reuses it to store the
 * heading and the first words of every page on the document, once per upload version.
 *
 * Lazy and best-effort: built the first time a brief asks for it, keyed to `currentUploadId` so a
 * replacement invalidates it, and a failure returns null rather than blocking the brief. The brief
 * without an outline still says "page 7"; it just cannot say "the pricing page".
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { fetchStoredBlob } from "@/lib/blob/fetchStoredBlob";
import { extractPdfTextByPage } from "@/lib/history/changedPages";
import { debugError } from "@/lib/debug";

export type PageOutlineEntry = { pageNumber: number; heading: string | null; excerpt: string | null; text: string | null };

/** Past this the prompt is paying for pages nobody read; the brief only ever names a handful. */
export const PAGE_OUTLINE_MAX_PAGES = 200;
/**
 * The whole page, within reason. A slide is a few hundred characters; a dense report page runs to
 * three or four thousand. The brief only ever sends the text of the handful of pages that held the
 * reader, so this bounds the prompt, not the store.
 */
export const PAGE_TEXT_MAX_CHARS = 2_500;
/** Bump when the stored shape changes; older outlines are rebuilt the next time a brief needs one. */
export const PAGE_OUTLINE_VERSION = 2;
const HEADING_MAX = 80;
const EXCERPT_MAX_WORDS = 40;

/** The first line that looks like a title, and the first words after it. Pure, for tests. */
export function outlineEntryFromText(pageNumber: number, text: string): PageOutlineEntry {
  const lines = (text ?? "")
    .split(/\r?\n|(?<=[.!?])\s{2,}/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // pdfjs joins text items with spaces, so a "line" here is often the whole page; fall back to the
  // first sentence-ish chunk when there is only one.
  const first = lines[0] ?? "";
  const words = (text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const heading = first ? first.slice(0, HEADING_MAX) : null;
  const excerpt = words.length ? words.slice(0, EXCERPT_MAX_WORDS).join(" ") : null;
  const full = words.join(" ");
  return {
    pageNumber,
    heading: heading || null,
    excerpt: excerpt && excerpt !== heading ? excerpt : null,
    text: full ? full.slice(0, PAGE_TEXT_MAX_CHARS) : null,
  };
}

type OutlineDoc = {
  _id: unknown;
  blobUrl?: unknown;
  currentUploadId?: unknown;
  uploadId?: unknown;
  pageOutline?: unknown;
  pageOutlineUploadId?: unknown;
  pageOutlineVersion?: unknown;
};

function currentUploadIdOf(doc: OutlineDoc): string | null {
  const v = doc.currentUploadId ?? doc.uploadId;
  return v && Types.ObjectId.isValid(String(v)) ? String(v) : null;
}

/**
 * The outline for a document, from the row when it is current, else built and stored.
 *
 * Errors are swallowed and reported as null: this runs inside the brief cron, where a PDF that
 * cannot be fetched or parsed must cost one line of detail, not the brief.
 */
export async function getPageOutline(docId: string | Types.ObjectId): Promise<PageOutlineEntry[] | null> {
  try {
    await connectMongo();
    const doc = (await DocModel.findById(docId)
      .select({ _id: 1, blobUrl: 1, currentUploadId: 1, uploadId: 1, pageOutline: 1, pageOutlineUploadId: 1, pageOutlineVersion: 1 })
      .lean()) as OutlineDoc | null;
    if (!doc) return null;

    const uploadId = currentUploadIdOf(doc);
    const stored = Array.isArray(doc.pageOutline) ? (doc.pageOutline as PageOutlineEntry[]) : [];
    const storedFor = doc.pageOutlineUploadId ? String(doc.pageOutlineUploadId) : null;
    const current = Number(doc.pageOutlineVersion) >= PAGE_OUTLINE_VERSION;
    if (stored.length && current && (!uploadId || storedFor === uploadId)) return stored.map(cleanEntry);

    const blobUrl = typeof doc.blobUrl === "string" ? doc.blobUrl : null;
    if (!blobUrl) return null;
    const res = await fetchStoredBlob(blobUrl);
    if (!res || !res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const pages = await extractPdfTextByPage(bytes);
    const outline = pages.slice(0, PAGE_OUTLINE_MAX_PAGES).map((p) => outlineEntryFromText(p.page_number, p.text));

    await DocModel.updateOne(
      { _id: doc._id },
      { $set: { pageOutline: outline, pageOutlineUploadId: uploadId ? new Types.ObjectId(uploadId) : null, pageOutlineVersion: PAGE_OUTLINE_VERSION } },
    );
    return outline;
  } catch (err) {
    debugError(1, "[visit-briefs] page outline failed", { docId: String(docId), message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function cleanEntry(e: PageOutlineEntry): PageOutlineEntry {
  return {
    pageNumber: Number(e.pageNumber),
    heading: typeof e.heading === "string" && e.heading ? e.heading : null,
    excerpt: typeof e.excerpt === "string" && e.excerpt ? e.excerpt : null,
    text: typeof e.text === "string" && e.text ? e.text : null,
  };
}
