"use client";

/**
 * Client UI for the `/project/[projectSlug]` page.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Cog6ToothIcon,
  FolderIcon,
  InboxArrowDownIcon,
  SparklesIcon,
  StarIcon as StarOutlineIcon,
  Square2StackIcon,
} from "@heroicons/react/24/outline";
import { StarIcon as StarSolidIcon } from "@heroicons/react/24/solid";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { trackProjectClick, trackProjectView } from "@/lib/metrics/client";
import DocActionsMenu from "@/components/DocActionsMenu";
import ProjectSharePanel from "@/components/ProjectSharePanel";
import { CopyButton } from "@/components/CopyButton";
import { isDocStarred, STARRED_DOCS_CHANGED_EVENT, toggleStarredDoc } from "@/lib/starredDocs";
import { DOCS_CHANGED_EVENT, PROJECTS_CHANGED_EVENT } from "@/lib/sidebarCache";
import Modal from "@/components/modals/Modal";
import { upload as blobUpload } from "@vercel/blob/client";
import { BLOB_HANDLE_UPLOAD_URL, buildDocBlobPathname } from "@/lib/blob/clientUpload";
import { notifyProjectsChanged, refreshSidebarCache } from "@/lib/sidebarCache";

type DocListItem = {
  id: string;
  shareId: string | null;
  title: string;
  summary?: string | null;
  status: string | null;
  version: number | null;
  reviewScore?: number | null;
  projectIds?: string[];
  previewImageUrl?: string | null;
  updatedDate: string | null;
  createdDate: string | null;
};

type ProjectDTO = {
  id: string;
  shareId: string | null;
  name: string;
  slug: string;
  description: string;
  autoAddFiles: boolean;
  isRequest?: boolean;
  request?: {
    uploadPath: string | null;
    viewPath: string | null;
    requireAuthToUpload: boolean;
    reviewEnabled: boolean;
    reviewPrompt: string;
    guideDocId: string | null;
    guideDocTitle: string | null;
  } | null;
};
type Paged<T> = { items: T[]; total: number; page: number; limit: number };

type ProjectDocsResponse = {
  project?: ProjectDTO;
  docs?: DocListItem[];
  total?: number;
  page?: number;
  limit?: number;
};

type ProjectDocsCacheEntry = {
  project: ProjectDTO | null;
  docs: Paged<DocListItem>;
  notFound: boolean;
  etag: string | null;
  ts: number;
};

type SuggestedDocItem = {
  id: string;
  shareId: string | null;
  title: string;
  summary: string | null;
  status: string | null;
  previewImageUrl: string | null;
  updatedDate: string | null;
  createdDate: string | null;
  matchCount: number;
};

type SuggestedDocsResponse = {
  tags?: string[];
  docs?: SuggestedDocItem[];
  error?: string;
};

const PROJECT_DOCS_CACHE_MAX = 75;
const PROJECT_DOCS_CACHE_TTL_MS = 3 * 60 * 1000;
const projectDocsCache = new Map<string, ProjectDocsCacheEntry>();
/**
 * Project Docs Cache Key (uses join, encodeURIComponent, String).
 */


function projectDocsCacheKey(params: { projectSlug: string; page: number; limit: number; q: string }) {
  return [
    encodeURIComponent(params.projectSlug),
    String(params.page),
    String(params.limit),
    params.q.trim(),
  ].join("|");
}
/**
 * Project Docs Cache Get (uses get, now, delete).
 */


function projectDocsCacheGet(key: string): ProjectDocsCacheEntry | null {
  const e = projectDocsCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > PROJECT_DOCS_CACHE_TTL_MS) {
    projectDocsCache.delete(key);
    return null;
  }
  return e;
}
/**
 * Project Docs Cache Set (uses set, now, sort).
 */


function projectDocsCacheSet(key: string, entry: Omit<ProjectDocsCacheEntry, "ts">) {
  projectDocsCache.set(key, { ...entry, ts: Date.now() });
  if (projectDocsCache.size <= PROJECT_DOCS_CACHE_MAX) return;
  const entries = Array.from(projectDocsCache.entries()).sort((a, b) => a[1].ts - b[1].ts);
  for (let i = 0; i < Math.max(0, entries.length - PROJECT_DOCS_CACHE_MAX); i++) {
    projectDocsCache.delete(entries[i]![0]);
  }
}
/**
 * Format Relative (uses parse, isFinite, now).
 */


function formatRelative(iso: string | null) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60000);
  if (mins <= 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}
/**
 * Render the ProjectPageClient UI (uses effects, memoized values, local state).
 */


export default function ProjectPageClient({ projectSlug }: { projectSlug: string }) {
  const MAX_PROJECT_NAME_LENGTH = 80;

  const router = useRouter();
  const [project, setProject] = useState<ProjectDTO | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showSuggestedDocs, setShowSuggestedDocs] = useState(false);
  const [suggestedDocsBusy, setSuggestedDocsBusy] = useState(false);
  const [suggestedDocsError, setSuggestedDocsError] = useState<string | null>(null);
  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [suggestedDocs, setSuggestedDocs] = useState<SuggestedDocItem[]>([]);
  const [suggestedSelectedById, setSuggestedSelectedById] = useState<Record<string, boolean>>({});
  const [addingSuggestedDocs, setAddingSuggestedDocs] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftAutoAddFiles, setDraftAutoAddFiles] = useState(false);
  const [draftRequestRequireAuthToUpload, setDraftRequestRequireAuthToUpload] = useState(false);
  const [draftRequestReviewEnabled, setDraftRequestReviewEnabled] = useState(false);
  const [draftRequestGuideFile, setDraftRequestGuideFile] = useState<File | null>(null);
  const [draftRequestGuideText, setDraftRequestGuideText] = useState("");
  const [copyRequestLinkDone, setCopyRequestLinkDone] = useState(false);
  const [copyRequestLinkCopying, setCopyRequestLinkCopying] = useState(false);
  const [copyRequestViewLinkDone, setCopyRequestViewLinkDone] = useState(false);
  const [copyRequestViewLinkCopying, setCopyRequestViewLinkCopying] = useState(false);
  const [showRequestReviewTemplates, setShowRequestReviewTemplates] = useState(false);
  const [draftRequestReviewAgentLabel, setDraftRequestReviewAgentLabel] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameSaveBusy, setNameSaveBusy] = useState(false);
  const [nameSaveError, setNameSaveError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [docs, setDocs] = useState<Paged<DocListItem>>({ items: [], total: 0, page: 1, limit: 25 });
  const [docsLoading, setDocsLoading] = useState(true);
  const [q, setQ] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [starredTick, setStarredTick] = useState(0);
  const [docsChangedTick, setDocsChangedTick] = useState(0);
  const [docsThumbAspectById, setDocsThumbAspectById] = useState<Record<string, number>>({});
  const [requestSort, setRequestSort] = useState<"recent" | "score">("recent");

  // Track project "view" (deduped server-side per session).
  useEffect(() => {
    if (typeof window === "undefined") return;
    trackProjectView({ projectId: projectSlug, path: window.location.pathname + window.location.search });
  }, [projectSlug]);

  useEffect(() => {
    let cancelled = false;
/**
 * Load (updates state (setNotFound, setProject, setDocs); uses trim, projectDocsCacheKey, projectDocsCacheGet).
 */

    async function load() {
      const trimmedQ = q.trim();
      const key = projectDocsCacheKey({
        projectSlug,
        page: docs.page,
        limit: docs.limit,
        q: trimmedQ,
      });
      const cached = projectDocsCacheGet(key);

      // If we have cached data, render immediately and revalidate in background.
      if (cached) {
        setNotFound(cached.notFound);
        setProject(cached.project);
        setDocs(cached.docs);
      }

      setDocsLoading(!cached);
      try {
        const qStr = trimmedQ ? `&q=${encodeURIComponent(trimmedQ)}` : "";
        const url = `/api/projects/${encodeURIComponent(projectSlug)}/docs?limit=${docs.limit}&page=${docs.page}${qStr}`;

        const res = await fetchWithTempUser(url, {
          // Only fetch JSON when the server says the list changed.
          headers: cached?.etag ? { "if-none-match": cached.etag } : undefined,
        });
        if (cancelled) return;
        if (res.status === 404) {
          setNotFound(true);
          // If the project was deleted out-of-band (e.g., DB reset), prune stale sidebar cache.
          notifyProjectsChanged();
          void refreshSidebarCache({ reason: "project-not-found", force: true });
          projectDocsCacheSet(key, {
            notFound: true,
            project: null,
            docs: { items: [], total: 0, page: docs.page, limit: docs.limit },
            etag: null,
          });
          setDocsLoading(false);
          return;
        }
        if (res.status === 304) {
          setDocsLoading(false);
          return;
        }
        if (!res.ok) return;
        const json = (await res.json()) as ProjectDocsResponse;
        if (cancelled) return;
        const nextProject = json.project ?? null;
        setNotFound(false);
        setProject(nextProject);
        setDocs((prev) => {
          const computed: Paged<DocListItem> = {
            items: Array.isArray(json.docs) ? json.docs : [],
            total: typeof json.total === "number" ? json.total : 0,
            page: typeof json.page === "number" ? json.page : prev.page,
            limit: typeof json.limit === "number" ? json.limit : prev.limit,
          };
          projectDocsCacheSet(key, {
            notFound: false,
            project: nextProject,
            docs: computed,
            etag: res.headers.get("etag"),
          });
          return computed;
        });
        setDocsLoading(false);
      } catch {
        // ignore
        if (!cancelled) setDocsLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectSlug, docs.page, docs.limit, q, docsChangedTick]);

  useEffect(() => {
/**
 * Handle docs changed events; updates state (setDocsChangedTick); uses clear, setDocsChangedTick.
 */

    // When docs are added/replaced elsewhere, force a revalidate so counts/versions stay correct.
    function onDocsChanged() {
      projectDocsCache.clear();
      setDocsChangedTick((t) => t + 1);
    }
    window.addEventListener(DOCS_CHANGED_EVENT, onDocsChanged);
    return () => window.removeEventListener(DOCS_CHANGED_EVENT, onDocsChanged);
  }, []);

  useEffect(() => {
    if (!project) return;
    // When navigating between projects, reset the draft to the loaded values.
    setDraftName(project.name ?? "");
    setDraftDescription(project.description ?? "");
    setDraftAutoAddFiles(Boolean(project.autoAddFiles));
    setDraftRequestRequireAuthToUpload(Boolean(project.request?.requireAuthToUpload));
    setDraftRequestReviewEnabled(Boolean(project.request?.reviewEnabled));
    // Request review "notes" UI removed; agent behavior is driven by Guide + server prompt.
    setDraftRequestGuideFile(null);
    setDraftRequestGuideText("");
    setDraftRequestReviewAgentLabel(Boolean(project.request?.reviewEnabled) ? "Venture Capitalist" : null);
    setSaveError(null);
  }, [project?.id]);

  useEffect(() => {
/**
 * Handle changed events; updates state (setStarredTick); uses setStarredTick.
 */

    function onChanged() {
      setStarredTick((t) => t + 1);
    }
/**
 * Handle storage events; uses onChanged.
 */

    function onStorage(e: StorageEvent) {
      if (e.storageArea !== window.localStorage) return;
      onChanged();
    }
    window.addEventListener(STARRED_DOCS_CHANGED_EVENT, onChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(STARRED_DOCS_CHANGED_EVENT, onChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Never show the slug as the visible title; wait for the full project name.
  const title = useMemo(() => project?.name ?? "", [project?.name]);
  const subtitle = useMemo(() => project?.description || "", [project?.description]);
  const maxPage = useMemo(() => Math.max(1, Math.ceil(docs.total / docs.limit)), [docs.total, docs.limit]);
  const isRequestRepo = useMemo(() => Boolean(project?.isRequest), [project?.isRequest]);
  const docsForList = useMemo(() => {
    if (!isRequestRepo) return docs.items;
    if (requestSort !== "score") return docs.items;
    const items = [...docs.items];
    items.sort((a, b) => {
      const as = typeof a.reviewScore === "number" && Number.isFinite(a.reviewScore) ? a.reviewScore : -1;
      const bs = typeof b.reviewScore === "number" && Number.isFinite(b.reviewScore) ? b.reviewScore : -1;
      if (bs !== as) return bs - as;
      const at = a.updatedDate ? Date.parse(a.updatedDate) : a.createdDate ? Date.parse(a.createdDate) : 0;
      const bt = b.updatedDate ? Date.parse(b.updatedDate) : b.createdDate ? Date.parse(b.createdDate) : 0;
      return bt - at;
    });
    return items;
  }, [docs.items, isRequestRepo, requestSort]);
  // This route uses `projectSlug` as the projectId; use it as a stable fallback before `project` loads.
  const projectIdForMenu = project?.id ?? projectSlug;

  useEffect(() => {
    // Keep draft in sync with server state when not actively editing.
    if (editingName) return;
    setNameDraft(title);
  }, [editingName, title]);

  useEffect(() => {
    if (!editingName) return;
    // focus/selection after the input mounts
    const id = window.setTimeout(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [editingName]);
/**
 * Save Name (updates state (setNameDraft, setEditingName, setNameSaveError); uses trim, setNameDraft, setEditingName).
 */


  async function saveName(nextRaw: string) {
    if (!project) return;
    const next = nextRaw.trim();

    // Don't allow empty names; treat as cancel.
    if (!next) {
      setNameDraft(title);
      setEditingName(false);
      setNameSaveError(null);
      return;
    }
    if (next.length > MAX_PROJECT_NAME_LENGTH) {
      setNameSaveError(`Project name must be ${MAX_PROJECT_NAME_LENGTH} characters or less.`);
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
      return;
    }
    // No-op
    if (next === (project.name ?? "")) {
      setEditingName(false);
      setNameSaveError(null);
      return;
    }

    setNameSaveBusy(true);
    setNameSaveError(null);
    try {
      // IMPORTANT: API requires name and will overwrite description/autoAddFiles from the request.
      // Preserve existing values so a rename doesn't reset settings.
      const res = await fetchWithTempUser(`/api/projects/${encodeURIComponent(projectSlug)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: next,
          description: project.description ?? "",
          autoAddFiles: Boolean(project.autoAddFiles),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { project?: ProjectDTO; error?: string };
      if (!res.ok) {
        setNameSaveError(json?.error || "Failed to rename project.");
        // Keep editing open so user can retry.
        nameInputRef.current?.focus();
        nameInputRef.current?.select();
        return;
      }
      if (json?.project) {
        setProject(json.project);
        setDraftName(json.project.name ?? "");
        setDraftDescription(json.project.description ?? "");
        setDraftAutoAddFiles(Boolean(json.project.autoAddFiles));
        setNameDraft(json.project.name ?? "");
      } else {
        setProject((p) => (p ? { ...p, name: next } : p));
        setDraftName(next);
        setNameDraft(next);
      }
      // Best-effort: notify other UI surfaces (sidebar cache) that projects changed.
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setEditingName(false);
    } catch {
      setNameSaveError("Failed to rename project.");
      // Keep editing open so user can retry.
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    } finally {
      setNameSaveBusy(false);
    }
  }

  const hasUnsavedChanges = useMemo(() => {
    if (!project) return false;
    const isRequestRepo = Boolean(project?.isRequest);
    const hasGuideText = Boolean(draftRequestGuideText.trim());
    const requestSettingsChanged =
      isRequestRepo &&
      (Boolean(draftRequestRequireAuthToUpload) !== Boolean(project.request?.requireAuthToUpload) ||
        Boolean(draftRequestReviewEnabled) !== Boolean(project.request?.reviewEnabled) ||
        (Boolean(draftRequestReviewEnabled) && (Boolean(draftRequestGuideFile) || hasGuideText)));
    return (
      draftName.trim() !== (project.name ?? "") ||
      draftDescription.trim() !== (project.description ?? "") ||
      Boolean(draftAutoAddFiles) !== Boolean(project.autoAddFiles) ||
      requestSettingsChanged
    );
  }, [draftAutoAddFiles, draftDescription, draftName, project, draftRequestRequireAuthToUpload, draftRequestGuideFile, draftRequestReviewEnabled, draftRequestGuideText]);
/**
 * Load Suggested Docs After Enabling Auto Add (updates state (setSuggestedDocsBusy, setSuggestedDocsError, setSuggestedTags); uses setSuggestedDocsBusy, setSuggestedDocsError, encodeURIComponent).
 */


  async function loadSuggestedDocsAfterEnablingAutoAdd() {
    // Best-effort only: don't block the save flow on this.
    setSuggestedDocsBusy(true);
    setSuggestedDocsError(null);
    try {
      const url = `/api/projects/${encodeURIComponent(projectSlug)}/suggested-docs?limit=20`;
      const res = await fetchWithTempUser(url);
      const json = (await res.json().catch(() => ({}))) as SuggestedDocsResponse;
      if (!res.ok) return;
      const tags = Array.isArray(json.tags) ? json.tags.filter((t) => typeof t === "string") : [];
      const docs = Array.isArray(json.docs) ? json.docs : [];
      if (!docs.length) return;
      setSuggestedTags(tags);
      setSuggestedDocs(docs);
      const selected: Record<string, boolean> = {};
      for (const d of docs) selected[d.id] = true;
      setSuggestedSelectedById(selected);
      setShowSuggestedDocs(true);
    } catch {
      // ignore
    } finally {
      setSuggestedDocsBusy(false);
    }
  }
/**
 * Add Selected Suggested Docs To Project (updates state (setShowSuggestedDocs, setAddingSuggestedDocs, setSuggestedDocsError); uses map, filter, Boolean).
 */


  async function addSelectedSuggestedDocsToProject() {
    if (!project) return;
    const selectedIds = suggestedDocs
      .filter((d) => Boolean(suggestedSelectedById[d.id]))
      .map((d) => d.id);
    if (!selectedIds.length) {
      setShowSuggestedDocs(false);
      return;
    }

    setAddingSuggestedDocs(true);
    setSuggestedDocsError(null);
    try {
      let idx = 0;
      const concurrency = Math.min(4, selectedIds.length);
      const workers = Array.from({ length: concurrency }, async () => {
        while (idx < selectedIds.length) {
          const current = selectedIds[idx];
          idx += 1;
          if (!current) continue;
          const res = await fetchWithTempUser(`/api/docs/${encodeURIComponent(current)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ addProjectId: project.id }),
          });
          if (!res.ok) {
            const json = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(json?.error || "Failed to add one or more docs.");
          }
        }
      });
      await Promise.all(workers);

      setShowSuggestedDocs(false);
      setSuggestedDocs([]);
      setSuggestedTags([]);
      setSuggestedSelectedById({});

      // Force lists/counts to revalidate.
      projectDocsCache.clear();
      window.dispatchEvent(new Event(DOCS_CHANGED_EVENT));
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
    } catch (err) {
      setSuggestedDocsError(err instanceof Error ? err.message : "Failed to add one or more docs.");
    } finally {
      setAddingSuggestedDocs(false);
    }
  }
/**
 * Save Project (updates state (setSaveError, setSaving, setProject); uses Boolean, trim, setSaveError).
 */


  async function saveProject() {
    if (!project) return;
    const enablingAutoAddFiles = !Boolean(project.autoAddFiles) && Boolean(draftAutoAddFiles);
    const isRequestRepo = Boolean(project.isRequest);
    const hasExistingGuide = Boolean(project.request?.guideDocId);
    const hasGuideText = Boolean(draftRequestGuideText.trim());
    const name = draftName.trim();
    if (!name) {
      setSaveError("Project name is required.");
      return;
    }
    if (name.length > MAX_PROJECT_NAME_LENGTH) {
      setSaveError(`Project name must be ${MAX_PROJECT_NAME_LENGTH} characters or less.`);
      return;
    }
    if (
      isRequestRepo &&
      Boolean(draftRequestReviewEnabled) &&
      !draftRequestGuideFile &&
      !hasGuideText &&
      !hasExistingGuide
    ) {
      setSaveError("Evaluation guide is required to enable the review agent.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetchWithTempUser(`/api/projects/${encodeURIComponent(projectSlug)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          description: draftDescription.trim(),
          autoAddFiles: Boolean(draftAutoAddFiles),
          requestRequireAuthToUpload: Boolean(draftRequestRequireAuthToUpload),
          requestReviewEnabled: Boolean(draftRequestReviewEnabled),
          requestReviewPrompt: "",
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { project?: ProjectDTO; error?: string };
      if (!res.ok) {
        setSaveError(json?.error || "Failed to save project.");
        return;
      }
      if (json?.project) {
        setProject(json.project);
        setDraftName(json.project.name ?? "");
        setDraftDescription(json.project.description ?? "");
        setDraftAutoAddFiles(Boolean(json.project.autoAddFiles));
        setDraftRequestRequireAuthToUpload(Boolean(json.project.request?.requireAuthToUpload));
        setDraftRequestReviewEnabled(Boolean(json.project.request?.reviewEnabled));
        setDraftRequestReviewAgentLabel(Boolean(json.project.request?.reviewEnabled) ? "Venture Capitalist" : null);
      }
      // Best-effort: notify other UI surfaces (sidebar cache) that projects changed.
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setShowSettings(false);

      // Optional: upload/attach a request guide PDF (best-effort).
      if (json?.project?.isRequest && (draftRequestGuideFile || hasGuideText)) {
        // If guide is pasted text, create a lightweight doc with extractedText (no upload pipeline).
        if (!draftRequestGuideFile && hasGuideText) {
          const docRes = await fetchWithTempUser("/api/docs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "Request guide (pasted)" }),
          });
          const docJson = (await docRes.json().catch(() => ({}))) as { doc?: { id?: string } };
          const guideDocId = typeof docJson?.doc?.id === "string" ? docJson.doc.id : "";
          if (!docRes.ok || !guideDocId) throw new Error("Failed to create guide doc");

          await fetchWithTempUser(`/api/docs/${encodeURIComponent(guideDocId)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ extractedText: draftRequestGuideText.trim(), status: "ready" }),
          });

          await fetchWithTempUser(`/api/requests/${encodeURIComponent(json.project.id)}/guide`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ docId: guideDocId }),
          });

          setDraftRequestGuideText("");
        } else if (draftRequestGuideFile) {
          const file = draftRequestGuideFile;
          const nameLower = (file.name ?? "").toLowerCase();
          const isPdf = file.type === "application/pdf" || nameLower.endsWith(".pdf");
          if (!isPdf) throw new Error("Guide document must be a PDF.");
          if (file.size > 1_000_000) throw new Error("Guide document must be 1MB or smaller.");

          const docRes = await fetchWithTempUser("/api/docs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: `Request guide: ${file.name}` }),
          });
          const docJson = (await docRes.json().catch(() => ({}))) as { doc?: { id?: string } };
          const guideDocId = typeof docJson?.doc?.id === "string" ? docJson.doc.id : "";
          if (!docRes.ok || !guideDocId) throw new Error("Failed to create guide doc");

          const upRes = await fetchWithTempUser("/api/uploads", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              docId: guideDocId,
              originalFileName: file.name,
              contentType: file.type || null,
              sizeBytes: file.size,
              skipReview: true,
            }),
          });
          const upJson = (await upRes.json().catch(() => ({}))) as { upload?: { id?: string } };
          const guideUploadId = typeof upJson?.upload?.id === "string" ? upJson.upload.id : "";
          if (!upRes.ok || !guideUploadId) throw new Error("Failed to create guide upload");

          const pathname = buildDocBlobPathname({
            docId: guideDocId,
            uploadId: guideUploadId,
            fileName: file.name,
          });
          const blob = await blobUpload(pathname, file, {
            access: "public",
            handleUploadUrl: BLOB_HANDLE_UPLOAD_URL,
            contentType: file.type || undefined,
          });
          await fetchWithTempUser(`/api/uploads/${encodeURIComponent(guideUploadId)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              status: "uploaded",
              blobUrl: blob.url,
              blobPathname: blob.pathname,
              metadata: { size: file.size },
            }),
          });
          await fetchWithTempUser(`/api/uploads/${encodeURIComponent(guideUploadId)}/process`, { method: "POST" });
          await fetchWithTempUser(`/api/requests/${encodeURIComponent(json.project.id)}/guide`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ docId: guideDocId }),
          });

          setDraftRequestGuideFile(null);
          setDraftRequestGuideText("");
        }
      }

      if (enablingAutoAddFiles) {
        void loadSuggestedDocsAfterEnablingAutoAdd();
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save project.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] bg-[var(--panel)] px-6 py-4">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            {isRequestRepo ? (
              <InboxArrowDownIcon className="h-5 w-5 text-[var(--muted-2)]" aria-hidden="true" />
            ) : (
              <FolderIcon className="h-5 w-5 text-[var(--muted-2)]" aria-hidden="true" />
            )}
            {title ? (
              <div className="min-w-0 flex-1">
                {editingName ? (
                  <div className="min-w-0">
                    <input
                      ref={nameInputRef}
                      value={nameDraft}
                      disabled={nameSaveBusy}
                      onChange={(e) => {
                        setNameDraft(e.target.value);
                        if (nameSaveError) setNameSaveError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void saveName(nameDraft);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setNameDraft(title);
                          setEditingName(false);
                          setNameSaveError(null);
                        }
                      }}
                      onBlur={() => {
                        // Best-effort: save on blur if changed.
                        void saveName(nameDraft);
                      }}
                      aria-label="Project name"
                      className={[
                        "w-full min-w-0 rounded-md border bg-[var(--panel)] px-2 py-1 text-sm font-semibold text-[var(--fg)]",
                        "border-[var(--border)] focus:outline-none focus:ring-2 focus:ring-black/10",
                        nameSaveBusy ? "opacity-70" : "",
                      ].join(" ")}
                    />
                    {nameSaveError ? (
                      <div className="mt-1 text-xs font-medium text-red-700">{nameSaveError}</div>
                    ) : null}
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={!project}
                    aria-disabled={!project}
                    aria-label="Rename project"
                    title="Rename project"
                    onClick={() => {
                      if (!project) return;
                      setNameDraft(title);
                      setNameSaveError(null);
                      setEditingName(true);
                    }}
                    className="block w-full min-w-0 truncate text-left text-sm font-semibold text-[var(--fg)] hover:underline"
                  >
                    {title}
                  </button>
                )}
              </div>
            ) : (
              <div
                className="h-4 w-32 animate-pulse rounded bg-[var(--panel-hover)]"
                aria-label="Loading project name"
              />
            )}
            {isRequestRepo ? (
              <span className="shrink-0 rounded-full bg-[var(--panel-hover)] px-2 py-0.5 text-[11px] font-semibold text-[var(--muted)] ring-1 ring-[var(--border)]">
                Request link
              </span>
            ) : null}
            {project ? (
              <button
                type="button"
                className="shrink-0 rounded-lg p-1 text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
                aria-label="Project settings"
                onClick={() => {
                  if (!project) return;
                  setSaveError(null);
                  setDraftName(project.name ?? "");
                  setDraftDescription(project.description ?? "");
                  setDraftAutoAddFiles(Boolean(project.autoAddFiles));
                  setShowSettings(true);
                }}
              >
                <Cog6ToothIcon className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 text-xs text-[var(--muted-2)]">{docs.total} docs</div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-[var(--bg)]">
        <div className="h-full px-6 py-6">
          {notFound ? (
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6 text-sm text-[var(--muted)]">
              Project not found.
            </div>
          ) : (
            <div className="grid h-full min-h-0 gap-5 lg:grid-cols-[1.35fr_0.65fr]">
              <section className="min-h-0 overflow-auto rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
                {subtitle ? <div className="text-xs text-[var(--muted-2)]">{subtitle}</div> : null}

                <div className={["flex items-center justify-between gap-3", subtitle ? "mt-5" : ""].join(" ")}>
                  <input
                    value={q}
                    onChange={(e) => {
                      setQ(e.target.value);
                      setDocs((s) => ({ ...s, page: 1 }));
                    }}
                    placeholder="Search docs"
                    className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  />
                  {isRequestRepo ? (
                    <select
                      value={requestSort}
                      onChange={(e) => setRequestSort(e.target.value === "score" ? "score" : "recent")}
                      aria-label="Sort request docs"
                      className="h-10 shrink-0 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                    >
                      <option value="recent">Most recent</option>
                      <option value="score">Most relevant (score)</option>
                    </select>
                  ) : null}
                </div>

                <ul className="mt-6 divide-y divide-[var(--border)]">
                  {docsForList.map((d) => {
                    // read from localStorage; `starredTick` forces re-render on changes
                    void starredTick;
                    const starred = isDocStarred(d.id);
                    const when = formatRelative(d.updatedDate ?? d.createdDate);
                    const summary = typeof d.summary === "string" && d.summary.trim() ? d.summary.trim() : null;
                    const previewImageUrl =
                      typeof d.previewImageUrl === "string" && d.previewImageUrl.trim()
                        ? d.previewImageUrl.trim()
                        : null;
                    const aspect = docsThumbAspectById[d.id];
                    const aspectClamped =
                      typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0
                        ? Math.max(0.55, Math.min(2.2, aspect))
                        : null;
                    return (
                      <li key={d.id}>
                        <div
                          role="link"
                          tabIndex={0}
                          className="cursor-pointer rounded-xl px-2 py-4 hover:bg-[var(--panel-hover)]"
                          onClick={() => {
                            if (typeof window !== "undefined") {
                              trackProjectClick({
                                projectId: projectSlug,
                                fromPath: window.location.pathname + window.location.search,
                                toPath: `/doc/${d.id}`,
                                toDocId: d.id,
                              });
                            }
                            router.push(`/doc/${d.id}`);
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            if (typeof window !== "undefined") {
                              trackProjectClick({
                                projectId: projectSlug,
                                fromPath: window.location.pathname + window.location.search,
                                toPath: `/doc/${d.id}`,
                                toDocId: d.id,
                              });
                            }
                            router.push(`/doc/${d.id}`);
                          }}
                        >
                          <div className="flex items-start justify-between gap-6">
                            <div className="flex min-w-0 items-start gap-4">
                              <div
                                className="h-24 shrink-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel-2)]"
                                style={{
                                  aspectRatio: aspectClamped ?? 0.75,
                                  maxWidth: 200,
                                }}
                              >
                                {previewImageUrl ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={previewImageUrl}
                                    alt=""
                                    className="h-full w-full object-contain"
                                    loading="lazy"
                                    decoding="async"
                                    onLoad={(e) => {
                                      const img = e.currentTarget;
                                      const w = img.naturalWidth;
                                      const h = img.naturalHeight;
                                      if (!w || !h) return;
                                      const next = w / h;
                                      if (!Number.isFinite(next) || next <= 0) return;
                                      setDocsThumbAspectById((prev) => {
                                        if (prev[d.id]) return prev;
                                        return { ...prev, [d.id]: next };
                                      });
                                    }}
                                  />
                                ) : (
                                  <div className="grid h-full w-full place-items-center bg-[var(--panel-2)] text-[10px] font-medium text-[var(--muted-2)]">
                                    PDF
                                  </div>
                                )}
                              </div>

                              <div className="min-w-0">
                                <div className="flex min-w-0 items-center gap-2">
                                  {isRequestRepo ? (
                                    <button
                                      type="button"
                                      className={[
                                        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors",
                                        starred
                                          ? "border-amber-300/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/20"
                                          : "border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                                      ].join(" ")}
                                      aria-label={starred ? "Unstar document" : "Star document"}
                                      title={starred ? "Starred" : "Star"}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleStarredDoc({ id: d.id, title: d.title || "Document" });
                                      }}
                                      onPointerDown={(e) => e.stopPropagation()}
                                    >
                                      {starred ? (
                                        <StarSolidIcon className="h-4 w-4" aria-hidden="true" />
                                      ) : (
                                        <StarOutlineIcon className="h-4 w-4" aria-hidden="true" />
                                      )}
                                    </button>
                                  ) : starred ? (
                                    <span className="shrink-0 text-amber-500" aria-label="Starred">
                                      <SmallStarIcon filled />
                                    </span>
                                  ) : null}
                                  <div className="truncate text-[13px] font-semibold text-[var(--fg)]">{d.title}</div>
                                </div>
                                {summary ? (
                                  <div className="mt-1 text-[12px] leading-5 text-[var(--muted)] line-clamp-2">
                                    {summary}
                                  </div>
                                ) : null}
                                <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--muted-2)]">
                                  <span className="truncate">{when || "-"}</span>
                                  {d.version ? (
                                    <span className="rounded-md bg-[var(--panel-hover)] px-1.5 py-0 text-[10px] text-[var(--muted)] ring-1 ring-[var(--border)]">
                                      v{d.version}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              {d.status && d.status.toLowerCase() !== "ready" ? (
                                <div className="pt-0.5 text-[11px] text-[var(--muted-2)]">{d.status}</div>
                              ) : null}
                              <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                                <DocActionsMenu
                                  docId={d.id}
                                  currentProjectId={projectIdForMenu}
                                  onOpenQualityReview={() => router.push(`/doc/${d.id}/review`)}
                                  onDocPatched={(patch) => {
                                    // If the doc is no longer in this project, drop it from this list.
                                    if (Array.isArray(patch.projectIds) && !patch.projectIds.includes(projectIdForMenu)) {
                                      setDocs((s) => ({
                                        ...s,
                                        items: s.items.filter((x) => x.id !== d.id),
                                        total: Math.max(0, s.total - 1),
                                      }));
                                    }
                                  }}
                                  onDeleted={() => {
                                    setDocs((s) => ({
                                      ...s,
                                      items: s.items.filter((x) => x.id !== d.id),
                                      total: Math.max(0, s.total - 1),
                                    }));
                                  }}
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                  {docsLoading ? (
                    <li>
                      <div className="py-8 text-sm text-[var(--muted)]">Loading…</div>
                    </li>
                  ) : !docs.items.length ? (
                    <li>
                      <div className="py-8 text-sm text-[var(--muted)]">No docs in this project yet.</div>
                    </li>
                  ) : null}
                </ul>

                {maxPage > 1 ? (
                  <div className="mt-6 flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
                    <button
                      type="button"
                      className={[
                        "text-sm font-medium text-[var(--muted)] hover:text-[var(--fg)] hover:underline underline-offset-4",
                        docs.page <= 1 ? "pointer-events-none text-[var(--muted-2)]" : "",
                      ].join(" ")}
                      disabled={docs.page <= 1}
                      onClick={() => setDocs((s) => ({ ...s, page: Math.max(1, s.page - 1) }))}
                    >
                      Prev
                    </button>
                    <div className="text-xs text-[var(--muted-2)]">
                      Page {docs.page} / {maxPage}
                    </div>
                    <button
                      type="button"
                      className={[
                        "text-sm font-medium text-[var(--muted)] hover:text-[var(--fg)] hover:underline underline-offset-4",
                        docs.page >= maxPage ? "pointer-events-none text-[var(--muted-2)]" : "",
                      ].join(" ")}
                      disabled={docs.page >= maxPage}
                      onClick={() => setDocs((s) => ({ ...s, page: s.page + 1 }))}
                    >
                      Next
                    </button>
                  </div>
                ) : null}
              </section>

              {project?.isRequest ? (
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                    Request link
                  </div>
                  <div className="mt-1 text-sm text-[var(--muted)]">
                    Share this link with the people you’re requesting documents from.
                  </div>

                  <div className="mt-3 flex items-stretch gap-2">
                    <input
                      readOnly
                      value={(function () {
                        const path = project.request?.uploadPath ?? "";
                        if (!path) return "";
                        if (typeof window === "undefined") return path;
                        try {
                          return new URL(path, window.location.origin).toString();
                        } catch {
                          return path;
                        }
                      })()}
                      className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 text-[13px] font-medium text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                      onFocus={(e) => e.currentTarget.select()}
                      aria-label="Request upload link"
                    />
                    <CopyButton
                      copyDone={copyRequestLinkDone}
                      isCopying={copyRequestLinkCopying}
                      disabled={!project.request?.uploadPath}
                      onCopy={() => {
                        void (async () => {
                          const path = project.request?.uploadPath ?? "";
                          if (!path) return;
                          if (typeof window === "undefined") return;
                          setCopyRequestLinkCopying(true);
                          setCopyRequestLinkDone(false);
                          let url = "";
                          try {
                            url = new URL(path, window.location.origin).toString();
                          } catch {
                            url = path;
                          }
                          try {
                            await navigator.clipboard.writeText(url);
                            setCopyRequestLinkDone(true);
                            window.setTimeout(() => setCopyRequestLinkDone(false), 900);
                          } catch {
                            // ignore
                          } finally {
                            setCopyRequestLinkCopying(false);
                          }
                        })();
                      }}
                      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
                      iconClassName="h-4 w-4"
                      label="Copy"
                      copiedLabel="Copied"
                      copyAriaLabel="Copy"
                      copiedAriaLabel="Copied"
                      copyTitle="Copy"
                      copiedTitle="Copied"
                    />
                  </div>
                  <div className="sr-only" aria-live="polite">
                    {copyRequestLinkDone ? "Copied to clipboard" : ""}
                  </div>

                  {project.request?.viewPath ? (
                    <div className="mt-5">
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                        Request view (read-only)
                      </div>
                      <div className="mt-1 text-sm text-[var(--muted)]">
                        Share this link to let someone view documents in this repository without enabling uploads.
                      </div>

                      <div className="mt-3 flex items-stretch gap-2">
                        <input
                          readOnly
                          value={(function () {
                            const path = project.request?.viewPath ?? "";
                            if (!path) return "";
                            if (typeof window === "undefined") return path;
                            try {
                              return new URL(path, window.location.origin).toString();
                            } catch {
                              return path;
                            }
                          })()}
                          className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 text-[13px] font-medium text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                          onFocus={(e) => e.currentTarget.select()}
                          aria-label="Request view link"
                        />
                        <CopyButton
                          copyDone={copyRequestViewLinkDone}
                          isCopying={copyRequestViewLinkCopying}
                          disabled={!project.request?.viewPath}
                          onCopy={() => {
                            void (async () => {
                              const path = project.request?.viewPath ?? "";
                              if (!path) return;
                              if (typeof window === "undefined") return;
                              setCopyRequestViewLinkCopying(true);
                              setCopyRequestViewLinkDone(false);
                              let url = "";
                              try {
                                url = new URL(path, window.location.origin).toString();
                              } catch {
                                url = path;
                              }
                              try {
                                await navigator.clipboard.writeText(url);
                                setCopyRequestViewLinkDone(true);
                                window.setTimeout(() => setCopyRequestViewLinkDone(false), 900);
                              } catch {
                                // ignore
                              } finally {
                                setCopyRequestViewLinkCopying(false);
                              }
                            })();
                          }}
                          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
                          iconClassName="h-4 w-4"
                          label="Copy"
                          copiedLabel="Copied"
                          copyAriaLabel="Copy"
                          copiedAriaLabel="Copied"
                          copyTitle="Copy"
                          copiedTitle="Copied"
                        />
                      </div>
                      <div className="sr-only" aria-live="polite">
                        {copyRequestViewLinkDone ? "Copied to clipboard" : ""}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <ProjectSharePanel
                  projectShareId={(project as unknown as { shareId?: string | null })?.shareId ?? null}
                  projectName={title}
                />
              )}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={showSettings}
        ariaLabel={project?.isRequest ? "Update link request repository" : "Project settings"}
        onClose={() => {
          setShowSettings(false);
          setSaveError(null);
          if (project) {
            setDraftName(project.name ?? "");
            setDraftDescription(project.description ?? "");
            setDraftAutoAddFiles(Boolean(project.autoAddFiles));
            setDraftRequestRequireAuthToUpload(Boolean(project.request?.requireAuthToUpload));
            setDraftRequestReviewEnabled(Boolean(project.request?.reviewEnabled));
            // Request review "notes" UI removed; agent behavior is driven by Guide + server prompt.
            setDraftRequestGuideFile(null);
            setDraftRequestGuideText("");
            setDraftRequestReviewAgentLabel(Boolean(project.request?.reviewEnabled) ? "Venture Capitalist" : null);
            setCopyRequestLinkDone(false);
          }
        }}
      >
        <div className="px-1 pb-3 text-base font-semibold text-[var(--fg)]">
          {project?.isRequest ? "Update link request repository" : "Project settings"}
        </div>

        <div className="mt-3 grid gap-3">
          <label className="grid gap-1">
            <span className="text-[11px] font-medium text-[var(--muted)]">Name</span>
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              maxLength={MAX_PROJECT_NAME_LENGTH}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              placeholder="Project name"
            />
          </label>

          <label className="grid gap-1">
            <span className="text-[11px] font-medium text-[var(--muted)]">Description</span>
            <textarea
              value={draftDescription}
              onChange={(e) => setDraftDescription(e.target.value)}
              className="min-h-[96px] w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              placeholder="What belongs in this project? (Used by AI auto-routing when enabled)"
            />
          </label>

          {project?.isRequest ? (
            <div className="grid gap-3">
              <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                  Request link
                </div>
                <div className="mt-1 text-[11px] text-[var(--muted)]">
                  Share this link with the people you’re requesting documents from. (This link can’t be changed.)
                </div>

                <div className="mt-3 flex items-stretch gap-2">
                  <input
                    readOnly
                    value={
                      (function () {
                        const path = project.request?.uploadPath ?? "";
                        if (!path) return "";
                        const origin = typeof window !== "undefined" ? window.location.origin : "";
                        return origin ? new URL(path, origin).toString() : path;
                      })()
                    }
                    className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-medium text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                    onFocus={(e) => e.currentTarget.select()}
                    aria-label="Request upload link"
                  />
                  <button
                    type="button"
                    className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
                    onClick={async () => {
                      const path = project.request?.uploadPath ?? "";
                      if (!path) return;
                      const origin = typeof window !== "undefined" ? window.location.origin : "";
                      const url = origin ? new URL(path, origin).toString() : path;
                      try {
                        await navigator.clipboard.writeText(url);
                        setCopyRequestLinkDone(true);
                        window.setTimeout(() => setCopyRequestLinkDone(false), 900);
                      } catch {
                        // ignore
                      }
                    }}
                  >
                    <Square2StackIcon className="h-4 w-4" />
                    {copyRequestLinkDone ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-3">
                <label className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-[var(--fg)]">Require sign-in to upload</div>
                    <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                      Only authenticated (signed-in) users can submit documents to this request link.
                    </div>
                  </div>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={draftRequestRequireAuthToUpload}
                    aria-label="Require sign-in to upload"
                    className={[
                      "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                      draftRequestRequireAuthToUpload ? "bg-[var(--primary-bg)]" : "bg-[var(--border)]",
                    ].join(" ")}
                    onClick={() => {
                      setDraftRequestRequireAuthToUpload((v) => !v);
                      if (saveError) setSaveError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      setDraftRequestRequireAuthToUpload((v) => !v);
                      if (saveError) setSaveError(null);
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className={[
                        "inline-block h-5 w-5 transform rounded-full bg-[var(--panel)] shadow ring-1 ring-[var(--border)] transition-transform",
                        draftRequestRequireAuthToUpload ? "translate-x-5" : "translate-x-1",
                      ].join(" ")}
                    />
                  </button>
                </label>
              </div>

              <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-3">
                <label className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--fg)]">
                      <SparklesIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
                      <span>Review agent</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                      Reviews each uploaded deck against your guide and provides an assessment summary.
                    </div>
                  </div>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={draftRequestReviewEnabled}
                    aria-label="Enable review agent"
                    className={[
                      "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                      draftRequestReviewEnabled ? "bg-[var(--primary-bg)]" : "bg-[var(--border)]",
                    ].join(" ")}
                    onClick={() => {
                      setDraftRequestReviewEnabled((v) => {
                        const next = !v;
                        if (!next) {
                          setDraftRequestReviewAgentLabel(null);
                          setDraftRequestGuideFile(null);
                          setDraftRequestGuideText("");
                        } else if (!draftRequestReviewAgentLabel) {
                          setDraftRequestReviewAgentLabel("Venture Capitalist");
                        }
                        if (saveError) setSaveError(null);
                        return next;
                      });
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      setDraftRequestReviewEnabled((v) => {
                        const next = !v;
                        if (!next) {
                          setDraftRequestReviewAgentLabel(null);
                          setDraftRequestGuideFile(null);
                          setDraftRequestGuideText("");
                        } else if (!draftRequestReviewAgentLabel) {
                          setDraftRequestReviewAgentLabel("Venture Capitalist");
                        }
                        if (saveError) setSaveError(null);
                        return next;
                      });
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className={[
                        "inline-block h-5 w-5 transform rounded-full bg-[var(--panel)] shadow ring-1 ring-[var(--border)] transition-transform",
                        draftRequestReviewEnabled ? "translate-x-5" : "translate-x-1",
                      ].join(" ")}
                    />
                  </button>
                </label>

                {draftRequestReviewEnabled ? (
                  <div className="mt-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                        Reviewer agent
                      </div>
                      <button
                        type="button"
                        className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
                        onClick={() => setShowRequestReviewTemplates(true)}
                      >
                        Select form
                      </button>
                    </div>

                    {draftRequestReviewAgentLabel ? (
                      <div className="mt-2 text-[11px] text-[var(--muted)]">
                        Selected: <span className="font-semibold text-[var(--fg)]">{draftRequestReviewAgentLabel}</span>
                      </div>
                    ) : null}

                    <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                      Guide/Prompt Document
                    </div>
                    <div className="mt-1 text-[11px] text-[var(--muted)]">
                      Attach a guide or a prompt (e.g. investor thesis) to help the agent come up with the closest assessment. (PDF-only, max 1MB)
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <input
                        type="file"
                        accept="application/pdf"
                        disabled={saving}
                        onChange={(e) => setDraftRequestGuideFile(e.currentTarget.files?.[0] ?? null)}
                      />
                      {draftRequestGuideFile ? (
                        <button
                          type="button"
                          className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
                          onClick={() => setDraftRequestGuideFile(null)}
                        >
                          Clear
                        </button>
                      ) : null}
                    </div>
                    <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                      Or paste guide text
                    </div>
                    <textarea
                      value={draftRequestGuideText}
                      onChange={(e) => setDraftRequestGuideText(e.target.value)}
                      disabled={saving}
                      rows={4}
                      className="mt-2 w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60"
                      placeholder="Paste evaluation criteria or scoring rubric text…"
                      aria-label="Paste evaluation guide text"
                    />
                    {project.request?.guideDocTitle ? (
                      <div className="mt-2 text-[11px] text-[var(--muted)]">
                        Current guide doc: {project.request.guideDocTitle}
                      </div>
                    ) : project.request?.guideDocId ? (
                      <div className="mt-2 text-[11px] text-[var(--muted)]">Current guide doc: attached</div>
                    ) : null}
                    {draftRequestReviewEnabled &&
                    !draftRequestGuideFile &&
                    !draftRequestGuideText.trim() &&
                    !project.request?.guideDocId ? (
                      <div className="mt-2 text-[11px] text-red-600" role="alert" aria-live="polite">
                        Evaluation guide is required to enable the review agent.
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--fg)]">
                  <SparklesIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
                  <span>Add files to this project automatically</span>
                </div>
                <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                  When enabled, AI can place new uploads into this project based on the description.
                </div>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={draftAutoAddFiles}
                aria-label="Add files to this project automatically"
                className={[
                  "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                  draftAutoAddFiles ? "bg-[var(--primary-bg)]" : "bg-[var(--border)]",
                ].join(" ")}
                onClick={() => setDraftAutoAddFiles((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  setDraftAutoAddFiles((v) => !v);
                }}
              >
                <span
                  aria-hidden="true"
                  className={[
                    "inline-block h-5 w-5 transform rounded-full bg-[var(--panel)] shadow ring-1 ring-[var(--border)] transition-transform",
                    draftAutoAddFiles ? "translate-x-5" : "translate-x-1",
                  ].join(" ")}
                />
              </button>
            </div>
          )}

          {saveError ? <div className="text-[12px] text-red-600">{saveError}</div> : null}

          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
              disabled={saving}
              onClick={() => {
                setShowSettings(false);
                setSaveError(null);
                if (project) {
                  setDraftName(project.name ?? "");
                  setDraftDescription(project.description ?? "");
                  setDraftAutoAddFiles(Boolean(project.autoAddFiles));
                  setDraftRequestRequireAuthToUpload(Boolean(project.request?.requireAuthToUpload));
                }
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-xl bg-[var(--primary-bg)] px-3 py-2 text-[13px] font-medium text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:opacity-50"
              disabled={
                !project ||
                !hasUnsavedChanges ||
                saving ||
                (Boolean(project?.isRequest) &&
                  Boolean(draftRequestReviewEnabled) &&
                  !draftRequestGuideFile &&
                  !draftRequestGuideText.trim() &&
                  !project?.request?.guideDocId)
              }
              onClick={() => void saveProject()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={showSuggestedDocs}
        ariaLabel="Add existing docs to project"
        onClose={() => {
          if (addingSuggestedDocs) return;
          setShowSuggestedDocs(false);
          setSuggestedDocsError(null);
        }}
      >
        <div className="px-1 pb-2 text-base font-semibold text-[var(--fg)]">
          Add existing docs to this project?
        </div>

        <div className="text-[13px] text-[var(--muted)]">
          {suggestedDocsBusy
            ? "Finding relevant docs…"
            : suggestedDocs.length
              ? `We found ${suggestedDocs.length} doc${suggestedDocs.length === 1 ? "" : "s"} that match this project.`
              : "No matching docs found."}
        </div>

        {suggestedTags.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {suggestedTags.map((t) => (
              <span
                key={t}
                className="rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-[11px] text-[var(--muted)]"
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}

        {suggestedDocsError ? (
          <div className="mt-3 text-[12px] text-red-600">{suggestedDocsError}</div>
        ) : null}

        <div className="mt-4 max-h-[46vh] overflow-auto rounded-xl border border-[var(--border)]">
          <ul className="divide-y divide-[var(--border)]">
            {suggestedDocs.map((d) => {
              const checked = Boolean(suggestedSelectedById[d.id]);
              return (
                <li key={d.id} className="flex items-start gap-3 bg-[var(--panel)] px-3 py-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setSuggestedSelectedById((prev) => ({ ...prev, [d.id]: next }));
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-[var(--fg)]">{d.title}</div>
                        {d.summary ? (
                          <div className="mt-0.5 line-clamp-2 text-[12px] text-[var(--muted)]">{d.summary}</div>
                        ) : null}
                      </div>
                      <div className="shrink-0 text-right text-[11px] text-[var(--muted-2)]">
                        <div>{formatRelative(d.updatedDate)}</div>
                        <div className="mt-0.5">{d.matchCount} tag match{d.matchCount === 1 ? "" : "es"}</div>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            type="button"
            className="text-[13px] font-medium text-[var(--muted)] hover:text-[var(--fg)] hover:underline underline-offset-4 disabled:opacity-50"
            disabled={addingSuggestedDocs}
            onClick={() => {
              setSuggestedSelectedById((prev) => {
                const next: Record<string, boolean> = { ...prev };
                for (const d of suggestedDocs) next[d.id] = true;
                return next;
              });
            }}
          >
            Select all
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
              disabled={addingSuggestedDocs}
              onClick={() => {
                setShowSuggestedDocs(false);
                setSuggestedDocsError(null);
              }}
            >
              Skip
            </button>
            <button
              type="button"
              className="rounded-xl bg-[var(--primary-bg)] px-3 py-2 text-[13px] font-medium text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:opacity-50"
              disabled={
                addingSuggestedDocs ||
                !suggestedDocs.some((d) => Boolean(suggestedSelectedById[d.id]))
              }
              onClick={() => void addSelectedSuggestedDocsToProject()}
            >
              {addingSuggestedDocs ? "Adding…" : "Add selected"}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={showRequestReviewTemplates}
        onClose={() => setShowRequestReviewTemplates(false)}
        ariaLabel="Review agent templates"
      >
        <div className="text-base font-semibold text-[var(--fg)]">Review agent templates</div>
        <div className="mt-1 text-sm text-[var(--muted)]">
          For now, we only support one reviewer agent type.
        </div>

        <div className="mt-4 grid gap-2">
          <button
            type="button"
            className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-left hover:bg-[var(--panel-hover)]"
            onClick={() => {
              setDraftRequestReviewAgentLabel("Venture Capitalist");
              setShowRequestReviewTemplates(false);
            }}
          >
            <div className="text-sm font-semibold text-[var(--fg)]">Venture Capitalist</div>
            <div className="mt-1 text-sm text-[var(--muted)]">Pitch decks, updates, memos, board minutes.</div>
          </button>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold hover:bg-[var(--panel-hover)]"
            onClick={() => setShowRequestReviewTemplates(false)}
          >
            Close
          </button>
        </div>
      </Modal>
    </div>
  );
}
/**
 * Render the SmallStarIcon UI.
 */


function SmallStarIcon({ filled }: { filled: boolean }) {
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


