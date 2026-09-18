/**
 * API route for `/api/uploads/:uploadId/process`.
 *
 * Triggers background processing (extract text, preview, AI) for an upload.
 */
import { NextResponse } from "next/server";
import { after } from "next/server";
import { Types } from "mongoose";
import { put } from "@vercel/blob";
import pdfParse from "pdf-parse";
import crypto from "node:crypto";
import { connectMongo } from "@/lib/mongodb";
import { UploadModel } from "@/lib/models/Upload";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { ReviewModel } from "@/lib/models/Review";
import { DocChangeModel } from "@/lib/models/DocChange";
import {
  buildDocExtractedTextPathname,
  buildDocPreviewPngPathname,
  buildDocPageImagePathname,
  buildDocPageThumbPathname,
} from "@/lib/blob/clientUpload";
import { analyzePdfText, isFallbackAnalysis, analysisTelemetry } from "@/lib/ai/analyzePdfText";
import { normalizeForCompare, runDocChangeDiff } from "@/lib/ai/docChangeDiff";
import { attachPageContext, extractPdfTextByPage, fetchPdfBytes, loadChangedPages, type ChangedPage } from "@/lib/history/changedPages";
import { computePageFingerprint } from "@/lib/history/pageFingerprint";
import { reviewDocText } from "@/lib/ai/reviewDocText";
import { runRequestReviewInvestorFocused } from "@/lib/ai/requestReviewInvestorFocused";
import { reserveCreditsOrThrow, markLedgerCharged, failAndRefundLedger, recordUnbilledRun } from "@/lib/credits/creditService";
import { getDefaultHistoryQualityTier } from "@/lib/credits/qualityDefaults";
import { isOutOfCreditsError } from "@/lib/credits/errors";
import { creditsForRun } from "@/lib/credits/schedule";
import { idempotencyKeyFromRequest } from "@/lib/credits/idempotency";
import { getCreditsSnapshot } from "@/lib/credits/snapshot";
import { OUT_OF_CREDITS_CODE } from "@/lib/credits/errors";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor, type Actor } from "@/lib/gating/actor";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";
import { openPdfDocument, renderPdfPageToPng, type PdfJsDocument } from "@/lib/pdf/renderPage";
import { agentFromRequest, recordActivity } from "@/lib/activity/log";
import { agentSummaryToAnalysis, readStoredAgentSummary } from "@/lib/ai/agentSummary";
import { findRaiseAmount, resolveAsk } from "@/lib/ai/askFromText";
import { INTERNAL_PROCESS_HEADER, verifyInternalProcessToken } from "@/lib/uploads/internalProcess";
import { createUploadProgressReporter } from "@/lib/uploads/progressWriter";

export const runtime = "nodejs";
// PDF rasterization + AI passes can take minutes for large decks (Vercel Pro/Enterprise cap).
export const maxDuration = 300;

/**
 * Reserve credits for an automatic run, never silently reusing a finished ledger row.
 *
 * Reservations are idempotent on their key, so a retried job gets the row from the earlier attempt
 * back. `pending` is the normal case and `charged` means that attempt already paid (the caller
 * must not charge or redo the work). A `refunded` or `failed` row holds no credits, so charging it
 * would give the run away for free; this reserves again under a retry-suffixed key instead.
 */
async function reserveForAttempt(params: Parameters<typeof reserveCreditsOrThrow>[0]) {
  const first = await reserveCreditsOrThrow(params);
  if (first.status === "pending" || first.status === "charged") return first;
  return await reserveCreditsOrThrow({ ...params, idempotencyKey: `${params.idempotencyKey}:retry:${Date.now().toString(36)}` });
}

/** An upload stuck in `processing` longer than this is considered abandoned and may be re-claimed. */
const PROCESSING_STALE_MS = 20 * 60 * 1000;
/**
 * Header (uses get, toLowerCase).
 */


function header(request: Request, name: string) {
  return request.headers.get(name) ?? request.headers.get(name.toLowerCase());
}

/**
 * Return whether record.
 */


/**
 * Write to the document only while this upload has not been superseded.
 *
 * A slow upload (a large file fetched from a URL) can still be processing when the owner replaces
 * it. Its late finish used to overwrite the document unconditionally, so a doc replaced with v2
 * went back to v1's preview, text and summary ten seconds later. The filter skips the write when
 * any newer upload of the document is already the current one; the upload row itself still
 * completes and stays in the version history.
 */
async function updateDocUnlessSuperseded(
  docId: unknown,
  upload: { _id: unknown; version?: unknown },
  update: Record<string, unknown>,
): Promise<boolean> {
  const version = Number.isFinite(Number(upload.version)) ? Number(upload.version) : 0;
  const newer = await UploadModel.find({ docId, version: { $gt: version }, isDeleted: { $ne: true } })
    .select({ _id: 1 })
    .lean();
  const res = await DocModel.updateOne({ _id: docId, currentUploadId: { $nin: newer.map((u) => u._id) } }, update);
  if (res.matchedCount === 0) {
    debugLog(1, "[process] doc write skipped: a newer upload is current", { docId: String(docId), uploadId: String(upload._id), version });
    return false;
  }
  return true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
/**
 * As String.
 */


function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
/**
 * As Number (uses isFinite).
 */


function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}


type SlideNode = {
  pageNumber: number;
  imageUrl: string | null;
  thumbUrl: string | null;
  /** Exact hash of the normalized thumbnail pixels: changes on every re-encode. */
  imageHash: string | null;
  /** Perceptual fingerprint of the same thumbnail: survives a re-encode of the same picture. */
  imageFingerprint: string | null;
  width: number | null;
  height: number | null;
};

let _cachedSharpPromise: Promise<any> | null = null;
async function getSharp(): Promise<any> {
  if (_cachedSharpPromise) return _cachedSharpPromise;
  _cachedSharpPromise = (async () => {
    const mod = await import("sharp");
    return (mod as any).default ?? (mod as any);
  })();
  return _cachedSharpPromise;
}

async function imageHashFromThumbJpeg(thumbJpeg: Buffer): Promise<string | null> {
  // Best-effort *exact* hash (kept for back-compat; the version compare prefers the perceptual
  // fingerprint stored alongside it, because identical pictures re-encode to different bytes):
  // - decode
  // - normalize to fixed 64x64 grayscale raw pixels
  // - sha256 raw bytes
  try {
    const sharp = await getSharp();
    const raw = await sharp(thumbJpeg)
      .resize({ width: 64, height: 64, fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer();
    return crypto.createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Render one PDF page to JPEG.
 *
 * The prebuilt npm `sharp` cannot decode PDF input, so the page is rasterized with
 * pdfjs + @napi-rs/canvas first (see `@/lib/pdf/renderPage`) and sharp only handles
 * resize/flatten/encode. Pass `pdfDocument` to avoid re-parsing the PDF per page.
 */
async function renderPdfPageJpeg(params: {
  pdfBytes: Uint8Array;
  pdfDocument?: PdfJsDocument;
  pageNumber: number;
  maxWidth: number;
  quality: number;
}): Promise<{ jpeg: Buffer; width: number | null; height: number | null }> {
  const pageNumber = Math.max(1, Math.floor(params.pageNumber || 1));
  const maxWidth = Math.max(240, Math.floor(params.maxWidth || 1200));
  const quality = Math.min(95, Math.max(40, Math.floor(params.quality || 75)));
  const sharp = await getSharp();

  const { png, width: pngWidth, height: pngHeight } = await renderPdfPageToPng({
    pdfBytes: params.pdfBytes,
    pdfDocument: params.pdfDocument,
    pageNumber,
    maxWidth,
    scale: 2.5, // ~180dpi for a 72pt page; tuned for slide screenshots
  });

  const base = sharp(png)
    .resize({ width: maxWidth, withoutEnlargement: true })
    // PDF render may contain transparency; flatten to keep JPEG stable.
    .flatten({ background: "#ffffff" });

  const { data: jpeg, info } = await base
    .jpeg({ quality, mozjpeg: true, progressive: true, chromaSubsampling: "4:4:4" })
    .toBuffer({ resolveWithObject: true });

  const width =
    typeof info?.width === "number" && Number.isFinite(info.width)
      ? info.width
      : Number.isFinite(pngWidth) ? pngWidth : null;
  const height =
    typeof info?.height === "number" && Number.isFinite(info.height)
      ? info.height
      : Number.isFinite(pngHeight) ? pngHeight : null;
  return { jpeg, width, height };
}

/**
 * Unique Lower Tags (uses isArray, toLowerCase, trim).
 */


function uniqueLowerTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const s = t.trim().toLowerCase();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

type AiOutputRecord = Record<string, unknown> & {
  tags?: unknown;
  doc_name?: unknown;
  page_slugs?: unknown;
  relevant_projects?: unknown;
};
/** The funding ask to store, from the model or a raise amount stated in the text. */
function ensureAsk(ai: Record<string, unknown>, extractedText: string): string {
  // Only an amount the text states as a raise; see src/lib/ai/askFromText.ts.
  return resolveAsk(asString(ai.ask) ?? "", extractedText, asString(ai.document_purpose));
}
/**
 * Ensure Key Metrics (uses isArray, filter, map).
 */


function ensureKeyMetrics(ai: Record<string, unknown>, extractedText: string): string[] {
  const km = Array.isArray(ai.key_metrics) ? ai.key_metrics : [];
  const cleaned = km
    .filter((v) => typeof v === "string")
    .map((s) => s.trim())
    .filter(Boolean);
  if (cleaned.length >= 2) return cleaned.slice(0, 8);

  const out: string[] = [...cleaned];
  // Only facts the text states: the raise amount, if any. (Earlier heuristics labelled every dollar
  // figure a "Funding ask" and invented milestones from words like "fly"; they are gone.)
  const raise = findRaiseAmount(extractedText);
  if (raise) out.push(`Funding ask: ${raise}`);

  // de-dupe and cap
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const s of out) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(s);
  }
  return uniq.slice(0, 8);
}
/**
 * Ensure Structure Signals (uses isArray, filter, map).
 */


function ensureStructureSignals(ai: Record<string, unknown>, extractedText: string): string[] {
  const ss = Array.isArray(ai.structure_signals) ? ai.structure_signals : [];
  const cleaned = ss
    .filter((v) => typeof v === "string")
    .map((s) => s.trim())
    .filter(Boolean);
  if (cleaned.length >= 3) return cleaned.slice(0, 12);

  const lines = (extractedText || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const candidates: string[] = [];
  for (const l of lines) {
    // Short heading-like lines
    const words = l.split(/\s+/);
    if (words.length > 6) continue;
    if (l.length > 40) continue;
    // Mostly letters and spaces
    if (/[^a-z0-9 &/.-]/i.test(l)) continue;
    // Avoid obvious noise
    if (/^https?:\/\//i.test(l)) continue;
    candidates.push(l);
  }
  // Add common structure cues from fields too
  const cat = asString(ai.category);
  if (cat) candidates.push(cat.replace(/_/g, " "));
  const stage = asString(ai.stage);
  if (stage) candidates.push(stage);
  const raise = findRaiseAmount(extractedText);
  if (raise) candidates.push(`Raising ${raise}`);

  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const s of candidates) {
    const k = s.toLowerCase();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(s);
  }
  return uniq.slice(0, 12);
}
/**
 * Clamp Meta Title (uses trim, replace, trimEnd).
 */


function clampMetaTitle(s: string) {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= 60) return t;
  return t.slice(0, 60).trimEnd();
}
/**
 * Clamp Meta Description (uses trim, replace, slice).
 */


function clampMetaDescription(s: string) {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= 160) return t;
  // Prefer cutting at a word boundary.
  const cut = t.slice(0, 160);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 120 ? cut.slice(0, lastSpace) : cut).trimEnd();
}
/**
 * Ensure Meta (uses trim, asString, clampMetaTitle).
 */


function ensureMeta(ai: Record<string, unknown>) {
  const company = (asString(ai.company_or_project_name) ?? "").trim();
  const docName = (asString(ai.doc_name) ?? "").trim();
  const ask = (asString(ai.ask) ?? "").trim();
  const summary = (asString(ai.summary) ?? "").trim();

  const metaTitle = (asString(ai.meta_title) ?? "").trim() || (docName || (company ? `${company} Document` : ""));

  let metaDescription = asString(ai.meta_description)?.trim() || "";
  if (!metaDescription) {
    if (ask && summary) {
      metaDescription = `${summary} ${ask}`.trim();
    } else if (summary) {
      metaDescription = summary;
    } else if (ask) {
      metaDescription = ask;
    }
  }

  return {
    meta_title: metaTitle ? clampMetaTitle(metaTitle) : "",
    meta_description: metaDescription ? clampMetaDescription(metaDescription) : "",
  };
}
/**
 * Ensure Non Null Page Slugs (uses map, trim, toLowerCase).
 */


function ensureNonNullPageSlugs(params: {
  pageSlugs: Array<{ pageNumber: number; slug: string | null }>;
  maxPage: number;
}) {
  const { maxPage } = params;
  const seen = new Map<string, number>();
  return params.pageSlugs.map((p) => {
    let slug = p.slug?.trim() || "";
    if (!slug) {
      slug = p.pageNumber === maxPage ? "last-page" : `page-${p.pageNumber}`;
    }
    const key = slug.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) slug = `${slug}-${n}`;
    return { ...p, slug };
  });
}
/**
 * Doc Type From Ai (uses asString, isArray).
 */


function docTypeFromAi(ai: Record<string, unknown>): string {
  const category = asString(ai.category) ?? "";
  const pages = Array.isArray(ai.page_slugs) ? ai.page_slugs.length : null;

  // Prefer explicit "One Pager" when it's truly short.
  if (pages !== null && pages <= 2) return "One Pager";

  switch (category) {
    case "sales_pitch":
      return "Sales Deck";
    case "fundraising_pitch":
    case "marketing_material":
    case "product_overview":
      return "Deck";
    case "technical_whitepaper":
      return "Whitepaper";
    case "financial_report":
    case "market_research":
      return "Report";
    case "internal_strategy":
      return "Strategy Memo";
    case "partnership_proposal":
      return "Partnership Proposal";
    case "training_or_manual":
      return "Training Manual";
    case "legal_document":
      return "Legal Document";
    case "resume_or_profile":
      return "Resume";
    case "academic_paper":
      return "Academic Paper";
    default:
      return "Document";
  }
}
/**
 * Normalize Doc Name (uses trim).
 */


function normalizeDocName(company: string, docType: string) {
  return `${company.trim()} ${docType}`.trim();
}
/**
 * Derive Doc Name From Ai (uses asString, trim, normalizeDocName).
 */


function deriveDocNameFromAi(ai: Record<string, unknown>): string | null {
  const company = asString(ai.company_or_project_name);
  if (!company || !company.trim()) return null;

  const desired = normalizeDocName(company, docTypeFromAi(ai));

  const existing = asString(ai.doc_name);
  if (!existing || !existing.trim()) return desired;

  const ex = existing.trim();
  // Accept if it already matches our "<Company> <DocType>" pattern.
  if (ex.toLowerCase().startsWith(company.trim().toLowerCase() + " ")) {
    const suffix = ex.slice(company.trim().length).trim();
    const allowed = new Set([
      "Deck",
      "Sales Deck",
      "One Pager",
      "Whitepaper",
      "Report",
      "Strategy Memo",
      "Partnership Proposal",
      "Training Manual",
      "Legal Document",
      "Resume",
      "Academic Paper",
      "Document",
    ]);
    if (allowed.has(suffix)) return ex;
  }

  // Otherwise normalize.
  return desired;
}

/**
 * Title From File Name (best-effort).
 *
 * Mirrors client-side naming (`HomeAuthedClient`) and request upload naming to detect
 * "default" titles that we can safely replace with an AI-derived recommendation.
 */
function titleFromFileName(name: string): string {
  const base = (name ?? "").trim().replace(/\.[a-z0-9]+$/i, "");
  return base || "Untitled document";
}
/**
 * Derive Tags From Ai (uses uniqueLowerTags, slice, asString).
 */


function deriveTagsFromAi(ai: Record<string, unknown>): string[] {
  const tags = uniqueLowerTags(ai.tags);
  if (tags.length) return tags.slice(0, 10);
  const derived: string[] = [];
  const cat = asString(ai.category);
  const industry = asString(ai.industry);
  const company = asString(ai.company_or_project_name);
  if (cat) derived.push(cat.replace(/_/g, " "));
  if (industry) derived.push(industry.toLowerCase());
  if (company) derived.push(company.toLowerCase());
  // de-dupe + clean
  return uniqueLowerTags(derived).slice(0, 10);
}
/**
 * Return whether duplicate key error.
 */


function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return "code" in err && (err as { code?: unknown }).code === 11000;
}
/**
 * Ensure Review For Upload (updates state (setTimeout); uses trim, debugLog, String).
 */


async function ensureReviewForUpload(params: {
  docId: Types.ObjectId;
  uploadId: string;
  version: number;
  extractedText: string;
  qualityTier?: "basic" | "standard" | "advanced";
  instructions?: string | null;
  guideText?: string | null;
  stageHint?: string | null;
  agentKind?: "reviewDocText" | "requestReviewInvestorFocused";
  force?: boolean;
  meta?: {
    userId?: string | null;
    projectId?: string | null;
    projectIds?: string[] | null;
  } | null;
}) {
  const { docId, uploadId, version, extractedText, instructions, force } = params;
  // Run at exactly the tier the caller reserved credits for; never silently upgrade a Basic run.
  const qualityTier: "basic" | "standard" | "advanced" = params.qualityTier ?? "standard";
  const agentKind = params.agentKind ?? "reviewDocText";
  const guideText = params.guideText ?? null;
  const stageHint = params.stageHint ?? null;
  if (!extractedText || !extractedText.trim()) return;

  debugLog(1, "[review] ensure start", {
    docId: String(docId),
    uploadId,
    version,
    agentKind,
    force: Boolean(force),
    hasInstructions: Boolean((instructions ?? "").trim()),
  });

  // Fast path: already completed for this version.
  const existing = await ReviewModel.findOne({ docId, version })
    .select({ _id: 1, status: 1 })
    .lean();
  if (!force && existing && (existing as { status?: unknown }).status === "completed") return;

  // Force re-run: reset the review record to queued and clear outputs (best-effort).
  if (force) {
    try {
      await ReviewModel.updateOne(
        { docId, version },
        {
          $set: { status: "queued" },
          $unset: {
            outputMarkdown: "",
            intel: "",
            error: "",
            agentKind: "",
            agentSystemPrompt: "",
            agentUserPrompt: "",
            agentRawOutputText: "",
            agentOutput: "",
          },
        },
      );
    } catch {
      // ignore; best-effort
    }
  }

  // Acquire a per-(docId, version) "lock" by transitioning to processing.
  let reviewIdForMeta: string | null = null;
  try {
    const locked = await ReviewModel.findOneAndUpdate(
      { docId, version, status: { $in: ["queued", "failed", "skipped", null] } },
      {
        $setOnInsert: {
          docId,
          uploadId: new Types.ObjectId(uploadId),
          version,
          inputTextChars: extractedText.length,
        },
        // Avoid Mongo update path conflicts: don't set `uploadId` in both $setOnInsert and $set.
        $set: { status: "processing" },
      },
      { upsert: true, new: true },
    ).lean();

    // If another worker is already processing/completed, this upsert can collide; handle below.
    if (!locked) return;
    reviewIdForMeta = (locked as { _id?: unknown })._id ? String((locked as { _id: unknown })._id) : null;
  } catch (e) {
    if (isDuplicateKeyError(e)) return;
    throw e;
  }

  debugLog(1, "[review] locked; generating", {
    docId: String(docId),
    uploadId,
    version,
  });

  // Fetch the prior completed review (if any), to inject into the prompt.
  const prior = await ReviewModel.findOne({
    docId,
    version: { $lt: version },
    status: "completed",
  })
    .sort({ version: -1 })
    .select({ _id: 1, version: 1, outputMarkdown: 1 })
    .lean();

  // Generate review (best-effort; do not fail the upload if review fails/skips).
  try {
    const startedAt = Date.now();
    debugLog(2, "[review] calling model", {
      docId: String(docId),
      uploadId,
      version,
      agentKind,
      extractedTextChars: extractedText.length,
      instructionsChars: (instructions ?? "").length,
      hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    });

    // Verbose heartbeat so it's obvious the job is still alive.
    // Only prints when DEBUG_MODE=verbose / DEBUG_LEVEL>=2.
    const heartbeat = setInterval(() => {
      debugLog(2, "[review] heartbeat", {
        docId: String(docId),
        uploadId,
        version,
        elapsedMs: Date.now() - startedAt,
      });
    }, 5_000);

    try {
      const reviewPromise = (async () => {
        if (agentKind === "requestReviewInvestorFocused") {
          const generated = await runRequestReviewInvestorFocused({
            guideText: typeof guideText === "string" ? guideText : null,
            deckText: extractedText,
            stageHint: typeof stageHint === "string" ? stageHint : null,
            requesterInstructions: typeof instructions === "string" ? instructions : null,
            qualityTier,
            meta: {
              userId: params.meta?.userId ?? null,
              projectId: params.meta?.projectId ?? null,
              projectIds: params.meta?.projectIds ?? null,
              docId: String(docId),
              uploadId,
              reviewId: reviewIdForMeta,
            },
          });
          return { kind: "requestReviewInvestorFocused" as const, generated };
        }

        const generated = await reviewDocText({
          docText: extractedText,
          priorReviewMarkdown:
            prior && typeof (prior as { outputMarkdown?: unknown }).outputMarkdown === "string"
              ? ((prior as { outputMarkdown: string }).outputMarkdown ?? null)
              : null,
          priorReviewVersion:
            prior && Number.isFinite((prior as { version?: unknown }).version)
              ? Number((prior as { version: number }).version)
              : null,
          instructions: typeof instructions === "string" ? instructions : null,
          qualityTier,
          meta: {
            userId: params.meta?.userId ?? null,
            projectId: params.meta?.projectId ?? null,
            projectIds: params.meta?.projectIds ?? null,
            docId: String(docId),
            uploadId,
            uploadVersion: Number.isFinite(version) ? Number(version) : null,
            reviewId: reviewIdForMeta,
          },
        });
        return { kind: "reviewDocText" as const, generated };
      })();
      const generated = await Promise.race([
        reviewPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Review timed out (90s)")), 90_000),
        ),
      ]);
      clearInterval(heartbeat);

      if (generated.kind === "requestReviewInvestorFocused") {
        const g = generated.generated;
        const markdown = (g.output.summary_markdown ?? "").toString().trim() || null;
        await ReviewModel.updateOne(
          { docId, version },
          {
            $set: {
              status: "completed",
              model: g.model,
              prompt: g.prompt,
              outputMarkdown: markdown,
              intel: null,
              agentKind: "requestReviewInvestorFocused",
              agentSystemPrompt: g.system,
              agentUserPrompt: g.prompt,
              agentRawOutputText: g.rawOutputText,
              agentOutput: g.output,
              priorReviewId: prior ? (prior as { _id?: unknown })._id : null,
              priorReviewVersion: prior ? (prior as { version?: unknown }).version : null,
              error: null,
            },
          },
        );
        debugLog(1, "[review] completed (requestReviewInvestorFocused)", { docId: String(docId), uploadId, version });
        return;
      }

      if (!generated.generated || !generated.generated.markdown) {
        await ReviewModel.updateOne(
          { docId, version },
          {
            $set: {
              status: "skipped",
              model: generated.generated?.model ?? null,
              prompt: generated.generated?.prompt ?? null,
              priorReviewId: prior ? (prior as { _id?: unknown })._id : null,
              priorReviewVersion: prior ? (prior as { version?: unknown }).version : null,
            },
          },
        );
        debugLog(1, "[review] skipped (no output)", { docId: String(docId), uploadId, version });
        return;
      }

      await ReviewModel.updateOne(
        { docId, version },
        {
          $set: {
            status: "completed",
            model: generated.generated.model,
            prompt: generated.generated.prompt,
            outputMarkdown: generated.generated.markdown,
            intel: (generated.generated as unknown as { intel?: unknown }).intel ?? null,
            agentKind: "reviewDocText",
            priorReviewId: prior ? (prior as { _id?: unknown })._id : null,
            priorReviewVersion: prior ? (prior as { version?: unknown }).version : null,
            error: null,
          },
        },
      );
      debugLog(2, "[review] model output persisted", {
        docId: String(docId),
        uploadId,
        version,
        elapsedMs: Date.now() - startedAt,
        markdownChars: generated.generated.markdown.length,
        hasIntel: Boolean((generated.generated as unknown as { intel?: unknown }).intel),
      });
      debugLog(1, "[review] completed", {
        docId: String(docId),
        uploadId,
        version,
        hasIntel: Boolean((generated.generated as unknown as { intel?: unknown }).intel),
        elapsedMs: Date.now() - startedAt,
      });
    } finally {
      clearInterval(heartbeat);
    }
  } catch (e) {
    debugError(1, "[review] failed", {
      docId: String(docId),
      uploadId,
      version,
      message: e instanceof Error ? e.message : String(e),
    });
    debugLog(2, "[review] failed details", {
      docId: String(docId),
      uploadId,
      version,
      stack: e instanceof Error ? e.stack : null,
    });
    await ReviewModel.updateOne(
      { docId, version },
      {
        $set: {
          status: "failed",
          error: { message: e instanceof Error ? e.message : String(e) },
        },
      },
    );
  }
}
/**
 * Render Pdf First Page Png (uses getDocument, getPage, isRecord).
 */


async function renderPdfFirstPagePng(params: {
  pdfBytes: Uint8Array;
  scale?: number;
  maxWidth?: number;
  page?: number;
}): Promise<{ png: Buffer; width: number; height: number }> {
  const scale = params.scale ?? 2;
  const page = params.page ?? 1;
  const maxWidth = params.maxWidth ?? 1200;

  // pdfjs + @napi-rs/canvas (fast; preserves vector text well). The prebuilt npm `sharp`
  // has no PDF decoder, so there is no sharp-based fallback: if this fails, callers keep
  // the prior preview (important for replacement uploads).
  try {
    return await renderPdfPageToPng({ pdfBytes: params.pdfBytes, pageNumber: page, maxWidth, scale });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`pdf preview failed (pdfjs): ${msg}`);
  }
}
/**
 * Handle POST requests.
 */


export async function POST(
  request: Request,
  ctx: { params: Promise<{ uploadId: string }> },
) {
  // Credits charged by this processing run (summary + history compare + review); reported on the
  // doc.processed / doc.replaced activity row so the feed can say what a run cost.
  let creditsUsedThisRun = 0;
  const { uploadId } = await ctx.params;
  const traceId = crypto.randomBytes(6).toString("base64url");
  if (!Types.ObjectId.isValid(uploadId)) {
    debugLog(1, "[process] invalid uploadId", { traceId, uploadId });
    return NextResponse.json({ error: "Invalid uploadId", traceId }, { status: 400 });
  }

  const url = new URL(request.url);
  const forceReviewRequested = url.searchParams.get("forceReview") === "1";
  const qualityRaw = (url.searchParams.get("quality") ?? "").trim().toLowerCase();
  const requestedQualityTier =
    qualityRaw === "advanced" ? ("advanced" as const) : qualityRaw === "basic" ? ("basic" as const) : ("standard" as const);

  await connectMongo();
  const uploadSecret = header(request, "x-upload-secret");

  /**
   * Capability (upload-secret) callers are link recipients acting *inside the owner's workspace*.
   * They must never be able to trigger owner-billed actions, so when `viaUploadSecret` is true:
   * - `forceReview` is ignored,
   * - quality is forced to the workspace default (standard),
   * - the caller-supplied idempotency key is ignored (derived server-side from uploadId+version).
   */
  const viaUploadSecret = typeof uploadSecret === "string" && Boolean(uploadSecret.trim());
  /**
   * Server-to-server trigger (summary rerun, monthly re-queue): a short-lived HMAC bound to this
   * upload id. Acts as the upload's owner in the document's workspace, billed as an owner upload.
   */
  const viaInternal = !viaUploadSecret && verifyInternalProcessToken(uploadId, header(request, INTERNAL_PROCESS_HEADER));

  let actor: Actor;
  if (viaInternal) {
    const upload = await UploadModel.findOne({ _id: new Types.ObjectId(uploadId), isDeleted: { $ne: true } })
      .select({ userId: 1, docId: 1 })
      .lean();
    const ownerUserId = upload?.userId ? String(upload.userId) : "";
    if (!ownerUserId) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { orgId } = await ensurePersonalOrgForUserId({ userId: new Types.ObjectId(ownerUserId) });
    let billingOrgId = String(orgId);
    if (upload?.docId) {
      const docOrg = await DocModel.findById(upload.docId).select({ orgId: 1 }).lean();
      const docOrgId = (docOrg as { orgId?: unknown } | null)?.orgId;
      if (docOrgId && Types.ObjectId.isValid(String(docOrgId))) billingOrgId = String(docOrgId);
    }
    actor = { kind: "user", userId: ownerUserId, orgId: billingOrgId, personalOrgId: String(orgId) };
  } else if (viaUploadSecret) {
    // Secret-authorized processing (used by request upload links).
    const upload = await UploadModel.findOne({
      _id: new Types.ObjectId(uploadId),
      uploadSecret: (uploadSecret as string).trim(),
      isDeleted: { $ne: true },
    })
      .select({ userId: 1, docId: 1 })
      .lean();
    const ownerUserId = upload?.userId ? String(upload.userId) : "";
    if (!ownerUserId) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { orgId } = await ensurePersonalOrgForUserId({ userId: new Types.ObjectId(ownerUserId) });
    const personalOrgId = String(orgId);
    // Bill the workspace the document belongs to (request repos can live in a team workspace whose
    // members share one credit pool); fall back to the owner's personal workspace for legacy docs.
    let billingOrgId = personalOrgId;
    if (upload?.docId) {
      const docOrg = await DocModel.findById(upload.docId).select({ orgId: 1 }).lean();
      const docOrgId = (docOrg as { orgId?: unknown } | null)?.orgId;
      if (docOrgId && Types.ObjectId.isValid(String(docOrgId))) billingOrgId = String(docOrgId);
    }
    actor = { kind: "user", userId: ownerUserId, orgId: billingOrgId, personalOrgId };
  } else {
    actor = await resolveActor(request);
    // Viewers must not trigger owner-billed processing.
    const forbidden = await forbidUnlessOrgRole(actor);
    if (forbidden) return forbidden;

    // Authorization: upload must belong to the actor.
    const allowed = await UploadModel.exists({
      _id: new Types.ObjectId(uploadId),
      userId: new Types.ObjectId(actor.userId),
      isDeleted: { $ne: true },
    });
    if (!allowed) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }
  }

  const forceReviewQualityTier = viaUploadSecret ? ("standard" as const) : requestedQualityTier;
  const requestIdempotencyKey = viaUploadSecret ? null : idempotencyKeyFromRequest(request);
  // Allow rerunning the review agent for signed-in users, and also for temp-user
  // environments where auth isn't configured (common in dev). Never for secret callers.
  const authConfigured = Boolean(process.env.NEXTAUTH_SECRET);
  const forceReview = forceReviewRequested && !viaUploadSecret && (actor.kind === "user" || !authConfigured);

  debugLog(1, "[process] queued", {
    traceId,
    uploadId,
    viaUploadSecret,
    forceReviewRequested,
    forceReview,
    quality: forceReviewQualityTier,
    idempotencyKey: requestIdempotencyKey ? "[set]" : "",
  });

  // Load the upload once for state checks. The background job uses the claimed document below.
  const initialUpload = await UploadModel.findOne({ _id: new Types.ObjectId(uploadId), isDeleted: { $ne: true } });
  if (!initialUpload) {
    return applyTempUserHeaders(NextResponse.json({ error: "Not found", traceId }, { status: 404 }), actor);
  }
  // The client PATCHes `status: "uploaded"` (+ blobUrl) before triggering processing. If the
  // POST races ahead of that, do not fail the upload/doc; tell the client to retry instead.
  if (initialUpload.status === "uploading") {
    debugLog(1, "[process] upload not ready (still uploading)", { traceId, uploadId });
    return applyTempUserHeaders(
      NextResponse.json({ error: "UPLOAD_NOT_READY", status: "uploading", traceId }, { status: 409 }),
      actor,
    );
  }

  // Server-side enforcement: if AI tools are blocked for this workspace, reject before scheduling work.
  // Note: this route always runs in the background via `after()`, so we must preflight here.
  //
  // Only a user-initiated paid action (forced review) is preflighted. The automatic summary and the
  // replacement compare reserve inside the job and fail soft: an upload always completes, the AI
  // step is skipped and the skip is recorded on the upload (`ai`) so the UI can explain it.
  const needsPaidAi = forceReview && creditsForRun({ actionType: "review", qualityTier: forceReviewQualityTier }) > 0;
  if (needsPaidAi) {
    try {
      const snap = await getCreditsSnapshot({ workspaceId: actor.orgId });
      if (snap.blocked) {
        return applyTempUserHeaders(
          NextResponse.json({ error: "Out of credits", code: OUT_OF_CREDITS_CODE, traceId }, { status: 402 }),
          actor,
        );
      }
    } catch {
      // Best-effort: if snapshot fails, fall back to per-action reservation enforcement inside the job.
      debugLog(1, "[process] credits snapshot failed (continuing)", { traceId, uploadId });
    }
  }

  /**
   * Atomically claim the upload for processing (`uploaded|failed -> processing`).
   *
   * Only one caller wins; concurrent/duplicate POSTs get `alreadyProcessing: true` and do nothing.
   * A run stuck in `processing` for longer than `PROCESSING_STALE_MS` (crash/timeout) is treated as
   * abandoned and can be re-claimed. Completed uploads are not claimed: their path below is an
   * idempotent doc sync (plus optional forced review re-run).
   */
  let claimedUpload: typeof initialUpload | null = null;
  if (initialUpload.status !== "completed") {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PROCESSING_STALE_MS);
    claimedUpload = await UploadModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(uploadId),
        isDeleted: { $ne: true },
        $or: [
          { status: { $in: ["uploaded", "failed"] } },
          { status: "processing", processingStartedAt: { $lt: staleBefore } },
          // Legacy rows claimed before `processingStartedAt` existed: fall back to updatedDate.
          { status: "processing", processingStartedAt: null, updatedDate: { $lt: staleBefore } },
        ],
      },
      { $set: { status: "processing", processingStartedAt: now } },
      { new: true },
    );
    if (!claimedUpload) {
      debugLog(1, "[process] already processing; skipping", { traceId, uploadId, status: initialUpload.status ?? null });
      return applyTempUserHeaders(NextResponse.json({ ok: true, alreadyProcessing: true, traceId }), actor);
    }
    debugLog(1, "[process] claimed (status=processing)", { traceId, uploadId });
  }

  // Agent attribution for the activity row is resolved now (headers are cheap to read here and the
  // background job below outlives the response).
  const activityAgent = viaInternal ? null : agentFromRequest(request);

  // Respond immediately; do the work in the background.
  after(async () => {
    const startedAt = Date.now();
    try {
      debugLog(1, "[process] start", { traceId, uploadId });
      await connectMongo();

      const upload = claimedUpload ?? initialUpload;

      const docId = upload.docId as Types.ObjectId | null;
      if (!docId) {
        debugError(1, "[process] missing docId on upload", { uploadId });
        return;
      }

      // Project routing context (used by AI + auto-assignment).
      // For replacement uploads, we keep existing project membership and only add more (never remove).
      const isReplacement = Number.isFinite(upload.version) && Number(upload.version) > 1;
      const uploadVersion = Number.isFinite(upload.version) ? Number(upload.version) : null;
      const existingDoc = await DocModel.findById(docId)
        .select({
          _id: 1,
          orgId: 1,
          title: 1,
          projectId: 1,
          projectIds: 1,
          isArchived: 1,
          isDeleted: 1,
          currentUploadId: 1,
          uploadId: 1,
          previewImageUrl: 1,
          firstPagePngUrl: 1,
          extractedText: 1,
          pdfText: 1,
          aiOutput: 1,
          docName: 1,
          pageSlugs: 1,
          slideNodes: 1,
        })
        .lean();
      const existingDocObj = isRecord(existingDoc) ? existingDoc : null;
      const priorExtractedTextRaw =
        existingDocObj && typeof (existingDocObj as { extractedText?: unknown }).extractedText === "string"
          ? String((existingDocObj as { extractedText: string }).extractedText ?? "")
          : existingDocObj && typeof (existingDocObj as { pdfText?: unknown }).pdfText === "string"
            ? String((existingDocObj as { pdfText: string }).pdfText ?? "")
            : "";
      const priorUploadIdRaw = existingDocObj
        ? ((existingDocObj as { currentUploadId?: unknown }).currentUploadId ??
            (existingDocObj as { uploadId?: unknown }).uploadId ??
            null)
        : null;
      const priorUploadId =
        priorUploadIdRaw && Types.ObjectId.isValid(String(priorUploadIdRaw))
          ? new Types.ObjectId(String(priorUploadIdRaw))
          : null;
      const existingDocOrgIdRaw = existingDocObj ? (existingDocObj as { orgId?: unknown }).orgId : null;
      const existingDocOrgId =
        existingDocOrgIdRaw && Types.ObjectId.isValid(String(existingDocOrgIdRaw))
          ? new Types.ObjectId(String(existingDocOrgIdRaw))
          : new Types.ObjectId(actor.orgId);
      /**
       * Live progress for this run.
       *
       * Every stage below reports through this; the writes are throttled inside the reporter
       * (~one per 750ms, first and last exempt) and each one becomes an `upload` frame on the
       * realtime channel, which is what draws the moving bar in the Activity feed. Nothing here
       * is allowed to fail the pipeline — the reporter swallows its own errors.
       */
      const progress = createUploadProgressReporter({
        uploadId,
        docId: String(docId),
        orgId: String(existingDocOrgId),
      });

      // When replacing a file, if AI extraction fails/skips for the new version,
      // we keep the prior AI-derived fields so the UI doesn't "lose" them.
      const priorDocAiOutput = existingDocObj ? (existingDocObj.aiOutput ?? null) : null;
      const priorDocName =
        existingDocObj && typeof existingDocObj.docName === "string" ? existingDocObj.docName : null;
      const priorPageSlugs =
        existingDocObj && Array.isArray(existingDocObj.pageSlugs) ? existingDocObj.pageSlugs : null;
      const priorSlideNodes =
        existingDocObj && Array.isArray((existingDocObj as any).slideNodes) ? ((existingDocObj as any).slideNodes as unknown[]) : null;
      const priorPreviewUrl =
        existingDocObj && typeof (existingDocObj as { previewImageUrl?: unknown }).previewImageUrl === "string"
          ? String((existingDocObj as { previewImageUrl: string }).previewImageUrl ?? "").trim() || null
          : existingDocObj && typeof (existingDocObj as { firstPagePngUrl?: unknown }).firstPagePngUrl === "string"
            ? String((existingDocObj as { firstPagePngUrl: string }).firstPagePngUrl ?? "").trim() || null
            : null;
      const existingProjectIdsRaw = existingDoc
        ? [
            ...(existingDoc.projectId ? [String(existingDoc.projectId)] : []),
            ...(Array.isArray((existingDoc as unknown as { projectIds?: unknown }).projectIds)
              ? ((existingDoc as unknown as { projectIds?: unknown }).projectIds as unknown[]).map((x) => String(x))
              : []),
          ]
        : [];
      const existingProjectIds = Array.from(new Set(existingProjectIdsRaw.filter(Boolean)));
      const existingDocIsArchived =
        existingDoc && typeof (existingDoc as unknown as { isArchived?: unknown }).isArchived === "boolean"
          ? Boolean((existingDoc as unknown as { isArchived?: unknown }).isArchived)
          : false;
      const existingDocIsDeleted =
        existingDoc && typeof (existingDoc as unknown as { isDeleted?: unknown }).isDeleted === "boolean"
          ? Boolean((existingDoc as unknown as { isDeleted?: unknown }).isDeleted)
          : false;

      const allProjects = await ProjectModel.find({ userId: new Types.ObjectId(actor.userId) })
        .select({ _id: 1, name: 1, description: 1, autoAddFiles: 1 })
        .sort({ updatedDate: -1 })
        .limit(250)
        .lean();
      const projectsContext = allProjects.map((p) => ({
        id: String(p._id),
        name: p.name ?? "",
        description: p.description ?? "",
        autoAddFiles: Boolean((p as unknown as { autoAddFiles?: unknown }).autoAddFiles),
      }));
      const eligibleProjectIdSet = new Set(
        projectsContext
          .filter((p) => Boolean(p.autoAddFiles) && Boolean(p.description?.trim()))
          .map((p) => p.id),
      );

      const blobUrl = upload.blobUrl;
      if (!blobUrl) {
        debugError(1, "[process] missing blobUrl", { uploadId, docId: String(docId) });
        await progress.report("failed", { force: true });
        await UploadModel.findByIdAndUpdate(uploadId, {
          status: "failed",
          error: { message: "Missing blobUrl" },
        });
        // IMPORTANT: for replacement uploads, do not mark the existing doc as failed.
        // A failed replacement must not overwrite the last good version.
        if (!isReplacement) {
          await updateDocUnlessSuperseded(docId, upload, { status: "failed" });
        }
        return;
      }

      // Idempotency: if already completed, just ensure doc is synced.
      const currentStatus = upload.status ?? undefined;
      if (currentStatus === "completed") {
        debugLog(1, "[process] already completed; syncing doc", {
          uploadId,
          docId: String(docId),
        });
        const isReplacement = Number.isFinite(upload.version) && Number(upload.version) > 1;
        const existingDoc = await DocModel.findById(docId)
          .select({ _id: 1, aiOutput: 1, docName: 1, pageSlugs: 1, slideNodes: 1 })
          .lean();
        const existingDocObj = isRecord(existingDoc) ? existingDoc : null;
        const priorDocAiOutput = existingDocObj ? (existingDocObj.aiOutput ?? null) : null;
        const priorDocName =
          existingDocObj && typeof existingDocObj.docName === "string" ? existingDocObj.docName : null;
        const priorPageSlugs =
          existingDocObj && Array.isArray(existingDocObj.pageSlugs) ? existingDocObj.pageSlugs : null;
        const priorSlideNodes =
          existingDocObj && Array.isArray((existingDocObj as any).slideNodes) ? ((existingDocObj as any).slideNodes as unknown[]) : null;

        await updateDocUnlessSuperseded(docId, upload, {
          status: "ready",
          blobUrl: blobUrl,
          currentUploadId: upload._id,
          uploadId: upload._id,
          previewImageUrl: upload.previewImageUrl ?? upload.firstPagePngUrl ?? null,
          extractedText: upload.rawExtractedText ?? upload.pdfText ?? null,
          aiOutput: upload.aiOutput ?? (isReplacement ? priorDocAiOutput : null),
          docName: upload.docName ?? (isReplacement ? priorDocName : null),
          pageSlugs: Array.isArray(upload.pageSlugs)
            ? upload.pageSlugs
            : (isReplacement ? priorPageSlugs : []),
          slideNodes: Array.isArray((upload as any).slideNodes) && (upload as any).slideNodes.length
            ? (upload as any).slideNodes
            : (isReplacement ? (priorSlideNodes ?? []) : []),
          firstPagePngUrl: upload.previewImageUrl ?? upload.firstPagePngUrl ?? null,
          pdfText: upload.rawExtractedText ?? upload.pdfText ?? null,
        });

        // Best-effort: ensure a DocChange record exists for completed replacement uploads
        // (covers rare cases where the initial processing attempt crashed after completing the upload).
        try {
          const toVersion = Number.isFinite(upload.version) ? Number(upload.version) : null;
          if (isReplacement && toVersion && toVersion > 1) {
            const existing = await DocChangeModel.exists({ docId, toUploadId: upload._id });
            if (!existing) {
              const prev = await UploadModel.findOne({
                docId,
                version: toVersion - 1,
                isDeleted: { $ne: true },
              })
                .select({ _id: 1, rawExtractedText: 1, pdfText: 1, blobUrl: 1, slideNodes: 1 })
                .lean();
              const previousText = (prev?.rawExtractedText ?? (prev as any)?.pdfText ?? "").toString();
              const newText = (upload.rawExtractedText ?? upload.pdfText ?? "").toString();
            // Credits: the automatic compare runs at the workspace default tier (Basic on Free,
            // Standard on Pro unless pinned). The idempotency key carries no tier so changing the
            // default cannot bill the same version twice.
            const historyTier = await getDefaultHistoryQualityTier(actor.orgId).catch(() => "basic" as const);
            const historyCredits = creditsForRun({ actionType: "history", qualityTier: historyTier });
            const historyIdempotencyKey = `history:auto:${String(docId)}:to:${toVersion}`;
            let historyLedgerId: string | null = null;
            // Credit-gated on every plan (no plan check): the reservation below is the gate. Recipient
            // uploads (request/replace links) never bill the owner, so they get no compare.
            const historyAllowed = !viaUploadSecret;
            if (!historyAllowed) {
              debugLog(1, "[process] history compare skipped (recipient upload)", { uploadId, docId: String(docId), version: toVersion });
            }
            if (historyAllowed) {
              try {
                const reserved = await reserveCreditsOrThrow({
                  workspaceId: actor.orgId,
                  userId: actor.userId,
                  docId: String(docId),
                  actionType: "history",
                  qualityTier: historyTier,
                  idempotencyKey: historyIdempotencyKey,
                });
                historyLedgerId = reserved.ledgerId;
              } catch {
                historyLedgerId = null;
              }
            }

            let diff = null as any;
            if (historyLedgerId) {
              try {
                const backfillPages = await loadChangedPages({ prevUpload: prev, newUpload: upload }).catch(() => []);
                diff = attachPageContext(
                  await runDocChangeDiff({ previousText, newText, changedPages: backfillPages, qualityTier: historyTier }),
                  backfillPages,
                );
                if (!diff) {
                  await failAndRefundLedger({ workspaceId: actor.orgId, ledgerId: historyLedgerId });
                  diff = null;
                } else {
                  await markLedgerCharged({ workspaceId: actor.orgId, ledgerId: historyLedgerId, creditsCharged: historyCredits });
                  creditsUsedThisRun += historyCredits;
                }
              } catch {
                await failAndRefundLedger({ workspaceId: actor.orgId, ledgerId: historyLedgerId });
                diff = null;
              }
            }
              await DocChangeModel.updateOne(
                { docId, toUploadId: upload._id },
                {
                  $set: {
                    orgId: new Types.ObjectId(actor.orgId),
                    docId,
                    createdByUserId: new Types.ObjectId(actor.userId),
                    fromUploadId: prev?._id ?? null,
                    toUploadId: upload._id,
                    fromVersion: toVersion - 1,
                    toVersion,
                    previousText,
                    newText,
                    diff: diff ?? { summary: "", changes: [], pagesThatChanged: [] },
                  },
                },
                { upsert: true },
              );
            }
          }
        } catch {
          // ignore; best-effort
        }

        // IMPORTANT: allow forcing a re-run of the review agent even when the upload is already completed.
        // (Used by "Edit prompt & rerun" for received docs.)
        if (forceReview) {
          const uploadVersion = Number.isFinite(upload.version) ? Number(upload.version) : null;
          const extractedText =
            (upload.rawExtractedText ?? upload.pdfText ?? "").toString().trim() || "";
          const skipReview = Boolean((upload.toObject() as { skipReview?: unknown }).skipReview);
          debugLog(1, "[process] forceReview=1; preflight", {
            uploadId,
            docId: String(docId),
            version: uploadVersion,
            extractedTextChars: extractedText.length,
            skipReview,
            projectIds: existingProjectIds.length,
          });
          if (uploadVersion && extractedText && !skipReview) {
            // Credits: review is user-initiated only (forceReview=1). Default = Standard, optional Advanced.
            const reviewTier = forceReviewQualityTier;
            const reviewCredits = creditsForRun({ actionType: "review", qualityTier: reviewTier });
            const reviewIdempotencyKey =
              requestIdempotencyKey ?? `review:manual:${uploadId}:v${uploadVersion}:${reviewTier}`;

            // Request review settings (if this doc belongs to a request repo).
            const finalProjectIdsForReview = existingProjectIds
              .filter((id) => typeof id === "string" && Types.ObjectId.isValid(id))
              .map((id) => new Types.ObjectId(id));

            let requestReviewEnabled: boolean | null = null;
            let requestReviewPrompt: string | null = null;
            let requestGuideDocText: string | null = null;
            let requestGuideDocId: string | null = null;
            let requestProjectId: string | null = null;
            if (finalProjectIdsForReview.length) {
              const reqProject = await ProjectModel.findOne({
                _id: { $in: finalProjectIdsForReview },
                userId: new Types.ObjectId(actor.userId),
                $or: [
                  { isRequest: true },
                  { requestUploadToken: { $exists: true, $nin: [null, ""] } },
                ],
              })
                .select({ requestReviewEnabled: 1, requestReviewPrompt: 1, requestReviewGuideDocId: 1 })
                .lean();
              if (reqProject) {
                requestProjectId = reqProject?._id ? String(reqProject._id) : null;
                requestReviewEnabled = Boolean(
                  (reqProject as { requestReviewEnabled?: unknown }).requestReviewEnabled,
                );
                const p = (reqProject as { requestReviewPrompt?: unknown }).requestReviewPrompt;
                requestReviewPrompt = typeof p === "string" && p.trim() ? p.trim() : null;

                const guideId = (reqProject as { requestReviewGuideDocId?: unknown }).requestReviewGuideDocId;
                const guideIdStr = guideId ? String(guideId) : "";
                if (guideIdStr && Types.ObjectId.isValid(guideIdStr)) {
                  requestGuideDocId = guideIdStr;
                  const guideDoc = await DocModel.findOne({
                    _id: new Types.ObjectId(guideIdStr),
                    userId: new Types.ObjectId(actor.userId),
                    isDeleted: { $ne: true },
                  })
                    .select({ extractedText: 1, pdfText: 1 })
                    .lean();
                  const guideTextRaw =
                    guideDoc && typeof (guideDoc as { extractedText?: unknown }).extractedText === "string"
                      ? ((guideDoc as { extractedText: string }).extractedText ?? "")
                      : guideDoc && typeof (guideDoc as { pdfText?: unknown }).pdfText === "string"
                        ? ((guideDoc as { pdfText: string }).pdfText ?? "")
                        : "";
                  const guideText = (guideTextRaw ?? "").trim();
                  requestGuideDocText = guideText ? guideText : null;
                }
              }
            }

            debugLog(1, "[process] forceReview=1; resolved request settings", {
              uploadId,
              docId: String(docId),
              version: uploadVersion,
              requestReviewEnabled,
              requestReviewPromptChars: requestReviewPrompt ? requestReviewPrompt.length : 0,
              requestGuideDocChars: requestGuideDocText ? requestGuideDocText.length : 0,
              requestGuideDocAttached: Boolean(requestGuideDocId),
            });

            const isRequestDoc = Boolean(requestProjectId);
            if (!isRequestDoc) {
              // Non-request docs: rerun the legacy review agent.
              let ledgerId: string | null = null;
              try {
                const reserved = await reserveCreditsOrThrow({
                  workspaceId: actor.orgId,
                  userId: actor.userId,
                  docId: String(docId),
                  actionType: "review",
                  qualityTier: reviewTier,
                  idempotencyKey: reviewIdempotencyKey,
                });
                ledgerId = reserved.ledgerId;
              } catch (e) {
                debugLog(1, "[process] forceReview=1; insufficient credits (skipping)", {
                  uploadId,
                  docId: String(docId),
                  version: uploadVersion,
                  message: e instanceof Error ? e.message : String(e),
                });
                return;
              }
              try {
                await ensureReviewForUpload({
                  docId,
                  uploadId,
                  version: uploadVersion,
                  extractedText,
                  qualityTier: reviewTier,
                  instructions: null,
                  force: true,
                  meta: {
                    userId: actor.userId,
                    projectId: null,
                    projectIds: existingProjectIds,
                  },
                });
                await markLedgerCharged({ workspaceId: actor.orgId, ledgerId, creditsCharged: reviewCredits });
                creditsUsedThisRun += reviewCredits;
              } catch (e) {
                await failAndRefundLedger({ workspaceId: actor.orgId, ledgerId });
                throw e;
              }
            } else if (requestReviewEnabled === true && Boolean(requestGuideDocId)) {
              const stageHint =
                isRecord(upload.aiOutput) && typeof (upload.aiOutput as { stage?: unknown }).stage === "string"
                  ? String((upload.aiOutput as { stage: string }).stage)
                  : null;

              debugLog(1, "[process] forceReview=1; rerunning review", {
                uploadId,
                docId: String(docId),
                version: uploadVersion,
              });
              let ledgerId: string | null = null;
              try {
                const reserved = await reserveCreditsOrThrow({
                  workspaceId: actor.orgId,
                  userId: actor.userId,
                  docId: String(docId),
                  actionType: "review",
                  qualityTier: reviewTier,
                  idempotencyKey: reviewIdempotencyKey,
                });
                ledgerId = reserved.ledgerId;
              } catch (e) {
                debugLog(1, "[process] forceReview=1; insufficient credits (skipping)", {
                  uploadId,
                  docId: String(docId),
                  version: uploadVersion,
                  message: e instanceof Error ? e.message : String(e),
                });
                return;
              }
              try {
                await ensureReviewForUpload({
                  docId,
                  uploadId,
                  version: uploadVersion,
                  extractedText,
                  qualityTier: reviewTier,
                  agentKind: "requestReviewInvestorFocused",
                  instructions: null,
                  guideText: requestGuideDocText,
                  stageHint,
                  force: true,
                  meta: {
                    userId: actor.userId,
                    projectId: requestProjectId,
                    projectIds: existingProjectIds,
                  },
                });
                await markLedgerCharged({ workspaceId: actor.orgId, ledgerId, creditsCharged: reviewCredits });
                creditsUsedThisRun += reviewCredits;
              } catch (e) {
                await failAndRefundLedger({ workspaceId: actor.orgId, ledgerId });
                throw e;
              }

              // Read back the latest status so we can see what happened without digging into Mongo.
              const latest = await ReviewModel.findOne({ docId, version: uploadVersion })
                .select({ status: 1, updatedDate: 1, outputMarkdown: 1, intel: 1, error: 1 })
                .lean();
              debugLog(1, "[process] forceReview=1; review rerun finished", {
                uploadId,
                docId: String(docId),
                version: uploadVersion,
                reviewStatus: latest?.status ?? null,
                hasMarkdown: Boolean(latest && (latest as unknown as { outputMarkdown?: unknown }).outputMarkdown),
                hasIntel: Boolean(latest && (latest as unknown as { intel?: unknown }).intel),
                reviewError: latest && (latest as unknown as { error?: unknown }).error ? true : false,
              });
            } else if (requestReviewEnabled === true && !requestGuideDocId) {
              debugLog(1, "[process] forceReview=1; skip request review (no guide attached)", {
                uploadId,
                docId: String(docId),
                version: uploadVersion,
                requestProjectId,
              });
              // Manual reruns should still be deterministic so the UI doesn't get stuck polling,
              // but we should not fall back to the legacy review schema for request docs.
              // Instead, mark the review as skipped with a clear explanation.
              const now = new Date();
              await ReviewModel.updateOne(
                { docId, version: uploadVersion },
                {
                  $setOnInsert: {
                    docId,
                    uploadId: new Types.ObjectId(uploadId),
                    version: uploadVersion,
                    createdDate: now,
                  },
                  $set: {
                    status: "skipped",
                    updatedDate: now,
                    outputMarkdown:
                      "Request review agent is enabled for this repo, but no Guide is attached yet. Attach a Guide doc (or pasted Guide text) to run Guide-vs-Deck Intel.",
                    intel: null,
                    agentKind: "requestReviewInvestorFocused",
                    agentSystemPrompt: null,
                    agentUserPrompt: null,
                    agentRawOutputText: null,
                    agentOutput: null,
                    error: { message: "Request review skipped: missing guide" },
                  },
                },
              );
            } else if (requestReviewEnabled !== true) {
              debugLog(1, "[process] forceReview=1; request review disabled; falling back to legacy review", {
                uploadId,
                docId: String(docId),
                version: uploadVersion,
                requestProjectId,
              });
              const now = new Date();
              await ReviewModel.updateOne(
                { docId, version: uploadVersion },
                {
                  $setOnInsert: {
                    docId,
                    uploadId: new Types.ObjectId(uploadId),
                    version: uploadVersion,
                    createdDate: now,
                  },
                  $set: {
                    status: "skipped",
                    updatedDate: now,
                    outputMarkdown:
                      "Request review agent is disabled for this request repo. Enable it (and attach a Guide) to generate Guide-vs-Deck Intel.",
                    intel: null,
                    agentKind: "requestReviewInvestorFocused",
                    agentSystemPrompt: null,
                    agentUserPrompt: null,
                    agentRawOutputText: null,
                    agentOutput: null,
                    error: { message: "Request review skipped: agent disabled" },
                  },
                },
              );
            }
          }
        }

        return;
      }

      // Status was already flipped to `processing` by the atomic claim above.
      debugLog(2, "[process] processing claimed upload", { uploadId, isReplacement, uploadVersion });
      // IMPORTANT: for replacement uploads, keep the Doc pointing at the last good version
      // until processing succeeds. The client tracks replacement progress via the Upload.
      if (!isReplacement) {
        await updateDocUnlessSuperseded(docId, upload, {
          status: "preparing",
          currentUploadId: upload._id,
          uploadId: upload._id,
        });
      }

      let pdfBytes: Uint8Array;
      try {
        debugLog(1, "[process] fetching pdf", { uploadId });
        await progress.report("fetching", { force: true });
        pdfBytes = await fetchPdfBytes(blobUrl);
        debugLog(1, "[process] fetched pdf", { uploadId, bytes: pdfBytes.length });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to fetch PDF";
        debugError(1, "[process] fetch failed", { uploadId, message });
        await progress.report("failed", { force: true });
        await UploadModel.findByIdAndUpdate(uploadId, {
          status: "failed",
          error: { message },
        });
        if (!isReplacement) {
          await updateDocUnlessSuperseded(docId, upload, { status: "failed" });
        }
        return;
      }

      let previewUrl: string | null = null;
      let extractedText: string | null = null;
      let extractedPages: Array<{ page_number: number; text: string }> | null = null;
      let aiOutput: unknown = upload.aiOutput ?? null;
      const uploadObj = upload.toObject() as Record<string, unknown>;
      let docName: string | null = asString(uploadObj.docName);
      let pageSlugs:
        | Array<{ pageNumber: number; slug: string | null }>
        | null = Array.isArray(uploadObj.pageSlugs)
          ? (uploadObj.pageSlugs as unknown[])
              .map((p) => (isRecord(p) ? p : null))
              .filter((p): p is Record<string, unknown> => Boolean(p))
              .map((p) => ({
                pageNumber: Math.max(
                  1,
                  Math.floor(asNumber(p.pageNumber ?? p.page_number) ?? 1),
                ),
                slug: asString(p.slug),
              }))
          : null;
      let slideNodes: SlideNode[] | null = Array.isArray((uploadObj as any).slideNodes)
        ? ((uploadObj as any).slideNodes as unknown[])
            .map((p) => (isRecord(p) ? p : null))
            .filter((p): p is Record<string, unknown> => Boolean(p))
            .map((p) => ({
              pageNumber: Math.max(1, Math.floor(asNumber(p.pageNumber ?? p.page_number) ?? 1)),
              imageUrl: asString(p.imageUrl ?? p.image_url),
              thumbUrl: asString(p.thumbUrl ?? p.thumb_url),
              imageHash: asString(p.imageHash ?? p.image_hash),
              imageFingerprint: asString(p.imageFingerprint ?? p.image_fingerprint),
              width: asNumber(p.width),
              height: asNumber(p.height),
            }))
        : null;
      let jobError: unknown = null;
      const warningDetails: Record<string, string> = {};

      // Preview PNG (retryable)
      try {
        await progress.report("preview");
        debugLog(2, "[process] preview begin", { uploadId, isReplacement, uploadVersion });
        const existingPreview =
          upload.previewImageUrl ?? upload.firstPagePngUrl ?? null;

        if (existingPreview) {
          previewUrl = existingPreview;
          debugLog(1, "[process] using existing preview", {
            uploadId,
            hasPreview: true,
          });
          debugLog(2, "[process] preview already exists", { uploadId });
        } else {
          debugLog(1, "[process] rendering preview png", { uploadId });
          const { png } = await renderPdfFirstPagePng({ pdfBytes });
          const previewPathname = buildDocPreviewPngPathname({
            docId: String(docId),
            uploadId,
          });
          debugLog(1, "[process] uploading preview png", { uploadId, previewPathname });
          // Deterministic pathname: allow overwrite so retries succeed.
          const blob = await put(previewPathname, png, {
            access: "public",
            contentType: "image/png",
            addRandomSuffix: false,
            allowOverwrite: true,
          });
          previewUrl = blob.url;
          debugLog(2, "[process] preview uploaded", { uploadId, previewPathname });
        }
      } catch (e) {
        jobError = jobError ?? e;
        warningDetails.preview = e instanceof Error ? e.message : String(e);
        debugError(1, "[process] preview failed (will continue without preview)", {
          uploadId,
          message: e instanceof Error ? e.message : String(e),
        });
      }

      // Extract text (retryable)
      try {
        await progress.report("extracting");
        const existingText = upload.rawExtractedText ?? upload.pdfText ?? null;
        if (existingText) {
          extractedText = existingText;
          debugLog(2, "[process] extracted text already exists", { uploadId });
        } else {
          debugLog(1, "[process] extracting text", { uploadId });
          try {
            const parsed = await pdfParse(Buffer.from(pdfBytes));
            extractedText = (parsed.text ?? "").toString();
          } catch (e) {
            // Some PDFs cause pdf-parse to error (e.g. "stream must have data") even when pdfjs can read them.
            // Fall back to pdfjs-based extraction so AI snapshots can still be generated.
            debugLog(1, "[process] pdf-parse failed; falling back to pdfjs text extraction", {
              uploadId,
              message: e instanceof Error ? e.message : String(e),
            });
            const pages = await extractPdfTextByPage(pdfBytes);
            extractedPages = pages;
            extractedText = pages.map((p) => p.text).join("\n\n").trim();
          }
        }
      } catch (e) {
        jobError = jobError ?? e;
        warningDetails.text = e instanceof Error ? e.message : String(e);
        debugError(1, "[process] text extraction failed", {
          uploadId,
          message: e instanceof Error ? e.message : String(e),
        });
      }

      // Extract/render per-page slide nodes (retryable; best-effort)
      try {
        // If we already have slide nodes (from a previous run), keep them.
        if (Array.isArray(slideNodes) && slideNodes.length) {
          debugLog(2, "[process] slideNodes already exist", { uploadId, count: slideNodes.length });
        } else {
          // Ensure we have a page count (prefer the already-extracted per-page text).
          if (!extractedPages) {
            extractedPages = await extractPdfTextByPage(pdfBytes).catch(() => []);
          }

          let pageCount = 0;
          if (Array.isArray(extractedPages) && extractedPages.length) {
            const nums = extractedPages
              .map((p) => (typeof p?.page_number === "number" ? Math.floor(p.page_number) : 0))
              .filter((n) => Number.isFinite(n) && n >= 1);
            pageCount = nums.length ? Math.max(...nums) : 0;
          }
          // Open the document once for the whole slide pass (avoids re-parsing per page).
          const slidePdf = await openPdfDocument(pdfBytes);
          try {
          if (!pageCount) {
            // Fallback: ask PDF.js for numPages.
            const n = typeof slidePdf?.numPages === "number" && Number.isFinite(slidePdf.numPages) ? Math.floor(slidePdf.numPages) : 0;
            pageCount = n > 0 ? n : 0;
          }

          debugLog(1, "[process] building slideNodes", { uploadId, pageCount });
          // The one stage worth a sub-position: this loop is most of the wait, so the bar moves
          // inside it ("rendering page 3 of 9") instead of holding one number for a minute.
          await progress.report("rendering", { page: 0, pages: pageCount, force: true });

          const PAGE_IMAGE_MAX_WIDTH = 1200;
          const PAGE_IMAGE_QUALITY = 78;
          const PAGE_THUMB_MAX_WIDTH = 480;
          const PAGE_THUMB_QUALITY = 65;

          const sharp = await getSharp();
          const nodes: SlideNode[] = [];

          for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
            const { jpeg, width, height } = await renderPdfPageJpeg({
              pdfBytes,
              pdfDocument: slidePdf,
              pageNumber,
              maxWidth: PAGE_IMAGE_MAX_WIDTH,
              quality: PAGE_IMAGE_QUALITY,
            });

            // Derive a smaller thumb from the rendered JPEG (cheaper than rendering twice).
            const thumbJpeg = await sharp(jpeg)
              .resize({ width: PAGE_THUMB_MAX_WIDTH, withoutEnlargement: true })
              .jpeg({ quality: PAGE_THUMB_QUALITY, mozjpeg: true, progressive: true })
              .toBuffer();
            const imageHash = await imageHashFromThumbJpeg(thumbJpeg);
            // The exact hash above only answers "same bytes", and the bytes are never the same
            // twice: the MCP optimizes every PDF through Ghostscript before upload
            // (`mcp/src/optimize.ts`) and this loop re-rasterizes and re-encodes every page. The
            // fingerprint is what the version compare uses to decide whether a page actually looks
            // different (`@/lib/history/pageFingerprint`).
            const imageFingerprint = await computePageFingerprint(thumbJpeg);

            const imagePathname = buildDocPageImagePathname({
              docId: String(docId),
              uploadId,
              pageNumber,
            });
            const thumbPathname = buildDocPageThumbPathname({
              docId: String(docId),
              uploadId,
              pageNumber,
            });

            // Deterministic pathnames: allow overwrite so retries after a partial run succeed.
            const [imageBlob, thumbBlob] = await Promise.all([
              put(imagePathname, jpeg, {
                access: "public",
                contentType: "image/jpeg",
                addRandomSuffix: false,
                allowOverwrite: true,
              }),
              put(thumbPathname, thumbJpeg, {
                access: "public",
                contentType: "image/jpeg",
                addRandomSuffix: false,
                allowOverwrite: true,
              }),
            ]);

            nodes.push({
              pageNumber,
              imageUrl: imageBlob.url,
              thumbUrl: thumbBlob.url,
              imageHash,
              imageFingerprint,
              width,
              height,
            });
            // Throttled inside the reporter: a nine-page deck writes a handful of times, a
            // two-hundred-page one does not write two hundred times.
            await progress.report("rendering", { page: pageNumber, pages: pageCount });
          }

          slideNodes = nodes;
          } finally {
            await slidePdf.destroy?.().catch(() => undefined);
          }
        }
      } catch (e) {
        jobError = jobError ?? e;
        warningDetails.slides = e instanceof Error ? e.message : String(e);
        debugError(1, "[process] slideNodes failed (will continue without slides)", {
          uploadId,
          message: e instanceof Error ? e.message : String(e),
        });
      }

      /**
       * Credits, reservation order.
       *
       * The summary (1 credit, every upload) is reserved before the replacement compare (2+ credits)
       * so a workspace with only a credit or two left keeps the summary and drops the compare, not
       * the other way round. Recipient uploads (request/replace links, `viaUploadSecret`) never
       * reserve: the summary still runs and is recorded as a 0-credit `recipient` ledger row.
       * `aiState` is persisted on the upload so the UI can say exactly why an AI step was skipped.
       */
      const summaryTier = "basic" as const;
      const summaryCredits = creditsForRun({ actionType: "summary", qualityTier: summaryTier });
      // A queued "write the summary again" run: only the summary runs (never the compare), under a
      // per-request key so each rerun is its own charge.
      const summaryRerun = Boolean((upload as { summaryRerun?: unknown }).summaryRerun);
      const summaryRerunCount = Number((upload as { summaryRerunCount?: unknown }).summaryRerunCount) || 0;
      const summaryIdempotencyKey = summaryRerun
        ? `summary:manual:${uploadId}:v${uploadVersion ?? "?"}:${summaryRerunCount}`
        : `summary:auto:${uploadId}:v${uploadVersion ?? "?"}:${summaryTier}`;
      // Summary written by the uploading agent (owner uploads only): no AI run, 0 credits.
      const agentSummary = viaUploadSecret ? null : readStoredAgentSummary((upload as { agentSummary?: unknown }).agentSummary);
      let summaryLedgerId: string | null = null;
      /** The reservation came back already charged (a retried job): run without charging again. */
      let summaryAlreadyPaid = false;
      const aiState: {
        summary: "done" | "skipped" | "failed" | "pending" | "unchanged";
        compare: "done" | "skipped" | "failed" | "not_applicable" | "pending";
        reason: string | null;
        code: "out_of_credits" | "daily_cap" | "plan" | "recipient" | "error" | null;
        creditsNeeded: number | null;
        creditsUsed: number;
        source: "owner" | "recipient";
        summaryBy?: { kind: "agent"; client: string | null; label: string | null };
      } = {
        summary: "pending",
        compare: isReplacement && !summaryRerun ? "pending" : "not_applicable",
        reason: null,
        code: null,
        creditsNeeded: null,
        creditsUsed: 0,
        source: viaUploadSecret ? "recipient" : "owner",
      };
      // Re-uploading the same file: the previous version's summary already describes it, so paying
      // for a fresh one buys a differently-worded copy. The doc keeps its existing aiOutput below
      // (finalDocAiOutput falls back to the prior one), so nothing is lost by not running it.
      const sameAsPreviousVersion =
        isReplacement &&
        !summaryRerun &&
        Boolean(extractedText) &&
        normalizeForCompare(priorExtractedTextRaw.toString()) === normalizeForCompare(extractedText ?? "");
      const summaryWanted =
        !upload.aiOutput &&
        !agentSummary &&
        !sameAsPreviousVersion &&
        Boolean(extractedText) &&
        Boolean(process.env.OPENAI_API_KEY);
      if (sameAsPreviousVersion) {
        // Its own state, not "skipped": nothing was withheld and nothing is missing, so readers
        // must not warn about it or mark the kept summary as stale.
        aiState.summary = "unchanged";
        aiState.reason = aiState.reason ?? "the text is identical to the previous version, so its summary was kept";
        debugLog(1, "[process] AI summary skipped: identical to the previous version", { uploadId, docId: String(docId), version: uploadVersion });
      }
      if (summaryWanted && !viaUploadSecret) {
        try {
          const reserved = await reserveForAttempt({
            workspaceId: String(existingDocOrgId),
            userId: actor.userId,
            docId: String(docId),
            actionType: "summary",
            qualityTier: summaryTier,
            idempotencyKey: summaryIdempotencyKey,
          });
          if (reserved.status === "charged") summaryAlreadyPaid = true;
          else summaryLedgerId = reserved.ledgerId;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          warningDetails.summaryCredits = message;
          aiState.summary = "skipped";
          aiState.reason = message;
          aiState.code = /daily credit cap/i.test(message) ? "daily_cap" : isOutOfCreditsError(e) ? "out_of_credits" : "error";
          aiState.creditsNeeded = summaryCredits;
          debugLog(1, "[process] AI analysis skipped (could not reserve credits)", { uploadId, message });
          summaryLedgerId = null;
        }
      }

      // Best-effort: store a DocChange record for replacement uploads (not on a summary-only rerun,
      // which must leave the existing compare and its charge alone).
      try {
        if (isReplacement && uploadVersion && uploadVersion > 1 && !summaryRerun) {
          const previousText = priorExtractedTextRaw.toString();
          const newText = (extractedText ?? "").toString();
          if (previousText.trim() && newText.trim()) {
            // Best-effort: pages that changed (text or slide image), with both versions' text and
            // thumbnails, so the compare can cite pages. Shared with the manual rerun.
            let changedPages: ChangedPage[] = [];
            let previousUploadId: Types.ObjectId | null = null;
            await progress.report("comparing");
            try {
              if (!extractedPages) {
                extractedPages = await extractPdfTextByPage(pdfBytes).catch(() => []);
              }
              // The previous version by number. `priorUploadId` (the doc's current upload) already points
              // at this new upload by the time processing runs, so it cannot be used here.
              const prevUpload = await UploadModel.findOne({
                docId,
                version: { $lt: uploadVersion },
                isDeleted: { $ne: true },
              })
                .sort({ version: -1 })
                .select({ _id: 1, blobUrl: 1, slideNodes: 1 })
                .lean();
              previousUploadId = prevUpload?._id ?? null;
              changedPages = await loadChangedPages({
                prevUpload,
                newUpload: { slideNodes: Array.isArray(slideNodes) ? slideNodes : [] },
                newPages: extractedPages ?? [],
              });
            } catch (e) {
              warningDetails.historyPages = e instanceof Error ? e.message : String(e);
              changedPages = [];
            }

            // Credits: the automatic compare runs at the workspace default tier (Basic on Free,
            // Standard on Pro unless pinned). The idempotency key carries no tier so changing the
            // default cannot bill the same version twice.
            const historyTier = await getDefaultHistoryQualityTier(String(existingDocOrgId)).catch(() => "basic" as const);
            const historyCredits = creditsForRun({ actionType: "history", qualityTier: historyTier });
            const historyIdempotencyKey = `history:auto:${String(docId)}:to:${uploadVersion}`;
            let historyLedgerId: string | null = null;
            /** The compare for this version was already charged by an earlier attempt; keep its DocChange. */
            let historyAlreadyDone = false;
            // Credit-gated on every plan (no plan check): a Free workspace with credits gets the compare
            // at its default tier (Basic unless pinned); short of credits the reservation fails and the
            // compare is skipped with `out_of_credits`. Recipient uploads never bill the owner: no compare.
            // The same file uploaded again: no model call and no credits. runDocChangeDiff answers
            // this case itself, so the DocChange is still written and history reads "no changes"
            // instead of an invented list of edits (owner, 2026-09-17).
            const nothingChanged =
              normalizeForCompare(previousText) === normalizeForCompare(newText) &&
              !changedPages.some((p) => p.imageChanged === true);
            const historyAllowed = !viaUploadSecret && !nothingChanged;
            if (nothingChanged) {
              debugLog(1, "[process] history compare skipped: identical text", { uploadId, docId: String(docId), version: uploadVersion });
            }
            if (!historyAllowed) {
              aiState.compare = "skipped";
              warningDetails.historyPlan = "recipient upload; AI compare is not run on the owner's credits";
              debugLog(1, "[process] history compare skipped (recipient upload)", { uploadId, docId: String(docId), version: uploadVersion });
            }
            if (historyAllowed) {
              try {
                const reserved = await reserveForAttempt({
                  workspaceId: String(existingDocOrgId),
                  userId: actor.userId,
                  docId: String(docId),
                  actionType: "history",
                  qualityTier: historyTier,
                  idempotencyKey: historyIdempotencyKey,
                });
                if (reserved.status === "charged") {
                  historyAlreadyDone = Boolean(await DocChangeModel.exists({ docId, toUploadId: upload._id }));
                  aiState.compare = "done";
                } else {
                  historyLedgerId = reserved.ledgerId;
                }
              } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                warningDetails.historyCredits = message;
                aiState.compare = "skipped";
                if (!aiState.code) {
                  aiState.reason = message;
                  aiState.code = /daily credit cap/i.test(message) ? "daily_cap" : isOutOfCreditsError(e) ? "out_of_credits" : "error";
                  aiState.creditsNeeded = historyCredits;
                }
                // Skip history diff generation if we can't reserve credits.
                historyLedgerId = null;
              }
            }

            let diff = null as any;
            if (nothingChanged) {
              // Free path: the fixed "no changes" record, without touching the model.
              diff = await runDocChangeDiff({ previousText, newText, changedPages, qualityTier: historyTier }).catch(() => null);
              aiState.compare = "done";
            }
            if (historyLedgerId) {
              try {
                diff = await runDocChangeDiff({ previousText, newText, changedPages, qualityTier: historyTier });
                if (!diff) {
                  await failAndRefundLedger({ workspaceId: String(existingDocOrgId), ledgerId: historyLedgerId });
                  aiState.compare = "failed";
                  // Say why: "AI compare failed: an error occurred." gave an agent nothing to act on.
                  warningDetails.historyDiff = "the compare returned no result (credits refunded)";
                  if (!aiState.code) {
                    aiState.code = "error";
                    aiState.reason = "the compare model returned no result; credits were refunded";
                  }
                  diff = null;
                } else {
                  await markLedgerCharged({
                    workspaceId: String(existingDocOrgId),
                    ledgerId: historyLedgerId,
                    creditsCharged: historyCredits,
                  });
                  creditsUsedThisRun += historyCredits;
                  aiState.compare = "done";
                }
              } catch (e) {
                await failAndRefundLedger({ workspaceId: String(existingDocOrgId), ledgerId: historyLedgerId });
                aiState.compare = "failed";
                const message = e instanceof Error ? e.message : String(e);
                warningDetails.historyDiff = message;
                debugError(1, "[process] history compare failed", { uploadId, docId: String(docId), message });
                if (!aiState.code) {
                  aiState.code = "error";
                  aiState.reason = `the compare failed (${message.slice(0, 160)}); credits were refunded`;
                }
                diff = null;
              }
            }

            // Best-effort: attach slide thumbnails and graphics-change hints to the per-page diff.
            try {
              diff = attachPageContext(diff, changedPages);
            } catch {
              // ignore; best-effort
            }

            if (!historyAlreadyDone) await DocChangeModel.updateOne(
              { docId, toUploadId: upload._id },
              {
                $set: {
                  orgId: existingDocOrgId,
                  docId,
                  createdByUserId: new Types.ObjectId(actor.userId),
                  fromUploadId: previousUploadId ?? priorUploadId,
                  toUploadId: upload._id,
                  fromVersion: uploadVersion - 1,
                  toVersion: uploadVersion,
                  previousText,
                  newText,
                  diff: diff ?? { summary: "", changes: [], pagesThatChanged: [] },
                },
              },
              { upsert: true },
            );
          }
        }
      } catch {
        // ignore; best-effort
      }

      // Persist extracted text to Blob (best-effort; bounded size).
      // This is especially useful for request guide documents used as prompt context.
      let extractedTextBlobUrl: string | null = null;
      let extractedTextBlobPathname: string | null = null;
      try {
        const text = (extractedText ?? "").trim();
        if (text) {
          const maxBytes = 1_000_000; // 1MB
          const buf = Buffer.from(text, "utf8");
          if (buf.length <= maxBytes) {
            const textPathname = buildDocExtractedTextPathname({
              docId: String(docId),
              uploadId,
            });
            // Deterministic pathname: allow overwrite so retries succeed.
            const blob = await put(textPathname, buf, {
              access: "public",
              contentType: "text/plain; charset=utf-8",
              addRandomSuffix: false,
              allowOverwrite: true,
            });
            extractedTextBlobUrl = blob.url;
            extractedTextBlobPathname = blob.pathname;
          } else {
            warningDetails.extractedTextBlob = `Extracted text too large to store (>${maxBytes} bytes)`;
          }
        }
      } catch (e) {
        warningDetails.extractedTextBlob = e instanceof Error ? e.message : String(e);
      }

      // AI extraction (retryable; should not fail the upload if it errors)
      try {
        await progress.report("summarizing");
        const existingAi = upload.aiOutput ?? null;
        if (existingAi) {
          aiOutput = existingAi;
          debugLog(2, "[process] aiOutput already exists", { uploadId });
        } else if (extractedText || agentSummary) {
          const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY);
          if (!hasOpenAiKey && !agentSummary) {
            const message = "OPENAI_API_KEY is not set in the server process";
            warningDetails.ai = message;
            jobError = jobError ?? new Error(`AI analysis skipped: ${message}`);
            debugLog(1, "[process] AI analysis skipped (missing OPENAI_API_KEY)", { uploadId });
          } else {
            debugLog(1, "[process] analyzing with AI", { uploadId });
            if (!extractedPages) {
              extractedPages = await extractPdfTextByPage(pdfBytes).catch(() => []);
            }
            const pages = extractedPages ?? [];
            const pageImages = Array.isArray(slideNodes)
              ? slideNodes.map((p) => ({
                  page_number: Math.max(1, Math.floor(Number(p.pageNumber) || 1)),
                  image_url: typeof p.imageUrl === "string" && p.imageUrl.trim() ? p.imageUrl.trim() : null,
                  thumb_url: typeof p.thumbUrl === "string" && p.thumbUrl.trim() ? p.thumbUrl.trim() : null,
                }))
              : [];
            // Credits were reserved above (before the compare) for owner uploads; recipient uploads
            // run unbilled and are recorded as a 0-credit ledger row after the run succeeds.
            if (agentSummary) {
              aiOutput = agentSummaryToAnalysis(agentSummary, pages);
              aiState.summary = "done";
              aiState.summaryBy = { kind: "agent", client: agentSummary.client, label: agentSummary.label };
              await recordUnbilledRun({
                workspaceId: String(existingDocOrgId),
                userId: actor.userId,
                docId: String(docId),
                actionType: "summary",
                qualityTier: summaryTier,
                idempotencyKey: `summary:agent:${uploadId}:v${uploadVersion ?? "?"}`,
                source: "agent",
              }).catch((e) => {
                debugLog(1, "[process] agent summary ledger row failed (continuing)", {
                  uploadId,
                  message: e instanceof Error ? e.message : String(e),
                });
              });
            } else if (summaryLedgerId || summaryAlreadyPaid || viaUploadSecret) {
              try {
                const analyzed = await analyzePdfText({
                  fullText: extractedText,
                  pages,
                  pageImages,
                  originalFileName: asString((uploadObj as { originalFileName?: unknown }).originalFileName),
                  projects: projectsContext,
                  existingProjectIds,
                  isReplacement,
                  qualityTier: summaryTier,
                  meta: {
                    userId: actor.userId,
                    projectIds: existingProjectIds,
                    docId: String(docId),
                    uploadId,
                    uploadVersion: Number.isFinite(upload.version) ? Number(upload.version) : null,
                  },
                });
                if (!analyzed) {
                  if (summaryLedgerId) await failAndRefundLedger({ workspaceId: String(existingDocOrgId), ledgerId: summaryLedgerId });
                  debugLog(1, "[process] AI analysis skipped (returned null)", { uploadId });
                  aiState.summary = "failed";
                  aiState.code = aiState.code ?? "error";
                  aiState.reason = aiState.reason ?? "the summary model returned no result; credits were refunded";
                  aiOutput = null;
                } else if (isFallbackAnalysis(analyzed)) {
                  // Both model attempts failed and the analyzer returned an empty snapshot so the
                  // downstream normalization still runs. That is not a summary: refund, don't charge.
                  aiOutput = analyzed;
                  if (summaryLedgerId) await failAndRefundLedger({ workspaceId: String(existingDocOrgId), ledgerId: summaryLedgerId });
                  warningDetails.ai = warningDetails.ai ?? "AI analysis failed; empty snapshot used";
                  aiState.summary = "failed";
                  aiState.code = aiState.code ?? "error";
                  aiState.reason = aiState.reason ?? "The AI summary could not be generated for this version";
                  debugLog(1, "[process] AI analysis returned the fallback snapshot (refunded)", { uploadId });
                } else {
                  aiOutput = analyzed;
                  if (summaryAlreadyPaid) {
                    // Paid by the earlier attempt whose output was lost; nothing more to charge.
                  } else if (summaryLedgerId) {
                    await markLedgerCharged({
                      workspaceId: String(existingDocOrgId),
                      ledgerId: summaryLedgerId,
                      creditsCharged: summaryCredits,
                      telemetry: analysisTelemetry(analyzed),
                    });
                    creditsUsedThisRun += summaryCredits;
                  } else {
                    await recordUnbilledRun({
                      workspaceId: String(existingDocOrgId),
                      userId: actor.userId,
                      docId: String(docId),
                      actionType: "summary",
                      qualityTier: summaryTier,
                      idempotencyKey: summaryIdempotencyKey,
                      source: "recipient",
                    }).catch((e) => {
                      debugLog(1, "[process] unbilled ledger row failed (continuing)", {
                        uploadId,
                        message: e instanceof Error ? e.message : String(e),
                      });
                    });
                  }
                  aiState.summary = "done";
                }
              } catch (e) {
                if (summaryLedgerId) await failAndRefundLedger({ workspaceId: String(existingDocOrgId), ledgerId: summaryLedgerId });
                aiState.summary = "failed";
                const message = e instanceof Error ? e.message : String(e);
                warningDetails.ai = warningDetails.ai ?? message;
                aiState.code = aiState.code ?? "error";
                aiState.reason = aiState.reason ?? `the summary failed (${message.slice(0, 160)}); credits were refunded`;
                jobError = jobError ?? new Error(`AI analysis failed: ${message}`);
                debugError(1, "[process] AI analysis failed (will continue without aiOutput)", {
                  uploadId,
                  message,
                });
                aiOutput = null;
              }
            }

            if (isRecord(aiOutput)) {
              // Work on a local typed copy; reassigning the `aiOutput: unknown` variable
              // would otherwise invalidate TypeScript narrowing.
              let ai = aiOutput as AiOutputRecord;
              // Prefer the model-provided doc_name when present.
              // (Previously we only used `deriveDocNameFromAi`, which requires company_or_project_name.)
              const modelDocName = (asString(ai.doc_name) ?? "").trim();
              if (modelDocName) docName = modelDocName;
              // Normalize doc_name to "<Company> <DocType>" for UI consistency.
              docName = deriveDocNameFromAi(ai) ?? docName;
              // If the model didn't provide a usable `doc_name` (or we couldn't infer a company),
              // fall back to a stable, user-friendly name derived from the upload filename + inferred doc type.
              if (!docName || !docName.trim()) {
                const base = titleFromFileName(asString(uploadObj.originalFileName) ?? "");
                const kind = docTypeFromAi(ai);
                docName = `${base} ${kind}`.trim();
              }
              if (docName) ai = { ...ai, doc_name: docName };
              // Ensure we keep tags populated even if the model returns [].
              const currentTags = uniqueLowerTags(ai.tags);
              const ensuredTags = currentTags.length ? currentTags : deriveTagsFromAi(ai);
              const ensuredAsk = ensureAsk(ai, extractedText ?? "");
              const ensuredKeyMetrics = ensureKeyMetrics(ai, extractedText ?? "");
              const ensuredStructureSignals = ensureStructureSignals(ai, extractedText ?? "");
              const meta = ensureMeta({
                ...ai,
                doc_name: docName ?? (typeof ai.doc_name === "string" ? ai.doc_name : ""),
                ask: ensuredAsk,
              });
              ai = {
                ...ai,
                tags: ensuredTags,
                ask: ensuredAsk,
                key_metrics: ensuredKeyMetrics,
                structure_signals: ensuredStructureSignals,
                meta_title: meta.meta_title,
                meta_description: meta.meta_description,
              };

              const ps = ai.page_slugs;
              if (Array.isArray(ps)) {
                pageSlugs = ps
                  .map((p) => (isRecord(p) ? p : null))
                  .filter((p): p is Record<string, unknown> => Boolean(p))
                  .map((p) => ({
                    pageNumber: Math.max(1, Math.floor(asNumber(p.page_number) ?? 1)),
                    slug: (() => {
                      const s = asString(p.slug);
                      return s && s.trim() ? s.trim() : "";
                    })(),
                  }));

                const maxPage = Math.max(1, ...pageSlugs.map((p) => p.pageNumber));
                const ensured = ensureNonNullPageSlugs({ pageSlugs, maxPage });
                pageSlugs = ensured;
                // Ensure stored aiOutput never contains null slugs.
                ai = {
                  ...ai,
                  page_slugs: ensured.map((p) => ({
                    page_number: p.pageNumber,
                    slug: p.slug,
                  })),
                };
              }

              aiOutput = ai;
            }
          }
        } else {
          debugLog(1, "[process] AI analysis skipped (no extracted text)", { uploadId });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        warningDetails.ai = warningDetails.ai ?? message;
        // Keep the job non-fatal, but persist the warning for debugging.
        jobError = jobError ?? new Error(`AI analysis failed: ${message}`);
        debugError(1, "[process] AI analysis failed (will continue without aiOutput)", {
          uploadId,
          message,
        });
      }

      const hadAnyArtifact = !!previewUrl || !!extractedText;
      const failed = !hadAnyArtifact;

      // Apply project auto-routing (best-effort). Never remove existing membership.
      let nextProjectIds: string[] = existingProjectIds;
      let nextPrimaryProjectId: string | null =
        existingDoc && existingDoc.projectId ? String(existingDoc.projectId) : null;
      try {
        if (isRecord(aiOutput)) {
          const ai = aiOutput as AiOutputRecord;
          const rp = ai.relevant_projects;
          const suggested = Array.isArray(rp)
            ? rp
                .map((x) => (isRecord(x) ? x : null))
                .filter(Boolean)
                .map((x) =>
                  typeof (x as { project_id?: unknown }).project_id === "string"
                    ? String((x as { project_id: string }).project_id)
                    : "",
                )
                .map((s) => s.trim())
                .filter(Boolean)
                .filter((id) => Types.ObjectId.isValid(id))
            : [];

          const autoAddIds = suggested.filter((id) => eligibleProjectIdSet.has(id));
          nextProjectIds = Array.from(new Set([...existingProjectIds, ...autoAddIds]));

          // If there is no primary project set yet, prefer the first auto-added project in AI order.
          if (!nextPrimaryProjectId) {
            nextPrimaryProjectId = autoAddIds[0] ?? nextProjectIds[0] ?? null;
          }
        }
      } catch {
        // ignore (best-effort)
      }

      const skipReview = Boolean((uploadObj as { skipReview?: unknown }).skipReview);

      // Request review settings (if this doc belongs to a request repo).
      const finalProjectIdsForReview = [
        ...(nextPrimaryProjectId ? [nextPrimaryProjectId] : []),
        ...(Array.isArray(nextProjectIds) ? nextProjectIds : []),
      ]
        .filter((id) => typeof id === "string" && Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));

      let requestReviewEnabled: boolean | null = null;
      let requestReviewPrompt: string | null = null;
      let requestGuideDocText: string | null = null;
      let requestGuideDocId: string | null = null;
      let requestProjectId: string | null = null;
      if (finalProjectIdsForReview.length) {
        const reqProject = await ProjectModel.findOne({
          _id: { $in: finalProjectIdsForReview },
          userId: new Types.ObjectId(actor.userId),
          $or: [
            { isRequest: true },
            { requestUploadToken: { $exists: true, $nin: [null, ""] } },
          ],
        })
          .select({ requestReviewEnabled: 1, requestReviewPrompt: 1, requestReviewGuideDocId: 1 })
          .lean();
        if (reqProject) {
          requestProjectId = reqProject?._id ? String(reqProject._id) : null;
          requestReviewEnabled = Boolean(
            (reqProject as { requestReviewEnabled?: unknown }).requestReviewEnabled,
          );
          const p = (reqProject as { requestReviewPrompt?: unknown }).requestReviewPrompt;
          requestReviewPrompt = typeof p === "string" && p.trim() ? p.trim() : null;

          const guideId = (reqProject as { requestReviewGuideDocId?: unknown }).requestReviewGuideDocId;
          const guideIdStr = guideId ? String(guideId) : "";
          if (guideIdStr && Types.ObjectId.isValid(guideIdStr)) {
            requestGuideDocId = guideIdStr;
            const guideDoc = await DocModel.findOne({
              _id: new Types.ObjectId(guideIdStr),
              userId: new Types.ObjectId(actor.userId),
              isDeleted: { $ne: true },
            })
              .select({ extractedText: 1, pdfText: 1 })
              .lean();
            const guideTextRaw =
              guideDoc && typeof (guideDoc as { extractedText?: unknown }).extractedText === "string"
                ? ((guideDoc as { extractedText: string }).extractedText ?? "")
                : guideDoc && typeof (guideDoc as { pdfText?: unknown }).pdfText === "string"
                  ? ((guideDoc as { pdfText: string }).pdfText ?? "")
                  : "";
            const guideText = (guideTextRaw ?? "").trim();
            requestGuideDocText = guideText ? guideText : null;
          }
        }
      }

      debugLog(1, "[process] request review decision", {
        uploadId,
        docId: String(docId),
        isRequestDoc: Boolean(requestProjectId),
        requestProjectId,
        requestReviewEnabled,
        requestGuideDocAttached: Boolean(requestGuideDocId),
        requestGuideDocChars: requestGuideDocText ? requestGuideDocText.length : 0,
        skipReview,
        extractedTextChars: (extractedText ?? "").length,
        uploadVersion,
      });

      debugLog(1, "[process] persisting results", { uploadId, failed });
      await progress.report("finishing");
      await UploadModel.findByIdAndUpdate(uploadId, {
        status: failed ? "failed" : "completed",
        blobUrl,
        previewImageUrl: previewUrl,
        firstPagePngUrl: previewUrl, // compat
        rawExtractedText: extractedText,
        pdfText: extractedText, // compat
        extractedTextBlobUrl,
        extractedTextBlobPathname,
        aiOutput: aiOutput ?? null,
        docName: docName ?? null,
        pageSlugs: pageSlugs ?? [],
        slideNodes: Array.isArray(slideNodes) ? slideNodes : [],
        // Page count as a plain number, so readers (the MCP's get_share) need not pull slideNodes.
        ...(Array.isArray(slideNodes) && slideNodes.length ? { "metadata.pages": slideNodes.length } : {}),
        summaryRerun: false,
        ai: {
          ...aiState,
          summary: aiState.summary === "pending" ? "skipped" : aiState.summary,
          compare: aiState.compare === "pending" ? "skipped" : aiState.compare,
          // A compare still pending here never ran: one of the two versions had no text (usually
          // the previous version had not finished processing). Say so instead of "an error occurred".
          ...(aiState.compare === "pending" && isReplacement && !aiState.reason
            ? { reason: "there was no text to compare against (the previous version may not have finished processing)" }
            : {}),
          creditsUsed: creditsUsedThisRun,
        },
        error: jobError
          ? {
              message:
                jobError instanceof Error ? jobError.message : "Processing failed",
              details:
                Object.keys(warningDetails).length > 0 ? warningDetails : undefined,
            }
          : null,
      });

      // Doc becomes ready if raw file is persisted, even if one artifact failed.
      const finalDocAiOutput = aiOutput ?? (isReplacement ? priorDocAiOutput : null);
      const finalDocName = docName ?? (isReplacement ? priorDocName : null);
      const finalPageSlugs =
        pageSlugs ?? (isReplacement && priorPageSlugs ? (priorPageSlugs as unknown[]) : []);
      const finalSlideNodes =
        (Array.isArray(slideNodes) && slideNodes.length
          ? slideNodes
          : (isReplacement && Array.isArray(priorSlideNodes) ? priorSlideNodes : [])) as unknown[];
      const docUpdate: Record<string, unknown> = {
        status: failed ? "failed" : "ready",
        blobUrl,
        currentUploadId: upload._id,
        uploadId: upload._id, // backward compat
        // IMPORTANT: for replacement uploads, never wipe the doc's prior preview image
        // if preview generation failed for this version.
        previewImageUrl: previewUrl ?? (isReplacement ? priorPreviewUrl : null),
        firstPagePngUrl: previewUrl ?? (isReplacement ? priorPreviewUrl : null), // compat
        extractedText: extractedText,
        pdfText: extractedText, // compat
        aiOutput: finalDocAiOutput,
        docName: finalDocName,
        pageSlugs: finalPageSlugs,
        slideNodes: finalSlideNodes,
      };
      // Auto-name the doc using AI once it has a recommendation.
      //
      // Only do this for the first upload version, and only if the doc still has a generic placeholder
      // name (URL uploads start with "Untitled document"). For local file uploads we keep the filename-
      // derived title stable by default.
      if (uploadVersion === 1 && finalDocName) {
        const existingTitle =
          existingDocObj && typeof (existingDocObj as { title?: unknown }).title === "string"
            ? String((existingDocObj as { title: string }).title).trim()
            : "";
        const isPlaceholder =
          !existingTitle ||
          existingTitle.toLowerCase() === "document" ||
          existingTitle.toLowerCase() === "untitled document";
        if (isPlaceholder) {
          docUpdate.title = finalDocName;
        }
      }
      // IMPORTANT: when replacing a file (version > 1), keep the doc's existing name intact.
      // The Upload record retains the new `originalFileName`, but the Doc's `fileName` stays stable.
      if (uploadVersion === 1) {
        docUpdate.fileName = asString(uploadObj.originalFileName);
      }
      if (nextProjectIds.length) {
        docUpdate.projectIds = nextProjectIds
          .filter((id) => Types.ObjectId.isValid(id))
          .map((id) => new Types.ObjectId(id));
      }
      if (nextPrimaryProjectId && Types.ObjectId.isValid(nextPrimaryProjectId)) {
        docUpdate.projectId = new Types.ObjectId(nextPrimaryProjectId);
      }
      // IMPORTANT: for replacement uploads, never overwrite the existing doc on failures.
      // Only flip the doc over once we have enough artifacts to consider the replacement successful.
      if (!isReplacement || !failed) {
        await updateDocUnlessSuperseded(docId, upload, docUpdate);
      }

      // Last frame of the run: forced past the throttle so the bar always finishes, rather than
      // being swallowed because the previous write was under 750ms ago.
      await progress.report(failed ? "failed" : "ready", { force: true });

      // Activity: the pipeline finished and the doc flipped to `ready` (best-effort, after the write).
      // Attributed to the same workspace the credits were billed to (`existingDocOrgId`).
      if (!failed) {
        const existingTitle =
          existingDocObj && typeof (existingDocObj as { title?: unknown }).title === "string"
            ? String((existingDocObj as { title: string }).title)
            : null;
        void recordActivity({
          orgId: existingDocOrgId,
          userId: actor.userId,
          actorKind: viaUploadSecret ? "secret" : actor.kind,
          agent: activityAgent,
          // A later version is a replacement; the feed labels it "replaced <doc> (vN)" instead of
          // a generic "processing finished", which read as noise across repeated replacements.
          // A summary-only rerun is its own row ("wrote the AI summary for <doc>"), not a replacement.
          type: summaryRerun
            ? "summary.generated"
            : typeof uploadVersion === "number" && uploadVersion > 1
              ? "doc.replaced"
              : "doc.processed",
          docId,
          uploadId,
          title: typeof docUpdate.title === "string" ? docUpdate.title : existingTitle,
          meta: {
            version: uploadVersion,
            summaryBy: aiState.summaryBy?.label ?? aiState.summaryBy?.client ?? null,
            summary: aiState.summary === "pending" ? "skipped" : aiState.summary,
            review: forceReviewRequested,
            quality: forceReviewQualityTier,
            replacement: isReplacement,
            // Both halves: the internal keys (which step complained) and the reason a reader can
            // act on. The row used to carry only keys like "historyCredits", which said nothing,
            // and stayed empty for a failed summary that the tool had already reported.
            warnings: Object.keys(warningDetails),
            warningDetails,
            compare: aiState.compare === "pending" ? "skipped" : aiState.compare,
            aiReason: aiState.reason ?? null,
            credits: creditsUsedThisRun,
            aiSkipped: aiState.code,
          },
          request,
        });
        // A credit-caused skip gets its own feed row so the owner learns why the summary is missing
        // without opening the upload. Recorded once per upload; a retry that succeeds does not undo it.
        if (aiState.code === "out_of_credits" || aiState.code === "daily_cap") {
          void recordActivity({
            orgId: existingDocOrgId,
            userId: actor.userId,
            actorKind: viaUploadSecret ? "secret" : actor.kind,
            agent: activityAgent,
            type: "credits.exhausted",
            docId,
            uploadId,
            title: typeof docUpdate.title === "string" ? docUpdate.title : existingTitle,
            meta: { version: uploadVersion, code: aiState.code, creditsNeeded: aiState.creditsNeeded },
            request,
          });
        }
      }

      // Debug breadcrumb: confirm the doc record actually flipped and points at this upload.
      // This log is intentionally level 1 so it's visible in dev when debugging "stuck preparing".
      try {
        const afterDoc = await DocModel.findById(docId)
          .select({ status: 1, blobUrl: 1, currentUploadId: 1, uploadId: 1, updatedDate: 1 })
          .lean();
        debugLog(1, "[process] doc synced", {
          uploadId,
          docId: String(docId),
          docStatus: afterDoc?.status ?? null,
          docBlobUrl: typeof afterDoc?.blobUrl === "string" ? "[set]" : null,
          docCurrentUploadId: afterDoc?.currentUploadId ? String(afterDoc.currentUploadId) : null,
          docUploadId: (afterDoc as any)?.uploadId ? String((afterDoc as any).uploadId) : null,
          updatedDate: afterDoc?.updatedDate ? new Date(afterDoc.updatedDate).toISOString() : null,
        });
      } catch {
        // ignore
      }

      // Project.docCount is maintained at the model level (Doc middleware).

      debugLog(1, "[process] done", { traceId, uploadId, ms: Date.now() - startedAt });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugError(1, "[process] crashed", {
        traceId,
        uploadId,
        ms: Date.now() - startedAt,
        message,
      });
      try {
        await UploadModel.findByIdAndUpdate(uploadId, {
          status: "failed",
          error: {
            message,
          },
        });
        // A crash is exactly when a watcher is left staring at a bar that stopped moving; say so.
        // The reporter built inside the try is out of scope here, so this one resolves the
        // workspace itself.
        await createUploadProgressReporter({ uploadId }).report("failed", { force: true });
      } catch {
        // ignore
      }
    }
  });

  return applyTempUserHeaders(NextResponse.json({ ok: true, traceId }), actor);
}

