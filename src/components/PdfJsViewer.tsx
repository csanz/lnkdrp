"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Modal from "@/components/modals/Modal";
import Markdown from "@/components/Markdown";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { getOrCreateBotId } from "@/lib/botId";

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
/**
 * Title From Enum (uses join, map, filter).
 */


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
   * If true, allow recipients to view a light revision history for the shared doc.
   */
  revisionHistoryEnabled?: boolean;
  /**
   * Endpoint for fetching revision history JSON (typically `/api/share/:shareId/changes`).
   */
  revisionHistoryUrl?: string | null;
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
   * - If provided as null, the viewer will show "Summary unavailable."
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
  rotate?: number;
  getViewport: (opts: { scale: number; rotation?: number }) => { width: number; height: number };
  render: (opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }) => { promise: Promise<unknown> };
};

const SHARE_LOCAL_STATS_PREFIX = "lnkdrp_share_local_stats_v1:";
const SHARE_OWNER_STATS_PREFIX = "lnkdrp_share_owner_stats_v1:";
const SHARE_VISIT_SESSION_PREFIX = "lnkdrp_share_visit_session_v1:";

type OwnerStats = { views: number; pagesViewed: number };
type ShareContext = { isOwner: boolean; stats?: OwnerStats };

type HistoryItem = {
  fromVersion: number | null;
  toVersion: number | null;
  createdDate: string | null;
  summary: string;
  pagesThatChanged?: Array<{ pageNumber: number; summary: string }>;
};

function normalizePdfRotation(page: { rotate?: number } | null | undefined): number {
  const raw = typeof page?.rotate === "number" && Number.isFinite(page.rotate) ? page.rotate : 0;
  // Normalize to 0/90/180/270 range; PDF rotation is specified in degrees.
  const snapped = Math.round(raw / 90) * 90;
  return ((snapped % 360) + 360) % 360;
}
/**
 * Return whether browser.
 */


function isBrowser() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}
type LocalShareStats = { viewedAt?: number; pagesSeen?: number[] };

type ShareVisitSession = { visitId: string; lastSeenAt: number };

/** Generate a cryptographically-random hex string of the given byte length. */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Best-effort per-tab visit id for share pages.
 * Stored in sessionStorage (new tab = new visit).
 */
function getOrCreateShareVisitId(shareId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const key = `${SHARE_VISIT_SESSION_PREFIX}${shareId}`;
    const raw = window.sessionStorage.getItem(key);
    const now = Date.now();
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      const visitId = parsed && typeof parsed === "object" ? (parsed as any).visitId : null;
      const lastSeenAt = parsed && typeof parsed === "object" ? (parsed as any).lastSeenAt : null;
      if (typeof visitId === "string" && visitId.trim()) {
        const last = typeof lastSeenAt === "number" && Number.isFinite(lastSeenAt) ? lastSeenAt : now;
        window.sessionStorage.setItem(key, JSON.stringify({ visitId, lastSeenAt: now } satisfies ShareVisitSession));
        // If a tab sits idle for a long time, rotate the visit id (best-effort).
        if (now - last < 30 * 60 * 1000) return visitId;
      }
    }
    const visitId = `v_${randomHex(16)}`;
    window.sessionStorage.setItem(key, JSON.stringify({ visitId, lastSeenAt: now } satisfies ShareVisitSession));
    return visitId;
  } catch {
    return null;
  }
}
/**
 * Read Local Share Stats (uses isBrowser, getItem, parse).
 */


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
/**
 * Write Local Share Stats (uses isBrowser, setItem, stringify).
 */


function writeLocalShareStats(shareId: string, next: LocalShareStats) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(`${SHARE_LOCAL_STATS_PREFIX}${shareId}`, JSON.stringify(next));
  } catch {
    // ignore
  }
}
/**
 * Write Owner Stats To Local Storage (uses isBrowser, setItem, stringify).
 */


function writeOwnerStatsToLocalStorage(shareId: string, stats: OwnerStats) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(`${SHARE_OWNER_STATS_PREFIX}${shareId}`, JSON.stringify(stats));
  } catch {
    // ignore
  }
}
/**
 * Render the PdfJsViewer UI (uses effects, memoized values, local state).
 */


export function PdfJsViewer({
  url,
  initialPage = 1,
  shareId,
  revisionHistoryEnabled = false,
  revisionHistoryUrl = null,
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
  const [reloadKey, setReloadKey] = useState(0);
  const [useNativePdf, setUseNativePdf] = useState(false);
  const [nativePdfLoaded, setNativePdfLoaded] = useState(false);
  const [nativePdfError, setNativePdfError] = useState<string | null>(null);
  // Perf: never let non-essential share stats compete with "first page painted".
  const [hasPaintedFirstPage, setHasPaintedFirstPage] = useState(false);
  const hasPaintedFirstPageRef = useRef(false);
  const markFirstPainted = useCallback(() => {
    if (hasPaintedFirstPageRef.current) return;
    hasPaintedFirstPageRef.current = true;
    setHasPaintedFirstPage(true);
  }, []);
  const hasFirstPaint = hasPaintedFirstPage || (useNativePdf && nativePdfLoaded);

  function scheduleAfterPaint(fn: () => void) {
    // Best-effort: give the browser a chance to paint the PDF before background work.
    try {
      if (typeof window !== "undefined" && "requestIdleCallback" in window) {
        (window as any).requestIdleCallback(fn, { timeout: 2000 });
        return;
      }
    } catch {
      // ignore
    }
    try {
      if (typeof window !== "undefined") window.setTimeout(fn, 800);
    } catch {
      // ignore
    }
  }
  const [headerHeight, setHeaderHeight] = useState(0);
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1); // multiplier on top of "fit-to-screen"
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(true);
  const historyReqIdRef = useRef(0);
  const historyPrefetchDoneRef = useRef(false);
  const historyScrollRef = useRef<HTMLDivElement | null>(null);
  const historySentinelRef = useRef<HTMLDivElement | null>(null);
  const shareTimingEnteredAtMsRef = useRef<number | null>(null);
  const shareTimingLastFlushAtMsRef = useRef<number>(0);
  const shareTimingPageRef = useRef<number>(initialPage);
  const shareTimingPageEnteredAtMsRef = useRef<number | null>(null);
  const shareVisitIdRef = useRef<string | null>(null);
  const [viewMode, setViewMode] = useState<"single" | "all" | "grid">("single");
  const [aiData, setAiData] = useState<AiOutput | null>(ai ?? null);
  const [shareContext, setShareContext] = useState<ShareContext | null>(null);
  const askText = useMemo(() => {
    const raw = (aiData?.ask ?? "").trim();
    if (!raw) return "";
    // Suppress "zero" placeholder values (common extraction artifact).
    const compact = raw.replace(/[\s,]/g, "").toLowerCase();
    if (compact === "$0.00" || compact === "$0" || compact === "0.00" || compact === "0") return "";
    return raw;
  }, [aiData?.ask]);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "rendering" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const aiProvided = typeof ai !== "undefined";
  const shareIdSafe = typeof shareId === "string" && shareId.trim() ? shareId.trim() : null;
  const canDownload = Boolean(allowDownload && downloadUrl);
  // Important for hydration: do not read/generate botId during render.
  // On the server, `window` is undefined and we'd produce a different `href` than the client.
  const [downloadHref, setDownloadHref] = useState<string | null>(() => {
    if (!canDownload) return null;
    return downloadUrl as string;
  });

  useEffect(() => {
    if (!canDownload) return;
    const href = downloadUrl as string;
    if (!shareIdSafe) {
      setDownloadHref(href);
      return;
    }
    const botId = getOrCreateBotId();
    if (!botId) {
      setDownloadHref(href);
      return;
    }
    const joiner = href.includes("?") ? "&" : "?";
    setDownloadHref(`${href}${joiner}botId=${encodeURIComponent(botId)}`);
  }, [canDownload, downloadUrl, shareIdSafe]);
  const ownerViews = shareContext?.stats?.views ?? 0;
  const ownerPagesViewed = shareContext?.stats?.pagesViewed ?? 0;
  const ownerViewsLabel = `${ownerViews} ${ownerViews === 1 ? "view" : "views"}`;
  const ownerPagesLabel = `${ownerPagesViewed} ${ownerPagesViewed === 1 ? "page" : "pages"}`;
  const categoryLabel =
    aiData?.category
      ? (CATEGORY_LABELS[aiData.category] ?? titleFromEnum(aiData.category))
      : null;
  const canPrev = useMemo(() => pageNumber > 1, [pageNumber]);
  const canNext = useMemo(
    () => (numPages ? pageNumber < numPages : true),
    [numPages, pageNumber],
  );

  const [edgeHint, setEdgeHint] = useState<{ kind: "start" | "end"; visible: boolean }>({
    kind: "start",
    visible: false,
  });
  const edgeHintTimerRef = useRef<number | null>(null);

  const showEdgeHint = useCallback((kind: "start" | "end") => {
    setEdgeHint({ kind, visible: true });
    if (edgeHintTimerRef.current) window.clearTimeout(edgeHintTimerRef.current);
    edgeHintTimerRef.current = window.setTimeout(() => {
      setEdgeHint((prev) => (prev.visible ? { ...prev, visible: false } : prev));
    }, 1100);
  }, []);

  useEffect(() => {
    return () => {
      if (edgeHintTimerRef.current) window.clearTimeout(edgeHintTimerRef.current);
    };
  }, []);

  const goPrev = useCallback(() => {
    setPageNumber((p) => {
      if (p <= 1) {
        showEdgeHint("start");
        return 1;
      }
      return p - 1;
    });
  }, [showEdgeHint]);

  const goNext = useCallback(() => {
    setPageNumber((p) => {
      if (numPages && p >= numPages) {
        showEdgeHint("end");
        return p;
      }
      return p + 1;
    });
  }, [numPages, showEdgeHint]);

  // When we're using the browser's native PDF viewer, force the "single page" slideshow experience.
  // (All/Grid are PDF.js-only features.)
  useEffect(() => {
    if (!useNativePdf) return;
    setViewMode("single");
  }, [useNativePdf]);

  useEffect(() => {
    if (useNativePdf && nativePdfLoaded) markFirstPainted();
  }, [useNativePdf, nativePdfLoaded, markFirstPainted]);

  const nativePdfSrc = useMemo(() => {
    // Chrome's built-in viewer respects these hash params.
    const hash = `page=${pageNumber}&zoom=page-fit&pagemode=none`;
    const base = url.includes("#") ? url.split("#")[0] : url;
    return `${base}#${hash}`;
  }, [pageNumber, url]);

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

    const rafs: number[] = [];
    function measure() {
      // `el` is captured by a closure; TS won't keep the null-narrowing. We already early-returned above.
      const rect = el!.getBoundingClientRect();
      setViewportSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) });
      return rect;
    }

    const ro = new ResizeObserver(() => {
      measure();
    });
    ro.observe(el);

    // Kick once synchronously.
    const first = measure();
    // Safari / some layout cases can report 0x0 on first paint; re-measure for a few frames.
    if (first.width <= 0 || first.height <= 0) {
      let tries = 0;
      const tick = () => {
        tries += 1;
        const r = measure();
        if ((r.width > 0 && r.height > 0) || tries >= 12) return;
        rafs.push(window.requestAnimationFrame(tick));
      };
      rafs.push(window.requestAnimationFrame(tick));
    }

    return () => {
      for (const id of rafs) window.cancelAnimationFrame(id);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;

    const rafs: number[] = [];
    function measure() {
      // `el` is captured by a closure; TS won't keep the null-narrowing. We already early-returned above.
      const rect = el!.getBoundingClientRect();
      setHeaderHeight(Math.floor(rect.height));
      return rect;
    }

    const ro = new ResizeObserver(() => {
      measure();
    });
    ro.observe(el);

    const first = measure();
    if (first.height <= 0) {
      let tries = 0;
      const tick = () => {
        tries += 1;
        const r = measure();
        if (r.height > 0 || tries >= 12) return;
        rafs.push(window.requestAnimationFrame(tick));
      };
      rafs.push(window.requestAnimationFrame(tick));
    }

    return () => {
      for (const id of rafs) window.cancelAnimationFrame(id);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
/**
 * Handle fullscreen change events; updates state (setIsFullscreen); uses setIsFullscreen.
 */

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
/**
 * Load Summary (updates state (setAiData); uses fetch, json, setAiData).
 */

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
        setAiData({ summary: "Summary unavailable." });
      }
    }
    loadSummary();
    return () => {
      cancelled = true;
    };
  }, [aiData, aiOpen, aiProvided]);

  useEffect(() => {
    if (!aiOpen) return;
/**
 * Handle pointer down events; updates state (setAiOpen); uses contains, setAiOpen.
 */


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

  const historyStateRef = useRef<{ cursor: string | null; hasMore: boolean; loading: boolean }>({
    cursor: null,
    hasMore: true,
    loading: false,
  });
  useEffect(() => {
    historyStateRef.current = { cursor: historyCursor, hasMore: historyHasMore, loading: historyLoading };
  }, [historyCursor, historyHasMore, historyLoading]);

  async function loadMoreHistory(reason: "open" | "prefetch" | "scroll") {
    if (!revisionHistoryEnabled) return;
    if (!revisionHistoryUrl) return;
    if (historyStateRef.current.loading) return;
    if (!historyStateRef.current.hasMore) return;

    const reqId = (historyReqIdRef.current += 1);
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutId =
      typeof window !== "undefined" && controller
        ? window.setTimeout(() => {
            try {
              controller.abort();
            } catch {
              // ignore
            }
          }, 10_000)
        : null;

    setHistoryLoading(true);
    setHistoryError(null);

    const limit = historyItems.length ? 18 : 10;
    const cursor = historyStateRef.current.cursor;
    const url = (() => {
      const base = revisionHistoryUrl;
      const joiner = base.includes("?") ? "&" : "?";
      const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      return `${base}${joiner}limit=${encodeURIComponent(String(limit))}${cursorParam}`;
    })();

    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.log("[lnkdrp][share][history] fetch", { reason, reqId, url });
    }

    try {
      const res = await fetchWithTempUser(url, {
        cache: "no-store",
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Request failed (${res.status})`);
      }
      const json = (await res.json().catch(() => null)) as any;
      if (historyReqIdRef.current !== reqId) return;

      const changesRaw = json && typeof json === "object" ? json.changes : null;
      const nextCursorRaw = json && typeof json === "object" ? json.nextCursor : null;

      const nextItems: HistoryItem[] = Array.isArray(changesRaw)
        ? (changesRaw as unknown[])
            .map((c) => {
              if (!c || typeof c !== "object") return null;
              const fromVersion = Number.isFinite((c as any).fromVersion) ? Number((c as any).fromVersion) : null;
              const toVersion = Number.isFinite((c as any).toVersion) ? Number((c as any).toVersion) : null;
              const createdDate = typeof (c as any).createdDate === "string" ? (c as any).createdDate : null;
              const summary = typeof (c as any).summary === "string" ? (c as any).summary : "";
              const pagesRaw = (c as any).pagesThatChanged;
              const pagesThatChanged = Array.isArray(pagesRaw)
                ? (pagesRaw as unknown[])
                    .map((p: any) => {
                      const n =
                        typeof p?.pageNumber === "number" && Number.isFinite(p.pageNumber) ? Math.floor(p.pageNumber) : null;
                      if (!n || n < 1) return null;
                      const s = typeof p?.summary === "string" ? p.summary : "";
                      return { pageNumber: n, summary: s };
                    })
                    .filter((x): x is { pageNumber: number; summary: string } => Boolean(x))
                : [];
              return { fromVersion, toVersion, createdDate, summary: summary.trim(), pagesThatChanged } satisfies HistoryItem;
            })
            .filter(Boolean) as HistoryItem[]
        : [];

      setHistoryItems((prev) => {
        const seen = new Set(prev.map((x) => `${x.toVersion ?? "?"}:${x.createdDate ?? "?"}`));
        const merged = [...prev];
        for (const it of nextItems) {
          const key = `${it.toVersion ?? "?"}:${it.createdDate ?? "?"}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(it);
        }
        return merged;
      });

      const nextCursor = typeof nextCursorRaw === "string" && nextCursorRaw.trim() ? nextCursorRaw.trim() : null;
      setHistoryCursor(nextCursor);
      setHistoryHasMore(Boolean(nextCursor));
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      // Keep wording calm and factual (avoid blame/negativity).
      setHistoryError(message || "Revision history isn’t available right now.");
    } finally {
      if (timeoutId && typeof window !== "undefined") window.clearTimeout(timeoutId);
      setHistoryLoading(false);
    }
  }

  // Ensure first page loads quickly when the user opens History.
  useEffect(() => {
    if (!historyOpen) return;
    if (!revisionHistoryEnabled) return;
    if (historyItems.length) return;
    void loadMoreHistory("open");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyOpen, revisionHistoryEnabled]);

  // Prefetch the first page of history (best-effort) so opening the modal is snappy.
  useEffect(() => {
    if (!revisionHistoryEnabled) return;
    if (!revisionHistoryUrl) return;
    if (historyPrefetchDoneRef.current) return;
    if (historyItems.length) return;
    if (!historyHasMore) return;

    historyPrefetchDoneRef.current = true;
    const run = () => void loadMoreHistory("prefetch");

    if (typeof (window as any)?.requestIdleCallback === "function") {
      (window as any).requestIdleCallback(() => run());
    } else if (typeof window !== "undefined") {
      window.setTimeout(run, 900);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyHasMore, historyItems.length, revisionHistoryEnabled, revisionHistoryUrl]);

  // Infinite scroll: when the sentinel becomes visible, load more.
  useEffect(() => {
    if (!historyOpen) return;
    if (!historyHasMore) return;
    const sentinel = historySentinelRef.current;
    if (!sentinel) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const anyVisible = entries.some((e) => e.isIntersecting);
        if (!anyVisible) return;
        void loadMoreHistory("scroll");
      },
      { threshold: [0, 0.05, 0.2] },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyHasMore, historyOpen]);

  useEffect(() => {
/**
 * Handle key down events; updates state (setAiOpen); uses toLowerCase, goPrev, preventDefault.
 */

    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (target?.isContentEditable) return;

      if (e.key === "ArrowLeft") {
        if (viewMode === "single") {
          goPrev();
          e.preventDefault();
        }
      } else if (e.key === "ArrowRight") {
        if (viewMode === "single") {
          goNext();
          e.preventDefault();
        }
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
    canZoomIn,
    canZoomOut,
    goNext,
    goPrev,
    resetZoom,
    toggleFullscreen,
    viewMode,
    zoomIn,
    zoomOut,
  ]);

  useEffect(() => {
    let cancelled = false;
/**
 * Load (updates state (setStatus, setNumPages, setPageNumber); uses setStatus, getDocument, setNumPages).
 */


    async function load() {
      setStatus({ kind: "loading" });
      try {
        const withBrowserPdfJsEnv = async <T,>(fn: () => Promise<T>): Promise<T> => {
          // PDF.js uses a heuristic (`process + "" === "[object process]"`) to detect Node.
          // Next injects a `process` polyfill in the browser, which can trip that heuristic and
          // send PDF.js down a Node-only codepath (breaking share viewer). Temporarily hide it
          // during module evaluation so PDF.js correctly treats this as a browser env.
          if (typeof window === "undefined") return await fn();
          const g = globalThis as any;
          const p = g.process;
          // If we can't access process, just proceed.
          if (!p || typeof p !== "object") return await fn();

          // First attempt: temporarily replace `globalThis.process` with a "safe" object whose
          // stringification cannot be mistaken for real Node.js. This is more robust than
          // patching Symbol.toStringTag/toString when those fields are non-writable.
          let restoredGlobalProcess = false;
          const hadOwnProcess = Object.prototype.hasOwnProperty.call(g, "process");
          let prevProcessDesc: PropertyDescriptor | undefined;
          try {
            prevProcessDesc = Object.getOwnPropertyDescriptor(g, "process");
          } catch {
            prevProcessDesc = undefined;
          }
          const safeProcess: any = (() => {
            const sp: any = {};
            // Preserve env (NextAuth and other libs may read it on the client).
            if (p.env && typeof p.env === "object") sp.env = p.env;
            if (p.versions && typeof p.versions === "object") sp.versions = p.versions;
            try {
              if (typeof Symbol !== "undefined" && (Symbol as any).toStringTag) {
                sp[(Symbol as any).toStringTag] = "Object";
              }
            } catch {
              // ignore
            }
            try {
              if (typeof Symbol !== "undefined" && (Symbol as any).toPrimitive) {
                sp[(Symbol as any).toPrimitive] = () => "[object Object]";
              }
            } catch {
              // ignore
            }
            sp.toString = () => "[object Object]";
            return sp;
          })();

          const restoreGlobalProcess = () => {
            if (restoredGlobalProcess) return;
            restoredGlobalProcess = true;
            try {
              if (prevProcessDesc && prevProcessDesc.configurable) {
                Object.defineProperty(g, "process", prevProcessDesc);
                return;
              }
            } catch {
              // ignore
            }
            try {
              // Best-effort restore by assignment.
              g.process = p;
              return;
            } catch {
              // ignore
            }
            try {
              // If it wasn't an own prop before, try to remove any temporary one we created.
              if (!hadOwnProcess) delete g.process;
            } catch {
              // ignore
            }
          };

          let replacedGlobalProcess = false;
          try {
            // If writable (or setter-backed), assignment is the least invasive path.
            g.process = safeProcess;
            replacedGlobalProcess = true;
          } catch {
            // ignore
          }
          if (!replacedGlobalProcess && prevProcessDesc?.configurable) {
            try {
              Object.defineProperty(g, "process", {
                value: safeProcess,
                configurable: true,
                writable: true,
                enumerable: prevProcessDesc.enumerable ?? false,
              });
              replacedGlobalProcess = true;
            } catch {
              // ignore
            }
          }
          if (replacedGlobalProcess) {
            try {
              return await fn();
            } finally {
              restoreGlobalProcess();
            }
          }

          const symToStringTag = typeof Symbol !== "undefined" ? (Symbol as any).toStringTag : null;
          const symToPrimitive = typeof Symbol !== "undefined" ? (Symbol as any).toPrimitive : null;

          const hadOwnTag = symToStringTag ? Object.prototype.hasOwnProperty.call(p, symToStringTag) : false;
          const prevTag = symToStringTag ? p[symToStringTag] : undefined;

          const hadOwnToPrimitive = symToPrimitive ? Object.prototype.hasOwnProperty.call(p, symToPrimitive) : false;
          const prevToPrimitive = symToPrimitive ? p[symToPrimitive] : undefined;

          const hadOwnToString = Object.prototype.hasOwnProperty.call(p, "toString");
          const prevToString = p.toString;

          let patched = false;
          try {
            try {
              // Make `process + ""` NOT equal "[object process]" during import.
              // This preserves process.env for NextAuth while preventing PDF.js from taking a Node path.
              if (symToStringTag) {
                try {
                  p[symToStringTag] = "Object";
                  patched = true;
                } catch {
                  // ignore
                }
              }
              if (symToPrimitive) {
                try {
                  // Ensure ToPrimitive doesn't return "[object process]" via a custom @@toPrimitive.
                  p[symToPrimitive] = () => "[object Object]";
                  patched = true;
                } catch {
                  // ignore
                }
              }
              try {
                // Avoid binding Object.prototype.toString (some polyfills mark toString non-writable);
                // just provide a simple string primitive.
                p.toString = () => "[object Object]";
                patched = true;
              } catch {
                // ignore
              }
            } catch {
              // ignore (non-writable)
            }
            return await fn();
          } finally {
            if (patched) {
              try {
                if (symToStringTag) {
                  try {
                    if (hadOwnTag) p[symToStringTag] = prevTag;
                    else delete p[symToStringTag];
                  } catch {
                    // ignore
                  }
                }
                if (symToPrimitive) {
                  try {
                    if (hadOwnToPrimitive) p[symToPrimitive] = prevToPrimitive;
                    else delete p[symToPrimitive];
                  } catch {
                    // ignore
                  }
                }
                try {
                  if (hadOwnToString) p.toString = prevToString;
                  else delete p.toString;
                } catch {
                  // ignore
                }
              } catch {
                // ignore
              }
            }
          }
        };

        // Prefer the bundler entry (it wires up the worker automatically),
        // In Next/Webpack dev we've seen `pdfjs-dist`'s ESM bundles blow up during import with
        // `Object.defineProperty called on non-object`. To avoid bundler transforms entirely,
        // we vendor the official ESM bundles into `/public/pdfjs/*` and import them at runtime.
        //
        // This restores the in-app viewer modes ("All pages" slide scrolling) instead of falling
        // back to the browser's native PDF viewer.
        const tryLoad = async (mode: "public-esm" | "public-esm-no-worker") => {
          const pdfJsModuleUrl = "/pdfjs/pdf.min.mjs";
          const pdfjs = await withBrowserPdfJsEnv(
            () => import(/* webpackIgnore: true */ pdfJsModuleUrl) as Promise<any>,
          );

          // Wire up the module worker (once) so rendering stays fast.
          if (mode === "public-esm" && typeof window !== "undefined" && "Worker" in window) {
            try {
              const g = globalThis as any;
              if (!g.__lnkdrpPdfJsWorkerPort) {
                g.__lnkdrpPdfJsWorkerPort = new Worker("/pdfjs/pdf.worker.min.mjs", {
                  type: "module",
                });
              }
              if ((pdfjs as any).GlobalWorkerOptions) {
                (pdfjs as any).GlobalWorkerOptions.workerPort = g.__lnkdrpPdfJsWorkerPort;
              }
            } catch {
              // If worker setup fails, we can still try a worker-less load below.
            }
          }

          const loadingTask =
            mode === "public-esm"
              ? (pdfjs as any).getDocument({ url })
              : (pdfjs as any).getDocument({ url, disableWorker: true } as any);
          return (await loadingTask.promise) as PdfDoc;
        };

        let pdf: PdfDoc;
        try {
          pdf = await tryLoad("public-esm");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e ?? "");
          const stack = e instanceof Error ? e.stack : null;
          // eslint-disable-next-line no-console
          console.warn("[lnkdrp][pdf] pdf.js load failed (public-esm)", { msg, stack });
          // Known dev-time failure mode where the bundler entry can throw.
          if (/defineProperty/i.test(msg) || /non-?object/i.test(msg)) {
            try {
              pdf = await tryLoad("public-esm-no-worker");
            } catch (e2) {
              const msg2 = e2 instanceof Error ? e2.message : String(e2 ?? "");
              const stack2 = e2 instanceof Error ? e2.stack : null;
              // eslint-disable-next-line no-console
              console.warn("[lnkdrp][pdf] pdf.js load failed (public-esm-no-worker)", {
                msg: msg2,
                stack: stack2,
              });
              // eslint-disable-next-line no-console
              console.warn("[lnkdrp][pdf] pdf.js failed; falling back to native PDF viewer", { msg, msg2 });
              setUseNativePdf(true);
              setNativePdfLoaded(false);
              setNativePdfError(null);
              setNumPages(null);
              setStatus({ kind: "idle" });
              return;
            }
          } else {
            // If it's a network/range/authorization issue, surface the original error.
            throw e;
          }
        }
        if (cancelled) return;
        setUseNativePdf(false);
        setNativePdfLoaded(false);
        setNativePdfError(null);
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
  }, [url, reloadKey]);

  useEffect(() => {
    if (!useNativePdf) return;
    setNativePdfLoaded(false);
    setNativePdfError(null);
  }, [useNativePdf, url, reloadKey]);

  useEffect(() => {
    let cancelled = false;
/**
 * Render (updates state (setStatus); uses setStatus, getPage, getViewport).
 */


    async function render() {
      if (viewMode !== "single") return;
      const pdf = pdfRef.current;
      const canvas = canvasRef.current;
      if (!pdf || !canvas) return;
      if (viewportSize.w <= 0 || viewportSize.h <= 0) return;

      setStatus({ kind: "rendering" });
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;

        // Fit-to-viewport (contain): ensure the page fits without scrolling at zoom=1.
        const rotation = normalizePdfRotation(page);
        const base = page.getViewport({ scale: 1, rotation });
        const fitScale = Math.min(viewportSize.w / base.width, viewportSize.h / base.height);
        const viewport = page.getViewport({
          scale: Math.max(0.1, fitScale * zoom),
          rotation,
        });
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D context not available");

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);

        const renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;

        if (cancelled) return;
        markFirstPainted();
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
  }, [pageNumber, pdfVersion, viewportSize.h, viewportSize.w, viewMode, zoom]);

  // "All pages" mode: lazily render visible pages (and neighbors) into canvases as you scroll.
  const allCanvasesRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const allRenderedKeyRef = useRef<Map<number, string>>(new Map());
  const allRenderTasksRef = useRef<Map<number, { key: string; task: { cancel?: () => void; promise: Promise<unknown> } }>>(
    new Map(),
  );
  const visiblePageRatiosRef = useRef<Map<number, number>>(new Map());
  const [visiblePages, setVisiblePages] = useState<number[]>([]);
  const allPagesContainerRef = useRef<HTMLDivElement | null>(null);
  const [allPagesWidth, setAllPagesWidth] = useState(0);

  useEffect(() => {
    if (viewMode !== "all") return;
    if (!numPages || numPages <= 0) return;
    const root = viewportRef.current;
    if (!root) return;

    visiblePageRatiosRef.current = new Map();
    setVisiblePages([]);

    const obs = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const pageStr = (entry.target as HTMLElement).dataset.pageNumber;
          const page = typeof pageStr === "string" ? Number(pageStr) : NaN;
          if (!Number.isFinite(page) || page < 1) continue;
          if (entry.isIntersecting) {
            const prev = visiblePageRatiosRef.current.get(page);
            if (prev !== entry.intersectionRatio) changed = true;
            visiblePageRatiosRef.current.set(page, entry.intersectionRatio);
          } else {
            if (visiblePageRatiosRef.current.has(page)) changed = true;
            visiblePageRatiosRef.current.delete(page);
          }
        }
        if (!changed) return;

        const nextVisible = Array.from(visiblePageRatiosRef.current.keys()).sort((a, b) => a - b);
        setVisiblePages(nextVisible);

        // Choose the "current" page as the most-visible intersecting page.
        let bestPage: number | null = null;
        let bestRatio = -1;
        for (const [p, r] of visiblePageRatiosRef.current.entries()) {
          if (r > bestRatio || (r === bestRatio && (bestPage === null || p < bestPage))) {
            bestRatio = r;
            bestPage = p;
          }
        }
        if (bestPage !== null) setPageNumber(bestPage);
      },
      { root, threshold: [0, 0.05, 0.15, 0.35, 0.6, 0.85] },
    );

    const pageEls = root.querySelectorAll<HTMLElement>("[data-page-number]");
    pageEls.forEach((p) => obs.observe(p));

    return () => obs.disconnect();
  }, [numPages, viewMode]);

  useEffect(() => {
    if (viewMode !== "all") return;
    const el = allPagesContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setAllPagesWidth(Math.floor(rect.width));
    });
    ro.observe(el);
    const rect = el.getBoundingClientRect();
    setAllPagesWidth(Math.floor(rect.width));
    return () => ro.disconnect();
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== "all") return;
    const pdf = pdfRef.current;
    const totalPages = numPages;
    if (!pdf) return;
    if (!totalPages || totalPages <= 0) return;
    const width = allPagesWidth > 0 ? allPagesWidth : viewportSize.w;
    if (width <= 0) return;

    const toRender = new Set<number>();
    for (const p of visiblePages) {
      toRender.add(p);
      toRender.add(p - 1);
      toRender.add(p + 1);
    }
    if (toRender.size === 0) toRender.add(Math.min(Math.max(1, pageNumber), totalPages));

    // Fit pages to the actual all-pages column width (not the full viewport),
    // and account for per-page card padding (p-3).
    const targetWidth = Math.max(1, width - 24);
    let cancelled = false;

    async function renderPage(p: number, doc: PdfDoc, pages: number) {
      if (p < 1 || p > pages) return;
      const canvas = allCanvasesRef.current.get(p);
      if (!canvas) return;

      try {
        const page = await doc.getPage(p);
        if (cancelled) return;

        const rotation = normalizePdfRotation(page);
        const key = `${targetWidth}:${zoom}:${pdfVersion}:${rotation}`;
        const prevKey = allRenderedKeyRef.current.get(p);
        if (prevKey === key) return;

        // Cancel any in-flight render for this page (prevents stale paints when switching modes / resizing).
        const prevTask = allRenderTasksRef.current.get(p);
        if (prevTask) {
          try {
            prevTask.task.cancel?.();
          } catch {
            // ignore
          }
          allRenderTasksRef.current.delete(p);
        }

        const base = page.getViewport({ scale: 1, rotation });
        const fitScale = targetWidth / base.width;
        const viewport = page.getViewport({ scale: Math.max(0.1, fitScale * zoom), rotation });
        const context = canvas.getContext("2d");
        if (!context) return;

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        // Make rendering deterministic even if a canvas was previously painted.
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);

        const renderTask = page.render({ canvasContext: context, viewport }) as unknown as {
          cancel?: () => void;
          promise: Promise<unknown>;
        };
        allRenderTasksRef.current.set(p, { key, task: renderTask });
        await renderTask.promise;
        if (cancelled) return;

        allRenderedKeyRef.current.set(p, key);
        const latest = allRenderTasksRef.current.get(p);
        if (latest?.key === key) allRenderTasksRef.current.delete(p);
      } catch {
        // ignore per-page rendering failures
      }
    }

    for (const p of toRender) void renderPage(p, pdf, totalPages);

    return () => {
      cancelled = true;
      // Best-effort: cancel any in-flight renders started by this effect.
      for (const { task } of allRenderTasksRef.current.values()) {
        try {
          task.cancel?.();
        } catch {
          // ignore
        }
      }
      allRenderTasksRef.current.clear();
    };
  }, [allPagesWidth, numPages, pageNumber, pdfVersion, viewMode, visiblePages, viewportSize.w, zoom]);

  // "Grid" mode: render thumbnail tiles (lazy, visible + neighbors).
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const gridCanvasesRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const gridRenderedKeyRef = useRef<Map<number, string>>(new Map());
  const gridRenderTasksRef = useRef<Map<number, { key: string; task: { cancel?: () => void; promise: Promise<unknown> } }>>(
    new Map(),
  );
  const gridVisibleRatiosRef = useRef<Map<number, number>>(new Map());
  const [gridVisiblePages, setGridVisiblePages] = useState<number[]>([]);

  const gridTileWidth = useMemo(() => {
    const w = gridWidth > 0 ? gridWidth : viewportSize.w;
    if (w <= 0) return 0;
    // Prefer larger thumbnails when space allows (cap columns on wide screens).
    const MIN = 240;
    const GAP = 12;
    const MAX_COLS = 4;
    const cols = Math.min(MAX_COLS, Math.max(1, Math.floor((w + GAP) / (MIN + GAP))));
    const tile = Math.floor((w - GAP * (cols - 1)) / cols);
    return Math.max(110, tile);
  }, [gridWidth, viewportSize.w]);

  useEffect(() => {
    if (viewMode !== "grid") return;
    const el = gridContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setGridWidth(Math.floor(rect.width));
    });
    ro.observe(el);
    const rect = el.getBoundingClientRect();
    setGridWidth(Math.floor(rect.width));
    return () => ro.disconnect();
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== "grid") return;
    if (!numPages || numPages <= 0) return;
    const root = viewportRef.current;
    if (!root) return;

    gridVisibleRatiosRef.current = new Map();
    setGridVisiblePages([]);

    const obs = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const pageStr = (entry.target as HTMLElement).dataset.gridPageNumber;
          const page = typeof pageStr === "string" ? Number(pageStr) : NaN;
          if (!Number.isFinite(page) || page < 1) continue;
          if (entry.isIntersecting) {
            const prev = gridVisibleRatiosRef.current.get(page);
            if (prev !== entry.intersectionRatio) changed = true;
            gridVisibleRatiosRef.current.set(page, entry.intersectionRatio);
          } else {
            if (gridVisibleRatiosRef.current.has(page)) changed = true;
            gridVisibleRatiosRef.current.delete(page);
          }
        }
        if (!changed) return;
        const nextVisible = Array.from(gridVisibleRatiosRef.current.keys()).sort((a, b) => a - b);
        setGridVisiblePages(nextVisible);
      },
      { root, threshold: [0, 0.05, 0.15, 0.35, 0.6] },
    );

    const tiles = root.querySelectorAll<HTMLElement>("[data-grid-page-number]");
    tiles.forEach((t) => obs.observe(t));
    return () => obs.disconnect();
  }, [numPages, viewMode]);

  useEffect(() => {
    if (viewMode !== "grid") return;
    const pdf = pdfRef.current;
    const totalPages = numPages;
    if (!pdf) return;
    if (!totalPages || totalPages <= 0) return;
    if (gridTileWidth <= 0) return;

    const toRender = new Set<number>();
    for (const p of gridVisiblePages) {
      toRender.add(p);
      toRender.add(p - 1);
      toRender.add(p + 1);
    }
    if (toRender.size === 0) {
      // Render the first few thumbnails to avoid an empty grid on load.
      for (let p = 1; p <= Math.min(12, totalPages); p++) toRender.add(p);
    }

    let cancelled = false;

    async function renderThumb(p: number, doc: PdfDoc, pages: number) {
      if (p < 1 || p > pages) return;
      const canvas = gridCanvasesRef.current.get(p);
      if (!canvas) return;

      try {
        const page = await doc.getPage(p);
        if (cancelled) return;
        const rotation = normalizePdfRotation(page);
        const key = `${gridTileWidth}:${zoom}:${pdfVersion}:${rotation}`;
        const prevKey = gridRenderedKeyRef.current.get(p);
        if (prevKey === key) return;

        // Cancel any in-flight render for this thumbnail.
        const prevTask = gridRenderTasksRef.current.get(p);
        if (prevTask) {
          try {
            prevTask.task.cancel?.();
          } catch {
            // ignore
          }
          gridRenderTasksRef.current.delete(p);
        }

        const base = page.getViewport({ scale: 1, rotation });
        const fitScale = gridTileWidth / base.width;
        const viewport = page.getViewport({ scale: Math.max(0.1, fitScale * zoom), rotation });
        const context = canvas.getContext("2d");
        if (!context) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
        const renderTask = page.render({ canvasContext: context, viewport }) as unknown as {
          cancel?: () => void;
          promise: Promise<unknown>;
        };
        gridRenderTasksRef.current.set(p, { key, task: renderTask });
        await renderTask.promise;
        if (cancelled) return;
        gridRenderedKeyRef.current.set(p, key);
        const latest = gridRenderTasksRef.current.get(p);
        if (latest?.key === key) gridRenderTasksRef.current.delete(p);
      } catch {
        // ignore
      }
    }

    for (const p of toRender) void renderThumb(p, pdf, totalPages);

    return () => {
      cancelled = true;
      for (const { task } of gridRenderTasksRef.current.values()) {
        try {
          task.cancel?.();
        } catch {
          // ignore
        }
      }
      gridRenderTasksRef.current.clear();
    };
  }, [gridTileWidth, gridVisiblePages, numPages, pdfVersion, viewMode, zoom]);

  useEffect(() => {
    if (!shareIdSafe) return;
    if (!hasFirstPaint) return;
    const shareId = shareIdSafe;
    shareVisitIdRef.current = getOrCreateShareVisitId(shareId);
    let cancelled = false;
/**
 * Load Context (updates state (setShareContext); uses fetchWithTempUser, catch, json).
 */

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
    scheduleAfterPaint(() => {
      if (!cancelled) void loadContext();
    });
    return () => {
      cancelled = true;
    };
  }, [hasFirstPaint, shareIdSafe]);

  useEffect(() => {
    // Best-effort "time spent" tracking for share pages.
    // We attribute time to the same per-browser botId used for views/pages.
    if (!shareIdSafe) return;
    if (!hasFirstPaint) return;
    const shareId = shareIdSafe;
    const botId = getOrCreateBotId();
    if (!botId) return;
    const visitId = shareVisitIdRef.current ?? getOrCreateShareVisitId(shareId);
    if (!visitId) return;
    shareVisitIdRef.current = visitId;

    function start(now: number) {
      shareTimingEnteredAtMsRef.current = now;
      shareTimingLastFlushAtMsRef.current = 0;
      // Only start page timer if not already started.
      if (!shareTimingPageEnteredAtMsRef.current) shareTimingPageEnteredAtMsRef.current = now;
    }

    function stop() {
      shareTimingEnteredAtMsRef.current = null;
      shareTimingLastFlushAtMsRef.current = 0;
      shareTimingPageEnteredAtMsRef.current = null;
    }

    start(Date.now());

    function flushTime({ includePage }: { includePage: boolean }) {
      const enteredAtMs = shareTimingEnteredAtMsRef.current;
      if (!enteredAtMs) return;
      // Only accumulate while the tab is visible (foreground).
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const now = Date.now();
      // Avoid double-flush storms from multiple lifecycle events.
      if (shareTimingLastFlushAtMsRef.current && now - shareTimingLastFlushAtMsRef.current < 1200) return;
      shareTimingLastFlushAtMsRef.current = now;

      const durationMs = now - enteredAtMs;
      // Ignore extremely short stays.
      if (!Number.isFinite(durationMs) || durationMs < 1500) return;
      // Reset start time so we increment in chunks.
      shareTimingEnteredAtMsRef.current = now;

      const payload: Record<string, unknown> = { botId, visitId, durationMs };
      if (includePage) {
        const p = shareTimingPageRef.current;
        if (typeof p === "number" && Number.isFinite(p) && p >= 1) payload.pageNumber = Math.floor(p);
      }
      void fetchWithTempUser(`/api/share/${shareId}/stats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        keepalive: true,
        body: JSON.stringify(payload),
      }).catch(() => void 0);
    }

    function onVisChange() {
      if (document.visibilityState === "hidden") {
        // Flush any visible time up to this point, then stop timers while hidden.
        // (We intentionally do NOT accumulate hidden time.)
        const enteredAtMs = shareTimingEnteredAtMsRef.current;
        if (enteredAtMs) {
          const now = Date.now();
          const durationMs = now - enteredAtMs;
          if (Number.isFinite(durationMs) && durationMs >= 1500) {
            const payload: Record<string, unknown> = { botId, visitId, durationMs };
            const p = shareTimingPageRef.current;
            if (typeof p === "number" && Number.isFinite(p) && p >= 1) {
              payload.pageNumber = Math.floor(p);
              // Provide best-effort timing bounds so the server can record per-visit page segments.
              payload.enteredAtMs = Math.max(0, Math.floor(now - durationMs));
              payload.leftAtMs = Math.floor(now);
            }
            void fetchWithTempUser(`/api/share/${shareId}/stats`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              keepalive: true,
              body: JSON.stringify(payload),
            }).catch(() => void 0);
          }
        }
        stop();
        return;
      }
      // Visible again: restart timers from now.
      start(Date.now());
    }
    function onPageHide() {
      // Flush only visible time; pagehide typically fires while still visible.
      flushTime({ includePage: true });
      stop();
    }

    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisChange);
    const interval = window.setInterval(() => flushTime({ includePage: true }), 30000);
    return () => {
      // Best-effort on unmount too (route transitions).
      flushTime({ includePage: true });
      stop();
      window.clearInterval(interval);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, [hasFirstPaint, shareIdSafe]);

  useEffect(() => {
    // Keep the "current page" ref in sync for time flushes.
    if (!shareIdSafe) return;
    if (!hasFirstPaint) return;
    shareTimingPageRef.current = pageNumber;
    // If we're visible and the page timer isn't running yet, start it now.
    try {
      if (typeof document !== "undefined" && document.visibilityState === "visible" && !shareTimingPageEnteredAtMsRef.current) {
        shareTimingPageEnteredAtMsRef.current = Date.now();
      }
    } catch {
      // ignore
    }
  }, [hasFirstPaint, pageNumber, shareIdSafe]);

  useEffect(() => {
    // Track per-page dwell time (best-effort): when the page changes, flush time for the previous page.
    if (!shareIdSafe) return;
    if (!hasFirstPaint) return;
    // Only count time while visible.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const shareId = shareIdSafe;
    const botId = getOrCreateBotId();
    if (!botId) return;
    const visitId = shareVisitIdRef.current ?? getOrCreateShareVisitId(shareId);
    if (!visitId) return;
    shareVisitIdRef.current = visitId;

    const prevPage = shareTimingPageRef.current;
    const enteredAt = shareTimingPageEnteredAtMsRef.current;
    const now = Date.now();

    // Initialize on first run.
    if (!enteredAt) {
      shareTimingPageRef.current = pageNumber;
      shareTimingPageEnteredAtMsRef.current = now;
      return;
    }

    if (pageNumber === prevPage) return;

    const durationMs = now - enteredAt;
    if (Number.isFinite(durationMs) && durationMs >= 1500 && Number.isFinite(prevPage) && prevPage >= 1) {
      void fetchWithTempUser(`/api/share/${shareId}/stats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          botId,
          visitId,
          pageNumber: Math.floor(prevPage),
          durationMs,
          enteredAtMs: Math.floor(enteredAt),
          leftAtMs: Math.floor(now),
        }),
      }).catch(() => void 0);
    }

    shareTimingPageRef.current = pageNumber;
    shareTimingPageEnteredAtMsRef.current = now;
  }, [hasFirstPaint, pageNumber, shareIdSafe]);

  useEffect(() => {
    // Public stats collection for share pages:
    // - store a per-browser botId in localStorage
    // - record one "view" per (shareId, botId) server-side
    // - record distinct pages viewed per (shareId, botId) server-side
    if (!shareIdSafe) return;
    if (!hasFirstPaint) return;
    const botId = getOrCreateBotId();
    if (!botId) return;
    const visitId = shareVisitIdRef.current ?? getOrCreateShareVisitId(shareIdSafe);
    if (visitId) shareVisitIdRef.current = visitId;

    const local = readLocalShareStats(shareIdSafe);
    const pagesSeen = new Set<number>(Array.isArray(local.pagesSeen) ? local.pagesSeen : []);

    // Record the view once per browser (localStorage) to reduce spam.
    if (!local.viewedAt) {
      scheduleAfterPaint(() => {
        void fetchWithTempUser(`/api/share/${shareIdSafe}/stats`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ botId, ...(visitId ? { visitId } : {}), pageNumber }),
        }).catch(() => void 0);
      });

      pagesSeen.add(pageNumber);
      writeLocalShareStats(shareIdSafe, {
        viewedAt: Date.now(),
        pagesSeen: Array.from(pagesSeen).sort((a, b) => a - b),
      });
      return;
    }

    // If we've already recorded a view, still record the initial page if it wasn't stored yet.
    if (!pagesSeen.has(pageNumber)) {
      scheduleAfterPaint(() => {
        void fetchWithTempUser(`/api/share/${shareIdSafe}/stats`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ botId, ...(visitId ? { visitId } : {}), pageNumber }),
        }).catch(() => void 0);
      });
      pagesSeen.add(pageNumber);
      writeLocalShareStats(shareIdSafe, {
        viewedAt: local.viewedAt,
        pagesSeen: Array.from(pagesSeen).sort((a, b) => a - b),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFirstPaint, shareIdSafe]);

  useEffect(() => {
    // Record distinct page views as the user navigates.
    if (!shareIdSafe) return;
    if (!hasFirstPaint) return;
    const botId = getOrCreateBotId();
    if (!botId) return;
    const visitId = shareVisitIdRef.current ?? getOrCreateShareVisitId(shareIdSafe);
    if (visitId) shareVisitIdRef.current = visitId;
    const local = readLocalShareStats(shareIdSafe);
    const pagesSeen = new Set<number>(Array.isArray(local.pagesSeen) ? local.pagesSeen : []);
    if (pagesSeen.has(pageNumber)) return;

    scheduleAfterPaint(() => {
      void fetchWithTempUser(`/api/share/${shareIdSafe}/stats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botId, ...(visitId ? { visitId } : {}), pageNumber }),
      }).catch(() => void 0);
    });

    pagesSeen.add(pageNumber);
    writeLocalShareStats(shareIdSafe, {
      viewedAt: local.viewedAt,
      pagesSeen: Array.from(pagesSeen).sort((a, b) => a - b),
    });
  }, [hasFirstPaint, pageNumber, shareIdSafe]);

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
                  aria-label="Summary (generated)"
                  ref={aiButtonRef}
                  onClick={() => {
                    setAiOpen((v) => !v);
                  }}
                  className="inline-flex h-8 items-center rounded-xl px-3 text-xs font-medium text-white/90 hover:bg-white/10"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <SparklesIcon />
                    Summary
                  </span>
                </button>

                {revisionHistoryEnabled ? (
                  <button
                    type="button"
                    aria-label="Revision history"
                    onClick={() => setHistoryOpen(true)}
                    className="inline-flex h-8 items-center rounded-xl px-3 text-xs font-medium text-white/90 hover:bg-white/10"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <HistoryIcon />
                      History
                    </span>
                  </button>
                ) : null}

                {/* Intentionally no share-context badge here; share links are self-evident. */}
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

                {shareIdSafe && !useNativePdf ? (
                  <>
                    <div className="h-8 w-px bg-white/10" aria-hidden="true" />
                    <div
                      className="inline-flex h-8 items-center rounded-xl border border-white/10 bg-white/5 p-0.5"
                      role="group"
                      aria-label="View mode"
                    >
                      <button
                        type="button"
                        aria-label="Single page view"
                        aria-pressed={viewMode === "single"}
                        onClick={() => setViewMode("single")}
                        className={`inline-flex h-7 items-center rounded-lg px-2.5 text-[11px] font-semibold ${
                          viewMode === "single"
                            ? "bg-white/15 text-white"
                            : "text-white/75 hover:bg-white/10 hover:text-white/90"
                        }`}
                        title="Single page"
                      >
                        Single
                      </button>
                      <button
                        type="button"
                        aria-label="All pages view"
                        aria-pressed={viewMode === "all"}
                        onClick={() => setViewMode("all")}
                        className={`inline-flex h-7 items-center rounded-lg px-2.5 text-[11px] font-semibold ${
                          viewMode === "all"
                            ? "bg-white/15 text-white"
                            : "text-white/75 hover:bg-white/10 hover:text-white/90"
                        }`}
                        title="All pages"
                      >
                        All
                      </button>
                      <button
                        type="button"
                        aria-label="Grid overview"
                        aria-pressed={viewMode === "grid"}
                        onClick={() => setViewMode("grid")}
                        className={`inline-flex h-7 items-center rounded-lg px-2.5 text-[11px] font-semibold ${
                          viewMode === "grid"
                            ? "bg-white/15 text-white"
                            : "text-white/75 hover:bg-white/10 hover:text-white/90"
                        }`}
                        title="Grid overview"
                      >
                        Grid
                      </button>
                    </div>
                    <div className="h-8 w-px bg-white/10" aria-hidden="true" />
                  </>
                ) : (
                  <div className="h-8 w-px bg-white/10" aria-hidden="true" />
                )}

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
                  href={(downloadHref ?? (downloadUrl as string)) as string}
                  className="inline-flex h-11 items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 text-xs font-semibold text-white/90 hover:bg-white/10"
                >
                  Download PDF
                </a>
              ) : null}
            </div>
          </div>

        </div>
      </header>

      {/* Summary popover (overlays PDF, aligned with top bar) */}
      {aiOpen ? (
        <>
          {/* Backdrop: gently dim + blur PDF behind the summary */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 right-0 bottom-0 z-30 bg-black/15 backdrop-blur-sm"
            style={{ top: headerHeight }}
          />

          <div
            className="pointer-events-none absolute left-0 right-0 bottom-0 z-40"
            style={{ top: headerHeight }}
          >
            <div className="pointer-events-auto h-full px-3 pt-4 pb-4 sm:px-6 sm:pt-5 sm:pb-6">
            <div
              ref={aiPopoverRef}
              className="max-w-3xl overflow-auto rounded-2xl border border-white/15 bg-black/95 p-7 text-base text-white shadow-2xl ring-1 ring-white/15"
              style={{ maxHeight: `calc(100svh - ${headerHeight}px - 24px)` }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center gap-2 text-sm font-semibold tracking-wide text-white/90">
                  <SparklesIcon />
                  SUMMARY
                  <span className="rounded-md border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/70">
                    Generated
                  </span>
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
                  "Summary unavailable."
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

                      {askText ? (
                        <div className="rounded-lg border-l-2 border-white/25 pl-3">
                          <div className="text-[11px] font-bold uppercase tracking-widest text-white/80">
                            Ask
                          </div>
                          <div className="mt-1 text-white/95">{askText}</div>
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

      <Modal
        open={historyOpen}
        onClose={() => {
          setHistoryOpen(false);
        }}
        ariaLabel="Revision history"
        panelClassName="border-white/15 bg-black/95 text-white ring-white/15"
        contentClassName="px-6 pb-6 pt-5"
      >
        <div className="flex items-center gap-2 text-base font-semibold text-white">
          <HistoryIcon />
          <span>Revision history</span>
        </div>
        <div className="mt-2 text-sm text-white/70">
          A light history of updates (version + date + summary).
        </div>

        {!historyItems.length && historyLoading ? (
          <div className="mt-5 text-sm text-white/80">Loading…</div>
        ) : !historyItems.length && historyError ? (
          <div className="mt-5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {historyError}
          </div>
        ) : historyItems && historyItems.length ? (
          <div className="mt-5 grid gap-3">
            {historyItems.map((h, idx) => (
              <div key={`h:${idx}`} className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-white/70">
                  <span className="rounded-md border border-white/10 bg-black/30 px-2 py-0.5 font-semibold text-white/85">
                    v{h.toVersion ?? "?"}
                  </span>
                  <span className="text-white/50">•</span>
                  <span className="tabular-nums">
                    {h.createdDate ? new Date(h.createdDate).toLocaleString() : "Unknown date"}
                  </span>
                </div>
                <div className="mt-2 text-sm leading-relaxed text-white/92">
                  {h.summary || "Update summary unavailable."}
                </div>

                {Array.isArray(h.pagesThatChanged) && h.pagesThatChanged.length ? (
                  <div className="mt-3 border-t border-white/10 pt-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-white/70">
                      Pages updated
                    </div>
                    <div className="mt-2 grid gap-2">
                      {h.pagesThatChanged.slice(0, 12).map((p) => (
                        <button
                          key={`h:${idx}:p:${p.pageNumber}`}
                          type="button"
                          className="rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-left text-sm text-white/90 hover:bg-black/35"
                          onClick={() => {
                            setPageNumber(p.pageNumber);
                            setViewMode("single");
                            setHistoryOpen(false);
                          }}
                          title={`Jump to page ${p.pageNumber}`}
                        >
                          <div className="text-xs font-semibold text-white/85">Page {p.pageNumber}</div>
                          <div className="mt-0.5 text-sm text-white/80">
                            {(p.summary || "").trim() || "Change summary unavailable."}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}

            {/* Infinite scroll sentinel */}
            <div ref={historySentinelRef} className="h-4" />
            {historyLoading ? <div className="text-sm text-white/70">Loading more…</div> : null}
            {!historyHasMore && !historyLoading ? (
              <div className="text-sm text-white/60">You’ve reached the start of the history.</div>
            ) : null}
          </div>
        ) : (
          <div className="mt-5 text-sm text-white/75">No revisions yet.</div>
        )}
      </Modal>

      {/* Page */}
      <div
        ref={viewportRef}
        className={`relative flex-1 bg-black ${
          viewMode !== "single" ? "overflow-auto" : zoom === 1 ? "overflow-hidden" : "overflow-auto"
        }`}
      >
        {useNativePdf ? (
          <div className="absolute inset-0 z-10">
            <iframe
              title="PDF"
              src={nativePdfSrc}
              className="block h-full w-full border-0"
              allow="fullscreen"
              // Key forces a full reload when toggling fallback / retrying.
              key={`native:${reloadKey}:${nativePdfSrc}`}
              onLoad={() => setNativePdfLoaded(true)}
              onError={() => setNativePdfError("Failed to load PDF in native viewer.")}
            />
            <div className="pointer-events-none absolute left-0 right-0 bottom-0 z-20 p-4">
              <div className="inline-flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-black/70 px-3 py-2 text-xs text-white/80 backdrop-blur-sm">
                <span className="font-semibold text-white/90">Viewer fallback</span>
                <span>Using the browser’s native PDF viewer (pdf.js failed in dev).</span>
                <a
                  className="pointer-events-auto ml-1 rounded-lg border border-white/15 bg-black/40 px-2.5 py-1 font-semibold text-white/90 hover:bg-black/30"
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open PDF directly
                </a>
                <button
                  type="button"
                  className="pointer-events-auto ml-1 rounded-lg bg-white/10 px-2.5 py-1 font-semibold text-white/90 hover:bg-white/15"
                  onClick={() => {
                    setUseNativePdf(false);
                    setReloadKey((k) => k + 1);
                  }}
                >
                  Try pdf.js again
                </button>
              </div>
            </div>
            {!nativePdfLoaded && !nativePdfError ? (
              <div className="absolute inset-0 z-20 grid place-items-center">
                <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/70 px-4 py-3 text-sm text-white/90 shadow-xl backdrop-blur-sm">
                  <div
                    className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white/90"
                    aria-hidden="true"
                  />
                  <div className="font-medium">Loading PDF…</div>
                </div>
              </div>
            ) : null}
            {nativePdfError ? (
              <div className="absolute inset-0 z-30 grid place-items-center px-6">
                <div className="w-full max-w-xl rounded-2xl border border-white/15 bg-black/85 p-6 text-white shadow-2xl backdrop-blur-sm">
                  <div className="text-sm font-semibold">Native viewer failed</div>
                  <div className="mt-2 whitespace-pre-wrap text-sm text-white/80">{nativePdfError}</div>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <a
                      className="inline-flex items-center justify-center rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open PDF directly
                    </a>
                    <button
                      type="button"
                      className="inline-flex items-center justify-center rounded-xl border border-white/15 bg-black/40 px-4 py-2 text-sm font-semibold text-white/90 hover:bg-black/30"
                      onClick={() => setReloadKey((k) => k + 1)}
                    >
                      Retry
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {status.kind === "error" ? (
          <div className="absolute inset-0 z-30 grid place-items-center px-6">
            <div className="w-full max-w-xl rounded-2xl border border-white/15 bg-black/85 p-6 text-white shadow-2xl backdrop-blur-sm">
              <div className="text-sm font-semibold">Failed to load PDF</div>
              <div className="mt-2 whitespace-pre-wrap text-sm text-white/80">{status.message}</div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
                  onClick={() => setReloadKey((k) => k + 1)}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-xl border border-white/15 bg-black/40 px-4 py-2 text-sm font-semibold text-white/90 hover:bg-black/30"
                  onClick={() => window.location.reload()}
                >
                  Reload page
                </button>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-xl border border-white/15 bg-black/40 px-4 py-2 text-sm font-semibold text-white/90 hover:bg-black/30"
                  onClick={() => {
                    setUseNativePdf(true);
                    setStatus({ kind: "idle" });
                  }}
                >
                  Use native viewer
                </button>
                {viewportSize.w <= 0 || viewportSize.h <= 0 ? (
                  <div className="ml-auto text-xs text-white/55">
                    Viewer size: {viewportSize.w}×{viewportSize.h}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {(status.kind === "loading" || (viewMode === "single" && status.kind === "rendering")) ? (
          <div
            aria-live="polite"
            aria-busy="true"
            className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black"
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

        {viewMode === "single" && !useNativePdf ? (
          <div className="grid min-h-full min-w-full place-items-center">
            {/* When zoomed in, allow the canvas to exceed viewport and scroll */}
            <canvas ref={canvasRef} className="block max-h-none max-w-none" />
          </div>
        ) : viewMode === "all" && !useNativePdf ? (
          <div className="min-h-full w-full px-6 py-6">
            <div ref={allPagesContainerRef} className="mx-auto flex w-full max-w-5xl flex-col gap-6">
              {numPages
                ? Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
                    <div
                      key={`page:${p}`}
                      data-page-number={p}
                      className="rounded-2xl border border-white/10 bg-black/40 p-3"
                    >
                      <div className="mb-2 flex items-center justify-between text-xs text-white/70">
                        <span className="tabular-nums">Page {p}</span>
                        <span className="text-white/50">Scroll</span>
                      </div>
                      <div className="grid place-items-center overflow-auto">
                        <canvas
                          ref={(el) => {
                            const m = allCanvasesRef.current;
                            if (!el) {
                              m.delete(p);
                              allRenderedKeyRef.current.delete(p);
                              return;
                            }
                            m.set(p, el);
                          }}
                          className="block max-h-none max-w-none rounded-xl bg-black"
                        />
                      </div>
                    </div>
                  ))
                : null}
            </div>
          </div>
        ) : !useNativePdf ? (
          <div className="min-h-full w-full px-6 py-6">
            <div ref={gridContainerRef} className="w-full">
              <div
                className="grid gap-3"
                style={{
                  gridTemplateColumns:
                    gridTileWidth > 0
                      ? `repeat(auto-fill, minmax(${gridTileWidth}px, 1fr))`
                      : "repeat(auto-fill, minmax(160px, 1fr))",
                }}
              >
                {numPages
                  ? Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
                      <button
                        key={`grid:${p}`}
                        type="button"
                        data-grid-page-number={p}
                        onClick={() => {
                          setPageNumber(p);
                          setViewMode("single");
                        }}
                        className="group relative overflow-hidden rounded-2xl border border-white/10 bg-black/40 p-2 text-left hover:bg-black/35"
                        title={`Open page ${p}`}
                      >
                        <div className="grid place-items-center overflow-hidden rounded-xl bg-black">
                          <canvas
                            ref={(el) => {
                              const m = gridCanvasesRef.current;
                              if (!el) {
                                m.delete(p);
                                gridRenderedKeyRef.current.delete(p);
                                return;
                              }
                              m.set(p, el);
                            }}
                            className="block max-h-none max-w-none"
                          />
                        </div>
                        <div className="pointer-events-none absolute left-2 top-2 inline-flex items-center rounded-md border border-white/10 bg-black/60 px-2 py-1 text-[11px] font-semibold text-white/85">
                          {p}
                        </div>
                        <div className="pointer-events-none absolute inset-0 ring-1 ring-white/0 transition group-hover:ring-white/10" />
                      </button>
                    ))
                  : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="min-h-full" />
        )}

        {/* Hover arrows (centered within PDF viewport) */}
        {viewMode === "single" ? (
          <button
            type="button"
            aria-label="Previous page"
            onClick={goPrev}
            aria-disabled={!canPrev}
            disabled={status.kind === "loading"}
            className={`pointer-events-auto absolute left-4 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/35 text-white/90 opacity-0 shadow-lg backdrop-blur-sm transition-opacity duration-200 hover:bg-black/45 disabled:opacity-0 group-hover:opacity-100 ${
              canPrev ? "" : "text-white/70"
            }`}
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
        ) : null}

        {viewMode === "single" ? (
          <button
            type="button"
            aria-label="Next page"
            onClick={goNext}
            aria-disabled={!canNext}
            disabled={status.kind === "loading"}
            className={`pointer-events-auto absolute right-4 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/35 text-white/90 opacity-0 shadow-lg backdrop-blur-sm transition-opacity duration-200 hover:bg-black/45 disabled:opacity-0 group-hover:opacity-100 ${
              canNext ? "" : "text-white/70"
            }`}
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
        ) : null}

        {/* Edge hint (only when trying to navigate past first/last page) */}
        {viewMode === "single" ? (
          <div
            className={`pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-3.5 py-1.5 text-[12px] font-medium text-white/80 shadow-lg backdrop-blur-sm transition-all duration-200 sm:text-[13px] ${
              edgeHint.visible ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
            }`}
          >
            {edgeHint.kind === "start" ? "First page" : "Last page"}
          </div>
        ) : null}

        {/* Subtle zoom reset overlay (only when zoomed) */}
        {viewMode === "single" && zoom !== 1 ? (
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
/**
 * Render the SparklesIcon UI.
 */


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

function HistoryIcon() {
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
        d="M12 8v4l3 2"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 12a9 9 0 1 0 3-6.7"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 5v4h4"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
/**
 * Render the MinusIcon UI.
 */


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
/**
 * Render the PlusIcon UI.
 */


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
/**
 * Render the FullscreenIcon UI.
 */


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

function LayoutIcon() {
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
        d="M4 5.5C4 4.67 4.67 4 5.5 4h13C19.33 4 20 4.67 20 5.5v13c0 .83-.67 1.5-1.5 1.5h-13C4.67 20 4 19.33 4 18.5v-13Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M4 10h16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M10 10v10"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

