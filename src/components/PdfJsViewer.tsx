"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import Modal from "@/components/modals/Modal";
import Markdown from "@/components/Markdown";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

const CATEGORY_LABELS: Record<string, string> = {
  fundraising_pitch: "Fundraising Pitch",
  sales_pitch: "Sales Pitch",
  product_overview: "Product Overview",
  technical_whitepaper: "Technical Whitepaper",
  business_plan: "Business Plan",
  investor_update: "Investor Update",
  financial_report: "Financial Report",
  market_research: "Market Research",
  internal_strategy: "Internal Strategy",
  partnership_proposal: "Partnership Proposal",
  marketing_material: "Marketing Material",
  training_or_manual: "Training or Manual",
  legal_document: "Legal Document",
  resume_or_profile: "Resume or Profile",
  academic_paper: "Academic Paper",
  other: "Other",
};

function titleFromEnum(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
    .join(" ");
}

type Props = {
  url: string;
  initialPage?: number;
  /**
   * Optional shareId for `/share/:shareId` pages.
   * If present, enables owner-only controls + view stats collection.
   */
  shareId?: string | null;
  /**
   * If true, show a receiver-facing "Download PDF" button.
   */
  allowDownload?: boolean;
  /**
   * URL to download the PDF (typically a same-origin route that sets Content-Disposition: attachment).
   */
  downloadUrl?: string | null;
  /**
   * If true, show the recipient-facing "relevancy checks" UI/education in the viewer.
   * (Controlled by the author on the doc page.)
   */
  relevancyEnabled?: boolean;
  /**
   * Optional AI output for this specific document.
   * - If omitted (undefined), the viewer falls back to the sample JSON fetch (used by the test page).
   * - If provided as null, the viewer will show "AI summary unavailable."
   */
  ai?: AiOutput | null;
};

export type AiOutput = {
  version?: number;
  visibility?: "owner_only" | "public" | "unlisted";
  document_author_name?: string;
  document_author_nickname?: string;
  one_liner?: string;
  core_problem_or_need?: string;
  solution_summary?: string;
  primary_capabilities_or_scope?: string[];
  intended_use_or_context?: string;
  outcomes_or_value?: string;
  maturity_or_status?: string;
  summary?: string;
  category?: string;
  tags?: string[];
  document_purpose?: string;
  intended_audience?: string;
  company_or_project_name?: string;
  industry?: string;
  stage?: string;
  key_metrics?: string[];
  ask?: string;
  tone?: string;
  confidence_level?: string;
  structure_signals?: string[];
};

type PdfDoc = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
};

type PdfPage = {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }) => { promise: Promise<unknown> };
};

const BOT_ID_STORAGE_KEY = "lnkdrp_botid_v1";
const SHARE_LOCAL_STATS_PREFIX = "lnkdrp_share_local_stats_v1:";
const SHARE_OWNER_STATS_PREFIX = "lnkdrp_share_owner_stats_v1:";

type OwnerStats = { views: number; pagesViewed: number };
type ShareContext = { isOwner: boolean; stats?: OwnerStats };

function isBrowser() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function getOrCreateBotId(): string | null {
  if (!isBrowser()) return null;
  try {
    const existing = window.localStorage.getItem(BOT_ID_STORAGE_KEY);
    if (existing && existing.trim()) return existing.trim();
    const created =
      // Prefer a stable UUID when available.
      (typeof crypto !== "undefined" && "randomUUID" in crypto && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`);
    window.localStorage.setItem(BOT_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return null;
  }
}

type LocalShareStats = { viewedAt?: number; pagesSeen?: number[] };

function readLocalShareStats(shareId: string): LocalShareStats {
  if (!isBrowser()) return {};
  try {
    const raw = window.localStorage.getItem(`${SHARE_LOCAL_STATS_PREFIX}${shareId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const viewedAt = (parsed as { viewedAt?: unknown }).viewedAt;
    const pagesSeen = (parsed as { pagesSeen?: unknown }).pagesSeen;
    return {
      viewedAt: typeof viewedAt === "number" && Number.isFinite(viewedAt) ? viewedAt : undefined,
      pagesSeen: Array.isArray(pagesSeen)
        ? pagesSeen.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 1)
        : undefined,
    };
  } catch {
    return {};
  }
}

function writeLocalShareStats(shareId: string, next: LocalShareStats) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(`${SHARE_LOCAL_STATS_PREFIX}${shareId}`, JSON.stringify(next));
  } catch {
    // ignore
  }
}

function writeOwnerStatsToLocalStorage(shareId: string, stats: OwnerStats) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(`${SHARE_OWNER_STATS_PREFIX}${shareId}`, JSON.stringify(stats));
  } catch {
    // ignore
  }
}

export function PdfJsViewer({
  url,
  initialPage = 1,
  shareId,
  allowDownload = false,
  downloadUrl = null,
  relevancyEnabled: _relevancyEnabled = false,
  ai,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfRef = useRef<PdfDoc | null>(null);
  const aiButtonRef = useRef<HTMLButtonElement | null>(null);
  const aiPopoverRef = useRef<HTMLDivElement | null>(null);

  const [pageNumber, setPageNumber] = useState(initialPage);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pdfVersion, setPdfVersion] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1); // multiplier on top of "fit-to-screen"
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiData, setAiData] = useState<AiOutput | null>(ai ?? null);
  const [copied, setCopied] = useState(false);
  const [shareContext, setShareContext] = useState<ShareContext | null>(null);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "rendering" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const aiProvided = typeof ai !== "undefined";
  const shareIdSafe = typeof shareId === "string" && shareId.trim() ? shareId.trim() : null;
  const canDownload = Boolean(allowDownload && downloadUrl);
  const ownerViews = shareContext?.stats?.views ?? 0;
  const ownerPagesViewed = shareContext?.stats?.pagesViewed ?? 0;
  const ownerViewsLabel = `${ownerViews} ${ownerViews === 1 ? "view" : "views"}`;
  const ownerPagesLabel = `${ownerPagesViewed} ${ownerPagesViewed === 1 ? "page" : "pages"}`;
  const categoryLabel =
    aiData?.category
      ? (CATEGORY_LABELS[aiData.category] ?? titleFromEnum(aiData.category))
      : null;

  async function shareOrCopyLink() {
    const href = window.location.href;
    if (typeof navigator !== "undefined" && "share" in navigator) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (navigator as any).share({ url: href, title: document.title });
        return;
      } catch (err) {
        // If the user cancels the share sheet, do nothing (don't "copy" behind their back).
        if (
          err &&
          typeof err === "object" &&
          "name" in err &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (err as any).name === "AbortError"
        ) {
          return;
        }
        // Otherwise, ignore and fall back to copy.
      }
    }
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  }

  const canPrev = useMemo(() => pageNumber > 1, [pageNumber]);
  const canNext = useMemo(
    () => (numPages ? pageNumber < numPages : true),
    [numPages, pageNumber],
  );

  const goPrev = useMemo(
    () => () => setPageNumber((p) => Math.max(1, p - 1)),
    [],
  );
  const goNext = useMemo(() => () => setPageNumber((p) => p + 1), []);

  const canZoomOut = zoom > 0.5;
  const canZoomIn = zoom < 4;

  // Zoom is a multiplier on top of "fit-to-screen".
  // Use multiplicative steps so each click feels meaningful.
  const ZOOM_STEP = 1.15;
  const zoomOut = useMemo(
    () => () =>
      setZoom((z) => {
        const next = z / ZOOM_STEP;
        return Math.max(0.5, Math.round(next * 100) / 100);
      }),
    [],
  );
  const zoomIn = useMemo(
    () => () =>
      setZoom((z) => {
        const next = z * ZOOM_STEP;
        return Math.min(4, Math.round(next * 100) / 100);
      }),
    [],
  );

  const resetZoom = useMemo(() => () => setZoom(1), []);

  const toggleFullscreen = useMemo(
    () => async () => {
      const el = containerRef.current;
      if (!el) return;
      try {
        if (!document.fullscreenElement) {
          await el.requestFullscreen();
        } else {
          await document.exitFullscreen();
        }
      } catch {
        // ignore
      }
    },
    [],
  );

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setViewportSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) });
    });
    ro.observe(el);

    // Kick once synchronously.
    const rect = el.getBoundingClientRect();
    setViewportSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) });

    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setHeaderHeight(Math.floor(rect.height));
    });
    ro.observe(el);

    const rect = el.getBoundingClientRect();
    setHeaderHeight(Math.floor(rect.height));

    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    onFullscreenChange();
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadSummary() {
      // If AI output was provided (including null), never load the sample.
      if (aiProvided) return;
      if (!aiOpen || aiData !== null) return;
      try {
        const res = await fetch("/sample/sample-ai-output.json", {
          cache: "no-store",
        });
        const data = (await res.json()) as AiOutput;
        if (cancelled) return;
        setAiData(data ?? {});
      } catch {
        if (cancelled) return;
        setAiData({ summary: "AI summary unavailable." });
      }
    }
    loadSummary();
    return () => {
      cancelled = true;
    };
  }, [aiData, aiOpen, aiProvided]);

  useEffect(() => {
    if (!aiOpen) return;

    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (aiPopoverRef.current?.contains(t)) return;
      if (aiButtonRef.current?.contains(t)) return;
      setAiOpen(false);
    }

    // Capture ensures we close even if other handlers stop propagation later.
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [aiOpen]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (target?.isContentEditable) return;

      if (e.key === "ArrowLeft") {
        if (canPrev) goPrev();
        e.preventDefault();
      } else if (e.key === "ArrowRight") {
        if (canNext) goNext();
        e.preventDefault();
      } else if (e.key === "=" || e.key === "+") {
        if (canZoomIn) zoomIn();
        e.preventDefault();
      } else if (e.key === "-" || e.key === "_") {
        if (canZoomOut) zoomOut();
        e.preventDefault();
      } else if (e.key === "0") {
        resetZoom();
        e.preventDefault();
      } else if (e.key.toLowerCase() === "f") {
        // Fullscreen toggle
        void toggleFullscreen();
      } else if (e.key === "Escape") {
        setAiOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    canNext,
    canPrev,
    canZoomIn,
    canZoomOut,
    goNext,
    goPrev,
    resetZoom,
    toggleFullscreen,
    zoomIn,
    zoomOut,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus({ kind: "loading" });
      try {
        // Use the bundler-specific entry to avoid PDF.js thinking it's running in Node
        // (Next injects a `process` polyfill in the browser).
        const pdfjs = await import("pdfjs-dist/webpack.mjs");
        const loadingTask = pdfjs.getDocument({ url });
        const pdf = (await loadingTask.promise) as PdfDoc;
        if (cancelled) return;
        pdfRef.current = pdf;
        setNumPages(pdf.numPages ?? null);
        setPageNumber((p) => Math.min(Math.max(1, p), pdf.numPages || p));
        setPdfVersion((v) => v + 1);
        setStatus({ kind: "idle" });
      } catch (e: unknown) {
        if (cancelled) return;
        const message =
          e instanceof Error ? e.message : "Failed to load PDF (unknown error)";
        setStatus({
          kind: "error",
          message,
        });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      const pdf = pdfRef.current;
      const canvas = canvasRef.current;
      if (!pdf || !canvas) return;
      if (viewportSize.w <= 0 || viewportSize.h <= 0) return;

      setStatus({ kind: "rendering" });
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;

        // Fit-to-viewport (contain): ensure the page fits without scrolling at zoom=1.
        const base = page.getViewport({ scale: 1 });
        const fitScale = Math.min(viewportSize.w / base.width, viewportSize.h / base.height);
        const viewport = page.getViewport({
          scale: Math.max(0.1, fitScale * zoom),
        });
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D context not available");

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);

        const renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;

        if (cancelled) return;
        setStatus({ kind: "idle" });
      } catch (e: unknown) {
        if (cancelled) return;
        const message =
          e instanceof Error
            ? e.message
            : "Failed to render PDF page (unknown error)";
        setStatus({
          kind: "error",
          message,
        });
      }
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [pageNumber, pdfVersion, viewportSize.h, viewportSize.w, zoom]);

  useEffect(() => {
    if (!shareIdSafe) return;
    const shareId = shareIdSafe;
    let cancelled = false;
    async function loadContext() {
      try {
        const res = await fetchWithTempUser(`/api/share/${shareId}/stats`, {
          cache: "no-store",
        });
        const json = (await res.json().catch(() => null)) as unknown;
        if (cancelled) return;
        if (!json || typeof json !== "object") return;
        const isOwner = Boolean((json as { isOwner?: unknown }).isOwner);
        const statsRaw = (json as { stats?: unknown }).stats;
        const stats =
          statsRaw && typeof statsRaw === "object"
            ? {
                views:
                  typeof (statsRaw as { views?: unknown }).views === "number"
                    ? (statsRaw as { views: number }).views
                    : 0,
                pagesViewed:
                  typeof (statsRaw as { pagesViewed?: unknown }).pagesViewed === "number"
                    ? (statsRaw as { pagesViewed: number }).pagesViewed
                    : 0,
              }
            : undefined;
        setShareContext({ isOwner, stats });
        if (isOwner && stats) writeOwnerStatsToLocalStorage(shareId, stats);
      } catch {
        // ignore
      }
    }
    void loadContext();
    return () => {
      cancelled = true;
    };
  }, [shareIdSafe]);

  useEffect(() => {
    // Public stats collection for share pages:
    // - store a per-browser botId in localStorage
    // - record one "view" per (shareId, botId) server-side
    // - record distinct pages viewed per (shareId, botId) server-side
    if (!shareIdSafe) return;
    const botId = getOrCreateBotId();
    if (!botId) return;

    const local = readLocalShareStats(shareIdSafe);
    const pagesSeen = new Set<number>(Array.isArray(local.pagesSeen) ? local.pagesSeen : []);

    // Record the view once per browser (localStorage) to reduce spam.
    if (!local.viewedAt) {
      void fetchWithTempUser(`/api/share/${shareIdSafe}/stats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botId, pageNumber }),
      }).catch(() => void 0);

      pagesSeen.add(pageNumber);
      writeLocalShareStats(shareIdSafe, {
        viewedAt: Date.now(),
        pagesSeen: Array.from(pagesSeen).sort((a, b) => a - b),
      });
      return;
    }

    // If we've already recorded a view, still record the initial page if it wasn't stored yet.
    if (!pagesSeen.has(pageNumber)) {
      void fetchWithTempUser(`/api/share/${shareIdSafe}/stats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botId, pageNumber }),
      }).catch(() => void 0);
      pagesSeen.add(pageNumber);
      writeLocalShareStats(shareIdSafe, {
        viewedAt: local.viewedAt,
        pagesSeen: Array.from(pagesSeen).sort((a, b) => a - b),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareIdSafe]);

  useEffect(() => {
    // Record distinct page views as the user navigates.
    if (!shareIdSafe) return;
    const botId = getOrCreateBotId();
    if (!botId) return;
    const local = readLocalShareStats(shareIdSafe);
    const pagesSeen = new Set<number>(Array.isArray(local.pagesSeen) ? local.pagesSeen : []);
    if (pagesSeen.has(pageNumber)) return;

    void fetchWithTempUser(`/api/share/${shareIdSafe}/stats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId, pageNumber }),
    }).catch(() => void 0);

    pagesSeen.add(pageNumber);
    writeLocalShareStats(shareIdSafe, {
      viewedAt: local.viewedAt,
      pagesSeen: Array.from(pagesSeen).sort((a, b) => a - b),
    });
  }, [pageNumber, shareIdSafe]);

  return (
    <div
      ref={containerRef}
      className="group relative flex h-[100svh] w-screen flex-col overflow-hidden bg-black"
    >
      {/* Top bar (fixed layout; does not overlay PDF) */}
      <header
        ref={headerRef}
        className="sticky top-0 z-20 w-full border-b border-white/10 bg-black/85 text-white/90 backdrop-blur-sm"
      >
        <div className="px-4 py-3 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            {/* Left */}
            <div className="flex min-w-0 items-center gap-3">
              <div aria-hidden="true" className="inline-flex items-center justify-center">
                <Image src="/icon-white.svg?v=3" alt="" width={26} height={26} />
              </div>

              <div className="inline-flex min-w-0 items-center gap-2 rounded-2xl border border-white/10 bg-white/5 p-1.5">
                <button
                  type="button"
                  aria-label="AI summary"
                  ref={aiButtonRef}
                  onClick={() => {
                    setAiOpen((v) => !v);
                  }}
                  className="inline-flex h-8 items-center rounded-xl px-3 text-xs font-medium text-white/90 hover:bg-white/10"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <SparklesIcon />
                    AI summary
                  </span>
                </button>

                {shareContext?.isOwner ? (
                  <>
                    <div className="hidden h-8 w-px bg-white/10 sm:block" aria-hidden="true" />

                    <div className="inline-flex h-8 min-w-0 items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-3">
                      <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-emerald-100/90">
                        Visible to you only
                      </span>

                      <button
                        type="button"
                        aria-label="Share link"
                        onClick={() => void shareOrCopyLink()}
                        className="inline-flex h-8 min-w-[84px] shrink-0 items-center justify-center whitespace-nowrap rounded-lg bg-white/5 px-3 text-xs font-semibold text-white/90 hover:bg-white/10"
                        title={copied ? "Copied!" : "Share / copy link"}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <ShareIcon />
                          {copied ? "Copied" : "Share"}
                        </span>
                      </button>

                      {shareContext.stats ? (
                        <div className="hidden items-center gap-1.5 text-[11px] text-white/75 md:inline-flex">
                          <span className="tabular-nums">{ownerViewsLabel}</span>
                          <span className="text-white/30">•</span>
                          <span className="tabular-nums">{ownerPagesLabel}</span>
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>
            </div>

            {/* Right */}
            <div className="flex shrink-0 items-center gap-2">
              <div className="inline-flex items-center gap-1 rounded-2xl border border-white/10 bg-white/5 p-1.5">
                <div className="inline-flex h-8 items-center rounded-xl px-3 text-xs text-white/85">
                  {numPages ? (
                    <>
                      <span className="tabular-nums">{pageNumber}</span>
                      <span className="text-white/50"> / </span>
                      <span className="tabular-nums">{numPages}</span>
                    </>
                  ) : (
                    <span className="text-white/70">…</span>
                  )}
                </div>

                <div className="h-8 w-px bg-white/10" aria-hidden="true" />

                <button
                  type="button"
                  aria-label="Zoom out"
                  onClick={zoomOut}
                  disabled={!canZoomOut}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-xl text-white/90 hover:bg-white/10 disabled:opacity-40"
                >
                  <MinusIcon />
                </button>

                {zoom === 1 ? (
                  <div className="inline-flex h-8 min-w-[58px] items-center justify-center text-center text-xs text-white/85 tabular-nums">
                    {Math.round(zoom * 100)}%
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-label="Reset zoom"
                    onClick={resetZoom}
                    className="inline-flex h-8 min-w-[86px] items-center justify-center rounded-xl px-2 text-center text-xs text-white/90 tabular-nums hover:bg-white/10"
                    title="Reset zoom (0)"
                  >
                    {Math.round(zoom * 100)}%{" "}
                    <span className="text-white/55">reset</span>
                  </button>
                )}

                <button
                  type="button"
                  aria-label="Zoom in"
                  onClick={zoomIn}
                  disabled={!canZoomIn}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-xl text-white/90 hover:bg-white/10 disabled:opacity-40"
                >
                  <PlusIcon />
                </button>

                <div className="h-8 w-px bg-white/10" aria-hidden="true" />

                <button
                  type="button"
                  aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                  onClick={toggleFullscreen}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-xl text-white/90 hover:bg-white/10"
                >
                  <FullscreenIcon isFullscreen={isFullscreen} />
                </button>
              </div>

              {shareIdSafe && !shareContext?.isOwner ? (
                null
              ) : null}

              {canDownload ? (
                <a
                  href={downloadUrl as string}
                  className="inline-flex h-11 items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 text-xs font-semibold text-white/90 hover:bg-white/10"
                >
                  Download PDF
                </a>
              ) : null}
            </div>
          </div>

        </div>
      </header>

      {/* AI summary popover (overlays PDF, aligned with top bar) */}
      {aiOpen ? (
        <>
          {/* Backdrop: gently dim + blur PDF behind the summary */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 right-0 bottom-0 z-30 bg-black/15 backdrop-blur-sm"
            style={{ top: headerHeight }}
          />

          <div
            className="pointer-events-none absolute left-0 right-0 z-40"
            style={{ top: headerHeight }}
          >
            <div className="pointer-events-auto px-3 pt-4 sm:px-6 sm:pt-5">
            <div
              ref={aiPopoverRef}
              className="max-w-3xl rounded-2xl border border-white/15 bg-black/95 p-7 text-base text-white shadow-2xl ring-1 ring-white/15"
            >
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center gap-2 text-sm font-semibold tracking-wide text-white/90">
                  <SparklesIcon />
                  AI SUMMARY
                </div>
                <div className="ml-auto text-sm text-white/70">Esc to close</div>
              </div>

              {aiData && typeof aiData.one_liner === "string" && aiData.one_liner.trim() ? (
                <div className="mt-4 text-lg font-semibold leading-snug text-white">
                  {aiData.one_liner.trim()}
                </div>
              ) : null}

              <div className="mt-5 leading-7 text-white/95">
                {typeof aiData?.summary === "string" ? (
                  <Markdown tone="dark" className="leading-7">
                    {aiData.summary}
                  </Markdown>
                ) : aiProvided ? (
                  "AI summary unavailable."
                ) : (
                  "Loading…"
                )}
              </div>

              {aiData ? (
                <div className="mt-6 grid gap-3">
                  <div className="grid gap-3 rounded-xl border border-white/15 bg-white/10 p-4">
                    {/* Quick facts (receiver-facing, no confidence/tone/critique) */}
                    <div className="grid gap-2 text-sm text-white/85">
                      {(aiData.company_or_project_name?.trim() || aiData.category?.trim()) ? (
                        <div className="text-white/75">
                          {aiData.company_or_project_name?.trim() ? (
                            <span className="text-white/95">{aiData.company_or_project_name.trim()}</span>
                          ) : null}
                          {aiData.company_or_project_name?.trim() && aiData.category?.trim() ? (
                            <span className="text-white/50"> • </span>
                          ) : null}
                          {aiData.category?.trim() ? (
                            <span>
                              <span className="text-white/70">Type:</span>{" "}
                              <span className="text-white/90">{categoryLabel}</span>
                            </span>
                          ) : null}
                        </div>
                      ) : null}

                      {aiData.core_problem_or_need?.trim() ? (
                        <div className="rounded-lg border-l-2 border-white/25 pl-3">
                          <div className="text-[11px] font-bold uppercase tracking-widest text-white/80">
                            Why this exists
                          </div>
                          <div className="mt-1 text-white/95">{aiData.core_problem_or_need.trim()}</div>
                        </div>
                      ) : null}

                      {aiData.primary_capabilities_or_scope?.length ? (
                        <div className="rounded-lg border-l-2 border-white/25 pl-3">
                          <div className="text-[11px] font-bold uppercase tracking-widest text-white/80">
                            What it covers
                          </div>
                          <ul className="mt-2 list-disc space-y-1 pl-5 text-white/95">
                            {aiData.primary_capabilities_or_scope
                              .filter((s) => typeof s === "string" && s.trim())
                              .slice(0, 6)
                              .map((s) => (
                                <li key={`scope:${s}`} className="pl-0">
                                  {s.trim()}
                                </li>
                              ))}
                          </ul>
                        </div>
                      ) : null}

                      {aiData.intended_use_or_context?.trim() ? (
                        <div className="rounded-lg border-l-2 border-white/25 pl-3">
                          <div className="text-[11px] font-bold uppercase tracking-widest text-white/80">
                            Context
                          </div>
                          <div className="mt-1 text-white/95">{aiData.intended_use_or_context.trim()}</div>
                        </div>
                      ) : null}

                      {aiData.outcomes_or_value?.trim() ? (
                        <div className="rounded-lg border-l-2 border-white/25 pl-3">
                          <div className="text-[11px] font-bold uppercase tracking-widest text-white/80">
                            Value
                          </div>
                          <div className="mt-1 text-white/95">{aiData.outcomes_or_value.trim()}</div>
                        </div>
                      ) : null}

                      {aiData.maturity_or_status?.trim() ? (
                        <div className="rounded-lg border-l-2 border-white/25 pl-3">
                          <div className="text-[11px] font-bold uppercase tracking-widest text-white/80">
                            Status
                          </div>
                          <div className="mt-1 text-white/95">{aiData.maturity_or_status.trim()}</div>
                        </div>
                      ) : null}

                      {aiData.ask?.trim() ? (
                        <div className="rounded-lg border-l-2 border-white/25 pl-3">
                          <div className="text-[11px] font-bold uppercase tracking-widest text-white/80">
                            Ask
                          </div>
                          <div className="mt-1 text-white/95">{aiData.ask.trim()}</div>
                        </div>
                      ) : null}

                      {aiData.key_metrics?.length ? (
                        <div className="text-white/80">
                          <span className="text-white/70">Key metrics:</span>{" "}
                          <span className="text-white/92">
                            {aiData.key_metrics.filter((s) => typeof s === "string" && s.trim()).slice(0, 6).join(" • ")}
                          </span>
                        </div>
                      ) : null}
                    </div>

                    {aiData.tags?.length ? (
                      <div className="mt-1 flex flex-wrap gap-2">
                        {aiData.tags
                          .filter((t) => typeof t === "string" && t.trim())
                          .slice(0, 10)
                          .map((t) => (
                            <span
                              key={`tag:${t}`}
                              className="rounded-full border border-white/15 bg-black/30 px-2.5 py-1 text-xs text-white/85"
                            >
                              {t}
                            </span>
                          ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          </div>
        </>
      ) : null}

      {/* Page */}
      <div
        ref={viewportRef}
        className={`relative flex-1 bg-black ${zoom === 1 ? "overflow-hidden" : "overflow-auto"}`}
      >
        {(status.kind === "loading" || status.kind === "rendering") ? (
          <div
            aria-live="polite"
            aria-busy="true"
            className="pointer-events-none absolute inset-0 z-20 grid place-items-center"
          >
            <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/70 px-4 py-3 text-sm text-white/90 shadow-xl backdrop-blur-sm">
              <div
                className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white/90"
                aria-hidden="true"
              />
              <div className="font-medium">
                {status.kind === "loading" ? "Loading PDF…" : "Rendering…"}
              </div>
            </div>
          </div>
        ) : null}

        <div className="grid min-h-full min-w-full place-items-center">
          {/* When zoomed in, allow the canvas to exceed viewport and scroll */}
          <canvas ref={canvasRef} className="block max-h-none max-w-none" />
        </div>

        {/* Hover arrows (centered within PDF viewport) */}
        <button
          type="button"
          aria-label="Previous page"
          onClick={goPrev}
          disabled={!canPrev || status.kind === "loading"}
          className="pointer-events-auto absolute left-4 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/35 text-white/90 opacity-0 shadow-lg backdrop-blur-sm transition-opacity duration-200 hover:bg-black/45 disabled:opacity-0 group-hover:opacity-100"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M15 6L9 12L15 18"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <button
          type="button"
          aria-label="Next page"
          onClick={goNext}
          disabled={!canNext || status.kind === "loading"}
          className="pointer-events-auto absolute right-4 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/35 text-white/90 opacity-0 shadow-lg backdrop-blur-sm transition-opacity duration-200 hover:bg-black/45 disabled:opacity-0 group-hover:opacity-100"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M9 6L15 12L9 18"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {/* Subtle zoom reset overlay (only when zoomed) */}
        {zoom !== 1 ? (
          <button
            type="button"
            onClick={resetZoom}
            className="pointer-events-auto absolute bottom-4 right-4 rounded-full border border-white/10 bg-black/70 px-3 py-1.5 text-xs text-white/85 shadow-xl backdrop-blur-sm opacity-80 transition-opacity duration-200 hover:opacity-100"
            title="Reset zoom (0)"
          >
            Reset zoom
          </button>
        ) : null}
      </div>

      {/* (Status is shown in top bar) */}
    </div>
  );
}

function SparklesIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M12 2l1.2 4.1L17.3 7.3l-4.1 1.2L12 12.6l-1.2-4.1L6.7 7.3l4.1-1.2L12 2Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M19 12l.7 2.3 2.3.7-2.3.7L19 18l-.7-2.3-2.3-.7 2.3-.7L19 12Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M5 13l.6 2.1 2.1.6-2.1.6L5 18.4l-.6-2.1-2.1-.6 2.1-.6L5 13Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M6 12h12"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M12 6v12M6 12h12"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M18 8a3 3 0 1 0-2.82-4H15a3 3 0 0 0 .18 1.03L8.8 9.1a3 3 0 0 0-1.8-.6 3 3 0 1 0 2.82 4l6.38 3.98A3 3 0 1 0 17 15a2.98 2.98 0 0 0-1.8.6l-6.38-3.98c.11-.32.18-.66.18-1.02 0-.36-.07-.7-.18-1.02l6.38-4.07c.53.32 1.16.5 1.8.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FullscreenIcon({ isFullscreen }: { isFullscreen: boolean }) {
  return isFullscreen ? (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M9 9H5V5M15 9h4V5M9 15H5v4M15 15h4v4"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M9 5H5v4M15 5h4v4M9 19H5v-4M15 19h4v-4"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

