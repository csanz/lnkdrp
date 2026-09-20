/**
 * What an admin may see of someone else's document: its metadata, never its contents, and never a
 * key to them.
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
 *
 * ---
 *
 * Two different things have to be withheld, and they fail differently.
 *
 * **Content** is the document. Leaking it is a disclosure: bad, but bounded by what was in the row.
 * That is `DOC_CONTENT_FIELDS`, and it was under-specified — `rawExtractedText` and `pdfText` were
 * listed but `extractedText`, which the processing pipeline writes with the whole PDF on every run,
 * was not; nor was `slideNodes`, whose `imageUrl`/`thumbUrl` are public blob URLs, one per page of
 * the deck. Stripping nine of eleven doors is not a wall.
 *
 * **Secrets** are worse, because they are not a copy of anything — they are *access*, they work
 * from any browser with no session, and nobody can take them back. `replaceUploadToken` overwrites
 * the PDF that every live share link serves. `uploadSecret` is a standing write capability over an
 * upload. `requestViewToken` streams the raw PDF of every document in a request repo, and
 * `requestUploadToken` plants new ones in it. The share slug is the plainest of all: `/s/:shareId`
 * renders the document, so one slug in an admin payload defeats every field stripped above it. And
 * the share-password material (salt+hash for offline cracking, plus an AES-GCM blob reversible
 * under one app-wide key) hands over the links that were protected.
 *
 * So `SECRET_FIELDS` is a deny-list by field *name*, applied to whatever row an admin route hands
 * back — Doc, Upload, Project, ShareLink alike. A route added next year that forgets to project its
 * fields still cannot serve a token through here. The flags say whether each capability exists,
 * which is what support actually gets asked ("is that link password-protected?", "is this repo
 * still accepting uploads?"); an admin who needs to open a share page asks the customer for the
 * slug, and can paste it into the search box on `/a/data/links` to find the row.
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
  /** The canonical copy of the PDF's text on the Doc — written on every processing run. */
  "extractedText",
  "aiOutput",
  "pageSlugs",
  /** Per-page image/thumb URLs; each one is a public blob link to a page of the document. */
  "slideNodes",
] as const;

/**
 * Fields whose *value is the access*. Never leave the server, on any row, from any admin route.
 *
 * Matched by name rather than by model on purpose: these names are stable across Doc, Upload,
 * Project and ShareLink, and a deny-list by name is the only version of this rule that covers a
 * route nobody has written yet.
 */
export const SECRET_FIELDS = [
  /** The public slug. `/s/:shareId` and `/p/:shareId` render the content itself. */
  "shareId",
  /** Doc: capability code accepted by `/api/doc/update/:code` — replaces the live PDF, unrevocable. */
  "replaceUploadToken",
  /** Upload: standing write capability, no expiry, accepted as `x-upload-secret`. */
  "uploadSecret",
  /** Project: plants documents in a customer's request repo as if a recipient had sent them. */
  "requestUploadToken",
  /** Project: streams the raw PDF of every document in the repo, with no session at all. */
  "requestViewToken",
  /** Doc: salt+hash (offline cracking) and the reversible copy of the share password. */
  "sharePasswordSalt",
  "sharePasswordHash",
  "sharePasswordEnc",
  "sharePasswordEncIv",
  "sharePasswordEncTag",
  /** ShareLink: the same password material under its per-link names. */
  "passwordSalt",
  "passwordHash",
  "passwordEnc",
  "passwordEncIv",
  "passwordEncTag",
] as const;

export type DocContentField = (typeof DOC_CONTENT_FIELDS)[number];
export type SecretField = (typeof SECRET_FIELDS)[number];

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
  /** Rendered page images exist, and how many — without the public URLs that serve them. */
  slideImageCount: number | null;
};

/**
 * Which capabilities this row carries, so support can answer "is it protected?" and "can they still
 * upload?" without being handed the thing that grants the access.
 *
 * `null` rather than `false` when the route never asked the database for the field. The whole point
 * of these flags is that routes can stop selecting secrets; a flag that reported `false` for an
 * unselected field would turn that improvement into a confident lie on a support call.
 */
export type RedactedSecrets = {
  /** The row has a public share slug (the link exists); the slug itself is withheld. */
  hasShareLink: boolean | null;
  hasSharePassword: boolean | null;
  /** A replace-upload / upload capability token is set on the row. */
  hasReplaceUploadToken: boolean | null;
  hasUploadSecret: boolean | null;
  /** Request repo: an upload token and/or a view token is set. */
  hasRequestUploadToken: boolean | null;
  hasRequestViewToken: boolean | null;
};

function textLength(v: unknown): number | null {
  return typeof v === "string" ? v.length : null;
}

function isSet(v: unknown): boolean {
  return typeof v === "string" ? v.trim().length > 0 : v != null && v !== false;
}

/** True if any of `names` holds a value, false if all were looked up and empty, null if none was. */
function flag(row: Record<string, unknown>, ...names: string[]): boolean | null {
  let lookedUp = false;
  for (const n of names) {
    if (!(n in row)) continue;
    lookedUp = true;
    if (isSet(row[n])) return true;
  }
  return lookedUp ? false : null;
}

/** Report which capabilities a row carried, then take them out of it. */
function describeSecrets(row: Record<string, unknown>): RedactedSecrets {
  return {
    hasShareLink: flag(row, "shareId"),
    hasSharePassword: flag(row, "sharePasswordHash", "passwordHash"),
    hasReplaceUploadToken: flag(row, "replaceUploadToken"),
    hasUploadSecret: flag(row, "uploadSecret"),
    hasRequestUploadToken: flag(row, "requestUploadToken"),
    hasRequestViewToken: flag(row, "requestViewToken"),
  };
}

/**
 * Strip every capability token from any admin row and report what was there instead.
 *
 * For rows that are not documents — a Project, a ShareLink — where there is no content to strip but
 * the tokens are exactly the same problem. Returns a new object; the input is untouched.
 */
export function stripSecrets<T extends Record<string, unknown>>(row: T): Omit<T, SecretField> & { secrets: RedactedSecrets } {
  const out: Record<string, unknown> = { ...row };
  const secrets = describeSecrets(row);
  for (const f of SECRET_FIELDS) delete out[f];
  out.secrets = secrets;
  return out as Omit<T, SecretField> & { secrets: RedactedSecrets };
}

/**
 * Strip every content field and every capability token from one document or upload row and report
 * what was there instead. Returns a new object; the input is untouched.
 */
export function redactDocRow<T extends Record<string, unknown>>(
  row: T,
): Omit<T, DocContentField | SecretField> & { content: RedactedContent; secrets: RedactedSecrets } {
  const out: Record<string, unknown> = { ...row };
  const pages = Array.isArray(row.pageSlugs) ? row.pageSlugs.length : null;
  const slides = Array.isArray(row.slideNodes) ? row.slideNodes.length : null;
  const content: RedactedContent = {
    hasFile: typeof row.blobUrl === "string" && row.blobUrl.length > 0,
    hasPreviewImage: typeof row.previewImageUrl === "string" && row.previewImageUrl.length > 0,
    hasFirstPagePng: typeof row.firstPagePngUrl === "string" && row.firstPagePngUrl.length > 0,
    hasExtractedText:
      (typeof row.rawExtractedText === "string" && row.rawExtractedText.length > 0) ||
      (typeof row.pdfText === "string" && row.pdfText.length > 0) ||
      (typeof row.extractedText === "string" && row.extractedText.length > 0) ||
      (typeof row.extractedTextBlobUrl === "string" && row.extractedTextBlobUrl.length > 0),
    extractedTextChars: textLength(row.rawExtractedText) ?? textLength(row.pdfText) ?? textLength(row.extractedText),
    hasAiOutput: Boolean(row.aiOutput),
    pageCount: pages,
    slideImageCount: slides,
  };
  const secrets = describeSecrets(row);
  for (const f of DOC_CONTENT_FIELDS) delete out[f];
  for (const f of SECRET_FIELDS) delete out[f];
  out.content = content;
  out.secrets = secrets;
  return out as Omit<T, DocContentField | SecretField> & { content: RedactedContent; secrets: RedactedSecrets };
}

/** `redactDocRow` over a list. */
export function redactDocRows<T extends Record<string, unknown>>(rows: T[]): ReturnType<typeof redactDocRow<T>>[] {
  return rows.map((r) => redactDocRow(r));
}

/**
 * A Review row's prompts and outputs are the document, twice over.
 *
 * `prompt` / `agentUserPrompt` are built by feeding the deck's extracted text to the review agent,
 * and `outputMarkdown` / `intel` / `agentOutput` are the AI's written analysis of it — company,
 * founders, traction. Withholding `rawExtractedText` on the doc row next to it and then serving
 * this was redaction in one tab only.
 */
export const REVIEW_CONTENT_FIELDS = [
  "prompt",
  "outputMarkdown",
  "intel",
  "agentOutput",
  "agentRawOutputText",
  "agentSystemPrompt",
  "agentUserPrompt",
] as const;

export type ReviewContentField = (typeof REVIEW_CONTENT_FIELDS)[number];

export type RedactedReviewContent = {
  /** `null` where the route did not select the field at all — see `RedactedSecrets`. */
  hasPrompt: boolean | null;
  promptChars: number | null;
  /** The agent produced written output, and how much — "did it run and return?" without the text. */
  hasOutput: boolean | null;
  outputChars: number | null;
  hasIntel: boolean | null;
};

/**
 * Strip a Review row's prompts and analysis, keeping the run's shape (status, model, sizes) — which
 * is what the admin page is for: seeing whether a review ran, failed, or came back empty.
 */
export function redactReviewRow<T extends Record<string, unknown>>(
  row: T,
): Omit<T, ReviewContentField | SecretField> & { review: RedactedReviewContent; secrets: RedactedSecrets } {
  const out = stripSecrets(row) as Record<string, unknown>;
  const review: RedactedReviewContent = {
    hasPrompt: flag(row, "prompt", "agentUserPrompt"),
    promptChars: textLength(row.prompt) ?? textLength(row.agentUserPrompt),
    hasOutput: flag(row, "outputMarkdown", "agentRawOutputText", "agentOutput"),
    outputChars: textLength(row.outputMarkdown) ?? textLength(row.agentRawOutputText),
    hasIntel: flag(row, "intel"),
  };
  for (const f of REVIEW_CONTENT_FIELDS) delete out[f];
  out.review = review;
  return out as Omit<T, ReviewContentField | SecretField> & { review: RedactedReviewContent; secrets: RedactedSecrets };
}

/**
 * An AiRun's prompts and outputs are customer content, not diagnostics.
 *
 * `userPrompt` is the analysis prompt with the document's whole text substituted into it (up to
 * 220,000 characters of it), `outputText`/`outputObject` are the model's reading of that document,
 * and `systemPrompt` is not safe either — it carries the requester's own instructions and the
 * customer's project names and descriptions appended to the base prompt. The list route next door
 * already answered "how big was the prompt?" with a character count; the detail route served the
 * prompt itself.
 */
export const AI_RUN_CONTENT_FIELDS = ["systemPrompt", "userPrompt", "outputText", "outputObject"] as const;

export type AiRunContentField = (typeof AI_RUN_CONTENT_FIELDS)[number];

export type RedactedAiRunContent = {
  /** `null` where the route did not select the field at all — see `RedactedSecrets`. */
  hasSystemPrompt: boolean | null;
  systemPromptChars: number | null;
  hasUserPrompt: boolean | null;
  userPromptChars: number | null;
  hasOutputText: boolean | null;
  outputTextChars: number | null;
  hasOutputObject: boolean | null;
};

/**
 * What an admin may know about an AI run: that it happened, how big it was, and how it failed.
 *
 * Takes the raw row and returns only the shape — the caller builds its own response object, so
 * there is nothing here to forget to delete.
 */
export function describeAiRunContent(row: Record<string, unknown>): RedactedAiRunContent {
  return {
    hasSystemPrompt: flag(row, "systemPrompt"),
    systemPromptChars: textLength(row.systemPrompt),
    hasUserPrompt: flag(row, "userPrompt"),
    userPromptChars: textLength(row.userPrompt),
    hasOutputText: flag(row, "outputText"),
    outputTextChars: textLength(row.outputText),
    hasOutputObject: flag(row, "outputObject"),
  };
}

/** Shown wherever an admin page would otherwise have offered the document. */
export const ADMIN_NO_CONTENT_NOTE =
  "Document contents are not available in admin: no file, preview, text or AI output. Ask the workspace owner if you need to see it.";

/**
 * Shown wherever an admin page would otherwise have offered a share slug or a capability token.
 *
 * Separate from the content note because it answers a different question: not "why can't I read
 * this?" but "why is there no link to copy?".
 */
export const ADMIN_NO_SECRETS_NOTE =
  "Share slugs and capability tokens are not available in admin: they grant access to the document itself, from any browser, with no way to revoke them. Ask the workspace owner for the link.";
