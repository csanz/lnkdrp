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
import { createRequire } from "module";
import { pathToFileURL } from "url";
import crypto from "node:crypto";
import { connectMongo } from "@/lib/mongodb";
import { UploadModel } from "@/lib/models/Upload";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { ReviewModel } from "@/lib/models/Review";
import { DocChangeModel } from "@/lib/models/DocChange";
import { buildDocExtractedTextPathname, buildDocPreviewPngPathname } from "@/lib/blob/clientUpload";
import { analyzePdfText } from "@/lib/ai/analyzePdfText";
import { runDocChangeDiff } from "@/lib/ai/docChangeDiff";
import { reviewDocText } from "@/lib/ai/reviewDocText";
import { runRequestReviewInvestorFocused } from "@/lib/ai/requestReviewInvestorFocused";
import { reserveCreditsOrThrow, markLedgerCharged, failAndRefundLedger } from "@/lib/credits/creditService";
import { creditsForRun } from "@/lib/credits/schedule";
import { idempotencyKeyFromRequest, generateIdempotencyKey } from "@/lib/credits/idempotency";
import { getCreditsSnapshot } from "@/lib/credits/snapshot";
import { OUT_OF_CREDITS_CODE } from "@/lib/credits/errors";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor, type Actor } from "@/lib/gating/actor";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";

export const runtime = "nodejs";
/**
 * Header (uses get, toLowerCase).
 */


function header(request: Request, name: string) {
  return request.headers.get(name) ?? request.headers.get(name.toLowerCase());
}

type PdfJsLib = {
  getDocument: (opts: { data: Uint8Array }) => { promise: Promise<unknown> };
  GlobalWorkerOptions?: { workerSrc?: string };
};

let _cachedPdfJsLibPromise: Promise<PdfJsLib> | null = null;
/**
 * Lazy-load PDF.js at runtime.
 *
 * Next's App Router bundling can choke on the ESM `pdf.mjs` entrypoint in certain dev builds
 * (seen as `Object.defineProperty called on non-object`). Using `createRequire` keeps this
 * as a Node-side runtime dependency instead of a webpack-bundled module.
 */
async function getPdfJsLib(): Promise<PdfJsLib> {
  if (_cachedPdfJsLibPromise) return _cachedPdfJsLibPromise;

  _cachedPdfJsLibPromise = (async () => {
    const require = createRequire(import.meta.url);
    // Resolve to a concrete file path, then import via file:// so Next doesn't try to bundle it.
    const pdfPath = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
    const pdfjs = (await import(pathToFileURL(pdfPath).href)) as unknown as PdfJsLib;

    // pdfjs-dist on Node uses a "fake worker" implementation that still needs access to the worker module.
    // In Next dev, the default worker resolution can point at a non-existent `.next/.../pdf.worker.mjs` chunk.
    // Resolve the worker from node_modules explicitly to make preview rendering reliable in local dev.
    try {
      require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
      if (pdfjs.GlobalWorkerOptions) {
        // Prefer a normal module specifier on Next dev (file:// URLs get rewritten into
        // annotated ids like "...[app-route] (ecmascript)" and become unresolvable).
        pdfjs.GlobalWorkerOptions.workerSrc = "pdfjs-dist/legacy/build/pdf.worker.mjs";
      }
    } catch {
      // Best-effort: if this fails for any reason, preview generation will fall back to the existing try/catch.
    }

    return pdfjs;
  })();

  return _cachedPdfJsLibPromise;
}
/**
 * Return whether record.
 */


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

function normalizeForPageHash(input: string): string {
  return (input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function pageTextHash(input: string): string {
  const normalized = normalizeForPageHash(input);
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

async function fetchPdfBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch PDF (${res.status})`);
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
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
/**
 * Extract Ask Detail From Text (uses replace, exec, trim).
 */


function extractAskDetailFromText(text: string, amount: string): string | null {
  const t = text || "";
  const escaped = amount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Common patterns in decks
  const patterns: RegExp[] = [
    new RegExp(`Raising\\s+${escaped}\\s+to\\s+([^\\n.]+)`, "i"),
    new RegExp(`Raise\\s+${escaped}\\s+to\\s+([^\\n.]+)`, "i"),
    new RegExp(`${escaped}\\s+to\\s+([^\\n.]+)`, "i"),
  ];
  for (const rx of patterns) {
    const m = rx.exec(t);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}
/**
 * Extract Dollar Amounts (uses map, from, matchAll).
 */


function extractDollarAmounts(text: string): string[] {
  const t = text || "";
  const rx = /\$[0-9]+(?:\.[0-9]+)?\s*(?:[MBK])?/gi;
  const found = Array.from(t.matchAll(rx)).map((m) => (m[0] ?? "").replace(/\s+/g, ""));
  // de-dupe, keep order
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of found) {
    const key = a.toUpperCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}
/**
 * Ensure Ask (uses trim, asString, test).
 */


function ensureAsk(ai: Record<string, unknown>, extractedText: string): string {
  const ask = (asString(ai.ask) ?? "").trim();
  if (ask && ask.length >= 12 && /\s/.test(ask)) return ask;

  const amounts = extractDollarAmounts(extractedText);
  const amount = ask || amounts[0] || "";
  if (!amount) return "";

  const detail = extractAskDetailFromText(extractedText, amount) || asString(ai.document_purpose);
  if (detail && detail.trim()) return `${amount} to ${detail.replace(/^to\\s+/i, "").trim()}.`;
  return amount;
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

  const out: string[] = [];
  // Pull any dollar amounts as a "metric"
  for (const amt of extractDollarAmounts(extractedText)) {
    out.push(`Funding ask: ${amt}`);
  }
  // Heuristic milestone phrases from common deck language
  if (/prototype/i.test(extractedText)) out.push("Milestone: complete first prototype");
  if (/take\s*off|stabilize|fly|land/i.test(extractedText))
    out.push("Milestone: autonomous takeoff/stabilize/fly/land");
  if (/edge/i.test(extractedText) && /cloud/i.test(extractedText))
    out.push("Claim: edge-native autonomy without cloud dependency");

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
  for (const amt of extractDollarAmounts(extractedText)) candidates.push(`Raising ${amt}`);

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
  qualityTier?: "standard" | "advanced";
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
  const qualityTier = params.qualityTier === "advanced" ? "advanced" : "standard";
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
 * Extract Pdf Text By Page (uses getDocument, Number, getPage).
 */


async function extractPdfTextByPage(pdfBytes: Uint8Array): Promise<
  Array<{ page_number: number; text: string }>
> {
  const pdfjsLib = await getPdfJsLib();
  // NOTE: pdfjs transfers `data.buffer` to its (fake) worker even on Node, which detaches it.
  // Always pass a copy so callers can safely reuse their original `pdfBytes`.
  const data = new Uint8Array(pdfBytes);
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = (await loadingTask.promise) as {
    numPages: number;
    getPage: (pageNumber: number) => Promise<unknown>;
  };
  const pages: Array<{ page_number: number; text: string }> = [];
  const n = Number(pdf.numPages) || 0;
  for (let i = 1; i <= n; i++) {
    const page = await pdf.getPage(i);
    if (!isRecord(page) || typeof page.getTextContent !== "function") {
      pages.push({ page_number: i, text: "" });
      continue;
    }
    const content = (await (page.getTextContent as () => Promise<unknown>)()) as unknown;
    const contentObj = isRecord(content) ? content : null;
    const items = (contentObj?.items ?? []) as unknown;
    const itemArr = Array.isArray(items) ? items : [];
    const text = itemArr
      .map((it: unknown) => {
        if (!isRecord(it)) return "";
        return typeof it.str === "string" ? it.str : "";
      })
      .filter(Boolean)
      .join(" ");
    pages.push({ page_number: i, text });
  }
  return pages;
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
  const pdfjsLib = await getPdfJsLib();
  /**
   * NOTE: `@napi-rs/canvas` ships native bindings per-platform.
   * In some local dev setups, optionalDependencies can fail to install the correct
   * binary (npm issue). Import it dynamically so the *route module* still loads,
   * and we can gracefully skip preview generation if the binding is unavailable.
   */
  const { createCanvas } = await import("@napi-rs/canvas");

  const scale = params.scale ?? 2;
  const page = params.page ?? 1;
  const maxWidth = params.maxWidth ?? 1200;

  // NOTE: pdfjs transfers `data.buffer` to its (fake) worker even on Node, which detaches it.
  // Always pass a copy so callers can safely reuse their original `pdfBytes`.
  const data = new Uint8Array(params.pdfBytes);
  const loadingTask = pdfjsLib.getDocument({
    data,
  });
  // pdfjs-dist types are intentionally loose in our repo; narrow just enough for TS.
  const pdf = (await loadingTask.promise) as {
    getPage: (pageNumber: number) => Promise<unknown>;
  };
  const pdfPage = await pdf.getPage(page);
  if (
    !isRecord(pdfPage) ||
    typeof pdfPage.getViewport !== "function" ||
    typeof pdfPage.render !== "function"
  ) {
    throw new Error("pdfjs page missing expected methods");
  }

  const baseViewport = (pdfPage.getViewport as (opts: { scale: number }) => {
    width: number;
    height: number;
  })({ scale });
  const finalScale =
    baseViewport.width > maxWidth ? scale * (maxWidth / baseViewport.width) : scale;
  const viewport = (pdfPage.getViewport as (opts: { scale: number }) => {
    width: number;
    height: number;
  })({ scale: finalScale });

  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const renderResult = (pdfPage.render as (opts: {
    canvasContext: unknown;
    viewport: unknown;
  }) => { promise: Promise<unknown> })({ canvasContext: ctx, viewport });
  await renderResult.promise;
  const png = canvas.toBuffer("image/png");

  return { png, width, height };
}
/**
 * Handle POST requests.
 */


export async function POST(
  request: Request,
  ctx: { params: Promise<{ uploadId: string }> },
) {
  const { uploadId } = await ctx.params;
  if (!Types.ObjectId.isValid(uploadId)) {
    return NextResponse.json({ error: "Invalid uploadId" }, { status: 400 });
  }

  const url = new URL(request.url);
  const forceReviewRequested = url.searchParams.get("forceReview") === "1";
  const qualityRaw = (url.searchParams.get("quality") ?? "").trim().toLowerCase();
  const forceReviewQualityTier =
    qualityRaw === "advanced" ? ("advanced" as const) : qualityRaw === "basic" ? ("basic" as const) : ("standard" as const);
  const requestIdempotencyKey = idempotencyKeyFromRequest(request);

  debugLog(1, "[process] queued", { uploadId });

  await connectMongo();
  const uploadSecret = header(request, "x-upload-secret");

  let actor: Actor;
  if (typeof uploadSecret === "string" && uploadSecret.trim()) {
    // Secret-authorized processing (used by request upload links).
    const upload = await UploadModel.findOne({
      _id: new Types.ObjectId(uploadId),
      uploadSecret: uploadSecret.trim(),
      isDeleted: { $ne: true },
    })
      .select({ userId: 1 })
      .lean();
    const ownerUserId = upload?.userId ? String(upload.userId) : "";
    if (!ownerUserId) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { orgId } = await ensurePersonalOrgForUserId({ userId: new Types.ObjectId(ownerUserId) });
    const personalOrgId = String(orgId);
    actor = { kind: "user", userId: ownerUserId, orgId: personalOrgId, personalOrgId };
  } else {
    actor = await resolveActor(request);

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

  // Server-side enforcement: if AI tools are blocked for this workspace, reject before scheduling work.
  // Note: this route always runs in the background via `after()`, so we must preflight here.
  const needsAi = forceReviewRequested || Boolean(process.env.OPENAI_API_KEY);
  if (needsAi) {
    try {
      const snap = await getCreditsSnapshot({ workspaceId: actor.orgId });
      if (snap.blocked) {
        return applyTempUserHeaders(
          NextResponse.json({ error: "Out of credits", code: OUT_OF_CREDITS_CODE }, { status: 402 }),
          actor,
        );
      }
    } catch {
      // Best-effort: if snapshot fails, fall back to per-action reservation enforcement inside the job.
    }
  }

  // Respond immediately; do the work in the background.
  after(async () => {
    const startedAt = Date.now();
    try {
      debugLog(1, "[process] start", { uploadId });
      await connectMongo();
      // Allow rerunning the review agent for signed-in users, and also for temp-user
      // environments where auth isn't configured (common in dev).
      const authConfigured = Boolean(process.env.NEXTAUTH_SECRET);
      const forceReview = forceReviewRequested && (actor.kind === "user" || !authConfigured);

      const upload = await UploadModel.findById(uploadId);
      if (!upload) {
        debugError(1, "[process] missing upload", { uploadId });
        return;
      }

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
      // When replacing a file, if AI extraction fails/skips for the new version,
      // we keep the prior AI-derived fields so the UI doesn't "lose" them.
      const priorDocAiOutput = existingDocObj ? (existingDocObj.aiOutput ?? null) : null;
      const priorDocName =
        existingDocObj && typeof existingDocObj.docName === "string" ? existingDocObj.docName : null;
      const priorPageSlugs =
        existingDocObj && Array.isArray(existingDocObj.pageSlugs) ? existingDocObj.pageSlugs : null;
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
        await UploadModel.findByIdAndUpdate(uploadId, {
          status: "failed",
          error: { message: "Missing blobUrl" },
        });
        // IMPORTANT: for replacement uploads, do not mark the existing doc as failed.
        // A failed replacement must not overwrite the last good version.
        if (!isReplacement) {
          await DocModel.findByIdAndUpdate(docId, { status: "failed" });
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
          .select({ _id: 1, aiOutput: 1, docName: 1, pageSlugs: 1 })
          .lean();
        const existingDocObj = isRecord(existingDoc) ? existingDoc : null;
        const priorDocAiOutput = existingDocObj ? (existingDocObj.aiOutput ?? null) : null;
        const priorDocName =
          existingDocObj && typeof existingDocObj.docName === "string" ? existingDocObj.docName : null;
        const priorPageSlugs =
          existingDocObj && Array.isArray(existingDocObj.pageSlugs) ? existingDocObj.pageSlugs : null;

        await DocModel.findByIdAndUpdate(docId, {
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
                .select({ _id: 1, rawExtractedText: 1, pdfText: 1 })
                .lean();
              const previousText = (prev?.rawExtractedText ?? (prev as any)?.pdfText ?? "").toString();
              const newText = (upload.rawExtractedText ?? upload.pdfText ?? "").toString();
            // Credits: history (automatic on replacement) defaults to Standard.
            const historyTier = "standard" as const;
            const historyCredits = creditsForRun({ actionType: "history", qualityTier: historyTier });
            const historyIdempotencyKey = `history:auto:${String(docId)}:to:${toVersion}:${historyTier}`;
            let historyLedgerId: string | null = null;
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

            let diff = null as any;
            if (historyLedgerId) {
              try {
                diff = await runDocChangeDiff({ previousText, newText, changedPages: [], qualityTier: historyTier });
                if (!diff) {
                  await failAndRefundLedger({ workspaceId: actor.orgId, ledgerId: historyLedgerId });
                  diff = null;
                } else {
                  await markLedgerCharged({ workspaceId: actor.orgId, ledgerId: historyLedgerId, creditsCharged: historyCredits });
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

      debugLog(1, "[process] set status=processing", { uploadId });
      await UploadModel.findByIdAndUpdate(uploadId, { status: "processing" });
      // IMPORTANT: for replacement uploads, keep the Doc pointing at the last good version
      // until processing succeeds. The client tracks replacement progress via the Upload.
      if (!isReplacement) {
        await DocModel.findByIdAndUpdate(docId, {
          status: "preparing",
          currentUploadId: upload._id,
          uploadId: upload._id,
        });
      }

      let pdfBytes: Uint8Array;
      try {
        debugLog(1, "[process] fetching pdf", { uploadId });
        pdfBytes = await fetchPdfBytes(blobUrl);
        debugLog(1, "[process] fetched pdf", { uploadId, bytes: pdfBytes.length });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to fetch PDF";
        debugError(1, "[process] fetch failed", { uploadId, message });
        await UploadModel.findByIdAndUpdate(uploadId, {
          status: "failed",
          error: { message },
        });
        if (!isReplacement) {
          await DocModel.findByIdAndUpdate(docId, { status: "failed" });
        }
        return;
      }

      let previewUrl: string | null = null;
      let extractedText: string | null = null;
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
      let jobError: unknown = null;
      const warningDetails: Record<string, string> = {};

      // Preview PNG (retryable)
      try {
        const existingPreview =
          upload.previewImageUrl ?? upload.firstPagePngUrl ?? null;

        if (existingPreview) {
          previewUrl = existingPreview;
          debugLog(2, "[process] preview already exists", { uploadId });
        } else {
          debugLog(1, "[process] rendering preview png", { uploadId });
          const { png } = await renderPdfFirstPagePng({ pdfBytes });
          const previewPathname = buildDocPreviewPngPathname({
            docId: String(docId),
            uploadId,
          });
          debugLog(1, "[process] uploading preview png", { uploadId, previewPathname });
          const blob = await put(previewPathname, png, {
            access: "public",
            contentType: "image/png",
            addRandomSuffix: false,
          });
          previewUrl = blob.url;
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

      // Best-effort: store a DocChange record for replacement uploads.
      try {
        if (isReplacement && uploadVersion && uploadVersion > 1) {
          const previousText = priorExtractedTextRaw.toString();
          const newText = (extractedText ?? "").toString();
          if (previousText.trim() && newText.trim()) {
            // Best-effort: compute changed pages for richer diff output (page-numbered links).
            let changedPages: Array<{ pageNumber: number; previousText: string; newText: string }> = [];
            try {
              // New version: extract per-page text from the PDF we already fetched.
              const newPages = await extractPdfTextByPage(pdfBytes).catch(() => []);
              const newByPage = new Map<number, string>(
                newPages
                  .map((p) => ({ n: Math.floor(Number(p.page_number)), t: String(p.text ?? "") }))
                  .filter((p) => Number.isFinite(p.n) && p.n >= 1)
                  .map((p) => [p.n, p.t]),
              );

              // Previous version: fetch the previous upload PDF and extract per-page text.
              const prevUpload =
                priorUploadId
                  ? await UploadModel.findById(priorUploadId).select({ blobUrl: 1 }).lean()
                  : null;
              const prevBlobUrl = prevUpload && typeof (prevUpload as any).blobUrl === "string" ? (prevUpload as any).blobUrl : "";
              if (prevBlobUrl) {
                const prevPdfBytes = await fetchPdfBytes(prevBlobUrl);
                const prevPages = await extractPdfTextByPage(prevPdfBytes).catch(() => []);
                const prevByPage = new Map<number, string>(
                  prevPages
                    .map((p) => ({ n: Math.floor(Number(p.page_number)), t: String(p.text ?? "") }))
                    .filter((p) => Number.isFinite(p.n) && p.n >= 1)
                    .map((p) => [p.n, p.t]),
                );

                const maxPages = Math.max(
                  ...[...prevByPage.keys(), ...newByPage.keys(), 0],
                );
                const changedNums: number[] = [];
                for (let p = 1; p <= maxPages; p++) {
                  const prevText = prevByPage.get(p) ?? "";
                  const nextText = newByPage.get(p) ?? "";
                  if (pageTextHash(prevText) !== pageTextHash(nextText)) changedNums.push(p);
                }

                // Cap page-level AI context to keep costs bounded.
                const MAX_PAGE_CONTEXT = 12;
                changedPages = changedNums.slice(0, MAX_PAGE_CONTEXT).map((p) => ({
                  pageNumber: p,
                  previousText: prevByPage.get(p) ?? "",
                  newText: newByPage.get(p) ?? "",
                }));
              }
            } catch (e) {
              warningDetails.historyPages = e instanceof Error ? e.message : String(e);
              changedPages = [];
            }

            // Credits: history (automatic on replacement) defaults to Standard.
            const historyTier = "standard" as const;
            const historyCredits = creditsForRun({ actionType: "history", qualityTier: historyTier });
            const historyIdempotencyKey = `history:auto:${String(docId)}:to:${uploadVersion}:${historyTier}`;
            let historyLedgerId: string | null = null;
            try {
              const reserved = await reserveCreditsOrThrow({
                workspaceId: String(existingDocOrgId),
                userId: actor.userId,
                docId: String(docId),
                actionType: "history",
                qualityTier: historyTier,
                idempotencyKey: historyIdempotencyKey,
              });
              historyLedgerId = reserved.ledgerId;
            } catch (e) {
              warningDetails.historyCredits = e instanceof Error ? e.message : String(e);
              // Skip history diff generation if we can't reserve credits.
              historyLedgerId = null;
            }

            let diff = null as any;
            if (historyLedgerId) {
              try {
                diff = await runDocChangeDiff({ previousText, newText, changedPages, qualityTier: historyTier });
                if (!diff) {
                  await failAndRefundLedger({ workspaceId: String(existingDocOrgId), ledgerId: historyLedgerId });
                  diff = null;
                } else {
                  await markLedgerCharged({
                    workspaceId: String(existingDocOrgId),
                    ledgerId: historyLedgerId,
                    creditsCharged: historyCredits,
                  });
                }
              } catch {
                await failAndRefundLedger({ workspaceId: String(existingDocOrgId), ledgerId: historyLedgerId });
                diff = null;
              }
            }
            await DocChangeModel.updateOne(
              { docId, toUploadId: upload._id },
              {
                $set: {
                  orgId: existingDocOrgId,
                  docId,
                  createdByUserId: new Types.ObjectId(actor.userId),
                  fromUploadId: priorUploadId,
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
            const blob = await put(textPathname, buf, {
              access: "public",
              contentType: "text/plain; charset=utf-8",
              addRandomSuffix: false,
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
        const existingAi = upload.aiOutput ?? null;
        if (existingAi) {
          aiOutput = existingAi;
          debugLog(2, "[process] aiOutput already exists", { uploadId });
        } else if (extractedText) {
          const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY);
          if (!hasOpenAiKey) {
            const message = "OPENAI_API_KEY is not set in the server process";
            warningDetails.ai = message;
            jobError = jobError ?? new Error(`AI analysis skipped: ${message}`);
            debugLog(1, "[process] AI analysis skipped (missing OPENAI_API_KEY)", { uploadId });
          } else {
            debugLog(1, "[process] analyzing with AI", { uploadId });
            const pages = await extractPdfTextByPage(pdfBytes).catch(() => []);
            // Credits: summary is automatic and defaults to Basic.
            const summaryTier = "basic" as const;
            const summaryCredits = creditsForRun({ actionType: "summary", qualityTier: summaryTier });
            const summaryIdempotencyKey = `summary:auto:${uploadId}:v${uploadVersion ?? "?"}:${summaryTier}`;
            let summaryLedgerId: string | null = null;
            try {
              const reserved = await reserveCreditsOrThrow({
                workspaceId: String(existingDocOrgId),
                userId: actor.userId,
                docId: String(docId),
                actionType: "summary",
                qualityTier: summaryTier,
                idempotencyKey: summaryIdempotencyKey,
              });
              summaryLedgerId = reserved.ledgerId;
            } catch (e) {
              warningDetails.summaryCredits = e instanceof Error ? e.message : String(e);
              debugLog(1, "[process] AI analysis skipped (insufficient credits)", { uploadId });
              // Skip AI analysis if we can't reserve credits.
              summaryLedgerId = null;
            }

            if (summaryLedgerId) {
              try {
                const analyzed = await analyzePdfText({
                  fullText: extractedText,
                  pages,
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
                  await failAndRefundLedger({ workspaceId: String(existingDocOrgId), ledgerId: summaryLedgerId });
                  debugLog(1, "[process] AI analysis skipped (returned null)", { uploadId });
                  aiOutput = null;
                } else {
                  aiOutput = analyzed;
                  await markLedgerCharged({
                    workspaceId: String(existingDocOrgId),
                    ledgerId: summaryLedgerId,
                    creditsCharged: summaryCredits,
                  });
                }
              } catch (e) {
                await failAndRefundLedger({ workspaceId: String(existingDocOrgId), ledgerId: summaryLedgerId });
                const message = e instanceof Error ? e.message : String(e);
                warningDetails.ai = warningDetails.ai ?? message;
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
              const ensuredAsk = ensureAsk(ai, extractedText);
              const ensuredKeyMetrics = ensureKeyMetrics(ai, extractedText);
              const ensuredStructureSignals = ensureStructureSignals(ai, extractedText);
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
      };
      // Auto-name the doc using AI once it has a recommendation.
      //
      // Only do this for the first upload version, and only if the title still matches the initial
      // default naming derived from the uploaded filename/URL (or a generic placeholder).
      if (uploadVersion === 1 && finalDocName) {
        const existingTitle =
          existingDocObj && typeof (existingDocObj as { title?: unknown }).title === "string"
            ? String((existingDocObj as { title: string }).title).trim()
            : "";
        const defaultTitle = titleFromFileName(asString(uploadObj.originalFileName) ?? "");
        const isPlaceholder =
          !existingTitle ||
          existingTitle.toLowerCase() === "document" ||
          existingTitle.toLowerCase() === "untitled document";
        const matchesDefault = existingTitle && existingTitle === defaultTitle;
        if (isPlaceholder || matchesDefault) {
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
        await DocModel.findByIdAndUpdate(docId, docUpdate);
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

      debugLog(1, "[process] done", { uploadId, ms: Date.now() - startedAt });
    } catch (err) {
      debugError(1, "[process] crashed", {
        uploadId,
        ms: Date.now() - startedAt,
        message: err instanceof Error ? err.message : String(err),
      });
      try {
        await UploadModel.findByIdAndUpdate(uploadId, {
          status: "failed",
          error: {
            message: err instanceof Error ? err.message : "Processing crashed",
          },
        });
      } catch {
        // ignore
      }
    }
  });

  return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
}

