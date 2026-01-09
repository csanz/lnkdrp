"use client";

// Client UI for `/doc/:docId` (owner doc view).

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowPathIcon, ChartBarIcon, FolderIcon, InboxArrowDownIcon, LightBulbIcon } from "@heroicons/react/24/outline";
import UploadButton from "@/components/UploadButton";
import DocSharePanel from "@/components/DocSharePanel";
import TempUserGateModal from "@/components/modals/TempUserGateModal";
import DocActionsMenu from "@/components/DocActionsMenu";
import DocProjectsModal, { type DocProjectListItem } from "@/components/modals/DocProjectsModal";
import { useAuthEnabled, useNavigationLockWhile } from "@/app/providers";
import { fetchJson } from "@/lib/http/fetchJson";
import { apiCreateUpload, startBlobUploadAndProcess } from "@/lib/client/docUploadPipeline";
import { buildPublicReplaceUrl, buildPublicShareUrl } from "@/lib/urls";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import Modal from "@/components/modals/Modal";
import Markdown from "@/components/Markdown";
import { CopyButton } from "@/components/CopyButton";
import {
  isDocStarred,
  STARRED_DOCS_CHANGED_EVENT,
  toggleStarredDoc,
  upsertStarredDocTitle,
} from "@/lib/starredDocs";
import { ACTIVE_ORG_CHANGED_EVENT, getSidebarCacheSnapshot, notifyDocsChanged, setSidebarCacheSnapshot } from "@/lib/sidebarCache";

type DocStatus = "draft" | "preparing" | "ready" | "failed";

type DocDTO = {
  id: string;
  shareId: string | null;
  title: string;
  status: DocStatus;
  projectId?: string | null;
  project?: { id: string; name: string; isRequest?: boolean; requestReviewEnabled?: boolean } | null;
  projectIds?: string[];
  projects?: Array<{ id: string; name: string; slug?: string; isRequest?: boolean; requestReviewEnabled?: boolean }>;
  isArchived?: boolean;
  currentUploadId: string | null;
  currentUploadVersion?: number | null;
  blobUrl: string | null;
  previewImageUrl: string | null;
  extractedText: string | null;
  aiOutput?: unknown | null;
  receiverRelevanceChecklist?: boolean;
  shareAllowPdfDownload?: boolean;
  shareAllowRevisionHistory?: boolean;
  sharePasswordEnabled?: boolean;
  receivedViaRequestProjectId?: string | null;
  replaceUploadToken?: string | null;
  guideForRequestProjectId?: string | null;
  metricsSnapshot?: null | {
    updatedAt: string | null;
    days: number | null;
    lastDaysViews: number;
    lastDaysDownloads: number;
    downloadsTotal: number;
  };
  lastUpdate?: null | {
    version: number | null;
    uploadedAt: string | null;
    uploadedBy:
      | null
      | {
          id: string;
          name: string | null;
          email: string | null;
        };
  };
};

type UploadDTO = {
  id: string;
  version: number | null;
  status: string | null;
  error?: unknown | null;
};
/**
 * Normalize Urlish (uses trim, test).
 */


function normalizeUrlish(v: string | null | undefined): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) return `https://${s}`;
  return s;
}

function pickDocSummary(aiOutput: unknown): {
  companyOrProjectName: string | null;
  oneLiner: string | null;
  summary: string | null;
  ask: string | null;
  tags: string[] | null;
} {
  if (!aiOutput || typeof aiOutput !== "object") {
    return { companyOrProjectName: null, oneLiner: null, summary: null, ask: null, tags: null };
  }
  const ai = aiOutput as Record<string, unknown>;
  const companyOrProjectName =
    typeof ai.company_or_project_name === "string" && ai.company_or_project_name.trim()
      ? ai.company_or_project_name.trim()
      : null;
  const oneLiner = typeof ai.one_liner === "string" && ai.one_liner.trim() ? ai.one_liner.trim() : null;
  const summary = typeof ai.summary === "string" && ai.summary.trim() ? ai.summary.trim() : null;
  const ask = (() => {
    const raw = typeof ai.ask === "string" ? ai.ask.trim() : "";
    if (!raw) return null;
    // Treat "zero" placeholder values as effectively empty. (Common artifact from some summaries.)
    const compact = raw.replace(/[\s,]/g, "").toLowerCase();
    if (compact === "$0.00" || compact === "$0" || compact === "0.00" || compact === "0") return null;
    return raw;
  })();
  const tags = Array.isArray(ai.tags)
    ? ai.tags
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim())
        .slice(0, 12)
    : [];
  return { companyOrProjectName, oneLiner, summary, ask, tags: tags.length ? tags : null };
}

function formatRelativeAge(iso: string): string | null {
  const d = new Date(iso);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  const diffMs = Date.now() - ms;
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs < 30_000) return "just now";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes <= 0) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(diffMs / 86_400_000);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;

  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
/**
 * Build Cached Pdf Iframe Url (uses isFinite, encodeURIComponent, String).
 */


function buildCachedPdfIframeUrl(params: {
  docId: string;
  currentUploadId?: string | null;
  currentUploadVersion?: number | null;
}) {
  // Prefer a stable cache key based on the upload id.
  // This avoids an extra iframe reload at the end when `currentUploadVersion` arrives later.
  const key =
    typeof params.currentUploadId === "string" && params.currentUploadId
      ? params.currentUploadId
      : typeof params.currentUploadVersion === "number" && Number.isFinite(params.currentUploadVersion)
        ? String(params.currentUploadVersion)
        : "0";
  // Versioned URL so the browser can cache indefinitely, and "replace file"
  // forces a new URL (cache miss) automatically.
  return `/api/docs/${encodeURIComponent(params.docId)}/pdf?v=${encodeURIComponent(key)}`;
}
/**
 * Render the DocPageClient UI (uses effects, memoized values, local state).
 */


export default function DocPageClient({ initialDoc }: { initialDoc: DocDTO }) {
  const router = useRouter();
  const authEnabled = useAuthEnabled();
  const [doc, setDoc] = useState<DocDTO>(initialDoc);
  const docRef = useRef<DocDTO>(initialDoc);
  const [currentUpload, setCurrentUpload] = useState<UploadDTO | null>(null);
  const lastResyncUploadIdRef = useRef<string>("");
  const lastDocPollLogKeyRef = useRef<string>("");
  const replacePendingRef = useRef<boolean>(false);
  const [replaceUploadId, setReplaceUploadId] = useState<string | null>(null);
  const [replaceToVersion, setReplaceToVersion] = useState<number | null>(null);
  const [replaceUploadStatus, setReplaceUploadStatus] = useState<string | null>(null);
  const [replaceNotice, setReplaceNotice] = useState<
    | null
    | {
        kind: "success" | "error";
        toVersion: number | null;
        summary: string;
        createdAtMs: number;
      }
  >(null);
  const [highlightVersionLink, setHighlightVersionLink] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState<string>(() => (initialDoc.title || "").toString());
  const [titleSaveBusy, setTitleSaveBusy] = useState(false);
  const [titleSaveError, setTitleSaveError] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [localPreviewUploadId, setLocalPreviewUploadId] = useState<string | null>(null);
  // UX/perf: when a preview image is available, show it first and only load the PDF iframe on intent.
  const [pdfViewerOpen, setPdfViewerOpen] = useState(false);
  const pdfViewerOpenedRef = useRef(false);
  const pdfAutoOpenDeadlineRef = useRef<number | null>(null);
  const [isCopying, setIsCopying] = useState(false);
  const [copyDone, setCopyDone] = useState(false);
  const [replaceIsCopying, setReplaceIsCopying] = useState(false);
  const [replaceCopyDone, setReplaceCopyDone] = useState(false);
  const [preparingTick, setPreparingTick] = useState(0);
  const [hasHydratedFromServer, setHasHydratedFromServer] = useState(false);
  const [hydrateError, setHydrateError] = useState<string | null>(null);
  const [starred, setStarred] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState<boolean | null>(null);
  const [showStarAuthModal, setShowStarAuthModal] = useState(false);
  const [tempGateOpen, setTempGateOpen] = useState(false);
  const shareInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const [showProjectsModal, setShowProjectsModal] = useState(false);
  const isInRequestRepo = useMemo(() => {
    if (Boolean(doc.project?.isRequest)) return true;
    const ps = Array.isArray(doc.projects) ? doc.projects : [];
    return ps.some((p) => Boolean((p as unknown as { isRequest?: unknown }).isRequest));
  }, [doc.project?.isRequest, doc.projects]);
  const isReceivedViaRequest = useMemo(
    // Backward/edge-case friendly: if it’s in a request repo, treat as "received" UI.
    () => Boolean(doc.receivedViaRequestProjectId) || isInRequestRepo,
    [doc.receivedViaRequestProjectId, isInRequestRepo],
  );
  const receivedRequestProjectName = useMemo(() => {
    const pid = doc.receivedViaRequestProjectId;
    if (!pid) {
      // Fall back to primary project name if it's a request repo.
      return Boolean(doc.project?.isRequest) ? (doc.project?.name ?? "") : "";
    }
    const projects = Array.isArray(doc.projects) ? doc.projects : [];
    const match = projects.find((p) => p && typeof p.id === "string" && p.id === pid);
    return match && typeof match.name === "string" ? match.name : "";
  }, [doc.receivedViaRequestProjectId, doc.projects, doc.project?.isRequest, doc.project?.name]);

  const requestProjectId = useMemo(() => {
    const pid = doc.receivedViaRequestProjectId;
    if (pid) return pid;
    if (doc.project?.isRequest && doc.projectId) return doc.projectId;
    return null;
  }, [doc.receivedViaRequestProjectId, doc.project?.isRequest, doc.projectId]);

  // If there's no preview available (or someone deep-links with #page=...), don't block on "open".
  useEffect(() => {
    if (pdfViewerOpen) return;
    if (!doc.blobUrl) return;
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    if (hash && /page=\d+/i.test(hash)) {
      pdfViewerOpenedRef.current = true;
      setPdfViewerOpen(true);
    }
  }, [pdfViewerOpen, doc.blobUrl, doc.previewImageUrl]);

  // Reconcile open/closed state after the real doc data hydrates.
  // The route entrypoint initializes `initialDoc` as a placeholder (no preview/pdf), so we need
  // to decide once `doc.blobUrl` / `doc.previewImageUrl` arrive from `/api/docs/:docId`.
  useEffect(() => {
    if (pdfViewerOpenedRef.current) return;
    if (!doc.blobUrl) return;
    // If a preview exists, default to preview-first (closed).
    if (doc.previewImageUrl && !localPreviewUrl) {
      setPdfViewerOpen(false);
      pdfAutoOpenDeadlineRef.current = null;
      return;
    }
    // If we haven't hydrated yet, don't guess—avoid mounting the iframe early.
    if (!hasHydratedFromServer) return;
    // If there's no preview, wait a beat in case it arrives shortly after the PDF does.
    // This prevents a "flash mount" that starts a PDF fetch and then immediately closes.
    const now = Date.now();
    if (pdfAutoOpenDeadlineRef.current === null) {
      pdfAutoOpenDeadlineRef.current = now + 1500;
      const t = window.setTimeout(() => {
        // Re-check after the grace period.
        if (pdfViewerOpenedRef.current) return;
        if (!docRef.current?.blobUrl) return;
        if (docRef.current?.previewImageUrl) return;
        setPdfViewerOpen(true);
      }, 1550);
      return () => window.clearTimeout(t);
    }
    if (now >= pdfAutoOpenDeadlineRef.current) setPdfViewerOpen(true);
  }, [doc.blobUrl, doc.previewImageUrl, localPreviewUrl, hasHydratedFromServer]);

  const requestReviewEnabledForRequestRepo = useMemo(() => {
    if (!requestProjectId) return false;
    const projects = Array.isArray(doc.projects) ? doc.projects : [];
    const match = projects.find((p) => p && typeof p.id === "string" && p.id === requestProjectId) ?? null;
    if (match) return Boolean((match as unknown as { requestReviewEnabled?: unknown }).requestReviewEnabled);
    // Edge-case fallback: if primary project is the request repo, use it.
    if (doc.project?.id === requestProjectId) {
      return Boolean((doc.project as unknown as { requestReviewEnabled?: unknown }).requestReviewEnabled);
    }
    return false;
  }, [doc.projects, doc.project, requestProjectId]);

  const showRequestIntel = isReceivedViaRequest && requestReviewEnabledForRequestRepo;

  const guideRequestProjectId = useMemo(() => {
    const pid = doc.guideForRequestProjectId;
    return typeof pid === "string" && pid.trim() ? pid.trim() : null;
  }, [doc.guideForRequestProjectId]);

  const guideRequestProjectName = useMemo(() => {
    const pid = guideRequestProjectId;
    if (!pid) return "";
    const projects = Array.isArray(doc.projects) ? doc.projects : [];
    const match = projects.find((p) => p && typeof p.id === "string" && p.id === pid);
    return match && typeof match.name === "string" ? match.name : "";
  }, [guideRequestProjectId, doc.projects]);

  const isOnePager = useMemo(() => {
    const ai = doc.aiOutput && typeof doc.aiOutput === "object" ? (doc.aiOutput as Record<string, unknown>) : null;
    const pageSlugs = ai && Array.isArray(ai.page_slugs) ? (ai.page_slugs as unknown[]) : null;
    if (pageSlugs) return pageSlugs.length <= 2;
    return false;
  }, [doc.aiOutput]);
  // Request review configuration UI (prompt editing/templates) intentionally removed.

  const [qualityReviewOpen, setQualityReviewOpen] = useState(false);
  const [qualityReviewLoading, setQualityReviewLoading] = useState(false);
  const [qualityReviewError, setQualityReviewError] = useState<string | null>(null);
  const [qualityReview, setQualityReview] = useState<null | {
    id: string;
    version: number | null;
    status: string | null;
    model: string | null;
    outputMarkdown: string | null;
    intel?: null | {
      company?: { name?: string | null; url?: string | null } | null;
      contact?: { name?: string | null; email?: string | null; url?: string | null } | null;
      overallAssessment?: string | null;
      effectivenessScore?: number | null;
      scoreRationale?: string | null;
      strengths?: Array<{ title: string; detail?: string | null }>;
      weaknessesAndRisks?: Array<{ title: string; detail?: string | null }>;
      recommendations?: Array<{ title: string; detail?: string | null }>;
      actionItems?: Array<{ title: string; detail?: string | null }>;
      suggestedRewrites?: string | null;
    };
    agentKind?: string | null;
    agentOutput?: null | {
      stage_match?: boolean | null;
      relevancy?: "low" | "medium" | "high" | null;
      notes?: string | null;
      relevancy_reason?: string | null;
      strengths?: string[] | null;
      weaknesses?: string[] | null;
      key_open_questions?: string[] | null;
      founder_note?: string | null;
      summary_markdown?: string | null;
    };
    createdDate: string | null;
    updatedDate: string | null;
  }>(null);

  const reviewRunStatus = (qualityReview?.status ?? "").toLowerCase();
  const [reviewRerunPending, setReviewRerunPending] = useState(false);
  const reviewRerunStartedAtRef = useRef<number | null>(null);
  const reviewRerunPrevUpdatedRef = useRef<string | null>(null);

  // (no per-request prompt editing; behavior is driven by Guide doc + server prompt)

  const preparingStartedAtRef = useRef<number>(Date.now());
  const hasProcessedThisSessionRef = useRef<boolean>(initialDoc.status !== "ready");
  const lastReviewLogKeyRef = useRef<string>("");

  const navLockActive = useMemo(() => {
    // IMPORTANT:
    // This route is client-first and initially renders with a placeholder doc ("preparing")
    // until we hydrate from `/api/docs/:id`. We don't want the sidebar (logo + "Add new")
    // to flash into a disabled/dim state on refresh/navigation during that brief hydrate.
    //
    // Only lock navigation once we have server-backed state that confirms we're actively
    // uploading/processing.
    if (!hasHydratedFromServer) return false;
    // Also lock navigation during a request-doc review rerun so users don't click away mid-run.
    return (
      doc.status === "preparing" ||
      doc.status === "draft" ||
      // Replacement uploads should lock navigation while we upload/process the new version
      // (even though the Doc stays on the last good version until success).
      Boolean(replaceUploadId) ||
      (hasHydratedFromServer &&
        isReceivedViaRequest &&
        doc.status === "ready" &&
        (reviewRerunPending || reviewRunStatus === "queued" || reviewRunStatus === "processing"))
    );
  }, [doc.status, hasHydratedFromServer, isReceivedViaRequest, replaceUploadId, reviewRunStatus, reviewRerunPending]);

  const docSummary = useMemo(() => pickDocSummary(doc.aiOutput ?? null), [doc.aiOutput]);

  // While the doc is uploading/processing, disable all link navigation.
  useNavigationLockWhile(navLockActive);

  useEffect(() => {
    // Reset preparing timer when we enter preparing.
    if (doc.status === "preparing" || doc.status === "draft") {
      hasProcessedThisSessionRef.current = true;
      preparingStartedAtRef.current = Date.now();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.currentUploadId]);

  useEffect(() => {
    // Keep local starred state in sync (this tab + other tabs).
    setStarred(isDocStarred(doc.id));
/**
 * Handle changed events; updates state (setStarred); uses setStarred, isDocStarred.
 */


    function onChanged() {
      setStarred(isDocStarred(doc.id));
    }
/**
 * Handle storage events; uses onChanged.
 */


    function onStorage(e: StorageEvent) {
      // Any localStorage changes from other tabs should trigger a re-check.
      if (e.storageArea !== window.localStorage) return;
      onChanged();
    }

    window.addEventListener(STARRED_DOCS_CHANGED_EVENT, onChanged);
    window.addEventListener(ACTIVE_ORG_CHANGED_EVENT, onChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(STARRED_DOCS_CHANGED_EVENT, onChanged);
      window.removeEventListener(ACTIVE_ORG_CHANGED_EVENT, onChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, [doc.id]);

  // Avoid fetching session during initial paint; we only need it when the user tries to star.
  useEffect(() => {
    if (!authEnabled) setIsSignedIn(null);
  }, [authEnabled]);
/**
 * Handle Toggle Star (updates state (setIsSignedIn, setShowStarAuthModal, setStarred); uses fetch, json, Boolean).
 */


  async function handleToggleStar() {
    // For received/request docs, allow starring even while we lock navigation during processing/review.
    if (navLockActive && !isReceivedViaRequest) return;
    // If auth is enabled, require sign-in to use starring.
    if (authEnabled) {
      let signedIn = isSignedIn;

      // If we don't know yet, fetch once on-demand.
      if (signedIn == null) {
        try {
          const res = await fetch("/api/auth/session", { cache: "no-store" });
          const json = res.ok ? ((await res.json()) as { user?: unknown }) : null;
          signedIn = Boolean(json && typeof json === "object" && (json as { user?: unknown }).user);
          setIsSignedIn(signedIn);
        } catch {
          signedIn = false;
          setIsSignedIn(false);
        }
      }

      if (!signedIn) {
        setShowStarAuthModal(true);
        return;
      }
    }

    const nextTitle = displayDocName || "Document";
    const res = toggleStarredDoc({ id: doc.id, title: nextTitle });
    setStarred(res.starred);
  }

  useEffect(() => {
    if (!(doc.status === "preparing" || doc.status === "draft")) return;
    const id = window.setInterval(() => setPreparingTick((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, [doc.status]);

  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  useEffect(() => {
    // Once the new upload finishes and the server-side preview takes over, drop the local preview.
    if (!localPreviewUrl || !localPreviewUploadId) return;
    if (doc.status !== "ready") return;
    if (doc.currentUploadId !== localPreviewUploadId) return;
    setLocalPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setLocalPreviewUploadId(null);
  }, [doc.status, doc.currentUploadId, localPreviewUrl, localPreviewUploadId]);

  useEffect(() => {
    return () => {
      if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    };
  }, [localPreviewUrl]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;
    let delayMs = 1500;
    let consecutiveNotFound = 0;

    async function refreshOnce(): Promise<boolean> {
      try {
        const qs = new URLSearchParams();
        // Keep the hot polling endpoint lightweight (do not ship full extracted text on every poll).
        qs.set("lite", "1");
        // Debug is intentionally opt-in so it doesn't slow down normal page loads.
        const wantsDebug = (() => {
          try {
            return (
              new URLSearchParams(window.location.search).get("debug") === "1" ||
              window.localStorage.getItem("lnkdrp_debug") === "1"
            );
          } catch {
            return false;
          }
        })();
        if (wantsDebug) qs.set("debug", "1");
        const query = qs.toString() ? `?${qs.toString()}` : "";

        const res = await fetchWithTempUser(`/api/docs/${docRef.current.id}${query}`, { cache: "no-store" });
        if (cancelled) return false;

        if (!res.ok) {
          if (res.status === 404) {
            if (!cancelled) router.replace("/dashboard");
            return false;
          } else {
            // Other transient errors: keep polling slowly.
            delayMs = Math.min(5_000, Math.max(delayMs, 1_200));
          }
          return true;
        }

        consecutiveNotFound = 0;
        delayMs = 900;
        setHydrateError(null);

        const data = (await res.json()) as { doc: DocDTO; upload?: UploadDTO | null };
        if (cancelled) return false;

        // Console breadcrumb (deduped): helps debug "stuck preparing" without guessing.
        const docStatus = (data.doc?.status ?? "").toString();
        const docUploadId = typeof data.doc?.currentUploadId === "string" ? data.doc.currentUploadId : "";
        const docVersion =
          typeof data.doc?.currentUploadVersion === "number" && Number.isFinite(data.doc.currentUploadVersion)
            ? data.doc.currentUploadVersion
            : null;
        const uploadStatus = (data.upload?.status ?? "").toString();
        const uploadId = typeof data.upload?.id === "string" ? data.upload.id : "";
        const uploadVersion =
          typeof data.upload?.version === "number" && Number.isFinite(data.upload.version) ? data.upload.version : null;
        const key = [
          `d:${docStatus}`,
          `dUp:${docUploadId || "—"}`,
          `dV:${docVersion ?? "—"}`,
          `u:${uploadStatus || "—"}`,
          `uId:${uploadId || "—"}`,
          `uV:${uploadVersion ?? "—"}`,
        ].join("|");
        if (key !== lastDocPollLogKeyRef.current) {
          lastDocPollLogKeyRef.current = key;
          // eslint-disable-next-line no-console
          console.log("[lnkdrp][doc] poll", {
            docId: data.doc?.id ?? docRef.current.id,
            docStatus,
            docCurrentUploadId: docUploadId || null,
            docCurrentUploadVersion: docVersion,
            uploadStatus: uploadStatus || null,
            uploadId: uploadId || null,
            uploadVersion,
          });
          // eslint-disable-next-line no-console
          if ((data as any)?.debug?.derived) console.log("[lnkdrp][doc] poll debug", (data as any).debug);
        }

        // Safety net:
        // Sometimes (rarely) the upload pipeline completes but the doc record can remain stuck in
        // `preparing` (e.g. due to an interrupted worker update). For non-request docs, if the
        // current upload is already `completed` but the doc is still `preparing` for a while,
        // re-trigger `/process` to force the route's idempotent "sync doc" path to run.
        //
        // IMPORTANT: do NOT do this for request-received docs, where we intentionally keep the
        // doc in `preparing` while Intel/review runs.
        try {
          const uploadStatus = (data.upload?.status ?? "").toString().toLowerCase();
          const elapsedMs = Date.now() - preparingStartedAtRef.current;
          const serverIsReceivedViaRequest =
            Boolean((data.doc as { receivedViaRequestProjectId?: unknown }).receivedViaRequestProjectId) ||
            Boolean((data.doc as { project?: unknown }).project && (data.doc.project as any)?.isRequest);
          const uploadId = typeof data.upload?.id === "string" ? data.upload.id : "";
          if (
            !serverIsReceivedViaRequest &&
            data.doc.status === "preparing" &&
            uploadStatus === "completed" &&
            elapsedMs > 25_000 &&
            uploadId &&
            uploadId !== lastResyncUploadIdRef.current
          ) {
            lastResyncUploadIdRef.current = uploadId;
            // eslint-disable-next-line no-console
            console.warn("[lnkdrp][doc] resync: upload completed but doc still preparing; re-triggering process", {
              docId: data.doc.id,
              uploadId,
              elapsedMs,
            });
            // Fire and forget; polling will observe the updated doc state.
            void fetchWithTempUser(`/api/uploads/${encodeURIComponent(uploadId)}/process`, { method: "POST" });
          }
        } catch {
          // ignore; best-effort safety net
        }

        // Keep polling even when ready:
        // Stop polling when ready:
        // We only need aggressive polling while the doc is preparing (initial upload or replacement).
        // For "replace file", we keep polling while the replace flow is active (replaceUploadId set).
        const isReady = data.doc.status === "ready" && Boolean(data.doc.shareId);
        delayMs = isReady ? 5_000 : 1500;

        setDoc((prev) => {
          const next = { ...prev, ...data.doc };
          // When processing finishes (or a new version lands), force-refresh the sidebar cache so the
          // updated version badge + timestamps show up immediately.
          if (
            prev.status !== "ready" && next.status === "ready" ||
            (prev.currentUploadId && next.currentUploadId && prev.currentUploadId !== next.currentUploadId)
          ) {
            notifyDocsChanged();
          }
          return next;
        });
        setCurrentUpload(data.upload ?? null);
        setHasHydratedFromServer(true);
        if (isReady && !replaceUploadId) return false;
        return true;
      } catch {
        // Network errors: keep polling but back off a bit.
        delayMs = Math.min(5_000, Math.max(delayMs, 1_500));
        return true;
      }
    }

    async function loop() {
      const shouldContinue = await refreshOnce();
      if (cancelled) return;
      if (!shouldContinue) return;
      timeoutId = window.setTimeout(loop, delayMs);
    }

    void loop();
    return () => {
      cancelled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [doc.id, doc.currentUploadId, replaceUploadId]);

  useEffect(() => {
    const uploadId = replaceUploadId;
    if (!uploadId) return;
    let cancelled = false;
    let intervalId: number | null = null;

    async function poll() {
      try {
        const res = await fetchWithTempUser(`/api/uploads/${encodeURIComponent(uploadId)}`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as any;
        if (cancelled) return;
        const upload = json && typeof json === "object" ? (json as any).upload : null;
        const statusRaw = upload && typeof upload === "object" ? (upload as any).status : null;
        const status = typeof statusRaw === "string" ? statusRaw.toLowerCase() : "";
        setReplaceUploadStatus(status || null);

        if (status === "failed") {
          const msg =
            upload && typeof upload === "object" && (upload as any).error && typeof (upload as any).error.message === "string"
              ? String((upload as any).error.message)
              : "Processing failed. Your existing document was kept.";
          setReplaceNotice({
            kind: "error",
            toVersion: replaceToVersion,
            summary: msg,
            createdAtMs: Date.now(),
          });
          replacePendingRef.current = false;
          setReplaceUploadId(null);
          setReplaceUploadStatus(null);
          // Clear the local preview (it never became a real version).
          setLocalPreviewUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return null;
          });
          setLocalPreviewUploadId(null);
          return;
        }

        if (status === "completed") {
          // Fetch a lightweight change summary (best-effort) for the banner.
          let summary = "";
          if (typeof replaceToVersion === "number" && Number.isFinite(replaceToVersion)) {
            try {
              const changesRes = await fetchWithTempUser(
                `/api/docs/${encodeURIComponent(docRef.current.id)}/changes?lite=1&limit=10`,
                {
                cache: "no-store",
                },
              );
              if (changesRes.ok) {
                const changesJson = (await changesRes.json().catch(() => null)) as any;
                const changes = Array.isArray(changesJson?.changes) ? (changesJson.changes as any[]) : [];
                const match = changes.find((c) => Number(c?.toVersion) === replaceToVersion) ?? null;
                summary = typeof match?.summary === "string" ? match.summary : "";
              }
            } catch {
              // ignore (best-effort)
            }
          }
          const vLabel =
            typeof replaceToVersion === "number" && Number.isFinite(replaceToVersion) ? `Updated to v${replaceToVersion}.` : "Update complete.";
          setReplaceNotice({
            kind: "success",
            toVersion: replaceToVersion,
            summary: summary?.trim() ? summary.trim() : vLabel,
            createdAtMs: Date.now(),
          });
          setHighlightVersionLink(true);
          window.setTimeout(() => setHighlightVersionLink(false), 2600);
          replacePendingRef.current = false;
          setReplaceUploadId(null);
          setReplaceUploadStatus(null);
        }
      } catch {
        // ignore; keep polling
      }
    }

    void poll();
    intervalId = window.setInterval(poll, 900);
    return () => {
      cancelled = true;
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [replaceUploadId, replaceToVersion]);

  const shareUrl = useMemo(() => {
    return buildPublicShareUrl(doc.shareId);
  }, [doc.shareId]);

  const replaceUrl = useMemo(() => {
    return buildPublicReplaceUrl(doc.replaceUploadToken ?? null);
  }, [doc.replaceUploadToken]);

  const isTempUser = useMemo(() => {
    if (!authEnabled) return false;
    return isSignedIn === false;
  }, [authEnabled, isSignedIn]);

  const tempReplaceLimitReached = useMemo(() => {
    if (!isTempUser) return false;
    const v = typeof doc.currentUploadVersion === "number" ? doc.currentUploadVersion : null;
    // Temp: allow versions 1..3 (1 initial + 2 replacements)
    return v !== null && v >= 3;
  }, [isTempUser, doc.currentUploadVersion]);

  // We intentionally do not show summary/tags on the owner panel when AI Snapshot is present.

  useEffect(() => {
    // Defensive boundary enforcement: the doc page must never render Phase-1 CTAs.
    if (process.env.NODE_ENV !== "development") return;
    if (typeof window === "undefined") return;
    if (!window.location.pathname.startsWith("/doc/")) return;

    const offenders: string[] = [];
    if (document.getElementById("finish-share")) offenders.push("#finish-share");

    const interactive = Array.from(document.querySelectorAll("button, a"));
    const hasFinishText = interactive.some((el) =>
      /\bfinish\b/i.test((el.textContent ?? "").trim()),
    );
    const hasReadyToShareText = interactive.some((el) =>
      /ready to share/i.test((el.textContent ?? "").trim()),
    );
    if (hasFinishText) offenders.push("button/a text contains “Finish”");
    if (hasReadyToShareText) offenders.push("button/a text contains “Ready to share”");

    if (offenders.length) {
      console.error(
        "[DocPageClient] Phase-1 CTA leakage detected on /doc/*; this must never happen.",
        { offenders },
      );
    }
  }, []);

  const statusPill = useMemo(() => {
    if (!hasHydratedFromServer) {
      return { label: "Loading…", tone: "neutral" as const };
    }
    if (doc.status === "ready") return { label: "Ready", tone: "ok" as const };
    if (doc.status === "failed") return { label: "Upload failed", tone: "bad" as const };
    return { label: "Preparing…", tone: "neutral" as const };
  }, [doc.status, hasHydratedFromServer]);

  const metricsGlimpse = useMemo(() => {
    const ms = doc.metricsSnapshot;
    if (!ms || !ms.updatedAt) return null;
    const days = typeof ms.days === "number" && Number.isFinite(ms.days) ? ms.days : 15;
    const views = typeof ms.lastDaysViews === "number" && Number.isFinite(ms.lastDaysViews) ? ms.lastDaysViews : 0;
    const downloads =
      typeof ms.lastDaysDownloads === "number" && Number.isFinite(ms.lastDaysDownloads) ? ms.lastDaysDownloads : 0;
    return { days, views, downloads };
  }, [doc.metricsSnapshot]);

  const displayDocName = useMemo(
    () => {
      // `/doc/:id` is client-first and initially hydrates from `/api/docs/:id`.
      // During that brief window, don't show a placeholder word in the title area.
      if (!hasHydratedFromServer) return "";
      const t = (doc.title ?? "").toString().trim();
      return t || "Document";
    },
    [doc.title, hasHydratedFromServer],
  );

  const displayVersion = useMemo(() => {
    const v = doc.currentUploadVersion;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }, [doc.currentUploadVersion]);

  useEffect(() => {
    // Keep draft in sync with server state when not actively editing.
    if (editingTitle) return;
    setTitleDraft(displayDocName);
  }, [displayDocName, editingTitle]);

  useEffect(() => {
    if (!editingTitle) return;
    // focus/selection after the input mounts
    const id = window.setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [editingTitle]);
/**
 * Save Title (updates state (setTitleDraft, setEditingTitle, setTitleSaveError); uses trim, setTitleDraft, setEditingTitle).
 */


  async function saveTitle(nextRaw: string) {
    const next = nextRaw.trim();
    // Don't allow empty titles; treat as cancel.
    if (!next) {
      setTitleDraft(displayDocName);
      setEditingTitle(false);
      setTitleSaveError(null);
      return;
    }
    // No-op
    if (next === displayDocName) {
      setEditingTitle(false);
      setTitleSaveError(null);
      return;
    }

    setTitleSaveBusy(true);
    setTitleSaveError(null);
    try {
      const res = await fetchJson<{ doc: Partial<DocDTO> }>(`/api/docs/${doc.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
      const patchedTitle =
        res?.doc && typeof res.doc.title === "string" && res.doc.title.trim()
          ? res.doc.title
          : next;
      setDoc((d) => ({ ...d, title: patchedTitle }));
      setTitleDraft(patchedTitle);
      setEditingTitle(false);
      notifyDocsChanged();
    } catch (e) {
      setTitleSaveError(e instanceof Error ? e.message : "Failed to rename document");
      // Keep editing open so user can retry.
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    } finally {
      setTitleSaveBusy(false);
    }
  }

  const projects = useMemo((): DocProjectListItem[] => {
    const ps = Array.isArray(doc.projects) ? doc.projects : [];
    const normalized = ps
      .map((p) => {
        if (!p || typeof p !== "object") return null;
        const id = typeof (p as { id?: unknown }).id === "string" ? String((p as { id: string }).id) : "";
        const name = typeof (p as { name?: unknown }).name === "string" ? String((p as { name: string }).name).trim() : "";
        const slug = typeof (p as { slug?: unknown }).slug === "string" ? String((p as { slug: string }).slug).trim() : undefined;
        if (!id || !name) return null;
        return { id, name, ...(slug ? { slug } : {}) };
      })
      .filter((x): x is DocProjectListItem => Boolean(x));
    // de-dupe by id, keep order
    const seen = new Set<string>();
    const out: DocProjectListItem[] = [];
    for (const p of normalized) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
    return out;
  }, [doc.projects]);
  const projectsInline = useMemo(() => projects.slice(0, 3), [projects]);
  const projectsMoreCount = useMemo(() => Math.max(0, projects.length - projectsInline.length), [projects, projectsInline]);

  useEffect(() => {
    // If the doc is starred, keep its title in storage fresh as server state hydrates.
    if (!starred) return;
    // IMPORTANT: `/doc/:id` is client-first and boots with a placeholder title ("Document").
    // Don't overwrite the sidebar's starred title with the placeholder during navigation.
    if (!hasHydratedFromServer) return;
    const nextTitle = (doc.title ?? "").toString().trim();
    if (!nextTitle) return;
    upsertStarredDocTitle({ id: doc.id, title: nextTitle });
  }, [starred, doc.id, doc.title, hasHydratedFromServer]);

  const overlayText = (() => {
    // forces re-render so the text can rotate by elapsed time
    const _tick = preparingTick;
    void _tick;
    if (hydrateError) return hydrateError;
    if (!hasHydratedFromServer) return "Loading document…";
    const elapsed = Date.now() - preparingStartedAtRef.current;
    if (elapsed > 3000) return "Reading your document…";
    if (elapsed > 1500) return "Generating preview…";
    return "Preparing document…";
  })();

  const pdfStatusOverlay = useMemo(() => {
    if (!hasHydratedFromServer) return null;
    if (replaceUploadId) {
      const s = (replaceUploadStatus ?? "").toLowerCase();
      if (s === "failed") {
        return { title: "Upload failed", body: "Processing failed. Your existing document was kept." };
      }
      return {
        title: "Replacing…",
        body:
          s === "uploading"
            ? "Uploading your new PDF…"
            : s === "processing"
              ? "Processing your new PDF…"
              : overlayText,
      };
    }
    if (doc.status === "ready") return null;
    if (doc.status === "failed") {
      return {
        title: "Upload failed",
        body: "Processing failed. Replace the file to try again.",
      };
    }
    return {
      title: "Preparing",
      body: overlayText,
    };
  }, [doc.status, hasHydratedFromServer, overlayText, replaceUploadId, replaceUploadStatus]);

  const shouldShowReviewRunOverlay =
    hasHydratedFromServer &&
    showRequestIntel &&
    doc.status === "ready" &&
    (reviewRerunPending || reviewRunStatus === "queued" || reviewRunStatus === "processing");

  /**
   * Copy the share URL to the clipboard (best-effort).
   */
  async function copyLink() {
    if (!shareUrl) return;
    setIsCopying(true);
    setCopyDone(false);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyDone(true);
      window.setTimeout(() => setCopyDone(false), 1000);
    } catch {
      // ignore
    } finally {
      setIsCopying(false);
    }
  }

  /**
   * Copy the replacement upload URL to the clipboard (best-effort).
   */
  async function copyReplaceLink() {
    if (!replaceUrl) return;
    setReplaceIsCopying(true);
    setReplaceCopyDone(false);
    try {
      await navigator.clipboard.writeText(replaceUrl);
      setReplaceCopyDone(true);
      window.setTimeout(() => setReplaceCopyDone(false), 1000);
    } catch {
      // ignore
    } finally {
      setReplaceIsCopying(false);
    }
  }
/**
   * Set receiver relevance checklist.
   */


  async function setReceiverRelevanceChecklist(next: boolean) {
    const prev = Boolean(doc.receiverRelevanceChecklist);
    if (prev === next) return;

    // Optimistic update
    setDoc((d) => ({ ...d, receiverRelevanceChecklist: next }));
    try {
      await fetchJson(`/api/docs/${doc.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receiverRelevanceChecklist: next }),
      });
    } catch {
      // Revert on failure
      setDoc((d) => ({ ...d, receiverRelevanceChecklist: prev }));
    }
  }
/**
   * Set share allow pdf download.
   */


  async function setShareAllowPdfDownload(next: boolean) {
    const prev = Boolean(doc.shareAllowPdfDownload);
    if (prev === next) return;

    // Optimistic update
    setDoc((d) => ({ ...d, shareAllowPdfDownload: next }));
    try {
      await fetchJson(`/api/docs/${doc.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shareAllowPdfDownload: next }),
      });
    } catch {
      // Revert on failure
      setDoc((d) => ({ ...d, shareAllowPdfDownload: prev }));
    }
  }

  /**
   * Set share allow revision history.
   */
  async function setShareAllowRevisionHistory(next: boolean) {
    const prev = Boolean(doc.shareAllowRevisionHistory);
    if (prev === next) return;

    // Optimistic update
    setDoc((d) => ({ ...d, shareAllowRevisionHistory: next }));
    try {
      await fetchJson(`/api/docs/${doc.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shareAllowRevisionHistory: next }),
      });
    } catch {
      // Revert on failure
      setDoc((d) => ({ ...d, shareAllowRevisionHistory: prev }));
    }
  }
/**
 * Refresh Quality Review (updates state (setQualityReviewLoading, setQualityReviewError, setQualityReview); uses setQualityReviewLoading, setQualityReviewError, fetchWithTempUser).
 */


  async function refreshQualityReview() {
    setQualityReviewLoading(true);
    setQualityReviewError(null);
    try {
      const res = await fetchWithTempUser(`/api/docs/${doc.id}/reviews?latest=1`, { cache: "no-store" });
      if (res.status === 404) {
        // During a rerun, the server may briefly return 404 while the new review record is being created.
        // Keep the optimistic queued overlay instead of clearing.
        if (!reviewRerunPending) setQualityReview(null);
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Request failed (${res.status})`);
      }
      const json = (await res.json()) as {
        reviews?: Array<{
          id?: unknown;
          version?: unknown;
          status?: unknown;
          model?: unknown;
          outputMarkdown?: unknown;
          intel?: unknown;
          agentKind?: unknown;
          agentOutput?: unknown;
          createdDate?: unknown;
          updatedDate?: unknown;
        }>;
      };
      const r = Array.isArray(json.reviews) ? json.reviews[0] : null;
      if (!r) {
        // During a rerun, the list can briefly be empty (race with background job).
        if (!reviewRerunPending) setQualityReview(null);
        return;
      }

      // Browser-console breadcrumbs to verify reruns + polling without spamming.
      const nextStatus = typeof r.status === "string" ? r.status : "";
      const nextVersion = typeof r.version === "number" ? r.version : null;
      const logKey = `${nextStatus}:${String(nextVersion ?? "")}`;
      if (logKey && logKey !== lastReviewLogKeyRef.current) {
        lastReviewLogKeyRef.current = logKey;
        // eslint-disable-next-line no-console
        console.log("[lnkdrp][review] latest", {
          docId: doc.id,
          status: nextStatus,
          version: nextVersion,
          hasIntel: Boolean(r.intel && typeof r.intel === "object"),
        });
      }

      // If a rerun was just requested, the background job can take a moment to flip the DB record
      // into queued/processing. During that window, /reviews?latest=1 may still return the last
      // completed review. Don't overwrite the optimistic queued UI with stale data, and keep polling.
      if (reviewRerunPending) {
        const prevUpdated = reviewRerunPrevUpdatedRef.current;
        const nextUpdated = typeof r.updatedDate === "string" ? r.updatedDate : null;
        const nextUpdatedMs = nextUpdated ? Date.parse(nextUpdated) : NaN;
        const startedAtMs = typeof reviewRerunStartedAtRef.current === "number" ? reviewRerunStartedAtRef.current : null;
        const ageMs =
          typeof reviewRerunStartedAtRef.current === "number"
            ? Date.now() - reviewRerunStartedAtRef.current
            : null;
        const timedOut = typeof ageMs === "number" ? ageMs > 120_000 : false;

        const nextStatusLower = nextStatus.toLowerCase();
        const started = nextStatusLower === "queued" || nextStatusLower === "processing";
        const terminal = nextStatusLower === "completed" || nextStatusLower === "failed" || nextStatusLower === "skipped";
        if (started) {
          setReviewRerunPending(false);
        } else if (!timedOut && terminal) {
          // The server can return a terminal state before we ever observe "queued"/"processing"
          // (e.g., very fast runs or status updates that skip intermediate phases).
          //
          // Only accept terminal results that look newer than what we had before the click; otherwise
          // keep the optimistic queued state and continue polling for the new run.
          const looksStaleByUpdatedDate =
            (prevUpdated && nextUpdated && nextUpdated === prevUpdated) ||
            (!Number.isFinite(nextUpdatedMs) || (typeof startedAtMs === "number" && nextUpdatedMs < startedAtMs));
          if (looksStaleByUpdatedDate) return;
          setReviewRerunPending(false);
        } else if (timedOut) {
          // Give up and accept server truth after a reasonable timeout.
          setReviewRerunPending(false);
        }
      }

      setQualityReview({
        id: typeof r.id === "string" ? r.id : "",
        version: typeof r.version === "number" ? r.version : null,
        status: typeof r.status === "string" ? r.status : null,
        model: typeof r.model === "string" ? r.model : null,
        outputMarkdown: typeof r.outputMarkdown === "string" ? r.outputMarkdown : null,
        intel: r.intel && typeof r.intel === "object" ? (r.intel as unknown as any) : null,
        agentKind: typeof r.agentKind === "string" ? r.agentKind : null,
        agentOutput: r.agentOutput && typeof r.agentOutput === "object" ? (r.agentOutput as any) : null,
        createdDate: typeof r.createdDate === "string" ? r.createdDate : null,
        updatedDate: typeof r.updatedDate === "string" ? r.updatedDate : null,
      });
    } catch (e) {
      setQualityReviewError(e instanceof Error ? e.message : "Failed to load review");
    } finally {
      setQualityReviewLoading(false);
    }
  }
/**
 * Load Request Prompt (updates state (setPromptLoading, setPromptError, setRequestProjectMeta); uses setPromptLoading, setPromptError, log).
 */


  /**
   * Rerun request review (owner-only).
   */
  async function rerunRequestReview() {
    if (!requestProjectId) return;
    if (!doc.currentUploadId) {
      setQualityReviewError("Missing upload id; cannot rerun review.");
      return;
    }

    const prevQualityReview = qualityReview;
    setQualityReviewError(null);
    setReviewRerunPending(true);
    reviewRerunStartedAtRef.current = Date.now();
    reviewRerunPrevUpdatedRef.current = qualityReview?.updatedDate ?? null;
    // Optimistic UI: show "queued" immediately so the overlay/disabled state appears
    // without requiring a refresh (the server work happens in the background).
    setQualityReviewLoading(true);
    setQualityReviewError(null);
    setQualityReview({
      id: "",
      version: qualityReview?.version ?? null,
      status: "queued",
      model: null,
      outputMarkdown: null,
      intel: null,
      createdDate: null,
      updatedDate: null,
    });
    try {
      // eslint-disable-next-line no-console
      console.log("[lnkdrp][review] rerun request review clicked", {
        docId: doc.id,
        uploadId: doc.currentUploadId,
        requestProjectId,
      });

      // eslint-disable-next-line no-console
      console.log("[lnkdrp][review] calling /process?forceReview=1", {
        uploadId: doc.currentUploadId,
      });
      await fetchJson(`/api/uploads/${encodeURIComponent(doc.currentUploadId)}/process?forceReview=1`, {
        method: "POST",
      });

      // eslint-disable-next-line no-console
      console.log("[lnkdrp][review] forceReview POST complete; polling /reviews?latest=1", { docId: doc.id });
      void refreshQualityReview();
    } catch (e) {
      // Show the error in the Intel panel (modal is already closed).
      setQualityReviewError(e instanceof Error ? e.message : "Failed to rerun review");
      setQualityReview(prevQualityReview ?? null);
      setReviewRerunPending(false);
    } finally {
      // no-op
    }
  }

  useEffect(() => {
    if (!qualityReviewOpen) return;
    void refreshQualityReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qualityReviewOpen, doc.id]);

  const shouldPollQualityReview = useMemo(() => {
    if (!qualityReviewOpen && !showRequestIntel) return false;
    const s = (qualityReview?.status ?? "").toLowerCase();
    return s === "queued" || s === "processing" || reviewRerunPending;
  }, [qualityReviewOpen, showRequestIntel, qualityReview?.status, reviewRerunPending]);

  useEffect(() => {
    if (!shouldPollQualityReview) return;
    const id = window.setInterval(() => void refreshQualityReview(), 1500);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldPollQualityReview]);

  useEffect(() => {
    if (!showRequestIntel) return;
    if (!hasHydratedFromServer) return;
    if (doc.status !== "ready") return;
    void refreshQualityReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRequestIntel, hasHydratedFromServer, doc.id, doc.status]);

  const intel = useMemo(() => {
    const i = qualityReview?.intel ?? null;
    const ai = (doc.aiOutput && typeof doc.aiOutput === "object" ? (doc.aiOutput as any) : null) as
      | null
      | {
          company_or_project_name?: unknown;
          company_url?: unknown;
          contact_name?: unknown;
          contact_email?: unknown;
          contact_url?: unknown;
        };
    return {
      companyName:
        (i?.company?.name ?? "").toString().trim() ||
        (typeof ai?.company_or_project_name === "string" ? ai.company_or_project_name.trim() : "") ||
        null,
      companyUrl:
        normalizeUrlish(i?.company?.url ?? null) ||
        normalizeUrlish(typeof ai?.company_url === "string" ? ai.company_url : null),
      contactName:
        (i?.contact?.name ?? "").toString().trim() ||
        (typeof ai?.contact_name === "string" ? ai.contact_name.trim() : "") ||
        null,
      contactEmail:
        (i?.contact?.email ?? "").toString().trim() ||
        (typeof ai?.contact_email === "string" ? ai.contact_email.trim() : "") ||
        null,
      contactUrl:
        normalizeUrlish(i?.contact?.url ?? null) ||
        normalizeUrlish(typeof ai?.contact_url === "string" ? ai.contact_url : null),
      overallAssessment: (i?.overallAssessment ?? "").toString().trim() || null,
      effectivenessScore:
        typeof i?.effectivenessScore === "number" && Number.isFinite(i.effectivenessScore)
          ? i.effectivenessScore
          : null,
      scoreRationale: (i?.scoreRationale ?? "").toString().trim() || null,
      strengths: Array.isArray(i?.strengths) ? i!.strengths! : [],
      weaknessesAndRisks: Array.isArray(i?.weaknessesAndRisks) ? i!.weaknessesAndRisks! : [],
      recommendations: Array.isArray(i?.recommendations) ? i!.recommendations! : [],
      actionItems: Array.isArray(i?.actionItems) ? i!.actionItems! : [],
      suggestedRewrites: (i?.suggestedRewrites ?? "").toString().trim() || null,
    };
  }, [qualityReview?.intel, doc.aiOutput, qualityReview?.version]);

  /**
   * Replace the document's current PDF by creating a new upload record and
   * restarting the processing pipeline.
   */
  async function replaceFile(file: File) {
    // Keep route stable; create a new upload record and rerun the pipeline.
    try {
      replacePendingRef.current = true;
      setReplaceNotice(null);
      setReplaceToVersion(null);
      setReplaceUploadStatus(null);

      // Immediately clear the current view and show a local preview for the new file.
      setLocalPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });

      preparingStartedAtRef.current = Date.now();

      // Create a new upload record
      let newUploadId = "";
      try {
        newUploadId = await apiCreateUpload({
          docId: doc.id,
          originalFileName: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "";
        if (message === "TEMP_USER_LIMIT") setTempGateOpen(true);
        replacePendingRef.current = false;
        // Best effort: restore server-backed view.
        setLocalPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return null;
        });
        setLocalPreviewUploadId(null);
        router.refresh();
        return;
      }
      setLocalPreviewUploadId(newUploadId);
      replacePendingRef.current = false;

      const optimisticNextVersion =
        typeof docRef.current.currentUploadVersion === "number" && Number.isFinite(docRef.current.currentUploadVersion)
          ? docRef.current.currentUploadVersion + 1
          : null;
      setReplaceToVersion(optimisticNextVersion);
      setReplaceUploadId(newUploadId);
      setReplaceUploadStatus("uploading");
      preparingStartedAtRef.current = Date.now();

      // Start direct-to-blob upload in the background (do not block UI).
      startBlobUploadAndProcess({
        docId: doc.id,
        uploadId: newUploadId,
        file,
        onFailure: async (message) => {
          // IMPORTANT: a failed replacement must not overwrite the current doc.
          // We'll mark the upload failed (best-effort) and show an inline error.
          try {
            await fetchJson(`/api/uploads/${newUploadId}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: "failed", error: { message } }),
            });
          } catch {
            // ignore
          }
          setReplaceNotice({
            kind: "error",
            toVersion: optimisticNextVersion,
            summary: message || "Processing failed. Your existing document was kept.",
            createdAtMs: Date.now(),
          });
          setReplaceUploadStatus("failed");
          setReplaceUploadId(null);
          // Clear local preview; we never landed a new version.
          setLocalPreviewUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return null;
          });
          setLocalPreviewUploadId(null);
        },
      });
    } catch {
      // ignore
    }
  }

  // This page always renders a right-side panel (share/intel/summary/preparing),
  // so keep the desktop layout split even while the doc is loading.
  const hasSidePanel = true;

  return (
    <>
        <div className="flex h-full flex-col">
        {shouldShowReviewRunOverlay ? (
          <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--bg)]/35 backdrop-blur-xl backdrop-saturate-150">
            <div className="max-w-[460px] rounded-2xl border border-[var(--border)] bg-[var(--panel)]/90 px-6 py-4 text-center shadow-[0_2px_10px_rgba(0,0,0,0.18)]">
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                Review running…
              </div>
              <div className="mt-2 text-sm font-medium text-[var(--fg)]">Updating Intel for this document</div>
              <div className="mt-1 text-sm text-[var(--muted)]">
                Status: <span className="font-medium text-[var(--fg)]">{reviewRunStatus}</span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
                <div className="h-full w-1/3 bg-[var(--primary-bg)] animate-[lnkdrpIndeterminate_1.05s_ease-in-out_infinite]" />
              </div>
            </div>
          </div>
        ) : null}
        {/* Top bar */}
        <div className="flex flex-col gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-3 md:flex-row md:items-center md:justify-between md:gap-4 md:px-6 md:py-4">
            <div className="flex w-full min-w-0 items-center gap-3 md:w-auto">
              <button
                type="button"
                onClick={() => void handleToggleStar()}
                className={[
                  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors",
                  starred
                    ? [
                        // Light mode: theme-aligned (soft tint + readable icon), not a loud block of color.
                        "border-amber-200 bg-amber-50 text-amber-600 hover:bg-amber-100",
                        "dark:border-amber-300/30 dark:bg-amber-300/10 dark:text-amber-200 dark:hover:bg-amber-300/15",
                      ].join(" ")
                    : [
                        // Light mode: stick to theme neutrals; rely on hover + border for affordance.
                        "border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                        "dark:text-[var(--muted)]",
                      ].join(" "),
                  navLockActive && !isReceivedViaRequest ? "cursor-not-allowed opacity-50 hover:bg-[var(--panel)]" : "",
                ].join(" ")}
                disabled={navLockActive && !isReceivedViaRequest}
                aria-disabled={navLockActive && !isReceivedViaRequest}
                aria-label={starred ? "Unstar document" : "Star document"}
                title={
                  navLockActive && !isReceivedViaRequest
                    ? "Disabled while uploading"
                    : starred
                      ? "Starred"
                      : "Star"
                }
              >
                <StarIcon filled={starred} />
              </button>

              {isReceivedViaRequest ? (
                <div
                  className={[
                    "inline-flex h-8 items-center gap-2 rounded-lg border px-3 text-xs font-semibold",
                    // Light mode: higher contrast so it reads on white backgrounds.
                    "border-sky-200 bg-sky-50 text-sky-800",
                    // Dark mode: subtle tint on dark surfaces.
                    "dark:border-sky-300/25 dark:bg-sky-400/10 dark:text-sky-200",
                  ].join(" ")}
                >
                  <InboxArrowDownIcon className="h-4 w-4" aria-hidden="true" />
                  RECEIVED
                </div>
              ) : null}

              {/* Replacement upload link is shown in the right-side panel for received docs. */}
              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1">
                  {!isReceivedViaRequest && editingTitle ? (
                    <div className="min-w-0">
                      <input
                        ref={titleInputRef}
                        value={titleDraft}
                        disabled={titleSaveBusy}
                        onChange={(e) => {
                          setTitleDraft(e.target.value);
                          if (titleSaveError) setTitleSaveError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void saveTitle(titleDraft);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setTitleDraft(displayDocName);
                            setEditingTitle(false);
                            setTitleSaveError(null);
                          }
                        }}
                        onBlur={() => {
                          // Best-effort: save on blur if changed.
                          void saveTitle(titleDraft);
                        }}
                        aria-label="Document name"
                        className={[
                          "w-full min-w-0 rounded-md border bg-[var(--panel)] px-2 py-1 text-sm font-semibold text-[var(--fg)]",
                          "border-[var(--border)] focus:outline-none focus:ring-2 focus:ring-black/10",
                          titleSaveBusy ? "opacity-70" : "",
                        ].join(" ")}
                      />
                      {titleSaveError ? (
                        <div className="mt-1 text-xs font-medium text-red-700">{titleSaveError}</div>
                      ) : null}
                    </div>
                  ) : isReceivedViaRequest ? (
                    <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-[var(--fg)]">
                      {!hasHydratedFromServer ? (
                        <span
                          className="inline-block h-4 w-32 animate-pulse rounded bg-[var(--panel-hover)] align-middle"
                          aria-hidden="true"
                        />
                      ) : (
                        <span className="min-w-0 truncate">{displayDocName}</span>
                      )}
                      {displayVersion != null ? (
                        navLockActive ? (
                          <span
                            className="shrink-0 rounded-md bg-[var(--panel-hover)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted-2)]"
                            aria-label={`Document version ${displayVersion}`}
                            title={`Version ${displayVersion}`}
                          >
                            v{displayVersion}
                          </span>
                        ) : (
                          <Link
                            href={`/doc/${encodeURIComponent(doc.id)}/history#v-${displayVersion}`}
                            className="shrink-0 rounded-md bg-[var(--panel-hover)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted-2)] hover:underline underline-offset-4"
                            aria-label={`Document version ${displayVersion} (view history)`}
                            title={`Version ${displayVersion} (view history)`}
                          >
                            v{displayVersion}
                          </Link>
                        )
                      ) : null}
                    </div>
                  ) : (
                    <div className="flex min-w-0 items-center gap-2">
                      <button
                        type="button"
                        disabled={navLockActive}
                        aria-disabled={navLockActive}
                        aria-label={hasHydratedFromServer ? displayDocName : "Loading document name"}
                        title={navLockActive ? "Disabled while uploading" : "Rename document"}
                        onClick={() => {
                          if (navLockActive) return;
                          setTitleDraft(displayDocName);
                          setTitleSaveError(null);
                          setEditingTitle(true);
                        }}
                        className={[
                          "block min-w-0 truncate text-left text-sm font-semibold text-[var(--fg)]",
                          navLockActive ? "cursor-not-allowed opacity-70" : "hover:underline",
                        ].join(" ")}
                      >
                        {!hasHydratedFromServer ? (
                          <span
                            className="inline-block h-4 w-32 animate-pulse rounded bg-[var(--panel-hover)] align-middle"
                            aria-hidden="true"
                          />
                        ) : (
                          displayDocName
                        )}
                      </button>
                      {displayVersion != null ? (
                        navLockActive ? (
                          <span
                            className="shrink-0 rounded-md bg-[var(--panel-hover)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted-2)]"
                            aria-label={`Document version ${displayVersion}`}
                            title={`Version ${displayVersion}`}
                          >
                            v{displayVersion}
                          </span>
                        ) : (
                          <Link
                            href={`/doc/${encodeURIComponent(doc.id)}/history#v-${displayVersion}`}
                            className="shrink-0 rounded-md bg-[var(--panel-hover)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted-2)] hover:underline underline-offset-4"
                            aria-label={`Document version ${displayVersion} (view history)`}
                            title={`Version ${displayVersion} (view history)`}
                          >
                            v{displayVersion}
                          </Link>
                        )
                      ) : null}
                    </div>
                  )}
                  {doc.lastUpdate?.uploadedAt ? (
                    <div className="mt-1 flex items-center gap-2 text-xs text-[var(--muted)]">
                      <ArrowPathIcon className="h-4 w-4 text-[var(--muted-2)]" aria-hidden="true" />
                      <span>
                        {(() => {
                          const iso = doc.lastUpdate?.uploadedAt ?? "";
                          const relative = iso ? formatRelativeAge(iso) : null;
                          const absolute = (() => {
                            try {
                              return new Date(iso).toLocaleString();
                            } catch {
                              return iso;
                            }
                          })();
                          return (
                            <>
                              Last updated{" "}
                              {relative ? (
                                <span className="font-medium text-[var(--fg)]" title={absolute}>
                                  {relative}
                                </span>
                              ) : (
                                <span className="font-medium text-[var(--fg)]">{absolute}</span>
                              )}
                            </>
                          );
                        })()}
                        {doc.lastUpdate?.uploadedBy ? (
                          <>
                            {" "}
                            by{" "}
                            <span className="font-medium text-[var(--fg)]">
                              {doc.lastUpdate.uploadedBy.name ??
                                doc.lastUpdate.uploadedBy.email ??
                                "Unknown"}
                            </span>
                          </>
                        ) : null}
                      </span>
                    </div>
                  ) : null}
                  {isReceivedViaRequest ? (
                    <div className="mt-1 flex items-center gap-2 text-xs text-[var(--muted)]">
                      <InboxArrowDownIcon className="h-4 w-4 text-[var(--muted-2)]" aria-hidden="true" />
                      <span>
                        uploaded into{" "}
                        {requestProjectId ? (
                          <Link
                            href={`/project/${encodeURIComponent(requestProjectId)}`}
                            className="font-medium text-[var(--fg)] hover:underline underline-offset-4"
                          >
                            {receivedRequestProjectName || (doc.project?.name ?? "Request")}
                          </Link>
                        ) : (
                          <span className="font-medium text-[var(--fg)]">
                            {receivedRequestProjectName || (doc.project?.name ?? "Request")}
                          </span>
                        )}
                      </span>
                    </div>
                  ) : null}
                  {guideRequestProjectId ? (
                    <div className="mt-1 flex items-center gap-2 text-xs text-[var(--muted)]">
                      <LightBulbIcon className="h-4 w-4 text-[var(--muted-2)]" aria-hidden="true" />
                      <span>
                        guide for{" "}
                        <Link
                          href={`/project/${encodeURIComponent(guideRequestProjectId)}`}
                          className="font-medium text-[var(--fg)] hover:underline underline-offset-4"
                        >
                          {guideRequestProjectName || "Request"}
                        </Link>
                      </span>
                    </div>
                  ) : null}
                </div>

                {!isReceivedViaRequest && projectsInline.length ? (
                  <div className="inline-flex shrink-0 flex-wrap items-center gap-1 text-sm font-medium text-[var(--muted-2)]">
                    {projectsInline.map((p) => {
                      const href = p.id ? `/project/${encodeURIComponent(p.id)}` : null;
                      const isRequestProject = Boolean((p as unknown as { isRequest?: unknown }).isRequest);
                      const Pill = (
                        <span
                          className={[
                            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5",
                            "text-[12px] font-medium text-[var(--muted-2)]",
                            "bg-transparent hover:bg-[var(--panel-hover)]",
                          ].join(" ")}
                        >
                          {isRequestProject ? (
                            <InboxArrowDownIcon className="h-3.5 w-3.5 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                          ) : (
                            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                          )}
                          <span className="max-w-[160px] truncate">{p.name}</span>
                        </span>
                      );
                      return href ? (
                        <Link key={p.id} href={href} className="hover:opacity-90">
                          {Pill}
                        </Link>
                      ) : (
                        <span key={p.id}>{Pill}</span>
                      );
                    })}

                    {projectsMoreCount > 0 ? (
                      <button
                        type="button"
                        className="ml-1 text-[12px] font-medium text-[var(--muted-2)] hover:text-[var(--fg)] hover:underline underline-offset-4"
                        onClick={() => setShowProjectsModal(true)}
                      >
                        See more
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex w-full flex-wrap items-center justify-end gap-2 md:w-auto md:gap-3 lg:flex-nowrap">
              {hasHydratedFromServer && !isReceivedViaRequest ? (
                <div className="flex items-center gap-2">
                <span
                  className={
                    statusPill.tone === "ok"
                      ? [
                          // Light mode: theme-aligned success tint (subtle but readable).
                          "rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200",
                          "dark:bg-emerald-300/10 dark:text-emerald-200 dark:ring-emerald-300/25",
                        ].join(" ")
                      : statusPill.tone === "bad"
                        ? [
                            "rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-800 ring-1 ring-red-200",
                            "dark:bg-red-400/10 dark:text-red-200 dark:ring-red-300/25",
                          ].join(" ")
                        : "rounded-full bg-[var(--panel-hover)] px-3 py-1 text-xs font-medium text-[var(--muted)] ring-1 ring-[var(--border)]"
                  }
                >
                  {statusPill.label}
                </span>
                </div>
              ) : null}

              {hasHydratedFromServer && doc.status === "ready" && metricsGlimpse && !isReceivedViaRequest ? (
                <div
                  className="hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-xs text-[var(--muted)] xl:flex xl:flex-wrap xl:items-center xl:gap-x-3 xl:gap-y-1"
                  aria-label="Metrics snapshot"
                  title="Cached metrics snapshot (updated by cron)"
                >
                  <span className="font-semibold text-[var(--fg)] whitespace-nowrap">Last {metricsGlimpse.days}d</span>
                  <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
                    <span className="tabular-nums font-semibold text-[var(--fg)]">{metricsGlimpse.views}</span>
                    <span>views</span>
                  </span>
                  {Boolean(doc.shareAllowPdfDownload) ? (
                    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
                      <span className="tabular-nums font-semibold text-[var(--fg)]">{metricsGlimpse.downloads}</span>
                      <span>downloads</span>
                    </span>
                  ) : (
                    <span className="whitespace-nowrap">downloads off</span>
                  )}
                </div>
              ) : null}

              {hasHydratedFromServer && !isReceivedViaRequest ? (
                <UploadButton
                label="Replace file"
                accept="pdf"
                variant="link"
                disabled={
                  !hasHydratedFromServer ||
                  doc.status === "preparing" ||
                  doc.status === "draft"
                }
                icon={
                  <span className="text-[var(--muted)]">
                    <ArrowPathIcon className="h-4 w-4" />
                  </span>
                }
                onBeforeOpen={() => {
                  if (tempReplaceLimitReached) {
                    setTempGateOpen(true);
                    return false;
                  }
                }}
                onFileSelected={replaceFile}
                />
              ) : null}

              {hasHydratedFromServer && !isReceivedViaRequest ? (
                <button
                  type="button"
                  onClick={() => router.push(`/doc/${encodeURIComponent(doc.id)}/metrics`)}
                  disabled={!hasHydratedFromServer || doc.status !== "ready"}
                  aria-disabled={!hasHydratedFromServer || doc.status !== "ready"}
                  aria-label="Open metrics"
                  title={!hasHydratedFromServer || doc.status !== "ready" ? "Available when ready" : "Metrics"}
                  className={[
                    "inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors",
                    "border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                    (!hasHydratedFromServer || doc.status !== "ready") ? "cursor-not-allowed opacity-60" : "",
                  ].join(" ")}
                >
                  <ChartBarIcon className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : null}

              {hasHydratedFromServer && !isReceivedViaRequest ? (
                <DocActionsMenu
                  docId={doc.id}
                  currentProjectId={doc.projectId ?? null}
                  currentProjectIds={Array.isArray(doc.projectIds) ? doc.projectIds : null}
                  disabled={
                    !hasHydratedFromServer || doc.status === "preparing" || doc.status === "draft"
                  }
                  onDocPatched={(patch) => setDoc((d) => ({ ...d, ...patch }))}
                  onDeleted={() => router.push("/")}
                  onOpenQualityReview={() => setQualityReviewOpen(true)}
                />
              ) : null}
            </div>
          </div>

          {/* Content */}
        <div className="min-h-0 flex-1 overflow-hidden bg-[var(--bg)]">
          <div className="h-full px-6 py-6">
            <div
              className={[
                "grid h-full min-h-0 gap-5",
                hasSidePanel ? "lg:grid-cols-[1.35fr_0.65fr]" : "lg:grid-cols-[1fr]",
              ].join(" ")}
            >
              {/* PDF left, info panel right (desktop). On mobile: show the PDF first, then the side panel. */}
              <div className="order-1 min-h-0 h-full flex flex-col gap-3 lg:order-1">
                {replaceNotice ? (
                  <div
                    className={[
                      "rounded-xl border px-3 py-2 text-sm",
                      replaceNotice.kind === "success"
                        ? [
                            // Light mode
                            "border-emerald-200 bg-emerald-50 text-emerald-950",
                            // Dark mode (keep existing look)
                            "dark:border-emerald-300/30 dark:bg-emerald-400/10 dark:text-emerald-200",
                          ].join(" ")
                        : [
                            "border-red-200 bg-red-50 text-red-950",
                            "dark:border-red-300/30 dark:bg-red-400/10 dark:text-red-200",
                          ].join(" "),
                    ].join(" ")}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div
                          className={[
                            "text-[11px] font-semibold uppercase tracking-wide",
                            replaceNotice.kind === "success"
                              ? "text-emerald-700 dark:text-white/70"
                              : "text-red-700 dark:text-white/70",
                          ].join(" ")}
                        >
                          {replaceNotice.kind === "success" ? "Upload complete" : "Upload failed"}
                        </div>
                        <div
                          className={[
                            "mt-1 text-sm font-medium",
                            replaceNotice.kind === "success"
                              ? "text-emerald-950 dark:text-white/90"
                              : "text-red-950 dark:text-white/90",
                          ].join(" ")}
                        >
                          {replaceNotice.summary}
                        </div>
                      </div>
                      <div className="shrink-0">
                        <Link
                          href={`/doc/${encodeURIComponent(doc.id)}/history`}
                          className={[
                            "inline-flex items-center rounded-lg px-3 py-1.5 text-xs font-semibold",
                            replaceNotice.kind === "success"
                              ? [
                                  "bg-emerald-600/10 text-emerald-900 hover:bg-emerald-600/15",
                                  "dark:bg-white/10 dark:text-white/90 dark:hover:bg-white/15",
                                ].join(" ")
                              : [
                                  "bg-red-600/10 text-red-900 hover:bg-red-600/15",
                                  "dark:bg-white/10 dark:text-white/90 dark:hover:bg-white/15",
                                ].join(" "),
                            highlightVersionLink && replaceNotice.kind === "success" ? "lnkdrp-heartbeat-glow" : "",
                          ].join(" ")}
                        >
                          {replaceNotice.toVersion ? `View v${replaceNotice.toVersion} changes` : "View version history"}
                        </Link>
                      </div>
                    </div>
                  </div>
                ) : null}

              <style jsx global>{`
                @keyframes lnkdrpHeartbeatGlow {
                  0% {
                    transform: scale(1);
                    box-shadow: 0 0 0 rgba(34, 197, 94, 0);
                  }
                  18% {
                    transform: scale(1.04);
                    box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.35), 0 0 22px rgba(34, 197, 94, 0.25);
                  }
                  36% {
                    transform: scale(1);
                    box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.18), 0 0 14px rgba(34, 197, 94, 0.18);
                  }
                  56% {
                    transform: scale(1.03);
                    box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.25), 0 0 18px rgba(34, 197, 94, 0.22);
                  }
                  100% {
                    transform: scale(1);
                    box-shadow: 0 0 0 rgba(34, 197, 94, 0);
                  }
                }
                .lnkdrp-heartbeat-glow {
                  animation: lnkdrpHeartbeatGlow 1.1s ease-in-out 0s 2;
                  will-change: transform, box-shadow;
                }
              `}</style>

                <section className="relative flex-1 min-h-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
                  {/* progress bar (pinned top) */}
                  {(!hasHydratedFromServer ||
                    doc.status === "preparing" ||
                    doc.status === "draft") && (
                    <div className="absolute left-0 right-0 top-0 z-20 h-1 overflow-hidden bg-[var(--border)]">
                      <div className="h-full w-1/3 bg-[var(--primary-bg)] animate-[lnkdrpIndeterminate_1.05s_ease-in-out_infinite]" />
                    </div>
                  )}

                  <div className="h-full w-full bg-[var(--panel-2)]">
                    {isReceivedViaRequest &&
                    (!hasHydratedFromServer ||
                      ((doc.status === "preparing" || doc.status === "draft") && !doc.blobUrl)) ? (
                      <div className="grid h-full place-items-center px-6 text-center">
                        <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-6 py-4">
                          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                            Processing…
                          </div>
                          <div className="mt-2 text-sm font-medium text-[var(--fg)]">
                            We’re preparing this received document.
                          </div>
                          <div className="mt-1 text-sm text-[var(--muted)]">
                            Please wait —{" "}
                            {showRequestIntel
                              ? "Intel will appear once processing is complete."
                              : "a summary will appear once processing is complete."}
                          </div>
                          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
                            <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--primary-bg)]" />
                          </div>
                        </div>
                      </div>
                    ) : !localPreviewUrl && !pdfViewerOpen && doc.blobUrl && doc.previewImageUrl ? (
                      <div className="relative h-full w-full">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={doc.previewImageUrl}
                          alt="Document preview"
                          loading="eager"
                          fetchPriority="high"
                          decoding="async"
                          className="h-full w-full object-contain"
                        />
                        <div className="absolute left-0 right-0 top-0 z-10 flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--panel)]/95 px-4 py-3">
                          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                            Preview
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              pdfViewerOpenedRef.current = true;
                              setPdfViewerOpen(true);
                            }}
                            className="rounded-lg bg-[var(--primary-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
                          >
                            Open PDF
                          </button>
                        </div>
                      </div>
                    ) : !localPreviewUrl && !pdfViewerOpen && doc.blobUrl && !doc.previewImageUrl ? (
                      <div className="grid h-full place-items-center px-6 text-center">
                        <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-6 py-4">
                          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                            Preview
                          </div>
                          <div className="mt-2 text-sm font-medium text-[var(--fg)]">
                            Preparing preview…
                          </div>
                          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
                            <div className="h-full w-1/3 bg-[var(--primary-bg)] animate-[lnkdrpIndeterminate_1.05s_ease-in-out_infinite]" />
                          </div>
                        </div>
                      </div>
                    ) : pdfViewerOpen && doc.status === "ready" && doc.blobUrl ? (
                      <iframe
                        title="PDF"
                        src={buildCachedPdfIframeUrl({
                          docId: doc.id,
                          currentUploadId: doc.currentUploadId,
                          currentUploadVersion: doc.currentUploadVersion,
                        })}
                        className={[
                          "block h-full w-full border-0",
                          pdfStatusOverlay ? "pointer-events-none" : "",
                        ].join(" ")}
                        allow="fullscreen"
                      />
                    ) : localPreviewUrl ? (
                      <iframe
                        title="PDF preview"
                        src={localPreviewUrl}
                        className={[
                          "block h-full w-full border-0",
                          pdfStatusOverlay ? "pointer-events-none" : "",
                        ].join(" ")}
                        allow="fullscreen"
                      />
                    ) : pdfViewerOpen && doc.blobUrl ? (
                      <iframe
                        title="PDF"
                        src={buildCachedPdfIframeUrl({
                          docId: doc.id,
                          currentUploadId: doc.currentUploadId,
                          currentUploadVersion: doc.currentUploadVersion,
                        })}
                        className={[
                          "block h-full w-full border-0",
                          pdfStatusOverlay ? "pointer-events-none" : "",
                        ].join(" ")}
                        allow="fullscreen"
                      />
                    ) : doc.previewImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={doc.previewImageUrl}
                        alt="Document preview"
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <div className="grid h-full place-items-center px-6 text-center">
                        <div className="text-sm font-medium text-[var(--muted)]">
                          Preview will appear here.
                        </div>
                      </div>
                    )}
                  </div>

                  {/* overlay */}
                  {pdfStatusOverlay ? (
                    <div className="absolute inset-0 z-10 grid place-items-center bg-[var(--bg)]/35 backdrop-blur-xl backdrop-saturate-150">
                      <div className="max-w-[460px] rounded-2xl border border-[var(--border)] bg-[var(--panel)]/90 px-6 py-4 text-center shadow-[0_2px_10px_rgba(0,0,0,0.18)]">
                        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                          {pdfStatusOverlay.title}
                        </div>
                        <div className="mt-2 text-sm font-medium text-[var(--fg)]">
                          {pdfStatusOverlay.body}
                        </div>
                        {doc.status !== "failed" ? (
                          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
                            <div className="h-full w-1/3 bg-[var(--primary-bg)] animate-[lnkdrpIndeterminate_1.05s_ease-in-out_infinite]" />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                </section>
              </div>

              <div className="order-2 min-h-0 h-full lg:order-2">
                {doc.status === "ready" && !isReceivedViaRequest ? (
                  <DocSharePanel
                    docId={doc.id}
                    shareUrl={shareUrl}
                    shareInputRef={shareInputRef}
                    isCopying={isCopying}
                    copyDone={copyDone}
                    onCopy={() => void copyLink()}
                    relevancyEnabled={Boolean(doc.receiverRelevanceChecklist)}
                    onToggleRelevancy={(next) => void setReceiverRelevanceChecklist(next)}
                    pdfDownloadEnabled={Boolean(doc.shareAllowPdfDownload)}
                    onPdfDownloadEnabledChange={(next) => void setShareAllowPdfDownload(next)}
                    revisionHistoryEnabled={Boolean(doc.shareAllowRevisionHistory)}
                    onRevisionHistoryEnabledChange={(next) => void setShareAllowRevisionHistory(next)}
                    sharePasswordEnabled={Boolean(doc.sharePasswordEnabled)}
                    onSharePasswordEnabledChange={(enabled) =>
                      setDoc((d) => ({ ...d, sharePasswordEnabled: enabled }))
                    }
                    aiOutput={doc.aiOutput ?? null}
                    uploadError={currentUpload?.error ?? null}
                  />
                ) : isReceivedViaRequest && doc.status === "ready" && showRequestIntel ? (
                  <aside className="min-h-0 overflow-auto rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="text-sm font-semibold">Intel</div>
                        {(() => {
                          const out = qualityReview?.agentOutput ?? null;
                          const stageMatch =
                            out && typeof (out as any).stage_match === "boolean"
                              ? Boolean((out as any).stage_match)
                              : null;
                          const relevancy =
                            out && typeof (out as any).relevancy === "string"
                              ? String((out as any).relevancy)
                              : null;

                          const pillBase =
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold";
                          const stagePill =
                            stageMatch === true
                              ? `${pillBase} border-emerald-300/40 bg-emerald-500/15 text-emerald-200`
                              : stageMatch === false
                                ? `${pillBase} border-red-300/40 bg-red-500/15 text-red-200`
                                : `${pillBase} border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]`;
                          const relKey = (relevancy ?? "").toLowerCase();
                          const relPill =
                            relKey === "high"
                              ? `${pillBase} border-emerald-300/40 bg-emerald-500/15 text-emerald-200`
                              : relKey === "medium"
                                ? `${pillBase} border-amber-300/40 bg-amber-500/15 text-amber-200`
                                : relKey === "low"
                                  ? `${pillBase} border-red-300/40 bg-red-500/15 text-red-200`
                                  : `${pillBase} border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]`;

                          const show = stageMatch !== null || Boolean(relevancy);
                          if (!show) return null;
                          return (
                            <div className="hidden flex-wrap items-center gap-1 sm:flex">
                              <span className={relPill}>Relevancy: {relevancy ? relKey : "—"}</span>
                              <span className={stagePill}>
                                Stage match: {stageMatch === null ? "—" : stageMatch ? "yes" : "no"}
                              </span>
                            </div>
                          );
                        })()}
                      </div>
                      <button
                        type="button"
                        className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
                        disabled={qualityReviewLoading}
                        onClick={() => void rerunRequestReview()}
                      >
                        Rerun review
                      </button>
                    </div>
                    <div className="mt-2 text-sm text-[var(--muted)]">
                      Review-agent intel extracted from the received document.
                    </div>

                    {hasHydratedFromServer && replaceUrl ? (
                      <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                          Replace upload link
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <input
                            ref={replaceInputRef}
                            readOnly
                            value={replaceUrl}
                            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[12px] text-[var(--fg)]"
                            aria-label="Replacement upload link"
                            onFocus={(e) => e.currentTarget.select()}
                          />
                          <CopyButton
                            copyDone={replaceCopyDone}
                            isCopying={replaceIsCopying}
                            onCopy={() => void copyReplaceLink()}
                            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
                            iconClassName="h-4 w-4"
                            label="Copy"
                            copiedLabel="Copied"
                            copyAriaLabel="Copy replacement upload link"
                          />
                        </div>
                        <div className="mt-2 text-[12px] text-[var(--muted)]">
                          Anyone with this link can upload a new version to replace the current file.
                        </div>
                      </div>
                    ) : null}

                    <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                        Company
                      </div>
                      <div className="mt-2 grid gap-2 text-sm">
                        <div className="grid grid-cols-[120px_1fr] gap-2">
                          <div className="text-[12px] font-medium text-[var(--muted)]">Name</div>
                          <div className="min-w-0 text-[12px] text-[var(--fg)]">
                            {intel.companyName ?? <span className="text-[var(--muted)]">—</span>}
                          </div>
                        </div>
                        <div className="grid grid-cols-[120px_1fr] gap-2">
                          <div className="text-[12px] font-medium text-[var(--muted)]">URL</div>
                          <div className="min-w-0 text-[12px] text-[var(--fg)]">
                            {intel.companyUrl ? (
                              <a
                                href={intel.companyUrl}
                                className="break-all underline decoration-transparent underline-offset-4 hover:decoration-[var(--border)]"
                                target="_blank"
                                rel="noreferrer"
                              >
                                {intel.companyUrl}
                              </a>
                            ) : (
                              <span className="text-[var(--muted)]">—</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                        Contact
                      </div>
                      <div className="mt-2 grid gap-2 text-sm">
                        <div className="grid grid-cols-[120px_1fr] gap-2">
                          <div className="text-[12px] font-medium text-[var(--muted)]">Name</div>
                          <div className="min-w-0 text-[12px] text-[var(--fg)]">
                            {intel.contactName ?? <span className="text-[var(--muted)]">—</span>}
                          </div>
                        </div>
                        <div className="grid grid-cols-[120px_1fr] gap-2">
                          <div className="text-[12px] font-medium text-[var(--muted)]">Email</div>
                          <div className="min-w-0 text-[12px] text-[var(--fg)]">
                            {intel.contactEmail ? (
                              <a
                                href={`mailto:${intel.contactEmail}`}
                                className="break-all underline decoration-transparent underline-offset-4 hover:decoration-[var(--border)]"
                              >
                                {intel.contactEmail}
                              </a>
                            ) : (
                              <span className="text-[var(--muted)]">—</span>
                            )}
                          </div>
                        </div>
                        <div className="grid grid-cols-[120px_1fr] gap-2">
                          <div className="text-[12px] font-medium text-[var(--muted)]">URL</div>
                          <div className="min-w-0 text-[12px] text-[var(--fg)]">
                            {intel.contactUrl ? (
                              <a
                                href={intel.contactUrl}
                                className="break-all underline decoration-transparent underline-offset-4 hover:decoration-[var(--border)]"
                                target="_blank"
                                rel="noreferrer"
                              >
                                {intel.contactUrl}
                              </a>
                            ) : (
                              <span className="text-[var(--muted)]">—</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                        Intel <span className="text-[var(--muted)]">(made by review agent)</span>
                      </div>

                      {(() => {
                        const s = (qualityReview?.status ?? "").toLowerCase();
                        if (s === "queued" || s === "processing") {
                          return (
                            <div className="mt-2 text-[12px] text-[var(--muted)]">
                              Review running… (status:{" "}
                              <span className="font-medium text-[var(--fg)]">{s}</span>)
                            </div>
                          );
                        }
                        if (s === "failed") {
                          return (
                            <div className="mt-2 text-[12px] text-red-600">
                              Review failed. Try “Rerun review”.
                            </div>
                          );
                        }
                        if (s === "skipped") {
                          return (
                            <div className="mt-2 text-[12px] text-[var(--muted)]">
                              Review skipped.
                            </div>
                          );
                        }
                        return null;
                      })()}

                      {qualityReview?.agentKind === "requestReviewInvestorFocused" ? (
                        <div className="mt-2 grid gap-2 text-sm">
                          <div className="grid grid-cols-[140px_1fr] gap-2">
                            <div className="text-[12px] font-medium text-[var(--muted)]">Relevancy</div>
                            <div className="min-w-0 text-[12px] text-[var(--fg)]">
                              {qualityReview.agentOutput?.relevancy ? (
                                <span className="font-semibold">
                                  {String(qualityReview.agentOutput.relevancy).toUpperCase()}
                                </span>
                              ) : (
                                <span className="text-[var(--muted)]">—</span>
                              )}
                            </div>
                          </div>
                          <div className="grid grid-cols-[140px_1fr] gap-2">
                            <div className="text-[12px] font-medium text-[var(--muted)]">Stage match note</div>
                            <div className="min-w-0 text-[12px] text-[var(--fg)]">
                              {qualityReview.agentOutput?.notes ? (
                                qualityReview.agentOutput.notes
                              ) : (
                                <span className="text-[var(--muted)]">—</span>
                              )}
                            </div>
                          </div>
                          <div className="grid grid-cols-[140px_1fr] gap-2">
                            <div className="text-[12px] font-medium text-[var(--muted)]">Relevancy reason</div>
                            <div className="min-w-0 text-[12px] text-[var(--fg)]">
                              {qualityReview.agentOutput?.relevancy_reason ? (
                                qualityReview.agentOutput.relevancy_reason
                              ) : (
                                <span className="text-[var(--muted)]">—</span>
                              )}
                            </div>
                          </div>

                          {Array.isArray(qualityReview.agentOutput?.strengths) && qualityReview.agentOutput?.strengths?.length ? (
                            <div className="mt-2">
                              <div className="text-[12px] font-semibold text-[var(--fg)]">Strengths</div>
                              <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[12px] text-[var(--fg)]">
                                {qualityReview.agentOutput.strengths.slice(0, 10).map((s, idx) => (
                                  <li key={`rs:${idx}`}>{s}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}

                          {Array.isArray(qualityReview.agentOutput?.weaknesses) && qualityReview.agentOutput?.weaknesses?.length ? (
                            <div className="mt-2">
                              <div className="text-[12px] font-semibold text-[var(--fg)]">Weaknesses</div>
                              <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[12px] text-[var(--fg)]">
                                {qualityReview.agentOutput.weaknesses.slice(0, 10).map((w, idx) => (
                                  <li key={`rw:${idx}`}>{w}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}

                          {Array.isArray(qualityReview.agentOutput?.key_open_questions) &&
                          qualityReview.agentOutput?.key_open_questions?.length ? (
                            <div className="mt-2">
                              <div className="text-[12px] font-semibold text-[var(--fg)]">Key open questions</div>
                              <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[12px] text-[var(--fg)]">
                                {qualityReview.agentOutput.key_open_questions.slice(0, 10).map((q, idx) => (
                                  <li key={`rq:${idx}`}>{q}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}

                          {qualityReview.agentOutput?.founder_note ? (
                            <div className="mt-2">
                              <div className="text-[12px] font-semibold text-[var(--fg)]">Founder note</div>
                              <div className="mt-1 text-[12px] text-[var(--fg)]">{qualityReview.agentOutput.founder_note}</div>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="mt-2 grid gap-2 text-sm">
                        <div className="grid grid-cols-[140px_1fr] gap-2">
                          <div className="text-[12px] font-medium text-[var(--muted)]">Overall assessment</div>
                          <div className="min-w-0 text-[12px] text-[var(--fg)]">
                            {intel.overallAssessment ?? <span className="text-[var(--muted)]">—</span>}
                          </div>
                        </div>
                        <div className="grid grid-cols-[140px_1fr] gap-2">
                          <div className="text-[12px] font-medium text-[var(--muted)]">Relevance score</div>
                          <div className="min-w-0 text-[12px] text-[var(--fg)]">
                            {typeof intel.effectivenessScore === "number" ? (
                              <span className="font-semibold">{intel.effectivenessScore} / 10</span>
                            ) : (
                              <span className="text-[var(--muted)]">—</span>
                            )}
                          </div>
                        </div>
                        <div className="grid grid-cols-[140px_1fr] gap-2">
                          <div className="text-[12px] font-medium text-[var(--muted)]">Relevance rationale</div>
                          <div className="min-w-0 text-[12px] text-[var(--fg)]">
                            {intel.scoreRationale ?? <span className="text-[var(--muted)]">—</span>}
                          </div>
                        </div>

                        {Array.isArray(intel.strengths) && intel.strengths.length ? (
                          <div className="mt-2">
                            <div className="text-[12px] font-semibold text-[var(--fg)]">Strengths</div>
                            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[12px] text-[var(--fg)]">
                              {intel.strengths.slice(0, 10).map((s, idx) => (
                                <li key={`s:${idx}`}>
                                  <span className="font-medium">{s.title}</span>
                                  {s.detail ? <span className="text-[var(--muted)]"> — {s.detail}</span> : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {Array.isArray(intel.weaknessesAndRisks) && intel.weaknessesAndRisks.length ? (
                          <div className="mt-2">
                            <div className="text-[12px] font-semibold text-[var(--fg)]">Weaknesses & risks</div>
                            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[12px] text-[var(--fg)]">
                              {intel.weaknessesAndRisks.slice(0, 10).map((w, idx) => (
                                <li key={`w:${idx}`}>
                                  <span className="font-medium">{w.title}</span>
                                  {w.detail ? <span className="text-[var(--muted)]"> — {w.detail}</span> : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {Array.isArray(intel.recommendations) && intel.recommendations.length ? (
                          <div className="mt-2">
                            <div className="text-[12px] font-semibold text-[var(--fg)]">Recommendations</div>
                            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[12px] text-[var(--fg)]">
                              {intel.recommendations.slice(0, 10).map((r, idx) => (
                                <li key={`r:${idx}`}>
                                  <span className="font-medium">{r.title}</span>
                                  {r.detail ? <span className="text-[var(--muted)]"> — {r.detail}</span> : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {Array.isArray(intel.actionItems) && intel.actionItems.length ? (
                          <div className="mt-2">
                            <div className="text-[12px] font-semibold text-[var(--fg)]">Action items</div>
                            <div className="mt-1 text-[12px] text-[var(--muted)]">
                              Things to ask the sender to improve or clarify.
                            </div>
                            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[12px] text-[var(--fg)]">
                              {intel.actionItems.slice(0, 10).map((a, idx) => (
                                <li key={`a:${idx}`}>
                                  <span className="font-medium">{a.title}</span>
                                  {a.detail ? <span className="text-[var(--muted)]"> — {a.detail}</span> : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                      )}
                    </div>

                    <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                        Intel detail
                      </div>
                      {qualityReviewError ? (
                        <div className="mt-2 text-sm text-red-600">{qualityReviewError}</div>
                      ) : qualityReviewLoading && !qualityReview ? (
                        <div className="mt-2 text-sm text-[var(--muted)]">Loading intel…</div>
                      ) : qualityReview?.outputMarkdown ? (
                        <div className="mt-3 text-sm leading-relaxed text-[var(--fg)]">
                          <Markdown>{qualityReview.outputMarkdown}</Markdown>
                        </div>
                      ) : (
                        <div className="mt-2 text-sm text-[var(--muted)]">
                          No intel available yet. If processing just finished, wait a moment and refresh.
                        </div>
                      )}
                    </div>

                    {/* Intel is already displayed in this panel; no need for an extra "Open Intel" button. */}
                  </aside>
                ) : isReceivedViaRequest ? (
                  <aside className="min-h-0 overflow-auto rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
                    <div className="text-sm font-semibold">Summary</div>
                    <div className="mt-2 text-sm text-[var(--muted)]">
                      Auto summary extracted from the uploaded document.
                    </div>

                    {hasHydratedFromServer && replaceUrl ? (
                      <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                          Replace upload link
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <input
                            ref={replaceInputRef}
                            readOnly
                            value={replaceUrl}
                            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[12px] text-[var(--fg)]"
                            aria-label="Replacement upload link"
                            onFocus={(e) => e.currentTarget.select()}
                          />
                          <CopyButton
                            copyDone={replaceCopyDone}
                            isCopying={replaceIsCopying}
                            onCopy={() => void copyReplaceLink()}
                            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
                            iconClassName="h-4 w-4"
                            label="Copy"
                            copiedLabel="Copied"
                            copyAriaLabel="Copy replacement upload link"
                          />
                        </div>
                        <div className="mt-2 text-[12px] text-[var(--muted)]">
                          Anyone with this link can upload a new version to replace the current file.
                        </div>
                      </div>
                    ) : null}

                    {docSummary.companyOrProjectName ? (
                      <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                          Company / project
                        </div>
                        <div className="mt-2 text-[12px] text-[var(--fg)]">{docSummary.companyOrProjectName}</div>
                      </div>
                    ) : null}

                    {docSummary.oneLiner ? ( 
                      <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                          One-liner
                        </div>
                        <div className="mt-2 text-[12px] text-[var(--fg)]">{docSummary.oneLiner}</div>
                      </div>
                    ) : null}

                    <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                        Summary
                      </div>
                      {docSummary.summary ? (
                        <div className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--fg)]">
                          {docSummary.summary}
                        </div>
                      ) : (
                        <div className="mt-2 text-[12px] text-[var(--muted)]">No summary available yet.</div>
                      )}
                    </div>

                    {docSummary.ask ? (
                      <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                          Ask
                        </div>
                        <div className="mt-2 text-[12px] text-[var(--fg)]">{docSummary.ask}</div>
                      </div>
                    ) : null}

                    {docSummary.tags?.length ? (
                      <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                          Tags
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {docSummary.tags.map((t) => (
                            <span
                              key={t}
                              className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--panel)] px-2 py-0.5 text-[11px] font-semibold text-[var(--muted)]"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </aside>
                ) : (
                  <aside className="min-h-0 overflow-auto rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
                    <div className="text-sm font-semibold">
                      {doc.status === "failed" ? "Upload failed" : "Preparing"}
                    </div>
                    <div className="mt-2 text-sm text-[var(--muted)]">
                      {doc.status === "failed"
                        ? "Processing failed. Replace the file to try again."
                        : "We’re preparing your PDF. Nothing you need to do."}
                    </div>
                  </aside>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <Modal open={showStarAuthModal} onClose={() => setShowStarAuthModal(false)} ariaLabel="Sign up to star docs">
        <div className="text-base font-semibold text-[var(--fg)]">Sign up to star docs</div>
        <div className="mt-3 text-sm text-[var(--muted)]">
          To use starring, please sign up or log in. Your starred docs will be saved to your new account.
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-lg bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
            onClick={() => setShowStarAuthModal(false)}
          >
            Sign up / Log in
          </Link>
          <button
            type="button"
            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
            onClick={() => setShowStarAuthModal(false)}
          >
            Not now
          </button>
        </div>
      </Modal>

      <TempUserGateModal
        open={tempGateOpen}
        onClose={() => setTempGateOpen(false)}
        authEnabled={authEnabled}
      />

      <Modal
        open={qualityReviewOpen}
        onClose={() => {
          if (qualityReviewLoading) return;
          setQualityReviewOpen(false);
          setQualityReviewError(null);
        }}
        ariaLabel="Quality review"
        panelClassName="w-[min(860px,calc(100vw-32px))]"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-base font-semibold text-[var(--fg)]">Quality review</div>
            <div className="mt-1 text-sm text-[var(--muted)]">
              AI-generated, stored per upload version.
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              if (isReceivedViaRequest) {
                void rerunRequestReview();
                return;
              }
              void refreshQualityReview();
            }}
            disabled={qualityReviewLoading}
            className="inline-flex shrink-0 items-center justify-center rounded-lg bg-[var(--primary-bg)] px-3 py-2 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isReceivedViaRequest ? "Rerun review" : (qualityReviewLoading ? "Refreshing…" : "Refresh")}
          </button>
        </div>

        <div className="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
          {qualityReviewError ? (
            <div className="text-sm text-red-700">{qualityReviewError}</div>
          ) : qualityReviewLoading && !qualityReview ? (
            <div className="text-sm text-[var(--muted)]">Loading…</div>
          ) : !qualityReview ? (
            <div className="text-sm text-[var(--muted)]">No review found for this doc yet.</div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-semibold text-[var(--fg)]">
                  Version {qualityReview.version ?? "-"}
                </div>
                <div className="text-xs font-medium text-[var(--muted-2)]">
                  Status:{" "}
                  <span className="text-[var(--muted)]">{qualityReview.status ?? "-"}</span>
                  {qualityReview.model ? (
                    <>
                      {" "}
                      · Model: <span className="text-[var(--muted)]">{qualityReview.model}</span>
                    </>
                  ) : null}
                </div>
              </div>

              {qualityReview.outputMarkdown ? (
                <Markdown className="mt-4 text-sm">{qualityReview.outputMarkdown}</Markdown>
              ) : (
                <div className="mt-4 text-sm text-[var(--muted)]">No review output yet.</div>
              )}
            </>
          )}
        </div>
      </Modal>

      <DocProjectsModal
        open={showProjectsModal}
        projects={projects}
        onClose={() => setShowProjectsModal(false)}
      />

    </>
  );
}
/**
 * Render the StarIcon UI.
 */


function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      className="h-4 w-4"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"
      />
    </svg>
  );
}

