"use client";

/**
 * pdf.js switches from one streaming download to HTTP range requests when the file is at least twice
 * this size. The default (64 KB) makes every share open fetch the PDF twice (full request aborted,
 * then ranges). 4 MB keeps documents under 8 MB to a single request; larger ones still range-load.
 */
const PDF_RANGE_CHUNK_BYTES = 4 * 1024 * 1024;

import Image from "next/image";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Modal from "@/components/modals/Modal";
import Markdown from "@/components/Markdown";
import OverflowMenu from "@/components/ui/OverflowMenu";
import BrandHeader from "@/components/BrandHeader";
import { useAuthEnabled } from "@/app/providers";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { getOrCreateBotId } from "@/lib/botId";
import {
  buildSeenPayload,
  buildTimingPayload,
  HEARTBEAT_MS,
  IDLE_CHECK_MS,
  ReadingClock,
  type Flush,
} from "@/lib/share/readingClock";
import { fetchJson } from "@/lib/http/fetchJson";
import { createStatsBeacon } from "@/lib/share/statsBeacon";
import { CATEGORY_LABELS } from "@/lib/ai/constants";
import type { ShareWorkspaceBrand } from "@/lib/share/brand";
import {
  clearShareViewerProfile,
  normalizeShareViewerEmail,
  normalizeShareViewerName,
  readShareViewerProfile,
  readShareViewerProfilePrefill,
  shareBrandOwnerKey,
  writeShareViewerProfile,
  type ShareViewerProfile,
  type ShareViewerScope,
} from "@/lib/share/viewerProfile";

/** What the version-history panel says when we have nothing more specific to tell the reader. */
export const HISTORY_ERROR_FALLBACK = "Version history isn’t available right now.";

/**
 * An error whose message was written here, for the recipient to read.
 *
 * The history drawer used to show whatever text it could get its hands on. `loadMoreHistory` did
 * `throw new Error(await res.text())` on a refusal and the catch set that message straight into the
 * red panel, so a reader whose link was revoked while their tab sat open was shown the literal
 * string `{"error":"Not found"}`. `/s/:shareId/changes` answers JSON for every refusal it has, so
 * the calm sentence sitting next to it as a fallback was unreachable. The browser's own text
 * reached the panel the same way: a dropped connection put `Failed to fetch` there, and the 10s
 * abort below put `The user aborted a request`. A recipient is the one person who cannot ask us
 * what happened, and none of those tell them anything they can act on. Only messages of this type
 * are rendered now; everything else falls back to the sentence above.
 */
export class HistoryMessageError extends Error {}

/**
 * Turn a refusal from `/s/:shareId/changes` into something a recipient can act on.
 *
 * The statuses are the route's own (see its header comment): 404 for a link that is gone, revoked,
 * expired or archived, 403 when history is off for the link or the owner's plan no longer carries
 * it, 401 when the share-auth cookie for a password-gated link has lapsed.
 */
export function historyErrorForStatus(status: number): string {
  if (status === 401) return "This link needs its password again. Reload the page to continue.";
  if (status === 403) return "Version history isn’t available for this document.";
  if (status === 404 || status === 410) return "This link is no longer available.";
  return HISTORY_ERROR_FALLBACK;
}

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
   * The workspace that shared this document, drawn beside our logo in the header. Omitted inside
   * the app (an owner reading their own document already knows whose it is); present on every
   * recipient-facing route.
   */
  workspace?: ShareWorkspaceBrand | null;
  /**
   * Where this document sits, when it was opened from a data room: the room's URL and its name.
   *
   * A recipient who clicks a document out of a data room is one browser-back from the list — and
   * browser-back is exactly what people do not reach for inside a viewer that has taken over the
   * window. Without this, the way back is a guess.
   */
  backHref?: string | null;
  backLabel?: string | null;
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
   * - If omitted (undefined) or provided as null, the viewer shows "Summary unavailable."
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
  /** Releases worker/transport resources for this document (pdf.js `PDFDocumentProxy.destroy`). */
  destroy?: () => Promise<void>;
};

type PdfRenderTask = {
  promise: Promise<unknown>;
  /** Cancels an in-flight render; the task promise rejects with `RenderingCancelledException`. */
  cancel?: () => void;
};

type PdfLoadingTask = {
  promise: Promise<PdfDoc>;
  /** Aborts loading and destroys the underlying document/transport. */
  destroy?: () => Promise<void>;
};

type PdfPage = {
  rotate?: number;
  getViewport: (opts: { scale: number; rotation?: number }) => { width: number; height: number };
  render: (opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
    /**
     * Extra transform applied before the viewport's, as `[a, b, c, d, e, f]`.
     *
     * This is how pdf.js is told to paint into a backing store larger than the CSS box: the canvas
     * is sized in device pixels and the page is scaled up to fill it.
     */
    transform?: number[];
  }) => PdfRenderTask;
};

/**
 * Device pixels per CSS pixel, clamped to something a phone can afford.
 *
 * Every canvas here used to be sized `Math.floor(viewport.width)` — CSS pixels, with no
 * `devicePixelRatio` — so on a Retina laptop or any modern phone the page was rasterised at half
 * the screen's resolution and then stretched: soft text in a product whose whole job is showing
 * someone a document. The clamp is the other half of the trade: the backing store costs the square
 * of this number in memory, so a 3x phone renders at 2x (4x the pixels of before) rather than 9x.
 */
const MAX_CANVAS_PIXEL_RATIO = 2;

/** The tightest canvas area a shipping browser will actually paint (iOS Safari, ~16.7M pixels). */
const MAX_CANVAS_BACKING_PIXELS = 16 * 1024 * 1024;

function canvasPixelRatio(): number {
  if (typeof window === "undefined") return 1;
  const raw = window.devicePixelRatio;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(MAX_CANVAS_PIXEL_RATIO, Math.max(1, raw));
}

/**
 * Size a canvas for a viewport at the current pixel ratio: backing store in device pixels, CSS box
 * in CSS pixels, and the transform pdf.js needs to fill the former.
 *
 * The explicit CSS size is load-bearing beyond sharpness. Without it a canvas lays out at its
 * intrinsic size, so dropping the backing store to 0x0 (which is how a far-offscreen page's memory
 * is released) would collapse its box and yank the scroll position out from under the reader.
 */
function sizeCanvasForViewport(
  canvas: HTMLCanvasElement,
  viewport: { width: number; height: number },
  ratio: number,
): number[] {
  const cssWidth = Math.max(1, Math.floor(viewport.width));
  const cssHeight = Math.max(1, Math.floor(viewport.height));
  /**
   * Browsers cap how big a canvas may be, and go blank rather than complain when you exceed it —
   * iOS Safari at roughly 16.7M device pixels. Zoom already multiplies the page up to 4x, so
   * doubling it again for the pixel ratio has to give way at the top end: a slightly softer page
   * at maximum zoom is a page, and an over-budget canvas is a white rectangle.
   */
  const budget = Math.sqrt(MAX_CANVAS_BACKING_PIXELS / (cssWidth * cssHeight));
  const effective = Math.max(0.1, Math.min(ratio, budget));
  canvas.width = Math.max(1, Math.floor(cssWidth * effective));
  canvas.height = Math.max(1, Math.floor(cssHeight * effective));
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  return [effective, 0, 0, effective, 0, 0];
}

/**
 * How far either side of the visible pages a painted bitmap is kept.
 *
 * Wider than the one-page-either-side that gets rendered, so a reader nudging the scrollbar back
 * and forth across a page boundary does not repaint constantly; grid tiles are a fraction of the
 * size of a full page, and a wide screen shows a lot of them, so that window is much wider.
 */
const ALL_PAGES_KEEP_RADIUS = 3;
const GRID_KEEP_RADIUS = 30;

/**
 * Release the bitmaps of pages that are nowhere near the viewport.
 *
 * "All pages" and "Grid" mount one canvas per page and, until this, never let a painted one go: a
 * 300-page deck kept 300 full-resolution backing stores alive at once, which is hundreds of
 * megabytes and a dead tab — and the device-pixel-ratio fix above multiplies exactly that number.
 * Memory now tracks what is on screen instead of how long the document is. The canvas element and
 * its CSS box stay exactly where they were, so nothing moves under the reader; scrolling back re-
 * renders the page, which is what already happens for one never painted.
 */
function releaseDistantCanvases(
  canvases: Map<number, HTMLCanvasElement>,
  renderedKeys: Map<number, string>,
  tasks: Map<number, { key: string; task: { cancel?: () => void; promise: Promise<unknown> } }>,
  keep: (pageNumber: number) => boolean,
): void {
  for (const [p, canvas] of canvases) {
    if (keep(p)) continue;
    if (canvas.width === 0 && canvas.height === 0) continue;
    const inFlight = tasks.get(p);
    if (inFlight) {
      try {
        inFlight.task.cancel?.();
      } catch {
        // ignore
      }
      tasks.delete(p);
    }
    canvas.width = 0;
    canvas.height = 0;
    renderedKeys.delete(p);
  }
}

/** Return whether a pdf.js error is the expected "render was cancelled" rejection. */
function isRenderingCancelled(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { name?: unknown }).name === "RenderingCancelledException");
}

const SHARE_LOCAL_STATS_PREFIX = "lnkdrp_share_local_stats_v1:";
const SHARE_OWNER_STATS_PREFIX = "lnkdrp_share_owner_stats_v1:";
const SHARE_VISIT_SESSION_PREFIX = "lnkdrp_share_visit_session_v1:";
/**
 * Pages this *visit* has already reported, in sessionStorage.
 *
 * Suppressing a repeat POST is right; suppressing it forever is not. The load POST and the initial
 * page POSTs used to be gated on a localStorage record that survives the visit, so a reader coming
 * back tomorrow sent nothing at load: their `ShareVisit` row only appeared when they turned a page,
 * and a returning reader who read one page and left produced no visit row at all until the 30s
 * heartbeat. A visit is a tab session, so its own storage is where "already reported" belongs.
 */
const SHARE_VISIT_PAGES_PREFIX = "lnkdrp_share_visit_pages_v1:";

/** Pages already reported during this tab session, and whether the load POST has gone out. */
/**
 * What this visit has already reported, keyed by **link and document**.
 *
 * It used to be keyed on the link alone, which is correct for a document link and wrong for a data
 * room: every document in a room is read through the same `shareId`, so opening a second one found
 * `loaded: true` and its pages already "seen", and reported nothing at all. A reader who opened
 * three documents appeared in the metrics having opened one — the bug this key fixes.
 */
function readVisitReported(shareId: string): { loaded: boolean; pages: Set<number> } {
  if (!isBrowser()) return { loaded: false, pages: new Set() };
  try {
    const raw = window.sessionStorage.getItem(`${SHARE_VISIT_PAGES_PREFIX}${shareId}`);
    if (!raw) return { loaded: false, pages: new Set() };
    const parsed = JSON.parse(raw) as unknown;
    const loaded = Boolean(parsed && typeof parsed === "object" && (parsed as { loaded?: unknown }).loaded);
    const pagesRaw = parsed && typeof parsed === "object" ? (parsed as { pages?: unknown }).pages : null;
    const pages = Array.isArray(pagesRaw)
      ? pagesRaw.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 1)
      : [];
    return { loaded, pages: new Set(pages) };
  } catch {
    return { loaded: false, pages: new Set() };
  }
}

/** Persist what this visit has reported. Best-effort: a private window may refuse to store. */
function writeVisitReported(shareId: string, next: { loaded: boolean; pages: Set<number> }): void {
  if (!isBrowser()) return;
  try {
    window.sessionStorage.setItem(
      `${SHARE_VISIT_PAGES_PREFIX}${shareId}`,
      JSON.stringify({ loaded: next.loaded, pages: Array.from(next.pages).sort((a, b) => a - b) }),
    );
  } catch {
    // ignore
  }
}
/**
 * The recipient's volunteered identity now lives in `@/lib/share/viewerProfile`: the data room's
 * front page asks for it too, and both surfaces have to store the same thing under the same key.
 */
type OwnerStats = { views: number; pagesViewed: number };
type ShareContext = { isOwner: boolean; stats?: OwnerStats };

type HistoryItem = {
  fromVersion: number | null;
  toVersion: number | null;
  createdDate: string | null;
  summary: string;
  pagesThatChanged?: Array<{
    pageNumber: number;
    summary: string;
    /** added / removed / replaced, measured from the two renders. Null when it cannot be told. */
    changeKind: "added" | "removed" | "replaced" | null;
    /** What the changed part of the page said before and says now, read off the page by the model. */
    previousWording: string | null;
    newWording: string | null;
    /** One line per marked area of the page. */
    regionNotes: string[];
  }>;
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
  workspace = null,
  backHref = null,
  backLabel = null,
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
  // Pending teardown of the previous document. pdf.js refuses to reuse a shared worker port while a
  // destroy is still in flight, so the next load awaits this before calling `getDocument`.
  const pdfTeardownRef = useRef<Promise<unknown> | null>(null);
  // In-flight single-page render (cancelled on cleanup so page/zoom changes never overlap on one canvas).
  const singleRenderTaskRef = useRef<PdfRenderTask | null>(null);
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
  const clockRef = useRef<{ clock: ReadingClock; send: (flushes: Flush[]) => void } | null>(null);
  /** The retrying sender for this viewer; stopped on unmount so a closed tab holds no timers. */
  const statsBeaconRef = useRef<ReturnType<typeof createStatsBeacon> | null>(null);
  const numPagesRef = useRef<number | null>(null);
  const pageNumberRef = useRef<number>(initialPage);
  const shareVisitIdRef = useRef<string | null>(null);
  const [viewMode, setViewMode] = useState<"single" | "all" | "grid">("single");
  const [aiData] = useState<AiOutput | null>(ai ?? null);
  const [shareContext, setShareContext] = useState<ShareContext | null>(null);
  const authEnabled = useAuthEnabled();
  const [viewerProfile, setViewerProfile] = useState<ShareViewerProfile | null>(null);
  const [introOpen, setIntroOpen] = useState(false);
  const [introName, setIntroName] = useState("");
  const [introEmail, setIntroEmail] = useState("");
  const [introBusy, setIntroBusy] = useState(false);
  const [introError, setIntroError] = useState<string | null>(null);
  // How this visit will read in the owner's analytics, live while the fields are typed.
  const introPreviewName = normalizeShareViewerName(introName) ?? "";
  const introPreviewEmail = normalizeShareViewerEmail(introEmail) ?? "";
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

  const shareIdSafe = typeof shareId === "string" && shareId.trim() ? shareId.trim() : null;

  /**
   * The key this visit's "already reported" state is stored under.
   *
   * A data room's documents all share one `shareId`, so keying on that alone made the second
   * document a visitor opened report nothing: the gate said this visit had already sent its load
   * and its pages. The document id — which is in the PDF URL on a project link,
   * `/p/:shareId/:docId/pdf` — puts each document back in its own bucket.
   */
  const reportKey = useMemo(() => {
    if (!shareIdSafe) return null;
    const match = /\/p\/[^/]+\/([^/?#]+)\//.exec(url ?? "");
    return match?.[1] ? `${shareIdSafe}:${match[1]}` : shareIdSafe;
  }, [shareIdSafe, url]);
  const canDownload = Boolean(allowDownload && downloadUrl);

  /**
   * Who the recipient's volunteered identity belongs to.
   *
   * It used to belong to nobody in particular: one origin-wide localStorage key, replayed onto the
   * very first stats POST of any link this browser opened, including a sender the recipient had
   * never introduced themselves to. The dialog below promises the opposite ("Goes to this
   * document's owner only"), and `/p/`'s LandingBeacon has always behaved — botId and visitId until
   * somebody presses Save. This scopes the stored identity to the sending workspace so the viewer
   * behaves the same way.
   *
   * `ownerKey` is read off the brand payload defensively: `ShareWorkspaceBrand` does not carry a
   * workspace id yet (that is a server-side change, outside this component), and until it does the
   * scope falls back to this link. Falling back costs a recipient one extra introduction across a
   * sender's links; the global key cost them their name on a stranger's.
   */
  const viewerProfileScope: ShareViewerScope = useMemo(
    () => ({ ownerKey: shareBrandOwnerKey(workspace), shareId: shareIdSafe }),
    [workspace, shareIdSafe],
  );

  function applyViewerProfileToStatsPayload(payload: Record<string, unknown>) {
    // Deliberately the scoped read and never the pre-fill: an identity the recipient typed for
    // someone else is a convenience for their fingers, not something to send on their behalf.
    const p = readShareViewerProfile(viewerProfileScope);
    if (p?.email) payload.viewerEmail = p.email;
    if (p?.name) payload.viewerName = p.name;
  }

  /**
   * Open the introduction modal with the fields filled in as far as we honestly can.
   *
   * What this sender has been told wins; failing that, the identity this browser last saved
   * elsewhere, which fills the inputs and nothing else. Until Save is pressed here, the owner is
   * told nothing.
   */
  const openIntro = useCallback(() => {
    setIntroError(null);
    const stored = readShareViewerProfile(viewerProfileScope);
    const prefill = stored ?? readShareViewerProfilePrefill();
    setIntroName(prefill?.name ?? "");
    setIntroEmail(prefill?.email ?? "");
    setIntroOpen(true);
  }, [viewerProfileScope]);

  /**
   * Set once an introduction is stored, turning the modal into a confirmation instead of closing.
   *
   * Closing on save was the entire acknowledgement, which reads as a form that may or may not have
   * worked. Someone who has just chosen to stop being anonymous is owed the other half: what the
   * owner sees now, in the words they typed, before going back to the document.
   */
  const [introSaved, setIntroSaved] = useState<{ name: string | null; email: string } | null>(null);

  const [downloadRequestOpen, setDownloadRequestOpen] = useState(false);
  const [downloadRequestEmail, setDownloadRequestEmail] = useState("");
  const [downloadRequestBusy, setDownloadRequestBusy] = useState(false);
  const [downloadRequestSent, setDownloadRequestSent] = useState(false);
  const [downloadRequestResult, setDownloadRequestResult] = useState<
    "created" | "resent" | "already_requested" | "download_already_enabled" | null
  >(null);
  const [downloadRequestError, setDownloadRequestError] = useState<string | null>(null);
  // Important for hydration: do not read/generate botId during render.
  // On the server, `window` is undefined and we'd produce a different `href` than the client.
  const [downloadHref, setDownloadHref] = useState<string | null>(() => {
    if (!canDownload) return null;
    return downloadUrl as string;
  });

  useEffect(() => {
    if (!shareIdSafe) {
      setViewerProfile(null);
      return;
    }
    // Best-effort: hydrate intro state from localStorage. Scoped, so "Viewing as …" only ever
    // claims an identity this sender has actually been given.
    setViewerProfile(readShareViewerProfile(viewerProfileScope));
  }, [shareIdSafe, viewerProfileScope]);

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
      ? (CATEGORY_LABELS[aiData.category as keyof typeof CATEGORY_LABELS] ?? titleFromEnum(aiData.category))
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
        // The body is ours to read, never the reader's: it is a JSON error object, and it used to
        // be rendered verbatim in the drawer. Status in, sentence out.
        const detail = await res.text().catch(() => "");
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.log("[lnkdrp][share][history] refused", { reason, reqId, status: res.status, detail });
        }
        throw new HistoryMessageError(historyErrorForStatus(res.status));
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
                      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
                      return {
                        pageNumber: n,
                        summary: s,
                        changeKind:
                          p?.changeKind === "added" || p?.changeKind === "removed" || p?.changeKind === "replaced"
                            ? (p.changeKind as "added" | "removed" | "replaced")
                            : null,
                        previousWording: str(p?.previousWording),
                        newWording: str(p?.newWording),
                        regionNotes: Array.isArray(p?.regionNotes)
                          ? (p.regionNotes as unknown[]).filter((x): x is string => typeof x === "string" && Boolean(x.trim()))
                          : [],
                      };
                    })
                    .filter((x): x is NonNullable<HistoryItem["pagesThatChanged"]>[number] => Boolean(x))
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
      // Keep wording calm and factual (avoid blame/negativity), which means only ever showing a
      // sentence written above: `e.message` here belongs to fetch, to the abort, or to the server.
      const message = e instanceof HistoryMessageError ? e.message : "";
      setHistoryError(message || HISTORY_ERROR_FALLBACK);
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
      // Typed as a string, not always one: password managers and autofill dispatch synthetic
      // keydowns with no `key`, and this viewer is the page a recipient opens with whatever
      // extensions they happen to run. Same guard as the ⌘K listener in `src/app/providers.tsx`.
      if (typeof e.key !== "string") return;
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
    // The pdf.js loading task owned by this effect run (destroyed on cleanup, which also destroys the
    // loaded document/transport).
    let activeLoadingTask: PdfLoadingTask | null = null;
    let loadedPdf: PdfDoc | null = null;

    const destroyLoadingTask = (task: PdfLoadingTask | null): Promise<unknown> | null => {
      if (!task || typeof task.destroy !== "function") return null;
      return Promise.resolve()
        .then(() => task.destroy?.())
        .catch(() => undefined);
    };
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

          // Wait for the previous document's teardown to settle: pdf.js throws
          // "the worker is being destroyed" if `getDocument` reuses the shared worker port mid-destroy.
          const pendingTeardown = pdfTeardownRef.current;
          if (pendingTeardown) {
            await pendingTeardown;
            if (pdfTeardownRef.current === pendingTeardown) pdfTeardownRef.current = null;
          }
          if (cancelled) throw new Error("PDF load cancelled");

          // A failed earlier attempt (e.g. worker mode) still owns transport resources; release it
          // before starting the next attempt.
          void destroyLoadingTask(activeLoadingTask);
          const loadingTask = (
            mode === "public-esm"
              ? (pdfjs as any).getDocument({ url, rangeChunkSize: PDF_RANGE_CHUNK_BYTES })
              : (pdfjs as any).getDocument({ url, disableWorker: true, rangeChunkSize: PDF_RANGE_CHUNK_BYTES } as any)
          ) as PdfLoadingTask;
          activeLoadingTask = loadingTask;
          return await loadingTask.promise;
        };

        let pdf: PdfDoc;
        try {
          pdf = await tryLoad("public-esm");
        } catch (e) {
          if (cancelled) return;
          const msg = e instanceof Error ? e.message : String(e ?? "");
          const stack = e instanceof Error ? e.stack : null;
          // eslint-disable-next-line no-console
          console.warn("[lnkdrp][pdf] pdf.js load failed (public-esm)", { msg, stack });
          // Known dev-time failure mode where the bundler entry can throw.
          if (/defineProperty/i.test(msg) || /non-?object/i.test(msg)) {
            try {
              pdf = await tryLoad("public-esm-no-worker");
            } catch (e2) {
              if (cancelled) return;
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
        loadedPdf = pdf;
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
      // Release the previous document (worker transport, page caches) when the URL changes,
      // the user retries, or the viewer unmounts. `loadingTask.destroy()` also destroys the
      // `PDFDocumentProxy` it produced (including a still in-flight load).
      if (loadedPdf && pdfRef.current === loadedPdf) pdfRef.current = null;
      const teardown = destroyLoadingTask(activeLoadingTask);
      activeLoadingTask = null;
      loadedPdf = null;
      if (teardown) {
        const prior = pdfTeardownRef.current;
        pdfTeardownRef.current = prior ? Promise.all([prior, teardown]) : teardown;
      }
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

        // Backing store in device pixels, CSS box in CSS pixels (see `sizeCanvasForViewport`):
        // the fit-to-viewport maths above is unchanged, only the resolution it is painted at.
        const transform = sizeCanvasForViewport(canvas, viewport, canvasPixelRatio());

        const renderTask = page.render({ canvasContext: context, viewport, transform });
        singleRenderTaskRef.current = renderTask;
        try {
          await renderTask.promise;
        } finally {
          if (singleRenderTaskRef.current === renderTask) singleRenderTaskRef.current = null;
        }

        if (cancelled) return;
        markFirstPainted();
        setStatus({ kind: "idle" });
      } catch (e: unknown) {
        if (cancelled) return;
        // A cancelled render (page/zoom changed mid-paint) is expected, not an error.
        if (isRenderingCancelled(e)) return;
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
      // Cancel the in-flight render so the next effect run never overlaps it on the same canvas
      // (pdf.js throws "Cannot use the same canvas during multiple render() operations").
      const task = singleRenderTaskRef.current;
      singleRenderTaskRef.current = null;
      if (task) {
        try {
          task.cancel?.();
        } catch {
          // ignore
        }
      }
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

    // Hand back the memory of pages the reader has scrolled well past, before painting the ones
    // they are looking at. Without this a long PDF accumulates one full-resolution bitmap per page
    // for as long as the tab is open, and eventually the tab dies mid-read.
    const keepAnchors = visiblePages.length ? visiblePages : Array.from(toRender);
    if (keepAnchors.length) {
      const keepMin = Math.min(...keepAnchors) - ALL_PAGES_KEEP_RADIUS;
      const keepMax = Math.max(...keepAnchors) + ALL_PAGES_KEEP_RADIUS;
      releaseDistantCanvases(
        allCanvasesRef.current,
        allRenderedKeyRef.current,
        allRenderTasksRef.current,
        (p) => p >= keepMin && p <= keepMax,
      );
    }

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
        // The pixel ratio is part of the key: dragging the window to a screen with a different one
        // (or a released page coming back) has to repaint, not sit there at the old resolution.
        const ratio = canvasPixelRatio();
        const key = `${targetWidth}:${zoom}:${pdfVersion}:${rotation}:${ratio}`;
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

        const transform = sizeCanvasForViewport(canvas, viewport, ratio);
        // Make rendering deterministic even if a canvas was previously painted.
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);

        const renderTask = page.render({ canvasContext: context, viewport, transform }) as unknown as {
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

    // Same bound as "All pages": a thumbnail is small, but one per page of a long deck is not.
    const keepAnchors = gridVisiblePages.length ? gridVisiblePages : Array.from(toRender);
    if (keepAnchors.length) {
      const keepMin = Math.min(...keepAnchors) - GRID_KEEP_RADIUS;
      const keepMax = Math.max(...keepAnchors) + GRID_KEEP_RADIUS;
      releaseDistantCanvases(
        gridCanvasesRef.current,
        gridRenderedKeyRef.current,
        gridRenderTasksRef.current,
        (p) => p >= keepMin && p <= keepMax,
      );
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
        const ratio = canvasPixelRatio();
        const key = `${gridTileWidth}:${zoom}:${pdfVersion}:${rotation}:${ratio}`;
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
        const transform = sizeCanvasForViewport(canvas, viewport, ratio);
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
        const renderTask = page.render({ canvasContext: context, viewport, transform }) as unknown as {
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
  }, [hasFirstPaint, shareIdSafe, reportKey]);

  useEffect(() => {
    numPagesRef.current = numPages;
  }, [numPages]);

  useEffect(() => {
    // Reading time for share pages. The rules (idle cut-off, final flushes, what a segment is) live in
    // `ReadingClock`; this effect only feeds it browser events and posts what it flushes.
    if (!shareIdSafe) return;
    if (!hasFirstPaint) return;
    const shareId = shareIdSafe;
    const botId = getOrCreateBotId();
    if (!botId) return;
    const visitId = shareVisitIdRef.current ?? getOrCreateShareVisitId(shareId);
    if (!visitId) return;
    shareVisitIdRef.current = visitId;

    const clock = new ReadingClock({ now: Date.now(), page: pageNumberRef.current });
    /**
     * Through `createStatsBeacon`, not a bare `fetch`.
     *
     * This used to be `void fetch(...).catch(() => void 0)`, which never read the status — and
     * `ReadingClock` clears its ledger the moment it hands a flush over, so anything the server did
     * not accept was destroyed rather than delayed. Once a rate limiter went in front of the ingest
     * that stopped being theoretical: the limiter is keyed per address, a real audience opens a
     * data room from one office, and what a 429 took was the reading time of the people the deck
     * was actually sent to.
     */
    const beacon = createStatsBeacon(`/api/share/${shareId}/stats`, (body, init) =>
      fetchWithTempUser(`/api/share/${shareId}/stats`, { ...init, body }),
    );
    statsBeaconRef.current = beacon;
    const send = (flushes: Flush[]) => {
      for (const flush of flushes) {
        const payload = buildTimingPayload(flush, { botId, visitId, numPages: numPagesRef.current });
        applyViewerProfileToStatsPayload(payload);
        beacon.send(JSON.stringify(payload));
      }
    };
    clockRef.current = { clock, send };
    // A tab that painted in the background: nothing has elapsed yet, so this only pauses the clock.
    if (document.visibilityState === "hidden") send(clock.hidden(Date.now()));

    let lastPointerMoveAt = 0;
    const onInput = () => clock.input(Date.now());
    const onPointerMove = () => {
      const now = Date.now();
      if (now - lastPointerMoveAt < 1000) return;
      lastPointerMoveAt = now;
      clock.input(now);
    };
    const onVisChange = () => {
      if (document.visibilityState === "hidden") send(clock.hidden(Date.now()));
      else clock.visible(Date.now());
    };
    const onPageHide = () => send(clock.pagehide(Date.now()));

    const passive = { passive: true } as const;
    const captureScroll = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", onInput, passive);
    window.addEventListener("pointermove", onPointerMove, passive);
    window.addEventListener("wheel", onInput, passive);
    window.addEventListener("keydown", onInput, passive);
    window.addEventListener("touchstart", onInput, passive);
    document.addEventListener("scroll", onInput, captureScroll);
    document.addEventListener("visibilitychange", onVisChange);
    window.addEventListener("pagehide", onPageHide);
    const tickInterval = window.setInterval(() => send(clock.tick(Date.now())), IDLE_CHECK_MS);
    const heartbeatInterval = window.setInterval(() => send(clock.heartbeat(Date.now())), HEARTBEAT_MS);
    return () => {
      // The last flush goes out before the beacon stops, so an unmount still reports its reading.
      // It is `keepalive`, so the browser carries it even as the tab goes; what cannot survive is a
      // *retry* of it, which is why the queue is drained rather than replayed.
      send(clock.unmount(Date.now()));
      beacon.stop();
      if (statsBeaconRef.current === beacon) statsBeaconRef.current = null;
      if (clockRef.current?.clock === clock) clockRef.current = null;
      window.clearInterval(tickInterval);
      window.clearInterval(heartbeatInterval);
      window.removeEventListener("pointerdown", onInput);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("wheel", onInput);
      window.removeEventListener("keydown", onInput);
      window.removeEventListener("touchstart", onInput);
      document.removeEventListener("scroll", onInput, true);
      document.removeEventListener("visibilitychange", onVisChange);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [hasFirstPaint, shareIdSafe]);

  useEffect(() => {
    // Set before the guards so the clock starts on the right page once the first paint lands.
    pageNumberRef.current = pageNumber;
    if (!shareIdSafe) return;
    if (!hasFirstPaint) return;
    const current = clockRef.current;
    if (current && pageNumber !== current.clock.snapshot().page) {
      current.send(current.clock.turn(Date.now(), pageNumber));
    }
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

    // Gated on the visit, not on the browser. The server's unique (shareId, botIdHash) index is
    // what stops a repeat view being counted twice, so this gate only saves a request — and paying
    // for it with a missing `ShareVisit` row on every return visit was a bad trade.
    const reported = readVisitReported(reportKey ?? shareIdSafe);
    if (!reported.loaded || !reported.pages.has(pageNumber)) {
      scheduleAfterPaint(() => {
        const payload = buildSeenPayload({ botId, visitId, pageNumber, numPages: numPagesRef.current });
        applyViewerProfileToStatsPayload(payload);
        void fetchWithTempUser(`/api/share/${shareIdSafe}/stats`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }).catch(() => void 0);
      });
      reported.pages.add(pageNumber);
      writeVisitReported(reportKey ?? shareIdSafe, { loaded: true, pages: reported.pages });
      // Kept for anything still reading it; it no longer gates a request.
      const local = readLocalShareStats(shareIdSafe);
      const pagesSeen = new Set<number>(Array.isArray(local.pagesSeen) ? local.pagesSeen : []);
      pagesSeen.add(pageNumber);
      writeLocalShareStats(shareIdSafe, {
        viewedAt: local.viewedAt ?? Date.now(),
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
    // Per visit, for the same reason as the load POST above: a `ShareVisit` row's `pagesSeen` is
    // what "which pages did they read this time" is built from, and gating on a browser-lifetime
    // record meant a returning reader's second visit recorded no pages they had seen before.
    const reported = readVisitReported(reportKey ?? shareIdSafe);
    if (reported.pages.has(pageNumber)) return;

    scheduleAfterPaint(() => {
      const payload = buildSeenPayload({ botId, visitId, pageNumber, numPages: numPagesRef.current });
      applyViewerProfileToStatsPayload(payload);
      void fetchWithTempUser(`/api/share/${shareIdSafe}/stats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => void 0);
    });

    reported.pages.add(pageNumber);
    writeVisitReported(reportKey ?? shareIdSafe, { loaded: true, pages: reported.pages });
    const local = readLocalShareStats(shareIdSafe);
    const pagesSeen = new Set<number>(Array.isArray(local.pagesSeen) ? local.pagesSeen : []);
    pagesSeen.add(pageNumber);
    writeLocalShareStats(shareIdSafe, {
      viewedAt: local.viewedAt ?? Date.now(),
      pagesSeen: Array.from(pagesSeen).sort((a, b) => a - b),
    });
  }, [hasFirstPaint, pageNumber, shareIdSafe]);

  return (
    <div
      ref={containerRef}
      className="group relative flex h-[100svh] w-screen flex-col overflow-hidden bg-black"
    >
      {/* Top bar (fixed layout; does not overlay PDF) */}
      <BrandHeader
        ref={headerRef}
        workspace={workspace}
        left={
          <>
            {backHref ? (
              /* Built like the button groups either side of it — a `p-1.5` shell around an `h-8`
                 row — rather than as a plain `h-9` pill. Every other control on this bar is 46px
                 tall by that arithmetic (32 + 12 padding + 2 border) and this one was 36, which
                 reads as a mistake next to them. Stating the height directly would work until
                 somebody changes the shell padding; sharing the recipe is what keeps them equal.
                 The hover fill moves inside the border for the same reason: that is where
                 Summary's is. */
              <a
                href={backHref}
                className="inline-flex min-w-0 shrink-0 items-center rounded-2xl border border-white/10 bg-white/5 p-1.5 text-white/80 transition-colors hover:text-white"
                title={backLabel ? `Back to ${backLabel}` : "Back"}
              >
                <span className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-xl px-3 text-xs font-medium hover:bg-white/10">
                  <span aria-hidden="true">←</span>
                  <span className="max-w-[160px] truncate">{backLabel || "Back"}</span>
                </span>
              </a>
            ) : null}
              <div className="inline-flex min-w-0 items-center gap-2 rounded-2xl border border-white/10 bg-white/5 p-1.5">
                <button
                  type="button"
                  aria-label="Summary and key points, written by LinkDrop"
                  ref={aiButtonRef}
                  onClick={() => {
                    setAiOpen((v) => !v);
                  }}
                  className="inline-flex h-8 items-center rounded-xl px-3 text-xs font-medium text-white/90 hover:bg-white/10"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <SparklesIcon />
                    {/* Icon-only on phones: with the label the header row runs ~60px wider than a
                        360px screen and this button spills over the page counter next to it. The
                        button's aria-label still names it. */}
                    <span className="hidden sm:inline">Summary</span>
                  </span>
                </button>

                {revisionHistoryEnabled ? (
                  <button
                    type="button"
                    aria-label="Version history"
                    onClick={() => setHistoryOpen(true)}
                    className="hidden h-8 items-center rounded-xl px-3 text-xs font-medium text-white/90 hover:bg-white/10 lg:inline-flex"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <HistoryIcon />
                      History
                    </span>
                  </button>
                ) : null}

                {/* Intentionally no share-context badge here; share links are self-evident. */}
              </div>
          </>
        }
      >
            {/* Right */}
            <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
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

                {/* View mode, zoom and fullscreen: below `lg` these move into the overflow menu
                    below instead of squeezing into this row — at a narrow enough width the row
                    had nowhere left to shrink and started overlapping the pill on the left
                    (reported live: "Summary" and "Single" overlapping at a resized window). `sm`
                    (640px) and `md` (768px) were both tried and measured too low: live screenshots
                    at every width from 640 to 950px kept finding the row still overlapping right
                    up to ~850px on a plain two-digit page count with no viewer name set — and
                    "Viewing as <name>" can run longer than that. `lg` (1024px) has real margin
                    above the worst case actually measured, not just the best case. */}
                <div className="hidden items-center gap-1 lg:flex">
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
              </div>

              {shareIdSafe && !shareContext?.isOwner ? (
                <div className="hidden lg:block">
                  {viewerProfile?.name || viewerProfile?.email ? (
                    <button
                      type="button"
                      className="inline-flex h-[46px] items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 text-xs font-semibold text-white/90 hover:bg-white/10"
                      onClick={openIntro}
                      title="Edit how you appear to the document owner"
                    >
                      Viewing as{" "}
                      <span className="ml-1 max-w-[14ch] truncate text-white">
                        {(viewerProfile?.name ?? viewerProfile?.email ?? "Viewer").trim()}
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex h-[46px] items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 text-xs font-semibold text-white/90 hover:bg-white/10"
                      onClick={openIntro}
                      title="Tell the owner who you are"
                    >
                      Introduce yourself
                    </button>
                  )}
                </div>
              ) : null}

              {/* Mobile-only trigger for everything `hidden sm:*` above: the same controls, same
                  handlers, laid out for a touch target instead of a toolbar pill. Summary and
                  Download PDF stay outside this menu — they are the two things a recipient came
                  here to do, everything folded in here is secondary on a phone. */}
              <div className="lg:hidden">
                <OverflowMenu
                  label="More viewer controls"
                  align="end"
                  panelClassName="fixed z-[1000] w-[252px] rounded-2xl border border-white/10 bg-[#0b0b0c] p-3 text-white shadow-xl"
                >
                  <div className="flex flex-col gap-1">
                    {revisionHistoryEnabled ? (
                      <button
                        type="button"
                        onClick={() => setHistoryOpen(true)}
                        className="flex items-center gap-2 rounded-xl px-2.5 py-2.5 text-left text-sm font-medium text-white/90 hover:bg-white/10"
                      >
                        <HistoryIcon />
                        Version history
                      </button>
                    ) : null}

                    {shareIdSafe && !useNativePdf ? (
                      <div className="py-1">
                        <div className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-white/45">
                          View
                        </div>
                        <div className="inline-flex w-full items-center rounded-xl border border-white/10 bg-white/5 p-0.5" role="group" aria-label="View mode">
                          {(["single", "all", "grid"] as const).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              aria-pressed={viewMode === mode}
                              onClick={() => setViewMode(mode)}
                              className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold capitalize ${
                                viewMode === mode
                                  ? "bg-white/15 text-white"
                                  : "text-white/75 hover:bg-white/10 hover:text-white/90"
                              }`}
                            >
                              {mode}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="py-1">
                      <div className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-white/45">
                        Zoom
                      </div>
                      <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-1 py-1">
                        <button
                          type="button"
                          aria-label="Zoom out"
                          onClick={zoomOut}
                          disabled={!canZoomOut}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-white/90 hover:bg-white/10 disabled:opacity-40"
                        >
                          <MinusIcon />
                        </button>
                        <button
                          type="button"
                          aria-label="Reset zoom"
                          onClick={resetZoom}
                          className="inline-flex h-8 items-center justify-center rounded-lg px-2 text-xs text-white/90 tabular-nums hover:bg-white/10"
                          title="Reset zoom"
                        >
                          {Math.round(zoom * 100)}%
                        </button>
                        <button
                          type="button"
                          aria-label="Zoom in"
                          onClick={zoomIn}
                          disabled={!canZoomIn}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-white/90 hover:bg-white/10 disabled:opacity-40"
                        >
                          <PlusIcon />
                        </button>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={toggleFullscreen}
                      className="flex items-center gap-2 rounded-xl px-2.5 py-2.5 text-left text-sm font-medium text-white/90 hover:bg-white/10"
                    >
                      <FullscreenIcon isFullscreen={isFullscreen} />
                      {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                    </button>

                    {shareIdSafe && !shareContext?.isOwner ? (
                      <button
                        type="button"
                        onClick={openIntro}
                        className="rounded-xl px-2.5 py-2.5 text-left text-sm font-medium text-white/90 hover:bg-white/10"
                      >
                        {viewerProfile?.name || viewerProfile?.email
                          ? `Viewing as ${(viewerProfile?.name ?? viewerProfile?.email ?? "").trim()}`
                          : "Introduce yourself"}
                      </button>
                    ) : null}
                  </div>
                </OverflowMenu>
              </div>

              {shareIdSafe ? (
                canDownload ? (
                  <a
                    href={(downloadHref ?? (downloadUrl as string)) as string}
                    className="inline-flex h-[46px] items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-3 sm:px-4 text-xs font-semibold text-white/90 hover:bg-white/10"
                  >
                    Download PDF
                  </a>
                ) : (
                  <button
                    type="button"
                    className="inline-flex h-[46px] items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-3 sm:px-4 text-xs font-semibold text-white/90 hover:bg-white/10"
                    onClick={() => {
                      setDownloadRequestOpen(true);
                      setDownloadRequestSent(false);
                      setDownloadRequestResult(null);
                      setDownloadRequestError(null);
                    }}
                  >
                    Download PDF
                  </button>
                )
              ) : null}
            </div>
      </BrandHeader>

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
                    Written by LinkDrop
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
                ) : (
                  "Summary unavailable."
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
        open={introOpen}
        onClose={() => {
          if (introBusy) return;
          setIntroOpen(false);
          setIntroError(null);
          setIntroSaved(null);
        }}
        ariaLabel="Introduce yourself"
        panelClassName="w-[min(680px,calc(100vw-32px))] border-white/15 bg-black/95 text-white ring-white/15"
        contentClassName="px-6 pb-6 pt-5"
      >
        {introSaved ? (
          <>
            <div className="pr-10">
              <div className="text-base font-semibold text-white">Thank you</div>
              <div className="mt-2 text-sm leading-6 text-white/70">
                The owner of this document can see who is reading it now. The pages you open and how
                long you spend on them are attributed to you from here.
              </div>
            </div>

            {/* The same row the form previewed, now as fact. "Saved" on its own does not tell them
                which of the two fields the owner actually sees. */}
            <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/45">You show up as</div>
              <div className="mt-2.5 flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-[13px] font-semibold text-black"
                >
                  {(introSaved.name ?? introSaved.email).trim().charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-white">{introSaved.name || introSaved.email}</div>
                  {introSaved.name ? <div className="truncate text-xs text-white/50">{introSaved.email}</div> : null}
                </div>
              </div>
            </div>

            <div className="mt-4 text-xs leading-5 text-white/55">
              You can change it or clear it any time from &ldquo;Viewing as&rdquo; in the toolbar.
            </div>

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setIntroOpen(false);
                  setIntroError(null);
                  setIntroSaved(null);
                }}
                className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black hover:bg-white/90"
              >
                Back to the document
              </button>
            </div>
          </>
        ) : (
        <>
        {/*
          Why a viewer would bother: the owner sees who each visit belongs to, and an anonymous visit
          is only a number in their analytics — there is nobody to reply to. The preview below shows
          exactly how this visit will read to them, live as the fields are filled in.
        */}
        <div className="pr-10">
          <div className="text-base font-semibold text-white">Introduce yourself</div>
          <div className="mt-2 text-sm leading-6 text-white/70">
            The owner of this document sees who opened it. Right now your visit reads as{" "}
            <span className="font-semibold text-white/90">anonymous</span>: a count on a chart, with nobody to reply to.
            Add your name and they know who was here.
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/45">What the owner sees</div>
          <div className="mt-2.5 flex items-center gap-3">
            <span
              aria-hidden="true"
              className={[
                "grid h-9 w-9 shrink-0 place-items-center rounded-full text-[13px] font-semibold",
                introPreviewName ? "bg-white text-black" : "border border-dashed border-white/25 text-white/40",
              ].join(" ")}
            >
              {introPreviewName ? introPreviewName.trim().charAt(0).toUpperCase() : "?"}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-white">{introPreviewName || "Anonymous viewer"}</div>
              <div className="truncate text-xs text-white/50">
                {introPreviewEmail || "No name, no email: just another view on the chart"}
              </div>
            </div>
          </div>
        </div>

        {introError ? (
          <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {introError}
          </div>
        ) : null}

        <div className="mt-5 grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-white/70" htmlFor="share-intro-name">
              Name (optional)
            </label>
            <input
              id="share-intro-name"
              className="mt-2 w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-white/15"
              placeholder="Your name"
              value={introName}
              onChange={(e) => setIntroName(e.target.value)}
              autoComplete="name"
              disabled={introBusy}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-white/70" htmlFor="share-intro-email">
              Email
            </label>
            <input
              id="share-intro-email"
              type="email"
              inputMode="email"
              className="mt-2 w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-white/15"
              placeholder="you@example.com"
              value={introEmail}
              onChange={(e) => setIntroEmail(e.target.value)}
              autoComplete="email"
              disabled={introBusy}
            />
          </div>
          </div>

          {/* A recipient is someone who sends documents too. Say what an account is for in the
              reader's own terms — one sign-in, then their own links — and name the agent path,
              which is the part no other document link has. Links leave for a public page, so they
              open in a new tab: nobody should lose the document they were reading. */}
          <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <div className="text-[13px] font-semibold text-white">Or use a free lnkdrp account</div>
            <ul className="mt-1.5 grid gap-1 text-xs leading-5 text-white/60">
              <li>Sign in once and every lnkdrp link you open knows you, with no typing.</li>
              <li>Send your own PDFs as links, and see who read them, which pages, and for how long.</li>
              <li>
                Or let an AI agent do it: Claude, Cursor and other MCP clients can create links and read the stats for you.{" "}
                <a
                  href="/mcp"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-white/80 underline underline-offset-2 hover:text-white"
                >
                  How that works
                </a>
              </li>
            </ul>
          </div>

          <ul className="grid gap-1.5 text-xs leading-5 text-white/60">
            <li className="flex gap-2">
              <span aria-hidden="true" className="text-white/35">·</span>
              <span>Goes to this document&apos;s owner only, with the pages you read. It is never published on the page.</span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true" className="text-white/35">·</span>
              <span>They can reply to you about this document, and send you a newer version when it changes.</span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true" className="text-white/35">·</span>
              <span>Change it or clear it any time from &ldquo;Viewing as&rdquo; in the toolbar.</span>
            </li>
          </ul>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {viewerProfile?.name || viewerProfile?.email ? (
              <button
                type="button"
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-60"
                disabled={introBusy}
                onClick={() => {
                  clearShareViewerProfile(viewerProfileScope);
                  setViewerProfile(null);
                  setIntroName("");
                  setIntroEmail("");
                  setIntroError(null);
                  setIntroOpen(false);
                }}
              >
                Clear
              </button>
            ) : (
              <button
                type="button"
                className="rounded-xl px-2 py-2.5 text-sm font-medium text-white/50 hover:text-white/80 disabled:opacity-60"
                disabled={introBusy}
                onClick={() => {
                  setIntroOpen(false);
                  setIntroError(null);
                }}
              >
                Stay anonymous
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {authEnabled ? (
              <button
                type="button"
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-60"
                disabled={introBusy}
                onClick={() => {
                  if (introBusy) return;
                  // Best-effort: authenticate; share pages are still readable without sign-in.
                  void signIn("google", {
                    callbackUrl:
                      typeof window !== "undefined"
                        ? `${window.location.pathname}${window.location.search}${window.location.hash}`
                        : "/",
                  });
                }}
              >
                Sign in with Google
              </button>
            ) : null}

            <button
              type="button"
              className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black shadow-sm transition hover:bg-white/90 disabled:opacity-70"
              disabled={introBusy}
              aria-busy={introBusy}
              onClick={() => {
                if (introBusy) return;
                const email = normalizeShareViewerEmail(introEmail) ?? "";
                const name = normalizeShareViewerName(introName);
                if (!email) {
                  setIntroError("Please enter a valid email.");
                  return;
                }
                setIntroBusy(true);
                setIntroError(null);

                // Persist locally immediately (best-effort).
                writeShareViewerProfile(viewerProfileScope, { name, email });
                const stored = readShareViewerProfile(viewerProfileScope);
                setViewerProfile(stored);

                // Best-effort: persist to server so owner metrics show it.
                void (async () => {
                  try {
                    if (!shareIdSafe) return;
                    const botId = getOrCreateBotId();
                    if (!botId) return;
                    const visitId = shareVisitIdRef.current ?? getOrCreateShareVisitId(shareIdSafe);
                    if (visitId) shareVisitIdRef.current = visitId;
                    // `introduced` marks *this* post as the act of introducing, as opposed to the
                    // heartbeats that follow, every one of which replays the same stored profile.
                    // The server still decides whether it is news; this only tells it when to ask,
                    // so the check costs nothing on the hot path.
                    const payload: Record<string, unknown> = {
                      botId,
                      ...(visitId ? { visitId } : {}),
                      viewerEmail: email,
                      introduced: true,
                    };
                    if (name) payload.viewerName = name;
                    await fetchWithTempUser(`/api/share/${shareIdSafe}/stats`, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify(payload),
                    });
                  } catch {
                    // ignore (best-effort)
                  } finally {
                    setIntroBusy(false);
                    setIntroSaved({ name: name || null, email });
                  }
                })();
              }}
            >
              Save
            </button>
          </div>
        </div>
        </>
        )}
      </Modal>

      <Modal
        open={historyOpen}
        onClose={() => {
          setHistoryOpen(false);
        }}
        ariaLabel="Version history"
        panelClassName="border-white/15 bg-black/95 text-white ring-white/15"
        contentClassName="px-6 pb-6 pt-5"
      >
        <div className="flex items-center gap-2 text-base font-semibold text-white">
          <HistoryIcon />
          <span>Version history</span>
        </div>
        <div className="mt-2 text-sm text-white/70">
          Versions of this document (version, date and what changed).
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
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold text-white/85">Page {p.pageNumber}</span>
                            {/* Measured from the two renders, so it is the same for every reader. */}
                            {p.changeKind ? (
                              <span
                                className={[
                                  "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                                  p.changeKind === "added"
                                    ? "bg-emerald-400/20 text-emerald-200"
                                    : p.changeKind === "removed"
                                      ? "bg-rose-400/20 text-rose-200"
                                      : "bg-white/10 text-white/80",
                                ].join(" ")}
                              >
                                {p.changeKind === "added" ? "Added" : p.changeKind === "removed" ? "Removed" : "Replaced"}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 text-sm text-white/80">
                            {(p.summary || "").trim() || "Change summary unavailable."}
                          </div>

                          {/*
                            The words themselves, where the compare could read them. A recipient
                            asking what changed wants the sentence, not a page number - and this is
                            text, so it carries none of the blob-URL exposure that keeps the page
                            images on the owner's side for now.
                          */}
                          {p.previousWording || p.newWording ? (
                            <div className="mt-2 space-y-1">
                              {p.previousWording ? (
                                <div className="rounded-md bg-rose-400/10 px-2 py-1 text-xs leading-relaxed text-rose-100/90">
                                  <span className="mr-1 font-semibold uppercase tracking-wide text-rose-200/70">Before</span>
                                  {p.previousWording}
                                </div>
                              ) : null}
                              {p.newWording ? (
                                <div className="rounded-md bg-emerald-400/10 px-2 py-1 text-xs leading-relaxed text-emerald-100/90">
                                  <span className="mr-1 font-semibold uppercase tracking-wide text-emerald-200/70">Now</span>
                                  {p.newWording}
                                </div>
                              ) : null}
                            </div>
                          ) : null}

                          {/* Only where they say something the page summary does not. */}
                          {p.regionNotes.length > 1 ? (
                            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-white/70">
                              {p.regionNotes.slice(0, 3).map((n, i) => (
                                <li key={i}>{n}</li>
                              ))}
                            </ul>
                          ) : null}
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

      <Modal
        open={downloadRequestOpen}
        onClose={() => {
          if (downloadRequestBusy) return;
          setDownloadRequestOpen(false);
          setDownloadRequestError(null);
          setDownloadRequestSent(false);
          setDownloadRequestResult(null);
        }}
        ariaLabel="Request download"
        panelClassName="border-white/15 bg-black/95 text-white ring-white/15"
        contentClassName="px-6 pb-6 pt-5"
      >
        {downloadRequestSent ? (
          <>
            <div className="text-base font-semibold text-white">
              {downloadRequestResult === "already_requested"
                ? "Request already sent"
                : downloadRequestResult === "resent"
                  ? "Request resent"
                : downloadRequestResult === "download_already_enabled"
                  ? "Downloads are enabled"
                  : "Request sent"}
            </div>
            <div className="mt-2 text-sm text-white/70">
              {downloadRequestResult === "already_requested"
                ? "A request for this email is already pending. Please wait a minute and try again if you need to resend."
                : downloadRequestResult === "resent"
                  ? "We resent your request to the owner."
                : downloadRequestResult === "download_already_enabled"
                  ? "This link currently allows downloads. Close this dialog and use the Download button."
                  : "We sent your request to the owner. If it’s approved, you’ll get an email with a link to download or save it to your account (sign-in required)."}
            </div>
            <div className="mt-5 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/85">
              <span className="font-semibold text-white/90">Sent to:</span>{" "}
              <span className="font-mono text-white/85">{downloadRequestEmail.trim() || "your email"}</span>
            </div>
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black shadow-sm transition hover:bg-white/90"
                onClick={() => setDownloadRequestOpen(false)}
              >
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-base font-semibold text-white">Request download</div>
            <div className="mt-2 text-sm text-white/70">
              Downloads are disabled for this link. Enter your email to request access. If approved, you’ll get an email with a link
              to download or save it to your account (sign-in required).
            </div>
            <div className="mt-5">
              <label className="text-xs font-medium text-white/70" htmlFor="download-request-email">
                Email
              </label>
              <input
                id="download-request-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={downloadRequestEmail}
                onChange={(e) => setDownloadRequestEmail(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const email = downloadRequestEmail.trim();
                  if (!email || downloadRequestBusy) return;
                  if (!shareIdSafe) {
                    setDownloadRequestError("Missing share link context.");
                    return;
                  }
                  setDownloadRequestBusy(true);
                  setDownloadRequestError(null);
                  void (async () => {
                    try {
                      const res = await fetchJson<{
                        ok?: boolean;
                        kind?: "created" | "resent" | "already_requested" | "download_already_enabled";
                        retryAfterSeconds?: number;
                      }>(`/api/share/${encodeURIComponent(shareIdSafe)}/download-requests`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ email }),
                      });
                      setDownloadRequestResult(res?.kind ?? "created");
                      setDownloadRequestSent(true);
                    } catch (err) {
                      setDownloadRequestError(err instanceof Error ? err.message : "Failed to request download");
                    } finally {
                      setDownloadRequestBusy(false);
                    }
                  })();
                }}
                disabled={downloadRequestBusy}
                className="mt-2 h-10 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-sm text-white/90 placeholder:text-white/35 focus:outline-none focus:ring-2 focus:ring-white/20 disabled:opacity-60"
              />
            </div>

            {downloadRequestError ? (
              <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                {downloadRequestError}
              </div>
            ) : null}

            <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
              <button
                type="button"
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-60"
                disabled={downloadRequestBusy}
                onClick={() => setDownloadRequestOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black shadow-sm transition hover:bg-white/90 disabled:opacity-70"
                disabled={downloadRequestBusy || !downloadRequestEmail.trim() || !shareIdSafe}
                aria-busy={downloadRequestBusy}
                onClick={() => {
                  const email = downloadRequestEmail.trim();
                  if (!email || downloadRequestBusy) return;
                  if (!shareIdSafe) {
                    setDownloadRequestError("Missing share link context.");
                    return;
                  }
                  setDownloadRequestBusy(true);
                  setDownloadRequestError(null);
                  void (async () => {
                    try {
                      const res = await fetchJson<{
                        ok?: boolean;
                        kind?: "created" | "resent" | "already_requested" | "download_already_enabled";
                        retryAfterSeconds?: number;
                      }>(`/api/share/${encodeURIComponent(shareIdSafe)}/download-requests`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ email }),
                      });
                      setDownloadRequestResult(res?.kind ?? "created");
                      setDownloadRequestSent(true);
                    } catch (err) {
                      setDownloadRequestError(err instanceof Error ? err.message : "Failed to request download");
                    } finally {
                      setDownloadRequestBusy(false);
                    }
                  })();
                }}
              >
                {downloadRequestBusy ? "Sending…" : "Request"}
              </button>
            </div>
          </>
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
              {/* This banner is shown to recipients in production, not to us in dev. It used to say
                  "pdf.js failed in dev" and offer "Try pdf.js again": a stranger who opened a link
                  was handed the name of a library they have never heard of and a claim about an
                  environment they are not in. The document is readable, which is the only thing
                  they need told — plus a way back, because this fallback is often a one-off. */}
              <div className="inline-flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-black/70 px-3 py-2 text-xs text-white/80 backdrop-blur-sm">
                <span className="font-semibold text-white/90">Simplified view</span>
                <span>This document is open in your browser’s own PDF viewer, so some controls are unavailable.</span>
                {/* Only offered when the sender allows downloads, because `/s/:shareId/pdf` refuses
                    exactly this request otherwise. Opening the link in a tab is a top-level
                    navigation, which the browser stamps `sec-fetch-dest: document`, which is what
                    the route's `isRawFileRequest` gate is written to catch. So on the 25-of-28
                    no-download links this button was a new tab containing the two words "Download
                    disabled", with no branding and no way back. A reader whose viewer had just
                    fallen back would have read that as the product breaking twice. `allowDownload`
                    rather than `canDownload` on purpose: this href is the raw file, not
                    `downloadUrl`, and `allowDownload` is the flag the route actually gates on. */}
                {allowDownload ? (
                  <a
                    className="pointer-events-auto ml-1 rounded-lg border border-white/15 bg-black/40 px-2.5 py-1 font-semibold text-white/90 hover:bg-black/30"
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open PDF directly
                  </a>
                ) : null}
                <button
                  type="button"
                  className="pointer-events-auto ml-1 rounded-lg bg-white/10 px-2.5 py-1 font-semibold text-white/90 hover:bg-white/15"
                  onClick={() => {
                    setUseNativePdf(false);
                    setReloadKey((k) => k + 1);
                  }}
                >
                  Try the full viewer
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
                    {/* Same gate as the banner above: on a no-download link this navigation is
                        refused with a bare 403, so offering it here, at the moment the reader
                        has nothing left but this panel, would be the worst place to send them to
                        a blank tab. Asking the sender is the honest alternative on those links. */}
                    {allowDownload ? (
                      <a
                        className="inline-flex items-center justify-center rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open PDF directly
                      </a>
                    ) : shareIdSafe ? (
                      <button
                        type="button"
                        className="inline-flex items-center justify-center rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
                        onClick={() => {
                          setDownloadRequestOpen(true);
                          setDownloadRequestSent(false);
                          setDownloadRequestResult(null);
                          setDownloadRequestError(null);
                        }}
                      >
                        Request download
                      </button>
                    ) : null}
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

        {/* Page arrows (centered within PDF viewport). Always visible at rest so touch and first-time
            viewers see them; brighter on hover. Dimmed, not hidden, at the first/last page. */}
        {viewMode === "single" && (numPages ?? 0) > 1 ? (
          <button
            type="button"
            aria-label="Previous page"
            title="Previous page (←)"
            onClick={goPrev}
            aria-disabled={!canPrev}
            disabled={status.kind === "loading"}
            className={`pointer-events-auto absolute left-4 top-1/2 grid h-14 w-14 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-white opacity-80 shadow-xl ring-1 ring-white/25 backdrop-blur-sm transition duration-200 hover:bg-black/80 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:opacity-0 group-hover:opacity-100 ${
              canPrev ? "" : "text-white/40 ring-white/10"
            }`}
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M15 6L9 12L15 18"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}

        {viewMode === "single" && (numPages ?? 0) > 1 ? (
          <button
            type="button"
            aria-label="Next page"
            title="Next page (→)"
            onClick={goNext}
            aria-disabled={!canNext}
            disabled={status.kind === "loading"}
            className={`pointer-events-auto absolute right-4 top-1/2 grid h-14 w-14 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-white opacity-80 shadow-xl ring-1 ring-white/25 backdrop-blur-sm transition duration-200 hover:bg-black/80 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:opacity-0 group-hover:opacity-100 ${
              canNext ? "" : "text-white/40 ring-white/10"
            }`}
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M9 6L15 12L9 18"
                stroke="currentColor"
                strokeWidth="2.5"
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

