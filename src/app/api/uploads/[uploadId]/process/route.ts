import { NextResponse } from "next/server";
import { after } from "next/server";
import { Types } from "mongoose";
import { put } from "@vercel/blob";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfParse from "pdf-parse";
import { createRequire } from "module";
import { pathToFileURL } from "url";
import { connectMongo } from "@/lib/mongodb";
import { UploadModel } from "@/lib/models/Upload";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { ReviewModel } from "@/lib/models/Review";
import { buildDocPreviewPngPathname } from "@/lib/blob/clientUpload";
import { analyzePdfText } from "@/lib/ai/analyzePdfText";
import { reviewDocText } from "@/lib/ai/reviewDocText";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

// pdfjs-dist on Node uses a "fake worker" implementation that still needs access to the worker module.
// In Next dev, the default worker resolution can point at a non-existent `.next/.../pdf.worker.mjs` chunk.
// Resolve the worker from node_modules explicitly to make preview rendering reliable in local dev.
try {
  const require = createRequire(import.meta.url);
  require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  // IMPORTANT: ESM module namespace exports are read-only, but the exported
  // `GlobalWorkerOptions` object is mutable; only mutate its properties.
  const gwo = (pdfjsLib as unknown as { GlobalWorkerOptions?: { workerSrc?: string } })
    .GlobalWorkerOptions;
  if (gwo) {
    // Prefer a normal module specifier on Next dev (file:// URLs get rewritten into
    // annotated ids like "...[app-route] (ecmascript)" and become unresolvable).
    gwo.workerSrc = "pdfjs-dist/legacy/build/pdf.worker.mjs";
  }
} catch {
  // Best-effort: if this fails for any reason, preview generation will fall back to the existing try/catch.
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

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

function clampMetaTitle(s: string) {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= 60) return t;
  return t.slice(0, 60).trimEnd();
}

function clampMetaDescription(s: string) {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= 160) return t;
  // Prefer cutting at a word boundary.
  const cut = t.slice(0, 160);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 120 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

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

function normalizeDocName(company: string, docType: string) {
  return `${company.trim()} ${docType}`.trim();
}

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

function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return "code" in err && (err as { code?: unknown }).code === 11000;
}

async function ensureReviewForUpload(params: {
  docId: Types.ObjectId;
  uploadId: string;
  version: number;
  extractedText: string;
}) {
  const { docId, uploadId, version, extractedText } = params;
  if (!extractedText || !extractedText.trim()) return;

  // Fast path: already completed for this version.
  const existing = await ReviewModel.findOne({ docId, version })
    .select({ _id: 1, status: 1 })
    .lean();
  if (existing && (existing as { status?: unknown }).status === "completed") return;

  // Acquire a per-(docId, version) "lock" by transitioning to processing.
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
  } catch (e) {
    if (isDuplicateKeyError(e)) return;
    throw e;
  }

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
    });

    if (!generated || !generated.markdown) {
      await ReviewModel.updateOne(
        { docId, version },
        {
          $set: {
            status: "skipped",
            model: generated?.model ?? null,
            prompt: generated?.prompt ?? null,
            priorReviewId: prior ? (prior as { _id?: unknown })._id : null,
            priorReviewVersion: prior ? (prior as { version?: unknown }).version : null,
          },
        },
      );
      return;
    }

    await ReviewModel.updateOne(
      { docId, version },
      {
        $set: {
          status: "completed",
          model: generated.model,
          prompt: generated.prompt,
          outputMarkdown: generated.markdown,
          priorReviewId: prior ? (prior as { _id?: unknown })._id : null,
          priorReviewVersion: prior ? (prior as { version?: unknown }).version : null,
          error: null,
        },
      },
    );
  } catch (e) {
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

async function extractPdfTextByPage(pdfBytes: Uint8Array): Promise<
  Array<{ page_number: number; text: string }>
> {
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

async function renderPdfFirstPagePng(params: {
  pdfBytes: Uint8Array;
  scale?: number;
  maxWidth?: number;
  page?: number;
}): Promise<{ png: Buffer; width: number; height: number }> {
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

export async function POST(
  request: Request,
  ctx: { params: Promise<{ uploadId: string }> },
) {
  const { uploadId } = await ctx.params;
  if (!Types.ObjectId.isValid(uploadId)) {
    return NextResponse.json({ error: "Invalid uploadId" }, { status: 400 });
  }

  debugLog(1, "[process] queued", { uploadId });

  const actor = await resolveActor(request);
  await connectMongo();

  // Authorization: upload must belong to the actor.
  const allowed = await UploadModel.exists({
    _id: new Types.ObjectId(uploadId),
    userId: new Types.ObjectId(actor.userId),
    isDeleted: { $ne: true },
  });
  if (!allowed) {
    return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
  }

  // Respond immediately; do the work in the background.
  after(async () => {
    const startedAt = Date.now();
    try {
      debugLog(1, "[process] start", { uploadId });
      await connectMongo();

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
      const existingDoc = await DocModel.findById(docId)
        .select({ _id: 1, projectId: 1, projectIds: 1, aiOutput: 1, docName: 1, pageSlugs: 1 })
        .lean();
      const existingDocObj = isRecord(existingDoc) ? existingDoc : null;
      // When replacing a file, if AI extraction fails/skips for the new version,
      // we keep the prior AI-derived fields so the UI doesn't "lose" them.
      const priorDocAiOutput = existingDocObj ? (existingDocObj.aiOutput ?? null) : null;
      const priorDocName =
        existingDocObj && typeof existingDocObj.docName === "string" ? existingDocObj.docName : null;
      const priorPageSlugs =
        existingDocObj && Array.isArray(existingDocObj.pageSlugs) ? existingDocObj.pageSlugs : null;
      const existingProjectIdsRaw = existingDoc
        ? [
            ...(existingDoc.projectId ? [String(existingDoc.projectId)] : []),
            ...(Array.isArray((existingDoc as unknown as { projectIds?: unknown }).projectIds)
              ? ((existingDoc as unknown as { projectIds?: unknown }).projectIds as unknown[]).map((x) => String(x))
              : []),
          ]
        : [];
      const existingProjectIds = Array.from(new Set(existingProjectIdsRaw.filter(Boolean)));

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
        await DocModel.findByIdAndUpdate(docId, { status: "failed" });
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
        return;
      }

      debugLog(1, "[process] set status=processing", { uploadId });
      await UploadModel.findByIdAndUpdate(uploadId, { status: "processing" });
      await DocModel.findByIdAndUpdate(docId, {
        status: "preparing",
        currentUploadId: upload._id,
        uploadId: upload._id,
      });

      let pdfBytes: Uint8Array;
      try {
        debugLog(1, "[process] fetching pdf", { uploadId });
        const res = await fetch(blobUrl);
        if (!res.ok) throw new Error(`Failed to fetch PDF (${res.status})`);
        const ab = await res.arrayBuffer();
        pdfBytes = new Uint8Array(ab);
        debugLog(1, "[process] fetched pdf", { uploadId, bytes: pdfBytes.length });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to fetch PDF";
        debugError(1, "[process] fetch failed", { uploadId, message });
        await UploadModel.findByIdAndUpdate(uploadId, {
          status: "failed",
          error: { message },
        });
        await DocModel.findByIdAndUpdate(docId, { status: "failed" });
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
          } else {
          debugLog(1, "[process] analyzing with AI", { uploadId });
          const pages = await extractPdfTextByPage(pdfBytes).catch(() => []);
          const analyzed = await analyzePdfText({
            fullText: extractedText,
            pages,
            projects: projectsContext,
            existingProjectIds,
            isReplacement,
          });
          if (!analyzed) {
            const message = "AI analysis returned null (likely missing OPENAI_API_KEY at runtime)";
            warningDetails.ai = warningDetails.ai ?? message;
            jobError = jobError ?? new Error(`AI analysis skipped: ${message}`);
          }
          aiOutput = analyzed;

          if (isRecord(aiOutput)) {
            // Work on a local typed copy; reassigning the `aiOutput: unknown` variable
            // would otherwise invalidate TypeScript narrowing.
            let ai = aiOutput as AiOutputRecord;
            // Normalize doc_name to "<Company> <DocType>" for UI consistency.
            docName = deriveDocNameFromAi(ai) ?? docName;
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
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        warningDetails.ai = message;
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

      debugLog(1, "[process] persisting results", { uploadId, failed });
      await UploadModel.findByIdAndUpdate(uploadId, {
        status: failed ? "failed" : "completed",
        blobUrl,
        previewImageUrl: previewUrl,
        firstPagePngUrl: previewUrl, // compat
        rawExtractedText: extractedText,
        pdfText: extractedText, // compat
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
      const uploadVersion = Number.isFinite(upload.version) ? Number(upload.version) : null;
      const finalDocAiOutput = aiOutput ?? (isReplacement ? priorDocAiOutput : null);
      const finalDocName = docName ?? (isReplacement ? priorDocName : null);
      const finalPageSlugs =
        pageSlugs ?? (isReplacement && priorPageSlugs ? (priorPageSlugs as unknown[]) : []);
      const docUpdate: Record<string, unknown> = {
        status: failed ? "failed" : "ready",
        blobUrl,
        currentUploadId: upload._id,
        previewImageUrl: previewUrl,
        firstPagePngUrl: previewUrl, // compat
        extractedText: extractedText,
        pdfText: extractedText, // compat
        aiOutput: finalDocAiOutput,
        docName: finalDocName,
        pageSlugs: finalPageSlugs,
      };
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
      await DocModel.findByIdAndUpdate(docId, docUpdate);

      // One-time review per version (best-effort, non-fatal).
      if (!failed && extractedText && uploadVersion) {
        // Temp-user limit: only 1 review total per doc.
        if (actor.kind === "temp") {
          const existingReviews = await ReviewModel.countDocuments({ docId });
          if (existingReviews < 1) {
            await ensureReviewForUpload({
              docId,
              uploadId,
              version: uploadVersion,
              extractedText,
            });
          }
        } else {
          await ensureReviewForUpload({
            docId,
            uploadId,
            version: uploadVersion,
            extractedText,
          });
        }
      }

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

