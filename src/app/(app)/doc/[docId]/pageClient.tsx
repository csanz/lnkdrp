"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowPathIcon, FolderIcon } from "@heroicons/react/24/outline";
import UploadButton from "@/components/UploadButton";
import DocSharePanel from "@/components/DocSharePanel";
import TempUserGateModal from "@/components/modals/TempUserGateModal";
import DocActionsMenu from "@/components/DocActionsMenu";
import DocProjectsModal, { type DocProjectListItem } from "@/components/modals/DocProjectsModal";
import { useAuthEnabled, useNavigationLockWhile } from "@/app/providers";
import { fetchJson } from "@/lib/http/fetchJson";
import { apiCreateUpload, startBlobUploadAndProcess } from "@/lib/client/docUploadPipeline";
import { buildPublicShareUrl } from "@/lib/urls";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import Modal from "@/components/modals/Modal";
import Markdown from "@/components/Markdown";
import {
  isDocStarred,
  STARRED_DOCS_CHANGED_EVENT,
  toggleStarredDoc,
  upsertStarredDocTitle,
} from "@/lib/starredDocs";
import { getSidebarCacheSnapshot, notifyDocsChanged, setSidebarCacheSnapshot } from "@/lib/sidebarCache";

type DocStatus = "draft" | "preparing" | "ready" | "failed";

type DocDTO = {
  id: string;
  shareId: string | null;
  title: string;
  status: DocStatus;
  projectId?: string | null;
  project?: { id: string; name: string } | null;
  projectIds?: string[];
  projects?: Array<{ id: string; name: string; slug?: string }>;
  isArchived?: boolean;
  currentUploadId: string | null;
  currentUploadVersion?: number | null;
  blobUrl: string | null;
  previewImageUrl: string | null;
  extractedText: string | null;
  aiOutput?: unknown | null;
  receiverRelevanceChecklist?: boolean;
  shareAllowPdfDownload?: boolean;
  sharePasswordEnabled?: boolean;
};

type UploadDTO = {
  id: string;
  version: number | null;
  status: string | null;
  error?: unknown | null;
};

function buildCachedPdfIframeUrl(docId: string, currentUploadVersion?: number | null) {
  const v =
    typeof currentUploadVersion === "number" && Number.isFinite(currentUploadVersion)
      ? currentUploadVersion
      : 0;
  // Versioned URL so the browser can cache indefinitely, and "replace file"
  // forces a new URL (cache miss) automatically.
  return `/api/docs/${encodeURIComponent(docId)}/pdf?v=${encodeURIComponent(String(v))}`;
}

export default function DocPageClient({ initialDoc }: { initialDoc: DocDTO }) {
  const router = useRouter();
  const authEnabled = useAuthEnabled();
  const [doc, setDoc] = useState<DocDTO>(initialDoc);
  const [currentUpload, setCurrentUpload] = useState<UploadDTO | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState<string>(() => (initialDoc.title || "").toString());
  const [titleSaveBusy, setTitleSaveBusy] = useState(false);
  const [titleSaveError, setTitleSaveError] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [localPreviewUploadId, setLocalPreviewUploadId] = useState<string | null>(null);
  const [isCopying, setIsCopying] = useState(false);
  const [copyDone, setCopyDone] = useState(false);
  const [preparingTick, setPreparingTick] = useState(0);
  const [hasHydratedFromServer, setHasHydratedFromServer] = useState(false);
  const [starred, setStarred] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState<boolean | null>(null);
  const [showStarAuthModal, setShowStarAuthModal] = useState(false);
  const [tempGateOpen, setTempGateOpen] = useState(false);
  const shareInputRef = useRef<HTMLInputElement | null>(null);
  const [showProjectsModal, setShowProjectsModal] = useState(false);

  const [qualityReviewOpen, setQualityReviewOpen] = useState(false);
  const [qualityReviewLoading, setQualityReviewLoading] = useState(false);
  const [qualityReviewError, setQualityReviewError] = useState<string | null>(null);
  const [qualityReview, setQualityReview] = useState<null | {
    id: string;
    version: number | null;
    status: string | null;
    model: string | null;
    outputMarkdown: string | null;
    createdDate: string | null;
    updatedDate: string | null;
  }>(null);

  const preparingStartedAtRef = useRef<number>(Date.now());
  const hasProcessedThisSessionRef = useRef<boolean>(initialDoc.status !== "ready");

  const navLockActive = useMemo(() => {
    // IMPORTANT:
    // This route is client-first and initially renders with a placeholder doc ("preparing")
    // until we hydrate from `/api/docs/:id`. We don't want the sidebar (logo + "Add new")
    // to flash into a disabled/dim state on refresh/navigation during that brief hydrate.
    //
    // Only lock navigation once we have server-backed state that confirms we're actively
    // uploading/processing.
    if (!hasHydratedFromServer) return false;
    return doc.status === "preparing" || doc.status === "draft";
  }, [doc.status, hasHydratedFromServer]);

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

    function onChanged() {
      setStarred(isDocStarred(doc.id));
    }

    function onStorage(e: StorageEvent) {
      // Any localStorage changes from other tabs should trigger a re-check.
      if (e.storageArea !== window.localStorage) return;
      onChanged();
    }

    window.addEventListener(STARRED_DOCS_CHANGED_EVENT, onChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(STARRED_DOCS_CHANGED_EVENT, onChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, [doc.id]);

  useEffect(() => {
    // Best-effort session detection. Only relevant when auth is enabled.
    if (!authEnabled) {
      setIsSignedIn(null);
      return;
    }

    let cancelled = false;
    async function loadSession() {
      try {
        const res = await fetch("/api/auth/session", { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setIsSignedIn(false);
          return;
        }
        const json = (await res.json()) as { user?: unknown };
        if (cancelled) return;
        const hasUser = Boolean(json && typeof json === "object" && (json as { user?: unknown }).user);
        setIsSignedIn(hasUser);
      } catch {
        if (!cancelled) setIsSignedIn(false);
      }
    }

    void loadSession();
    return () => {
      cancelled = true;
    };
  }, [authEnabled]);

  async function handleToggleStar() {
    if (navLockActive) return;
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

    async function refresh() {
      try {
        const res = await fetchWithTempUser(`/api/docs/${doc.id}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { doc: DocDTO; upload?: UploadDTO | null };
        if (cancelled) return;
        setDoc((prev) => ({ ...prev, ...data.doc }));
        setCurrentUpload(data.upload ?? null);
        setHasHydratedFromServer(true);
      } catch {
        // ignore
      }
    }

    void refresh();

    // Poll while:
    // - doc isn't ready yet, OR
    // - doc is ready but shareId hasn't arrived yet (we need it to form /s/:id).
    const shouldPoll = doc.status !== "ready" || !doc.shareId;
    if (!shouldPoll) return () => void 0;

    const id = window.setInterval(refresh, 900);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [doc.id, doc.status, doc.shareId]);

  const shareUrl = useMemo(() => {
    return buildPublicShareUrl(doc.shareId);
  }, [doc.shareId]);

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
    if (!hasHydratedFromServer) return "Loading document…";
    const elapsed = Date.now() - preparingStartedAtRef.current;
    if (elapsed > 3000) return "AI is extracting text…";
    if (elapsed > 1500) return "Generating preview…";
    return "Preparing document…";
  })();

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

  async function refreshQualityReview() {
    setQualityReviewLoading(true);
    setQualityReviewError(null);
    try {
      const res = await fetchWithTempUser(`/api/docs/${doc.id}/reviews?latest=1`, { cache: "no-store" });
      if (res.status === 404) {
        setQualityReview(null);
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
          createdDate?: unknown;
          updatedDate?: unknown;
        }>;
      };
      const r = Array.isArray(json.reviews) ? json.reviews[0] : null;
      if (!r) {
        setQualityReview(null);
        return;
      }
      setQualityReview({
        id: typeof r.id === "string" ? r.id : "",
        version: typeof r.version === "number" ? r.version : null,
        status: typeof r.status === "string" ? r.status : null,
        model: typeof r.model === "string" ? r.model : null,
        outputMarkdown: typeof r.outputMarkdown === "string" ? r.outputMarkdown : null,
        createdDate: typeof r.createdDate === "string" ? r.createdDate : null,
        updatedDate: typeof r.updatedDate === "string" ? r.updatedDate : null,
      });
    } catch (e) {
      setQualityReviewError(e instanceof Error ? e.message : "Failed to load review");
    } finally {
      setQualityReviewLoading(false);
    }
  }

  useEffect(() => {
    if (!qualityReviewOpen) return;
    void refreshQualityReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qualityReviewOpen, doc.id]);

  const shouldPollQualityReview = useMemo(() => {
    if (!qualityReviewOpen) return false;
    const s = (qualityReview?.status ?? "").toLowerCase();
    return s === "queued" || s === "processing";
  }, [qualityReviewOpen, qualityReview?.status]);

  useEffect(() => {
    if (!shouldPollQualityReview) return;
    const id = window.setInterval(() => void refreshQualityReview(), 1500);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldPollQualityReview]);

  /**
   * Replace the document's current PDF by creating a new upload record and
   * restarting the processing pipeline.
   */
  async function replaceFile(file: File) {
    // Keep route stable; create a new upload record and rerun the pipeline.
    try {
      // Immediately clear the current view and show a local preview for the new file.
      setLocalPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });

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
      // Optimistically update the sidebar's version badge (so it never "disappears"),
      // then force a refresh so server truth lands quickly.
      const optimisticNextVersion =
        typeof doc.currentUploadVersion === "number" && Number.isFinite(doc.currentUploadVersion)
          ? doc.currentUploadVersion + 1
          : null;
      if (typeof optimisticNextVersion === "number" && Number.isFinite(optimisticNextVersion)) {
        const snap = getSidebarCacheSnapshot();
        if (snap) {
          const nowIso = new Date().toISOString();
          setSidebarCacheSnapshot({
            ...snap,
            updatedAt: Date.now(),
            docs: {
              ...snap.docs,
              items: snap.docs.items.map((it) =>
                it.id === doc.id
                  ? { ...it, version: optimisticNextVersion, status: "preparing", updatedDate: nowIso }
                  : it,
              ),
            },
          });
        }
      }
      notifyDocsChanged();

      // Set local state to preparing immediately.
      setDoc((d) => ({
        ...d,
        status: "preparing",
        currentUploadId: newUploadId,
        currentUploadVersion:
          typeof d.currentUploadVersion === "number" ? d.currentUploadVersion + 1 : d.currentUploadVersion,
        previewImageUrl: null,
        extractedText: null,
      }));
      preparingStartedAtRef.current = Date.now();

      // Start direct-to-blob upload in the background (do not block UI).
      startBlobUploadAndProcess({
        docId: doc.id,
        uploadId: newUploadId,
        file,
        onFailure: async (message) => {
          // Mark DB state as failed so the UI can surface it consistently.
          try {
            await fetchJson(`/api/uploads/${newUploadId}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: "failed", error: { message } }),
            });
            await fetchJson(`/api/docs/${doc.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: "failed" }),
            });
          } catch {
            // ignore
          }
        },
      });
    } catch {
      // ignore
    }
  }

  return (
    <>
      <div className="flex h-full flex-col">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] bg-[var(--panel)] px-6 py-4">
            <div className="min-w-0 flex items-center gap-3">
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
                  navLockActive ? "cursor-not-allowed opacity-50 hover:bg-[var(--panel)]" : "",
                ].join(" ")}
                disabled={navLockActive}
                aria-disabled={navLockActive}
                aria-label={starred ? "Unstar document" : "Star document"}
                title={
                  navLockActive
                    ? "Disabled while uploading"
                    : starred
                      ? "Starred"
                      : "Star"
                }
              >
                <StarIcon filled={starred} />
              </button>
              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1">
                  {editingTitle ? (
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
                  ) : (
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
                        "block w-full min-w-0 truncate text-left text-sm font-semibold text-[var(--fg)]",
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
                  )}
                </div>

                {projectsInline.length ? (
                  <div className="inline-flex shrink-0 flex-wrap items-center gap-1 text-sm font-medium text-[var(--muted-2)]">
                    {projectsInline.map((p) => {
                      const href = p.slug ? `/project/${encodeURIComponent(p.slug)}` : null;
                      const Pill = (
                        <span
                          className={[
                            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5",
                            "text-[12px] font-medium text-[var(--muted-2)]",
                            "bg-transparent hover:bg-[var(--panel-hover)]",
                          ].join(" ")}
                        >
                          <FolderIcon className="h-3.5 w-3.5 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
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

            <div className="flex items-center gap-3">
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
            </div>
          </div>

          {/* Content */}
        <div className="min-h-0 flex-1 overflow-hidden bg-[var(--bg)]">
          <div className="h-full px-6 py-6">
            <div className="grid h-full min-h-0 gap-5 lg:grid-cols-[1.35fr_0.65fr]">
                <section className="relative min-h-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
                  {/* progress bar (pinned top) */}
                  {(!hasHydratedFromServer ||
                    doc.status === "preparing" ||
                    doc.status === "draft") && (
                    <div className="absolute left-0 right-0 top-0 z-20 h-1 overflow-hidden bg-[var(--border)]">
                      <div className="h-full w-1/3 bg-[var(--primary-bg)] animate-[lnkdrpIndeterminate_1.05s_ease-in-out_infinite]" />
                    </div>
                  )}

                  <div className="h-full w-full bg-[var(--panel-2)]">
                    {localPreviewUrl ? (
                      <iframe
                        title="PDF preview"
                        src={localPreviewUrl}
                        className="block h-full w-full border-0"
                        allow="fullscreen"
                      />
                    ) : doc.blobUrl ? (
                      <iframe
                        title="PDF"
                        src={buildCachedPdfIframeUrl(doc.id, doc.currentUploadVersion)}
                        className="block h-full w-full border-0"
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
                  {(!hasHydratedFromServer ||
                    doc.status === "preparing" ||
                    doc.status === "draft") && (
                    <div className="absolute inset-0 z-10 grid place-items-center bg-[var(--bg)]/35 backdrop-blur-xl backdrop-saturate-150">
                      <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)]/90 px-6 py-4 text-sm font-medium text-[var(--fg)] shadow-[0_2px_10px_rgba(0,0,0,0.18)]">
                        {overlayText}
                      </div>
                    </div>
                  )}
                </section>

                {doc.status === "ready" ? (
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
                    sharePasswordEnabled={Boolean(doc.sharePasswordEnabled)}
                    onSharePasswordEnabledChange={(enabled) =>
                      setDoc((d) => ({ ...d, sharePasswordEnabled: enabled }))
                    }
                    aiOutput={doc.aiOutput ?? null}
                    uploadError={currentUpload?.error ?? null}
                  />
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
            onClick={() => void refreshQualityReview()}
            disabled={qualityReviewLoading}
            className="inline-flex shrink-0 items-center justify-center rounded-lg bg-[var(--primary-bg)] px-3 py-2 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {qualityReviewLoading ? "Refreshing…" : "Refresh"}
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

