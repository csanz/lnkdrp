"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import {
  ClipboardDocumentCheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DocumentPlusIcon,
  EllipsisHorizontalIcon,
  FolderIcon,
  InboxArrowDownIcon,
  LightBulbIcon,
  MagnifyingGlassIcon,
  MinusIcon,
  SparklesIcon,
  Square2StackIcon,
} from "@heroicons/react/24/outline";
import DeleteProjectModal from "@/components/modals/DeleteProjectModal";
import DeleteRequestRepoModal, { type RequestRepoDeleteMode } from "@/components/modals/DeleteRequestRepoModal";
import CreateLinkRequestRepositoryModal from "@/components/modals/CreateLinkRequestRepositoryModal";
import DeleteDocModal from "@/components/modals/DeleteDocModal";
import ReviewPerspectiveModal from "@/components/modals/ReviewPerspectiveModal";
import SidebarDocsModal from "@/components/modals/SidebarDocsModal";
import SidebarProjectsModal from "@/components/modals/SidebarProjectsModal";
import SidebarRequestsModal from "@/components/modals/SidebarRequestsModal";
import SidebarStarredModal from "@/components/modals/SidebarStarredModal";
import AccountMenu from "@/components/AccountMenu";
import SidebarProjectsSection from "@/components/SidebarProjectsSection";
import ActiveWorkspacePill from "@/components/ActiveWorkspacePill";
import IconButton from "@/components/ui/IconButton";
import CreateProjectModal from "@/components/modals/CreateProjectModal";
import { buildPublicRequestUrl, buildPublicRequestViewUrl, buildPublicShareUrl, getPublicSiteBase } from "@/lib/urls";
import {
  getStarredDocs,
  moveStarredDoc,
  refreshStarredDocsFromServer,
  STARRED_DOCS_CHANGED_EVENT,
  upsertStarredDocMeta,
  type StarredDoc,
} from "@/lib/starredDocs";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { upload as blobUpload } from "@vercel/blob/client";
import { BLOB_HANDLE_UPLOAD_URL, buildDocBlobPathname } from "@/lib/blob/clientUpload";
import {
  ACTIVE_ORG_STORAGE_KEY,
  ACTIVE_ORG_CHANGED_EVENT,
  DOCS_CHANGED_EVENT,
  getSidebarCacheSnapshot,
  optimisticallyAddProjectToSidebarCache,
  PROJECTS_CHANGED_EVENT,
  notifyDocsChanged,
  notifyProjectsChanged,
  refreshSidebarCache,
  SIDEBAR_CACHE_UPDATED_EVENT,
} from "@/lib/sidebarCache";
import { useNavigationLocked } from "@/app/providers";

type DocListItem = {
  id: string;
  shareId: string | null;
  title: string;
  status: string | null;
  version: number | null;
  receivedViaRequestProjectId?: string | null;
  guideForRequestProjectId?: string | null;
  previewImageUrl?: string | null;
  one_liner?: string | null;
  updatedDate: string | null;
  createdDate: string | null;
};

type Paged<T> = { items: T[]; total: number; page: number; limit: number };

type StarredMeta = { updatedDate: string | null; createdDate: string | null };
type StarredMetaById = Record<string, StarredMeta>;
type StarredDetails = {
  previewImageUrl: string | null;
  one_liner: string | null;
  title: string | null;
  version: number | null;
  status: string | null;
};
type StarredDetailsById = Record<string, StarredDetails>;

const STARRED_META_CACHE_KEY_BASE = "lnkdrp-starred-meta-cache-v2";
const STARRED_META_CACHE_KEY_LEGACY = "lnkdrp.starredMetaCache.v1";
const STARRED_COLLAPSED_KEY = "lnkdrp.sidebar.starredCollapsed.v1";
const PROJECTS_COLLAPSED_KEY = "lnkdrp.sidebar.projectsCollapsed.v1";
const DOCS_COLLAPSED_KEY = "lnkdrp.sidebar.docsCollapsed.v1";
const REQUESTS_COLLAPSED_KEY = "lnkdrp.sidebar.requestsCollapsed.v1";
const STARRED_SIDEBAR_LIMIT = 3;
const PROJECTS_SIDEBAR_LIMIT = 4;
const REQUESTS_SIDEBAR_LIMIT = 3;
const DOCS_SIDEBAR_LIMIT = 10;

type DocFolder = { id: string; name: string; slug: string };
/**
 * Truncate a string to a maximum length (adds an ellipsis when truncated).
 */


function truncateEnd(text: string, maxChars: number) {
  const s = (text ?? "").trim();
  if (!maxChars || maxChars < 2) return s;
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
/**
 * Parse JSON input (best-effort) and return null when invalid.
 */


function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getActiveOrgIdForClientCaches(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
    const s = typeof raw === "string" ? raw.trim() : "";
    return /^[a-f0-9]{24}$/i.test(s) ? s : null;
  } catch {
    return null;
  }
}

function starredMetaCacheStorageKey(): string | null {
  const orgId = getActiveOrgIdForClientCaches();
  if (!orgId) return null;
  return `${STARRED_META_CACHE_KEY_BASE}:${orgId}`;
}
/**
 * Read Starred Meta Cache (uses getItem, safeParseJson, entries).
 */


function readStarredMetaCache(): StarredMetaById {
  if (typeof window === "undefined") return {};
  try {
    const key = starredMetaCacheStorageKey();
    // If we don't know the active org yet, don't read any cache (prevents stale cross-org flash).
    if (!key) return {};
    const raw = window.localStorage.getItem(key);
    const v = safeParseJson(raw ?? "");
    if (!v || typeof v !== "object") return {};
    const out: StarredMetaById = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (!k) continue;
      if (!val || typeof val !== "object") continue;
      const o = val as { updatedDate?: unknown; createdDate?: unknown };
      out[k] = {
        updatedDate: typeof o.updatedDate === "string" ? o.updatedDate : null,
        createdDate: typeof o.createdDate === "string" ? o.createdDate : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}
/**
 * Write Starred Meta Cache (uses setItem, stringify).
 */


function writeStarredMetaCache(next: StarredMetaById) {
  if (typeof window === "undefined") return;
  try {
    const key = starredMetaCacheStorageKey();
    if (!key) return;
    window.localStorage.setItem(key, JSON.stringify(next));
    // Best-effort: stop writing to legacy unscoped storage.
    window.localStorage.removeItem(STARRED_META_CACHE_KEY_LEGACY);
  } catch {
    // ignore (quota / private mode)
  }
}
/**
 * Prune Meta Cache.
 */


function pruneMetaCache(cache: StarredMetaById, keepIds: Set<string>): StarredMetaById {
  const out: StarredMetaById = {};
  for (const id of keepIds) {
    const v = cache[id];
    if (!v) continue;
    out[id] = v;
  }
  return out;
}

type ProjectListItem = {
  id: string;
  name: string;
  slug: string;
  description: string;
  isRequest?: boolean;
  docCount?: number;
  updatedDate: string | null;
  createdDate: string | null;
};

type RequestListItem = {
  id: string;
  name: string;
  description: string;
  docCount?: number;
  updatedDate: string | null;
  createdDate: string | null;
};

/**
 * Render a user-friendly relative time string for ISO timestamps.
 */
function formatRelative(iso: string | null) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;

  const mins = Math.round(diff / 60000);
  if (mins <= 1) return "Just now";
  if (mins < 60) return `${mins} ${mins === 1 ? "min" : "mins"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? "hr" : "hrs"} ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return "Yesterday";
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
/**
 * Render the LeftSidebar UI (uses effects, memoized values, local state).
 */


export default function LeftSidebar({
  onAddNewFile,
}: {
  onAddNewFile: (file: File) => void;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const { resolvedTheme } = useTheme();
  const navLocked = useNavigationLocked();
  const isDocRoute = useMemo(() => pathname.startsWith("/doc/"), [pathname]);

  const activeProjectId = useMemo(() => {
    const p = typeof pathname === "string" ? pathname : "";
    const m = p.match(/^\/project\/([^/]+)/);
    if (!m?.[1]) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }, [pathname]);

  const activeDocId = useMemo(() => {
    const p = typeof pathname === "string" ? pathname : "";
    const m = p.match(/^\/doc\/([^/]+)/);
    if (!m?.[1]) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }, [pathname]);
  // Avoid hydration mismatches from client-only sources (localStorage, Date.now()).
  // This returns `false` on the server and `true` on the client without a setState-in-effect.
  const mounted = useSyncExternalStore(
    () => () => {
      // no-op subscription; we only need server vs client snapshots
    },
    () => true,
    () => false,
  );
  const logoSrc = mounted && resolvedTheme === "dark" ? "/icon-white.svg?v=3" : "/icon-black.svg?v=3";
  const [isAddNewDropActive, setIsAddNewDropActive] = useState(false);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [requestName, setRequestName] = useState("");
  const [requestDescription, setRequestDescription] = useState("");
  const [requestRequireAuthToUpload, setRequestRequireAuthToUpload] = useState(false);
  const [requestReviewEnabled, setRequestReviewEnabled] = useState(false);
  const [requestReviewGuideFile, setRequestReviewGuideFile] = useState<File | null>(null);
  const [requestReviewGuideText, setRequestReviewGuideText] = useState("");
  const [showReviewTemplateModal, setShowReviewTemplateModal] = useState(false);
  const [requestReviewAgentLabel, setRequestReviewAgentLabel] = useState<string | null>(null);
  const [requestTriedSubmit, setRequestTriedSubmit] = useState(false);
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestBusyStep, setRequestBusyStep] = useState<
    "idle" | "creating" | "uploading_guide" | "processing_guide" | "finalizing"
  >("idle");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [createdRequestUploadUrl, setCreatedRequestUploadUrl] = useState<string | null>(null);
  const [createdRequestViewUrl, setCreatedRequestViewUrl] = useState<string | null>(null);
  const [createdRequestProjectId, setCreatedRequestProjectId] = useState<string | null>(null);
  // IMPORTANT: don't read localStorage in render-time initializers; it causes SSR/client hydration mismatches.
  // We'll hydrate starred docs in a client-only effect below.
  const [starredDocs, setStarredDocs] = useState<StarredDoc[]>([]);
  // IDs we could not resolve via `/api/docs?ids=...` (stale/phantom localStorage entries).
  // This allows the Starred section to render instantly while still hiding invalid items once verified.
  const [starredInvalidById, setStarredInvalidById] = useState<Record<string, true>>({});
  const [starredSyncing, setStarredSyncing] = useState(false);
  const [starredMetaById, setStarredMetaById] = useState<
    Record<string, { updatedDate: string | null; createdDate: string | null }>
  >({});
  const [starredDetailsById, setStarredDetailsById] = useState<StarredDetailsById>({});
  const [starredDetailsRefreshTick, setStarredDetailsRefreshTick] = useState(0);
  const [starredCollapsed, setStarredCollapsed] = useState(false);
  const [starredCollapsedLoaded, setStarredCollapsedLoaded] = useState(false);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [projectsCollapsedLoaded, setProjectsCollapsedLoaded] = useState(false);
  const [requestsCollapsed, setRequestsCollapsed] = useState(false);
  const [requestsCollapsedLoaded, setRequestsCollapsedLoaded] = useState(false);
  const [docsCollapsed, setDocsCollapsed] = useState(false);
  const [docsCollapsedLoaded, setDocsCollapsedLoaded] = useState(false);
  // Cached meta used ONLY for sorting to avoid a brief reorder flash on refresh.
  // Keep "verified existence" logic based on `starredMetaById` (loaded from /api/docs) untouched.
  const [starredMetaCacheById, setStarredMetaCacheById] = useState<StarredMetaById>({});

  const [showCreateProjectModal, setShowCreateProjectModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDescription, setNewProjectDescription] = useState("");
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [newProjectError, setNewProjectError] = useState<string | null>(null);
  const [pendingNewProjectNavId, setPendingNewProjectNavId] = useState<string | null>(null);
  const [docs, setDocs] = useState<Paged<DocListItem>>({
    items: [],
    total: 0,
    page: 1,
    limit: DOCS_SIDEBAR_LIMIT,
  });

  const [projects, setProjects] = useState<Paged<ProjectListItem>>({
    items: [],
    total: 0,
    page: 1,
    limit: PROJECTS_SIDEBAR_LIMIT,
  });
  const [requests, setRequests] = useState<Paged<RequestListItem>>({
    items: [],
    total: 0,
    page: 1,
    limit: REQUESTS_SIDEBAR_LIMIT,
  });
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [requestsLoaded, setRequestsLoaded] = useState(false);

  const [showDocsModal, setShowDocsModal] = useState(false);
  const [docsQuery, setDocsQuery] = useState("");
  const [showStarredModal, setShowStarredModal] = useState(false);
  const [starredQuery, setStarredQuery] = useState("");
  const [starredModalPage, setStarredModalPage] = useState(1);
  const [showProjectsModal, setShowProjectsModal] = useState(false);
  const [projectsQuery, setProjectsQuery] = useState("");
  const [showRequestsModal, setShowRequestsModal] = useState(false);
  const [requestsQuery, setRequestsQuery] = useState("");
  const starredMetaRef = useRef(starredMetaById);
  const starredDetailsRef = useRef(starredDetailsById);
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null);
  const [hideCopyIconShareId, setHideCopyIconShareId] = useState<string | null>(null);
  const [docsThumbAspectById, setDocsThumbAspectById] = useState<Record<string, number>>({});
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [openDocMenuId, setOpenDocMenuId] = useState<string | null>(null);
  const [openRequestMenuId, setOpenRequestMenuId] = useState<string | null>(null);
  const [deleteProjectOpen, setDeleteProjectOpen] = useState(false);
  const [deleteProjectBusy, setDeleteProjectBusy] = useState(false);
  const [deleteProjectError, setDeleteProjectError] = useState<string | null>(null);
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<ProjectListItem | null>(null);
  const [deleteRequestRepoOpen, setDeleteRequestRepoOpen] = useState(false);
  const [deleteRequestRepoBusy, setDeleteRequestRepoBusy] = useState(false);
  const [deleteRequestRepoError, setDeleteRequestRepoError] = useState<string | null>(null);
  const [deleteRequestRepoTarget, setDeleteRequestRepoTarget] = useState<RequestListItem | null>(null);
  const [deleteDocOpen, setDeleteDocOpen] = useState(false);
  const [deleteDocBusy, setDeleteDocBusy] = useState(false);
  const [deleteDocError, setDeleteDocError] = useState<string | null>(null);
  const [deleteDocTarget, setDeleteDocTarget] = useState<DocListItem | null>(null);
  const [deleteDocFoldersBusy, setDeleteDocFoldersBusy] = useState(false);
  const [deleteDocFolders, setDeleteDocFolders] = useState<DocFolder[] | null>(null);
  const [docsModal, setDocsModal] = useState<Paged<DocListItem>>({
    items: [],
    total: 0,
    page: 1,
    limit: 20,
  });

  const [projectsModal, setProjectsModal] = useState<Paged<ProjectListItem>>({
    items: [],
    total: 0,
    page: 1,
    limit: 20,
  });

  const [requestsModal, setRequestsModal] = useState<Paged<RequestListItem>>({
    items: [],
    total: 0,
    page: 1,
    limit: 20,
  });

  useEffect(() => {
    let cancelled = false;
/**
 * Apply From Cache (updates state (setDocs, setProjects, setProjectsLoaded); uses getSidebarCacheSnapshot, setDocs, setProjects).
 */


    function applyFromCache() {
      const snap = getSidebarCacheSnapshot();
      if (!snap) return;
      setDocs(snap.docs);
      setProjects(snap.projects);
      setRequests(snap.requests);
      setProjectsLoaded(true);
      setRequestsLoaded(true);
    }
/**
 * Handle cache updated events; uses applyFromCache.
 */


    function onCacheUpdated() {
      if (cancelled) return;
      applyFromCache();
    }

    applyFromCache();
    window.addEventListener(SIDEBAR_CACHE_UPDATED_EVENT, onCacheUpdated);

    // Background refresh: keep UI stable; update silently when data changes.
    // Defer so initial page paint isn't competing with sidebar work.
    // Doc pages are especially sensitive (viewer + history), so delay more there.
    // If there's no cache snapshot yet, refresh immediately (otherwise the sidebar stays empty).
    const hasCache = Boolean(getSidebarCacheSnapshot());
    const mountDelayMs = hasCache ? (isDocRoute ? 1200 : 350) : 0;
    const mountT = window.setTimeout(() => {
      void refreshSidebarCache({ reason: "mount" }).finally(() => {
        if (!cancelled) {
          setProjectsLoaded(true);
          setRequestsLoaded(true);
        }
      });
    }, mountDelayMs);
    // Avoid aggressive polling. The sidebar snapshot is cached (localStorage) and updated via:
    // - explicit "changed" events (docs/projects)
    // - tab visibility transitions
    // - a slow backstop interval for long-lived tabs
    const backstopMs = 60_000;
    const id = window.setInterval(() => {
      try {
        if (document.hidden) return;
      } catch {
        // ignore
      }
      void refreshSidebarCache({ reason: "interval" });
    }, backstopMs);

    function onVisibility() {
      try {
        if (document.hidden) return;
      } catch {
        // ignore
      }
      void refreshSidebarCache({ reason: "visibility", force: true });
    }
    window.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.removeEventListener(SIDEBAR_CACHE_UPDATED_EVENT, onCacheUpdated);
      window.removeEventListener("visibilitychange", onVisibility);
      window.clearTimeout(mountT);
      window.clearInterval(id);
    };
  }, [isDocRoute]);

  useEffect(() => {
    if (!openProjectMenuId) return;
/**
 * Handle pointer down events; updates state (setOpenProjectMenuId); uses setOpenProjectMenuId.
 */

    function onPointerDown() {
      setOpenProjectMenuId(null);
    }
/**
 * Handle key down events; updates state (setOpenProjectMenuId); uses setOpenProjectMenuId.
 */

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenProjectMenuId(null);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openProjectMenuId]);

  useEffect(() => {
    if (!openDocMenuId) return;
/**
 * Handle pointer down events; updates state (setOpenDocMenuId); uses setOpenDocMenuId.
 */

    function onPointerDown() {
      setOpenDocMenuId(null);
    }
/**
 * Handle key down events; updates state (setOpenDocMenuId); uses setOpenDocMenuId.
 */

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenDocMenuId(null);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openDocMenuId]);

  useEffect(() => {
    // Refresh projects immediately when another part of the UI creates/updates them.
    let cancelled = false;
/**
 * Refresh (updates state (setProjects, setDocs, setProjectsLoaded); uses refreshSidebarCache, getSidebarCacheSnapshot, setProjects).
 */


    async function refresh() {
      try {
        await refreshSidebarCache({ reason: "projects-changed", force: true });
        if (cancelled) return;
        const snap = getSidebarCacheSnapshot();
        if (snap) {
          setProjects(snap.projects);
          setDocs(snap.docs);
          setRequests(snap.requests);
          setProjectsLoaded(true);
          setRequestsLoaded(true);
        }

        if (!showProjectsModal) return;
        const q = projectsQuery.trim() ? `&q=${encodeURIComponent(projectsQuery.trim())}` : "";
        const res = await fetchWithTempUser(
          `/api/projects?limit=${projectsModal.limit}&page=${projectsModal.page}${q}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = (await res.json()) as {
          projects?: ProjectListItem[];
          total?: number;
          page?: number;
          limit?: number;
        };
        if (cancelled) return;
        setProjectsModal({
          items: Array.isArray(json.projects) ? json.projects : [],
          total: typeof json.total === "number" ? json.total : 0,
          page: typeof json.page === "number" ? json.page : projectsModal.page,
          limit: typeof json.limit === "number" ? json.limit : projectsModal.limit,
        });

        if (!showRequestsModal) return;
        const rq = requestsQuery.trim() ? `&q=${encodeURIComponent(requestsQuery.trim())}` : "";
        const rRes = await fetchWithTempUser(
          `/api/requests?limit=${requestsModal.limit}&page=${requestsModal.page}${rq}`,
          { cache: "no-store" },
        );
        if (!rRes.ok) return;
        const rJson = (await rRes.json()) as {
          items?: RequestListItem[];
          total?: number;
          page?: number;
          limit?: number;
        };
        if (cancelled) return;
        setRequestsModal({
          items: Array.isArray(rJson.items) ? rJson.items : [],
          total: typeof rJson.total === "number" ? rJson.total : 0,
          page: typeof rJson.page === "number" ? rJson.page : requestsModal.page,
          limit: typeof rJson.limit === "number" ? rJson.limit : requestsModal.limit,
        });
      } catch {
        // ignore
      }
    }
/**
 * Handle projects changed events; uses refresh.
 */


    function onProjectsChanged() {
      void refresh();
    }

    window.addEventListener(PROJECTS_CHANGED_EVENT, onProjectsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(PROJECTS_CHANGED_EVENT, onProjectsChanged);
    };
  }, [
    projectsModal.limit,
    projectsModal.page,
    projectsQuery,
    showProjectsModal,
    requestsModal.limit,
    requestsModal.page,
    requestsQuery,
    showRequestsModal,
  ]);

  useEffect(() => {
    // Refresh docs immediately when another part of the UI changes them.
    let cancelled = false;
/**
 * Refresh (updates state (setDocs, setStarredDetailsRefreshTick); uses refreshSidebarCache, getSidebarCacheSnapshot, setDocs).
 */


    async function refresh() {
      try {
        await refreshSidebarCache({ reason: "docs-changed", force: true });
        if (cancelled) return;
        const snap = getSidebarCacheSnapshot();
        if (snap) setDocs(snap.docs);
        // Starred modal uses a best-effort scan of `/api/docs` to populate thumbnails + one-liners.
        // If a doc's one-liner/preview becomes available later, refresh those details too.
        setStarredDetailsRefreshTick((t) => t + 1);
      } catch {
        // ignore
      }
    }
/**
 * Handle docs changed events; uses refresh.
 */


    function onDocsChanged() {
      void refresh();
    }

    window.addEventListener(DOCS_CHANGED_EVENT, onDocsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(DOCS_CHANGED_EVENT, onDocsChanged);
    };
  }, []);

  useEffect(() => {
/**
 * Refresh Starred (updates state (setStarredDocs, setStarredMetaCacheById); uses setStarredDocs, getStarredDocs, setStarredMetaCacheById).
 */

    // Keep starred docs in sync (this tab + other tabs).
    function refreshStarred() {
      setStarredDocs(getStarredDocs());
      // Seed sort metadata from cache so order is stable before the best-effort API paging completes.
      setStarredMetaCacheById(readStarredMetaCache());
    }

    // Best-effort sync from MongoDB source-of-truth into local cache.
    let disposed = false;
    async function syncStarredFromServer() {
      try {
        setStarredSyncing(true);
        await refreshStarredDocsFromServer({ bootstrap: true });
      } catch {
        // ignore
      } finally {
        if (!disposed) setStarredSyncing(false);
      }
    }
/**
 * Handle storage events; uses refreshStarred.
 */

    function onStorage(e: StorageEvent) {
      if (e.storageArea !== window.localStorage) return;
      refreshStarred();
    }
    refreshStarred();
    const syncT = window.setTimeout(() => void syncStarredFromServer(), 500);
    function onActiveOrgChanged() {
      refreshStarred();
      void syncStarredFromServer();
    }
    window.addEventListener(STARRED_DOCS_CHANGED_EVENT, refreshStarred);
    window.addEventListener(ACTIVE_ORG_CHANGED_EVENT, onActiveOrgChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      disposed = true;
      window.clearTimeout(syncT);
      window.removeEventListener(STARRED_DOCS_CHANGED_EVENT, refreshStarred);
      window.removeEventListener(ACTIVE_ORG_CHANGED_EVENT, onActiveOrgChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (!mounted) return;
    try {
      const raw = window.localStorage.getItem(STARRED_COLLAPSED_KEY);
      setStarredCollapsed(raw === "1");
    } catch {
      // ignore
    } finally {
      setStarredCollapsedLoaded(true);
    }
  }, [mounted]);

  useEffect(() => {
    if (!mounted || !starredCollapsedLoaded) return;
    try {
      window.localStorage.setItem(STARRED_COLLAPSED_KEY, starredCollapsed ? "1" : "0");
    } catch {
      // ignore (quota / private mode)
    }
  }, [mounted, starredCollapsed, starredCollapsedLoaded]);

  useEffect(() => {
    if (!mounted) return;
    try {
      const raw = window.localStorage.getItem(PROJECTS_COLLAPSED_KEY);
      setProjectsCollapsed(raw === "1");
    } catch {
      // ignore
    } finally {
      setProjectsCollapsedLoaded(true);
    }
  }, [mounted]);

  useEffect(() => {
    if (!mounted || !projectsCollapsedLoaded) return;
    try {
      window.localStorage.setItem(PROJECTS_COLLAPSED_KEY, projectsCollapsed ? "1" : "0");
    } catch {
      // ignore (quota / private mode)
    }
  }, [mounted, projectsCollapsed, projectsCollapsedLoaded]);

  useEffect(() => {
    if (!mounted) return;
    try {
      const raw = window.localStorage.getItem(DOCS_COLLAPSED_KEY);
      setDocsCollapsed(raw === "1");
    } catch {
      // ignore
    } finally {
      setDocsCollapsedLoaded(true);
    }
  }, [mounted]);

  useEffect(() => {
    if (!mounted || !docsCollapsedLoaded) return;
    try {
      window.localStorage.setItem(DOCS_COLLAPSED_KEY, docsCollapsed ? "1" : "0");
    } catch {
      // ignore (quota / private mode)
    }
  }, [mounted, docsCollapsed, docsCollapsedLoaded]);

  useEffect(() => {
    if (!mounted) return;
    try {
      const raw = window.localStorage.getItem(REQUESTS_COLLAPSED_KEY);
      setRequestsCollapsed(raw === "1");
    } catch {
      // ignore
    } finally {
      setRequestsCollapsedLoaded(true);
    }
  }, [mounted]);

  useEffect(() => {
    if (!mounted || !requestsCollapsedLoaded) return;
    try {
      window.localStorage.setItem(REQUESTS_COLLAPSED_KEY, requestsCollapsed ? "1" : "0");
    } catch {
      // ignore (quota / private mode)
    }
  }, [mounted, requestsCollapsed, requestsCollapsedLoaded]);

  useEffect(() => {
    starredMetaRef.current = starredMetaById;
  }, [starredMetaById]);

  useEffect(() => {
    starredDetailsRef.current = starredDetailsById;
  }, [starredDetailsById]);

  useEffect(() => {
    // Best-effort: fetch updated/created dates for starred docs so we can sort by "updated date".
    // Fetch directly via `/api/docs?ids=...` so Starred can render without waiting on paging.
    if (!starredDocs.length) return;

    let cancelled = false;
/**
 * Load Starred Meta (updates state (setStarredMetaById, setStarredMetaCacheById, setStarredDetailsById); uses filter, map, add).
 */

    async function loadStarredMeta() {
      try {
        const ids = new Set(starredDocs.map((d) => d.id).filter(Boolean));
        if (!ids.size) return;

        const existingMeta = starredMetaRef.current ?? {};
        const existingDetails = starredDetailsRef.current ?? {};

        const forceRefresh = starredDetailsRefreshTick > 0;
        const foundMeta: Record<string, { updatedDate: string | null; createdDate: string | null }> = {};
        const foundDetails: StarredDetailsById = {};
        const foundIds = new Set<string>();

        // Chunk to respect `/api/docs` max limit (50).
        const idList = Array.from(ids);
        const chunks: string[][] = [];
        for (let i = 0; i < idList.length; i += 50) chunks.push(idList.slice(i, i + 50));

        let allOk = true;
        for (const chunk of chunks) {
          if (cancelled) return;
          const res = await fetchWithTempUser(`/api/docs?ids=${encodeURIComponent(chunk.join(","))}&sidebar=1`, {
            cache: "no-store",
          });
          if (!res.ok) {
            allOk = false;
            break;
          }
          const json = (await res.json()) as { docs?: DocListItem[] };
          const docsPage = Array.isArray(json.docs) ? json.docs : [];
        for (const doc of docsPage) {
            if (!doc?.id) continue;
            if (!ids.has(doc.id)) continue;
            foundIds.add(doc.id);

            if (forceRefresh || !existingMeta[doc.id]) {
              foundMeta[doc.id] = {
                updatedDate: doc.updatedDate ?? null,
                createdDate: doc.createdDate ?? null,
              };
            }
            if (forceRefresh || !existingDetails[doc.id]) {
              foundDetails[doc.id] = {
                previewImageUrl: typeof doc.previewImageUrl === "string" ? doc.previewImageUrl : null,
                one_liner: typeof doc.one_liner === "string" ? doc.one_liner : null,
                title: typeof doc.title === "string" ? doc.title : null,
                version: typeof doc.version === "number" && Number.isFinite(doc.version) ? doc.version : null,
                status: typeof doc.status === "string" ? doc.status : null,
              };
            }

            // Persist version/status into the starred local cache so "v#" pills render instantly next time.
            upsertStarredDocMeta({
              id: doc.id,
              version: typeof doc.version === "number" && Number.isFinite(doc.version) ? doc.version : null,
              status: typeof doc.status === "string" ? doc.status : null,
            });
          }
        }

        if (cancelled) return;
        if (Object.keys(foundMeta).length) {
          setStarredMetaById((prev) => ({ ...prev, ...foundMeta }));
          // Also persist to the cache so refreshes don't briefly reorder the list.
          setStarredMetaCacheById((prev) => {
            const ids = new Set(starredDocs.map((d) => d.id).filter(Boolean));
            const merged = { ...prev, ...foundMeta };
            const pruned = pruneMetaCache(merged, ids);
            writeStarredMetaCache(pruned);
            return pruned;
          });
        }

        if (Object.keys(foundDetails).length) {
          setStarredDetailsById((prev) => ({ ...prev, ...foundDetails }));
        }

        // Mark missing IDs as invalid only if we successfully fetched the requested docs.
        // (If the request fails, prefer showing optimistic localStorage items over hiding them.)
        if (allOk) {
          const nextInvalid: Record<string, true> = {};
          for (const id of ids) {
            if (!foundIds.has(id)) nextInvalid[id] = true;
          }
          setStarredInvalidById(nextInvalid);
        }
      } catch {
        // ignore
      }
    }

    const starredMetaT = window.setTimeout(() => void loadStarredMeta(), 600);
    return () => {
      cancelled = true;
      window.clearTimeout(starredMetaT);
    };
  }, [starredDocs, starredDetailsRefreshTick]);

  useEffect(() => {
    if (!showDocsModal) return;
    let cancelled = false;
/**
 * Load (updates state (setDocsModal); uses trim, encodeURIComponent, fetchWithTempUser).
 */

    async function load() {
      try {
        // Prefill from cached sidebar snapshot for instant UI, then refresh in the background.
        if (!docsQuery.trim() && docsModal.page === 1 && docs.items.length) {
          setDocsModal((prev) => ({
            ...prev,
            items: prev.items.length ? prev.items : docs.items.slice(0, prev.limit),
            total: prev.total || docs.total || docs.items.length,
          }));
        }
        const q = docsQuery.trim() ? `&q=${encodeURIComponent(docsQuery.trim())}` : "";
        const res = await fetchWithTempUser(`/api/docs?limit=${docsModal.limit}&page=${docsModal.page}${q}&sidebar=1`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = (await res.json()) as {
          docs?: DocListItem[];
          total?: number;
          page?: number;
          limit?: number;
        };
        if (cancelled) return;
        setDocsModal({
          items: Array.isArray(json.docs) ? json.docs : [],
          total: typeof json.total === "number" ? json.total : 0,
          page: typeof json.page === "number" ? json.page : docsModal.page,
          limit: typeof json.limit === "number" ? json.limit : docsModal.limit,
        });
      } catch {
        // ignore
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [showDocsModal, docsModal.page, docsModal.limit, docsQuery]);

  useEffect(() => {
    if (!showProjectsModal) return;
    let cancelled = false;
/**
 * Load (updates state (setProjectsModal); uses trim, encodeURIComponent, fetchWithTempUser).
 */

    async function load() {
      try {
        // Prefill from cached sidebar snapshot for instant UI, then refresh in the background.
        if (!projectsQuery.trim() && projectsModal.page === 1 && projects.items.length) {
          setProjectsModal((prev) => ({
            ...prev,
            items: prev.items.length ? prev.items : projects.items.slice(0, prev.limit),
            total: prev.total || projects.total || projects.items.length,
          }));
        }
        const q = projectsQuery.trim() ? `&q=${encodeURIComponent(projectsQuery.trim())}` : "";
        const res = await fetchWithTempUser(
          `/api/projects?limit=${projectsModal.limit}&page=${projectsModal.page}${q}&sidebar=1`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = (await res.json()) as {
          projects?: ProjectListItem[];
          total?: number;
          page?: number;
          limit?: number;
        };
        if (cancelled) return;
        setProjectsModal({
          items: Array.isArray(json.projects) ? json.projects : [],
          total: typeof json.total === "number" ? json.total : 0,
          page: typeof json.page === "number" ? json.page : projectsModal.page,
          limit: typeof json.limit === "number" ? json.limit : projectsModal.limit,
        });
      } catch {
        // ignore
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [showProjectsModal, projectsModal.page, projectsModal.limit, projectsQuery]);

  useEffect(() => {
    if (!showRequestsModal) return;
    let cancelled = false;
/**
 * Load (updates state (setRequestsModal); uses trim, encodeURIComponent, fetchWithTempUser).
 */

    async function load() {
      try {
        // Prefill from cached sidebar snapshot for instant UI, then refresh in the background.
        if (!requestsQuery.trim() && requestsModal.page === 1 && requests.items.length) {
          setRequestsModal((prev) => ({
            ...prev,
            items: prev.items.length ? prev.items : requests.items.slice(0, prev.limit),
            total: prev.total || requests.total || requests.items.length,
          }));
        }
        const q = requestsQuery.trim() ? `&q=${encodeURIComponent(requestsQuery.trim())}` : "";
        const res = await fetchWithTempUser(
          `/api/requests?limit=${requestsModal.limit}&page=${requestsModal.page}${q}&sidebar=1`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = (await res.json()) as {
          items?: RequestListItem[];
          total?: number;
          page?: number;
          limit?: number;
        };
        if (cancelled) return;
        setRequestsModal({
          items: Array.isArray(json.items) ? json.items : [],
          total: typeof json.total === "number" ? json.total : 0,
          page: typeof json.page === "number" ? json.page : requestsModal.page,
          limit: typeof json.limit === "number" ? json.limit : requestsModal.limit,
        });
      } catch {
        // ignore
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [showRequestsModal, requestsModal.page, requestsModal.limit, requestsQuery]);

  const docsForSidebar = useMemo(() => docs.items.slice(0, DOCS_SIDEBAR_LIMIT), [docs.items]);

  // Fast-path for starred "v#" pills: if the starred doc is present in the sidebar docs list
  // (which is loaded from localStorage immediately), use that version instead of waiting on
  // `/api/docs?ids=...` to resolve starred details.
  const sidebarDocMetaById = useMemo(() => {
    const out = new Map<string, { version: number | null; status: string | null }>();
    for (const d of docs.items) {
      if (!d?.id) continue;
      out.set(d.id, {
        version: typeof d.version === "number" && Number.isFinite(d.version) ? d.version : null,
        status: typeof d.status === "string" ? d.status : null,
      });
    }
    return out;
  }, [docs.items]);

  const requestFoldersForSidebar = useMemo(() => {
    return requests.items.slice(0, REQUESTS_SIDEBAR_LIMIT);
  }, [requests.items]);

  const projectsForSidebar = useMemo(() => {
    return projects.items.slice(0, PROJECTS_SIDEBAR_LIMIT);
  }, [projects.items]);

  const starredSorted = useMemo(() => {
    // Preserve the stored order of starred docs (manual ordering via move up/down).
    // Meta is still used for display (timestamps), but does not affect ordering.
    return starredDocs;
  }, [starredDocs, starredMetaById, starredMetaCacheById]);

  // Show starred docs immediately (from localStorage), but hide any that we explicitly
  // failed to resolve via `/api/docs?ids=...` (stale/phantom localStorage entries).
  const starredValid = useMemo(() => {
    return starredSorted.filter((d) => !starredInvalidById[d.id]);
  }, [starredInvalidById, starredSorted]);

  const starredForSidebar = useMemo(() => starredValid.slice(0, STARRED_SIDEBAR_LIMIT), [starredValid]);

  // Keep cached starred meta (version/status) up to date from the sidebar docs list snapshot.
  // This makes the Starred "v#" pills render instantly without waiting on `/api/docs?ids=...`.
  useEffect(() => {
    if (!starredDocs.length) return;
    if (!docs.items.length) return;
    for (const s of starredDocs) {
      const meta = sidebarDocMetaById.get(s.id) ?? null;
      if (!meta) continue;
      // Only write when we have something meaningful; `upsertStarredDocMeta` is internally no-op when unchanged.
      if (meta.version != null || meta.status) {
        upsertStarredDocMeta({ id: s.id, version: meta.version, status: meta.status });
      }
    }
  }, [docs.items.length, sidebarDocMetaById, starredDocs]);

  const starredFilteredForModal = useMemo(() => {
    const q = starredQuery.trim().toLowerCase();
    if (!q) return starredValid;
    return starredValid.filter((d) => (d.title ?? "").toLowerCase().includes(q));
  }, [starredQuery, starredValid]);

  const starredModalLimit = 20;
  const starredModalTotal = starredFilteredForModal.length;
  const starredModalMaxPage = Math.max(1, Math.ceil(starredModalTotal / starredModalLimit));
  const starredModalPageClamped = Math.max(1, Math.min(starredModalPage, starredModalMaxPage));
  const starredModalItems = useMemo(() => {
    const start = (starredModalPageClamped - 1) * starredModalLimit;
    return starredFilteredForModal.slice(start, start + starredModalLimit);
  }, [starredFilteredForModal, starredModalLimit, starredModalPageClamped]);

  /**
   * Copy the public `/s/:id` link for a doc to the clipboard.
   */
  async function copyDocLink(shareId: string | null) {
    const url = buildPublicShareUrl(shareId);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedShareId(shareId);
      setHideCopyIconShareId(null);
      window.setTimeout(() => {
        setCopiedShareId((prev) => (prev === shareId ? null : prev));
        // After the "copied" indicator clears, keep the icon hidden until the user hovers again.
        setHideCopyIconShareId(shareId);
      }, 900);
    } catch {
      // ignore
    }
  }
/**
   * Return whether accepted pdf or image.
   */


  function isAcceptedPdfOrImage(file: File) {
    // Some platforms/drivers may provide an empty/unknown MIME type, so fall back
    // to filename extension while still enforcing "PDF or image only".
    const name = (file.name ?? "").toLowerCase();
    return file.type === "application/pdf" || name.endsWith(".pdf") || file.type.startsWith("image/");
  }
/**
 * Open Add New Picker (uses push).
 */


  function openAddNewPicker() {
    if (navLocked) return;
    // "Add new" should go to the home upload page (no OS file picker from the sidebar).
    router.push("/");
  }
/**
 * Create Request (updates state (setRequestTriedSubmit, setRequestBusy, setRequestError); uses setRequestTriedSubmit, setRequestBusy, setRequestError).
 */


  async function createRequest() {
    setRequestTriedSubmit(true);
    setRequestBusy(true);
    setRequestBusyStep("creating");
    setRequestError(null);
    try {
      const hasGuideText = Boolean(requestReviewGuideText.trim());
      if (requestReviewEnabled && !requestReviewGuideFile && !hasGuideText) {
        // Required when Automatic review is selected; show inline error under the upload control.
        return;
      }
      if (requestReviewGuideFile) {
        const name = (requestReviewGuideFile.name ?? "").toLowerCase();
        const isPdf = requestReviewGuideFile.type === "application/pdf" || name.endsWith(".pdf");
        if (!isPdf) {
          setRequestError("Evaluation guide must be a PDF.");
          return;
        }
      }
      if (requestReviewGuideFile && requestReviewGuideFile.size > 1_000_000) {
        setRequestError("Evaluation guide must be 1MB or smaller.");
        return;
      }
      const res = await fetchWithTempUser("/api/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: requestName,
          description: requestDescription,
          requireAuthToUpload: requestRequireAuthToUpload,
          reviewEnabled: requestReviewEnabled,
          reviewPrompt: "",
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        request?: {
          uploadPath?: string;
          uploadToken?: string;
          viewPath?: string;
          viewToken?: string;
          projectId?: string;
        };
      };
      if (!res.ok) {
        setRequestError(json?.error || "Failed to create request");
        return;
      }
      const uploadPath = typeof json?.request?.uploadPath === "string" ? json.request.uploadPath : "";
      const uploadToken = typeof json?.request?.uploadToken === "string" ? json.request.uploadToken : "";
      const viewPath = typeof json?.request?.viewPath === "string" ? json.request.viewPath : "";
      const viewToken = typeof json?.request?.viewToken === "string" ? json.request.viewToken : "";
      const projectId = typeof json?.request?.projectId === "string" ? json.request.projectId : "";
      notifyProjectsChanged();
      void refreshSidebarCache({ reason: "request-created", force: true });

      // Optional: attach an evaluation guide document (thesis / RFP / job description).
      // Best-effort: keep the request link usable even if this fails, but do not silently leave
      // the review agent enabled without a guide attached.
      if (requestReviewEnabled && projectId && (requestReviewGuideFile || hasGuideText)) {
        try {
          // If guide is pasted text, create a lightweight doc with extractedText (no upload pipeline).
          if (!requestReviewGuideFile && hasGuideText) {
            setRequestBusyStep("finalizing");
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
              body: JSON.stringify({ extractedText: requestReviewGuideText.trim(), status: "ready" }),
            });

            await fetchWithTempUser(`/api/requests/${encodeURIComponent(projectId)}/guide`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ docId: guideDocId }),
            });
          } else if (requestReviewGuideFile) {
            const file = requestReviewGuideFile;
            setRequestBusyStep("uploading_guide");

            // 1) Create a doc record for the guide.
            const docRes = await fetchWithTempUser("/api/docs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title: `Request guide: ${file.name}` }),
            });
            const docJson = (await docRes.json().catch(() => ({}))) as { doc?: { id?: string } };
            const guideDocId = typeof docJson?.doc?.id === "string" ? docJson.doc.id : "";
            if (!docRes.ok || !guideDocId) throw new Error("Failed to create guide doc");

            // 2) Create an upload record (skip review for the guide itself).
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

            // 3) Upload to Blob.
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

            // 4) Persist blob metadata + trigger processing.
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

            setRequestBusyStep("processing_guide");
            await fetchWithTempUser(`/api/uploads/${encodeURIComponent(guideUploadId)}/process`, { method: "POST" });

            // IMPORTANT: processing continues on the server after /process returns.
            // Keep the modal in "Processing…" until the guide doc is actually ready.
            const startedAt = Date.now();
            const maxWaitMs = 2 * 60 * 1000;
            // eslint-disable-next-line no-constant-condition
            while (true) {
              if (Date.now() - startedAt > maxWaitMs) {
                throw new Error("Still processing the evaluation guide. Please keep this modal open a bit longer.");
              }
              const stRes = await fetchWithTempUser(`/api/uploads/${encodeURIComponent(guideUploadId)}`, {
                method: "GET",
                cache: "no-store",
              });
              const stJson = (await stRes.json().catch(() => ({}))) as {
                upload?: { status?: string | null };
                doc?: { status?: string | null };
              };
              const uploadStatus = (stJson.upload?.status ?? "").toLowerCase();
              const docStatus = (stJson.doc?.status ?? "").toLowerCase();
              if (uploadStatus === "failed" || docStatus === "failed") {
                throw new Error("Evaluation guide processing failed. Please try again.");
              }
              if (docStatus === "ready") break;
              await new Promise((r) => setTimeout(r, 900));
            }

            setRequestBusyStep("finalizing");
            // 5) Attach to the request folder.
            await fetchWithTempUser(`/api/requests/${encodeURIComponent(projectId)}/guide`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ docId: guideDocId }),
            });
          }
        } catch {
          // Best-effort: keep the request link usable even if guide upload fails,
          // but disable review since the guide is required for automatic review.
          setRequestError(
            "Repository created, but evaluation guide upload failed. Automatic review was disabled—attach a guide from the repo settings to enable it.",
          );
          try {
            await fetchWithTempUser(`/api/projects/${encodeURIComponent(projectId)}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                name: requestName,
                description: requestDescription,
                autoAddFiles: false,
                requestReviewEnabled: false,
                requestReviewPrompt: "",
              }),
            });
          } catch {
            // ignore
          }
        }
      }

      // Only show the success state once server-side setup is complete.
      const uploadUrl =
        buildPublicRequestUrl(uploadToken) ||
        (function () {
          const base = getPublicSiteBase();
          return base && uploadPath ? new URL(uploadPath, base).toString() : uploadPath || "";
        })();
      const viewUrl =
        buildPublicRequestViewUrl(viewToken) ||
        (function () {
          const base = getPublicSiteBase();
          return base && viewPath ? new URL(viewPath, base).toString() : viewPath || "";
        })();
      setCreatedRequestUploadUrl(uploadUrl || null);
      setCreatedRequestViewUrl(viewUrl || null);
      setCreatedRequestProjectId(projectId || null);
    } catch {
      setRequestError("Failed to create request");
    } finally {
      setRequestBusy(false);
      setRequestBusyStep("idle");
    }
  }

  function resetCreateRequestModal() {
    setShowRequestModal(false);
    setRequestBusy(false);
    setRequestBusyStep("idle");
    setRequestError(null);
    setCreatedRequestUploadUrl(null);
    setCreatedRequestViewUrl(null);
    setCreatedRequestProjectId(null);
    setRequestName("");
    setRequestDescription("");
    setRequestRequireAuthToUpload(false);
    setRequestReviewEnabled(false);
    setRequestReviewGuideFile(null);
    setRequestReviewGuideText("");
    setShowReviewTemplateModal(false);
    setRequestReviewAgentLabel(null);
    setRequestTriedSubmit(false);
  }

  // (intentionally no extra per-request notes field; Guide doc is the steering context)
/**
 * Delete Project By Id (updates state (setDeleteProjectBusy, setDeleteProjectError, setDeleteProjectOpen); uses setDeleteProjectBusy, setDeleteProjectError, fetchWithTempUser).
 */


  async function deleteProjectById(projectId: string) {
    setDeleteProjectBusy(true);
    setDeleteProjectError(null);
    try {
      const res = await fetchWithTempUser(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "DELETE",
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setDeleteProjectError(json?.error || "Failed to delete project");
        return;
      }
      setDeleteProjectOpen(false);
      setDeleteProjectTarget(null);
      notifyProjectsChanged();
      void refreshSidebarCache({ reason: "project-deleted", force: true });
    } catch {
      setDeleteProjectError("Failed to delete project");
    } finally {
      setDeleteProjectBusy(false);
    }
  }

  async function deleteRequestRepoById(projectId: string, mode: RequestRepoDeleteMode) {
    setDeleteRequestRepoBusy(true);
    setDeleteRequestRepoError(null);
    try {
      const res = await fetchWithTempUser(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestDocsMode: mode }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setDeleteRequestRepoError(json?.error || "Failed to delete request repository");
        return;
      }
      setDeleteRequestRepoOpen(false);
      setDeleteRequestRepoTarget(null);
      notifyProjectsChanged();
      void refreshSidebarCache({ reason: "request-repo-deleted", force: true });
    } catch {
      setDeleteRequestRepoError("Failed to delete request repository");
    } finally {
      setDeleteRequestRepoBusy(false);
    }
  }
/**
 * Delete Doc By Id (updates state (setDeleteDocBusy, setDeleteDocError, setDeleteDocOpen); uses setDeleteDocBusy, setDeleteDocError, fetchWithTempUser).
 */


  async function deleteDocById(docId: string) {
    setDeleteDocBusy(true);
    setDeleteDocError(null);
    try {
      const res = await fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}`, { method: "DELETE" });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setDeleteDocError(json?.error || "Failed to delete document");
        return;
      }
      setDeleteDocOpen(false);
      setDeleteDocTarget(null);
      notifyDocsChanged();
      void refreshSidebarCache({ reason: "doc-deleted", force: true });
    } catch {
      setDeleteDocError("Failed to delete document");
    } finally {
      setDeleteDocBusy(false);
    }
  }

  async function createProject() {
    if (navLocked) return;
    setNewProjectBusy(true);
    setNewProjectError(null);
    let createdId: string | null = null;
    try {
      const name = newProjectName.trim();
      const description = newProjectDescription.trim();
      if (!name) {
        setNewProjectError("Project name is required.");
        return;
      }

      const res = await fetchWithTempUser("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          autoAddFiles: false,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        project?: { id?: string; slug?: string };
      };
      if (!res.ok) {
        setNewProjectError(json?.error || "Failed to create project");
        return;
      }
      const id = typeof json?.project?.id === "string" ? json.project.id : "";
      if (!id) {
        setNewProjectError("Failed to create project");
        return;
      }

      createdId = id;
      setPendingNewProjectNavId(id);
      optimisticallyAddProjectToSidebarCache({
        id,
        name,
        slug: typeof json?.project?.slug === "string" ? json.project.slug : "",
        description,
        isRequest: false,
        docCount: 0,
        updatedDate: new Date().toISOString(),
        createdDate: new Date().toISOString(),
      });
      notifyProjectsChanged();
      void refreshSidebarCache({ reason: "project-created", force: true });
      router.push(`/project/${encodeURIComponent(id)}`);
    } catch {
      setNewProjectError("Failed to create project");
    } finally {
      // If project creation succeeded, keep the modal open + busy until navigation completes.
      if (!createdId) setNewProjectBusy(false);
    }
  }

  // Close the Create Project modal only after we've actually navigated to the new project.
  useEffect(() => {
    if (!pendingNewProjectNavId) return;
    const target = `/project/${pendingNewProjectNavId}`;
    if (pathname === target || pathname.startsWith(`${target}/`)) {
      setShowCreateProjectModal(false);
      setNewProjectName("");
      setNewProjectDescription("");
      setNewProjectError(null);
      setPendingNewProjectNavId(null);
      setNewProjectBusy(false);
    }
  }, [pathname, pendingNewProjectNavId]);

  // When opening delete confirmation, fetch the folders/projects this doc belongs to
  // so the user understands what they’re deleting.
  useEffect(() => {
    if (!deleteDocOpen) return;
    const docId = deleteDocTarget?.id ?? "";
    if (!docId) return;

    const ac = new AbortController();
    setDeleteDocFoldersBusy(true);
    setDeleteDocFolders(null);

    (async () => {
      try {
        const res = await fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}`, {
          cache: "no-store",
          signal: ac.signal,
        });
        const json = (await res.json().catch(() => ({}))) as unknown;
        if (!res.ok) return;
        const projectsRaw =
          json && typeof json === "object" && "doc" in json
            ? (json as { doc?: unknown }).doc
            : null;
        const foldersMaybe =
          projectsRaw && typeof projectsRaw === "object" && "projects" in projectsRaw
            ? (projectsRaw as { projects?: unknown }).projects
            : null;

        if (!Array.isArray(foldersMaybe)) {
          setDeleteDocFolders([]);
          return;
        }

        const parsed: DocFolder[] = [];
        for (const p of foldersMaybe) {
          if (!p || typeof p !== "object") continue;
          const id = "id" in p ? (p as { id?: unknown }).id : null;
          const name = "name" in p ? (p as { name?: unknown }).name : null;
          const slug = "slug" in p ? (p as { slug?: unknown }).slug : null;
          if (typeof id !== "string" || !id) continue;
          parsed.push({
            id,
            name: typeof name === "string" ? name : "",
            slug: typeof slug === "string" ? slug : "",
          });
        }
        setDeleteDocFolders(parsed);
      } catch (e) {
        // ignore (best-effort), including aborts
        void e;
      } finally {
        setDeleteDocFoldersBusy(false);
      }
    })();

    return () => ac.abort();
  }, [deleteDocOpen, deleteDocTarget?.id]);

  return (
    <aside className="lnkdrp-sidebar relative z-50 h-screen w-[280px] shrink-0 overflow-hidden border-r border-[color-mix(in_srgb,var(--border)_35%,transparent)] bg-[var(--sidebar-bg)]">
      <div className="flex h-full flex-col">
        <div className="flex min-w-0 items-center gap-2 px-4 pb-5 pt-5">
          <Link href="/" className="inline-flex shrink-0 items-center gap-2" aria-label="Home">
            <Image src={logoSrc} alt="LinkDrop" width={28} height={28} className="block" />
          </Link>
          <ActiveWorkspacePill
            maxWidthClassName="max-w-[240px]"
            textClassName="text-[13px]"
            // On doc pages, avoid extra network work competing with the viewer/history UI.
            disableNetwork={isDocRoute}
          />
        </div>

        <div className="pl-3 pr-12 pt-2 pb-2">
          <div className="grid gap-0.5">
            <button
              type="button"
              disabled={navLocked}
              className={[
                "group w-full cursor-pointer overflow-hidden rounded-xl pl-3 pr-2 py-1.5 text-left text-[15px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20",
                navLocked ? "cursor-not-allowed opacity-50" : "text-[var(--fg)] hover:bg-[var(--sidebar-hover)]",
              ].join(" ")}
              onClick={() => {
                if (navLocked) return;
                setDocsModal((s) => ({ ...s, page: 1 }));
                setShowDocsModal(true);
              }}
              aria-label="Search"
              title={navLocked ? "Disabled while uploading" : "Search"}
            >
              <div className="flex items-center gap-2">
                <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)] opacity-80" />
                <span>Search</span>
              </div>
            </button>

            <button
              type="button"
              disabled={navLocked}
              className={[
                "group relative w-full cursor-pointer overflow-hidden rounded-xl pl-3 pr-2 py-1.5 text-left text-[15px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20",
                navLocked ? "cursor-not-allowed opacity-50" : "text-[var(--fg)] hover:bg-[var(--sidebar-hover)]",
                isAddNewDropActive ? "bg-[var(--sidebar-hover)] text-[var(--fg)]" : "",
              ].join(" ")}
              onClick={() => openAddNewPicker()}
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (navLocked) return;
                setIsAddNewDropActive(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (navLocked) return;
                setIsAddNewDropActive(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (navLocked) return;
                const related = e.relatedTarget as Node | null;
                if (related && e.currentTarget.contains(related)) return;
                setIsAddNewDropActive(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsAddNewDropActive(false);
                if (navLocked) return;
                const file = e.dataTransfer?.files?.[0] ?? null;
                if (!file) return;
                if (!isAcceptedPdfOrImage(file)) return;
                onAddNewFile(file);
              }}
              aria-label="Upload"
              title={navLocked ? "Disabled while uploading" : "Upload"}
            >
              <div className={["flex items-center gap-2", isAddNewDropActive ? "opacity-25" : "opacity-100"].join(" ")}>
                <DocumentPlusIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)] opacity-80" />
                <span>Upload</span>
              </div>

              {isAddNewDropActive ? (
                <div className="pointer-events-none absolute left-1/2 top-[calc(100%+6px)] z-10 -translate-x-1/2">
                  <div className="whitespace-nowrap rounded-full bg-[var(--panel)]/90 px-3 py-1 text-[13px] font-semibold text-[var(--fg)] shadow-sm ring-1 ring-black/5 backdrop-blur">
                    Drop to upload
                  </div>
                </div>
              ) : null}
            </button>

            <button
              type="button"
              disabled={navLocked}
              className={[
                "group w-full cursor-pointer overflow-hidden rounded-xl pl-3 pr-2 py-1.5 text-left text-[15px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20",
                navLocked ? "cursor-not-allowed opacity-50" : "text-[var(--fg)] hover:bg-[var(--sidebar-hover)]",
              ].join(" ")}
              onClick={() => {
                if (navLocked) return;
                setShowRequestModal(true);
                setRequestError(null);
                setCreatedRequestUploadUrl(null);
                setCreatedRequestProjectId(null);
              }}
              aria-label="Request"
              title={navLocked ? "Disabled while uploading" : "Request"}
            >
              <div className="flex items-center gap-2">
                <InboxArrowDownIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)] opacity-80" />
                <span>Request</span>
              </div>
            </button>
          </div>
        </div>

        <nav
          // Force a stable scrollbar presence to avoid horizontal layout shift when sections collapse/expand.
          // (Some browsers ignore `scrollbar-gutter`, so `overflow-y-scroll` is the reliable backstop.)
          className="mt-2 flex-1 overflow-y-scroll overflow-x-hidden pl-3 pr-12 pb-4"
          style={{ scrollbarGutter: "stable" }}
        >
          <div className="grid gap-3">
            <section>
              <div className="flex h-6 items-center gap-1 pl-1 pr-2 text-[13px] font-medium leading-5 text-[color-mix(in_srgb,var(--fg)_74%,transparent)]">
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1.5 rounded-md px-1 py-0 text-left hover:bg-[var(--sidebar-hover)]"
                  onClick={() => {
                    setStarredCollapsedLoaded(true);
                    setStarredCollapsed((v) => !v);
                  }}
                >
                  <StarIcon className="h-4 w-4 text-amber-400" filled />
                  <span>Starred</span>
                </button>
                <IconButton
                  ariaLabel={(starredCollapsedLoaded ? starredCollapsed : true) ? "Expand starred" : "Collapse starred"}
                  variant="ghost"
                  size="sm"
                  className={[
                    // Keep inline next to the title (avoids overlay scrollbar issues).
                    "h-6 w-6 rounded-md p-0 text-[color-mix(in_srgb,var(--fg)_74%,transparent)]",
                    "opacity-100",
                  ].join(" ")}
                  onClick={() => {
                    setStarredCollapsedLoaded(true);
                    setStarredCollapsed((v) => !v);
                  }}
                >
                  <StablePlusMinusIcon expanded={!(starredCollapsedLoaded ? starredCollapsed : true)} />
                </IconButton>
              </div>

              {(starredCollapsedLoaded ? starredCollapsed : true) ? (
                !starredValid.length ? (
                  <div className="mt-2 pl-3 pr-2 py-2 text-[13px] text-[var(--muted)]">
                    {starredSyncing ? "Loading starred…" : "No starred docs yet."}
                  </div>
                ) : (
                  <div className="mt-2 flex items-center justify-between gap-3 pl-3 pr-2 py-1.5">
                    <div className="text-[13px] font-medium text-[var(--muted)]">{starredValid.length} starred</div>
                    <button
                      type="button"
                      disabled={navLocked}
                      className={[
                        "rounded-lg px-2 py-1 text-[13px] font-medium text-[var(--muted)]",
                        navLocked ? "cursor-not-allowed opacity-60" : "hover:bg-[var(--sidebar-hover)]",
                      ].join(" ")}
                      onClick={() => {
                        if (navLocked) return;
                        setShowStarredModal(true);
                      }}
                    >
                      See more
                    </button>
                  </div>
                )
              ) : !starredForSidebar.length ? (
                <div className="mt-2 pl-3 pr-2 py-2 text-[13px] text-[var(--muted)]">
                  {starredSyncing ? "Loading starred…" : "No starred docs yet."}
                </div>
              ) : (
                <ul className="mt-2 space-y-1">
                  {starredForSidebar.map((d) => {
                    const href = `/doc/${d.id}`;
                    const details = starredDetailsById[d.id] ?? null;
                    const sidebarMeta = sidebarDocMetaById.get(d.id) ?? null;
                    const title = truncateEnd(d.title, 32);
                    return (
                      <li key={d.id}>
                        <Link
                          href={href}
                          className={[
                            // Avoid `w-full + margin` overflow that can slide under the body divider.
                            // IMPORTANT: `box-border` so padding does not increase the effective width.
                            "block box-border w-[calc(100%-12px)] overflow-hidden rounded-xl pl-3 pr-2 py-1.5 text-left text-[15px]",
                            activeDocId === d.id ? "bg-[var(--sidebar-hover)]" : "hover:bg-[var(--sidebar-hover)]",
                          ].join(" ")}
                        >
                          <div className="flex min-w-0 items-center gap-1.5">
                            <StarIcon className="h-3.5 w-3.5 shrink-0 text-amber-400 opacity-70" />
                            <span className="block min-w-0 flex-1 truncate font-medium text-[var(--fg)]">{title}</span>
                          </div>
                        </Link>
                      </li>
                    );
                  })}

                  {starredValid.length > STARRED_SIDEBAR_LIMIT ? (
                    <li>
                      <button
                        type="button"
                        disabled={navLocked}
                        className={[
                          "w-full rounded-xl pl-3 pr-2 py-1 text-left text-[13px] font-medium text-[var(--muted)]",
                          navLocked ? "cursor-not-allowed opacity-60" : "hover:bg-[var(--sidebar-hover)]",
                        ].join(" ")}
                        onClick={() => {
                          if (navLocked) return;
                          setShowStarredModal(true);
                        }}
                      >
                        See more
                      </button>
                    </li>
                  ) : null}
                </ul>
              )}
            </section>

            <section>
              <div className="flex h-6 items-center gap-1 pl-1 pr-2 text-[13px] font-medium leading-5 text-[color-mix(in_srgb,var(--fg)_74%,transparent)]">
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1.5 rounded-md px-1 py-0 text-left hover:bg-[var(--sidebar-hover)]"
                  onClick={() => {
                    setRequestsCollapsedLoaded(true);
                    setRequestsCollapsed((v) => !v);
                  }}
                >
                  <span>Received</span>
                </button>
                <IconButton
                  ariaLabel={(requestsCollapsedLoaded ? requestsCollapsed : true) ? "Expand received" : "Collapse received"}
                  variant="ghost"
                  size="sm"
                  className={[
                    // Keep inline next to the title (avoids overlay scrollbar issues).
                    "h-6 w-6 rounded-md p-0 text-[color-mix(in_srgb,var(--fg)_74%,transparent)]",
                    "opacity-100",
                  ].join(" ")}
                  onClick={() => {
                    setRequestsCollapsedLoaded(true);
                    setRequestsCollapsed((v) => !v);
                  }}
                >
                  <StablePlusMinusIcon expanded={!(requestsCollapsedLoaded ? requestsCollapsed : true)} />
                </IconButton>
              </div>

              {(requestsCollapsedLoaded ? requestsCollapsed : true) ? (
                !requestsLoaded ? (
                  <div className="mt-2 pl-3 pr-2 py-2 text-[13px] text-[var(--muted)]">Loading…</div>
                ) : !requests.total && !requests.items.length ? (
                  <div className="mt-2 pl-3 pr-2 py-2 text-[13px] text-[var(--muted)]">Nothing received yet.</div>
                ) : (
                  <div className="mt-2 flex items-center gap-3 pl-3 pr-2 py-1.5">
                    <div className="text-[13px] font-medium text-[var(--muted)]">
                      {requests.total || requests.items.length} inbox{(requests.total || requests.items.length) === 1 ? "" : "es"}
                    </div>
                    <button
                      type="button"
                      disabled={navLocked}
                      className={[
                        "rounded-lg px-2 py-1 text-[13px] font-medium text-[var(--muted)]",
                        navLocked ? "cursor-not-allowed opacity-60" : "hover:bg-[var(--sidebar-hover)]",
                      ].join(" ")}
                      onClick={() => {
                        if (navLocked) return;
                        setShowRequestsModal(true);
                      }}
                    >
                      See more
                    </button>
                  </div>
                )
              ) : !requestsLoaded ? (
                <div className="mt-2 pl-3 pr-2 py-2 text-[13px] text-[var(--muted)]">Loading…</div>
              ) : !requestFoldersForSidebar.length ? (
                <div className="mt-2 pl-3 pr-2 py-2 text-[13px] text-[var(--muted)]">Nothing received yet.</div>
              ) : (
                <ul className="mt-2 space-y-1">
                  {requestFoldersForSidebar.map((p) => (
                    <li key={p.id}>
                      <div className="group relative">
                        <div
                          role="link"
                          tabIndex={0}
                          className="w-full cursor-pointer overflow-hidden rounded-xl pl-3 pr-2 py-1.5 text-left text-[13px] hover:bg-[var(--sidebar-hover)]"
                          onClick={() => {
                            setOpenProjectMenuId(null);
                            setOpenDocMenuId(null);
                            setOpenRequestMenuId(null);
                            router.push(`/project/${p.id}`);
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            setOpenProjectMenuId(null);
                            setOpenDocMenuId(null);
                            setOpenRequestMenuId(null);
                            router.push(`/project/${p.id}`);
                          }}
                          title={p.description || undefined}
                        >
                          <div className="flex min-w-0 items-center gap-1.5 pr-10">
                            <InboxArrowDownIcon className="h-4 w-4 shrink-0 text-[var(--muted)]" />
                              <span className="block min-w-0 flex-1 truncate font-medium text-[var(--fg)]">
                                {truncateEnd(p.name || "Request", 27)}
                              </span>
                          </div>
                        </div>

                        <IconButton
                          ariaLabel="Request repository actions"
                          variant="ghost"
                          size="xs"
                          className={[
                            // IMPORTANT: keep this out of layout so it doesn't affect row height.
                            "absolute right-3.5 top-1/2 -translate-y-1/2 rounded-md text-[var(--muted)]",
                            "opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100",
                          ].join(" ")}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setOpenProjectMenuId(null);
                            setOpenDocMenuId(null);
                            setOpenRequestMenuId((prev) => (prev === p.id ? null : p.id));
                          }}
                        >
                          <EllipsisHorizontalIcon className="h-4 w-4" />
                        </IconButton>

                        {openRequestMenuId === p.id ? (
                          <div
                            className="absolute right-2 top-[calc(100%+6px)] z-50 w-[210px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-lg"
                            onPointerDown={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium text-red-700 hover:bg-red-50"
                              onClick={() => {
                                setOpenRequestMenuId(null);
                                setDeleteRequestRepoTarget(p);
                                setDeleteRequestRepoError(null);
                                setDeleteRequestRepoOpen(true);
                              }}
                            >
                              <span>Delete repository…</span>
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}

                  {requests.total > REQUESTS_SIDEBAR_LIMIT ? (
                    <li>
                      <button
                        type="button"
                        disabled={navLocked}
                        className={[
                          "w-full rounded-xl pl-3 pr-2 py-1 text-left text-[13px] font-medium text-[var(--muted)]",
                          navLocked ? "cursor-not-allowed opacity-60" : "hover:bg-[var(--sidebar-hover)]",
                        ].join(" ")}
                        onClick={() => {
                          if (navLocked) return;
                          setShowRequestsModal(true);
                        }}
                      >
                        See more
                      </button>
                    </li>
                  ) : null}
                </ul>
              )}
            </section>

            <section>
              <SidebarProjectsSection
                navLocked={navLocked}
                activeProjectId={activeProjectId}
                projectsLoaded={projectsLoaded}
                projects={projects}
                projectsForSidebar={projectsForSidebar}
                projectsSidebarLimit={PROJECTS_SIDEBAR_LIMIT}
                projectsCollapsedLoaded={projectsCollapsedLoaded}
                projectsCollapsed={projectsCollapsed}
                setProjectsCollapsedLoaded={setProjectsCollapsedLoaded}
                setProjectsCollapsed={setProjectsCollapsed}
                setShowProjectsModal={setShowProjectsModal}
                onClickNewProject={() => {
                  if (navLocked) return;
                  setNewProjectError(null);
                  setShowCreateProjectModal(true);
                }}
                routerPush={(href) => router.push(href)}
                openProjectMenuId={openProjectMenuId}
                setOpenProjectMenuId={setOpenProjectMenuId}
                setOpenDocMenuId={setOpenDocMenuId}
                setDeleteProjectTarget={(p) => setDeleteProjectTarget(p)}
                setDeleteProjectError={setDeleteProjectError}
                setDeleteProjectOpen={setDeleteProjectOpen}
                truncateEnd={truncateEnd}
              />
            </section>

            <section>
              <div className="flex h-6 items-center gap-1 pl-1 pr-2 text-[13px] font-medium leading-5 text-[color-mix(in_srgb,var(--fg)_74%,transparent)]">
                <button
                  type="button"
                  className="inline-flex h-6 items-center rounded-md px-1 py-0 text-left hover:bg-[var(--sidebar-hover)]"
                  onClick={() => {
                    setDocsCollapsedLoaded(true);
                    setDocsCollapsed((v) => !v);
                  }}
                >
                  Docs
                </button>
                <IconButton
                  ariaLabel={(docsCollapsedLoaded ? docsCollapsed : true) ? "Expand docs" : "Collapse docs"}
                  variant="ghost"
                  size="sm"
                  className={[
                    // Keep this control right next to the title so overlay scrollbars can't cover it.
                    "h-6 w-6 rounded-md p-0 text-[color-mix(in_srgb,var(--fg)_74%,transparent)]",
                    "opacity-100",
                  ].join(" ")}
                  onClick={() => {
                    setDocsCollapsedLoaded(true);
                    setDocsCollapsed((v) => !v);
                  }}
                >
                  <StablePlusMinusIcon expanded={!(docsCollapsedLoaded ? docsCollapsed : true)} />
                </IconButton>
              </div>

              {(docsCollapsedLoaded ? docsCollapsed : true) ? (
                docs.total <= 0 && !docs.items.length ? (
                  <div className="mt-2 pl-3 pr-2 py-2 text-[13px] text-[var(--muted)]">No docs/links yet.</div>
                ) : (
                  <div className="mt-2 flex items-center justify-between gap-3 pl-3 pr-2 py-1.5">
                    <div className="text-[13px] font-medium text-[var(--muted)]">
                      {docs.total || docs.items.length} docs
                    </div>
                    <button
                      type="button"
                      disabled={navLocked}
                      className={[
                        "rounded-lg px-2 py-1 text-[13px] font-medium text-[var(--muted)]",
                        navLocked ? "cursor-not-allowed opacity-60" : "hover:bg-[var(--sidebar-hover)]",
                      ].join(" ")}
                      onClick={() => {
                        if (navLocked) return;
                        setShowDocsModal(true);
                      }}
                    >
                      See more
                    </button>
                  </div>
                )
              ) : (
                <ul className="mt-2 space-y-1">
                  {docsForSidebar.map((d) => {
                  // App navigation should always go to the internal doc page.
                  // The public `/share/:shareId` page is for external recipients.
                  const href = `/doc/${d.id}`;
                  const when = mounted ? formatRelative(d.updatedDate ?? d.createdDate) : "";
                  // Explicit character cap so long titles never crowd out right-side controls.
                  // Keep this conservative since we also show version pills + hover actions on the right.
                  const title = truncateEnd(d.title, 32);
                  return (
                    <li key={d.id}>
                      <div className="group relative">
                        <Link
                          href={href}
                          className={[
                            // Avoid `w-full + margin` overflow that can slide under the body divider.
                            // IMPORTANT: `box-border` so padding does not increase the effective width.
                            "block box-border w-[calc(100%-12px)] overflow-hidden rounded-xl pl-3 pr-2 py-1.5 text-left text-[15px]",
                            activeDocId === d.id ? "bg-[var(--sidebar-hover)]" : "hover:bg-[var(--sidebar-hover)]",
                          ].join(" ")}
                          title={when ? `Updated ${when}` : undefined}
                        >
                          <div className="flex min-w-0 items-center gap-1.5 text-[15px] font-medium leading-normal text-[var(--fg)]">
                            <span className="block min-w-0 flex-1 truncate">{title}</span>
                          </div>
                        </Link>
                      </div>
                    </li>
                  );
                })}

                {docs.total > DOCS_SIDEBAR_LIMIT ? (
                  <li>
                    <button
                      type="button"
                      className="w-full rounded-xl pl-3 pr-2 py-1.5 text-left text-[13px] font-medium text-[var(--muted)] hover:bg-[var(--sidebar-hover)]"
                      onClick={() => setShowDocsModal(true)}
                    >
                      See more
                    </button>
                  </li>
                ) : null}

                {!docsForSidebar.length ? (
                  <li className="pl-3 pr-2 py-2 text-[13px] text-[var(--muted)]">No docs/links yet.</li>
                ) : null}
                </ul>
              )}

            </section>
          </div>
        </nav>

        <div className="border-t border-[var(--border)] px-3 py-3">
          <AccountMenu />
        </div>
      </div>

      {/* Docs modal */}
      {/* Request modal */}
      <CreateLinkRequestRepositoryModal
        open={showRequestModal}
        onModalClose={() => resetCreateRequestModal()}
        onClickClose={() => resetCreateRequestModal()}
        onClickCancel={() => resetCreateRequestModal()}
        onOpenCreatedProject={() => {
          if (!createdRequestProjectId) return;
          resetCreateRequestModal();
          router.push(`/project/${encodeURIComponent(createdRequestProjectId)}`);
        }}
        onOpenReviewPerspective={() => setShowReviewTemplateModal(true)}
        onCreate={() => void createRequest()}
        requestBusy={requestBusy}
        requestBusyStep={requestBusyStep}
        requestName={requestName}
        setRequestName={setRequestName}
        requestDescription={requestDescription}
        setRequestDescription={setRequestDescription}
        requestRequireAuthToUpload={requestRequireAuthToUpload}
        setRequestRequireAuthToUpload={setRequestRequireAuthToUpload}
        requestReviewEnabled={requestReviewEnabled}
        setRequestReviewEnabled={setRequestReviewEnabled}
        requestReviewAgentLabel={requestReviewAgentLabel}
        setRequestReviewAgentLabel={setRequestReviewAgentLabel}
        requestReviewGuideFile={requestReviewGuideFile}
        setRequestReviewGuideFile={setRequestReviewGuideFile}
        requestReviewGuideText={requestReviewGuideText}
        setRequestReviewGuideText={setRequestReviewGuideText}
        requestTriedSubmit={requestTriedSubmit}
        requestError={requestError}
        setRequestError={setRequestError}
        createdRequestUploadUrl={createdRequestUploadUrl}
        createdRequestViewUrl={createdRequestViewUrl}
        createdRequestProjectId={createdRequestProjectId}
      />

      <ReviewPerspectiveModal
        open={showReviewTemplateModal}
        onClose={() => setShowReviewTemplateModal(false)}
        onSelectVentureCapitalist={() => {
          setRequestReviewAgentLabel("Venture Capitalist");
          setShowReviewTemplateModal(false);
        }}
      />

      <SidebarDocsModal
        open={showDocsModal}
        onModalClose={() => {
          setShowDocsModal(false);
          setDocsQuery("");
          setDocsModal((s) => ({ ...s, page: 1 }));
        }}
        onDismiss={() => setShowDocsModal(false)}
        routerPush={(href) => router.push(href)}
        docsQuery={docsQuery}
        setDocsQuery={setDocsQuery}
        docsModal={docsModal}
        setDocsModal={setDocsModal}
        docsThumbAspectById={docsThumbAspectById}
        setDocsThumbAspectById={setDocsThumbAspectById}
        hideCopyIconShareId={hideCopyIconShareId}
        setHideCopyIconShareId={setHideCopyIconShareId}
        copiedShareId={copiedShareId}
        copyDocLink={copyDocLink}
        formatRelative={formatRelative}
      />

      <DeleteProjectModal
        open={deleteProjectOpen}
        projectName={deleteProjectTarget?.name ?? "this project"}
        busy={deleteProjectBusy}
        error={deleteProjectError}
        onClose={() => {
          if (deleteProjectBusy) return;
          setDeleteProjectOpen(false);
          setDeleteProjectTarget(null);
          setDeleteProjectError(null);
        }}
        onConfirm={() => {
          const id = deleteProjectTarget?.id ?? "";
          if (!id) return;
          void deleteProjectById(id);
        }}
      />

      <DeleteRequestRepoModal
        open={deleteRequestRepoOpen}
        repoName={deleteRequestRepoTarget?.name ?? "this repository"}
        busy={deleteRequestRepoBusy}
        error={deleteRequestRepoError}
        onClose={() => {
          if (deleteRequestRepoBusy) return;
          setDeleteRequestRepoOpen(false);
          setDeleteRequestRepoTarget(null);
          setDeleteRequestRepoError(null);
        }}
        onConfirm={(mode) => {
          const id = deleteRequestRepoTarget?.id ?? "";
          if (!id) return;
          void deleteRequestRepoById(id, mode);
        }}
      />

      <DeleteDocModal
        open={deleteDocOpen}
        busy={Boolean(deleteDocBusy)}
        canConfirm={Boolean(deleteDocTarget?.id)}
        docTitle={deleteDocTarget?.title ?? "this doc"}
        foldersBusy={Boolean(deleteDocFoldersBusy)}
        folders={deleteDocFolders}
        error={deleteDocError}
        onClose={() => {
          setDeleteDocOpen(false);
          setDeleteDocTarget(null);
          setDeleteDocError(null);
          setDeleteDocFolders(null);
        }}
        onCancel={() => {
          setDeleteDocOpen(false);
          setDeleteDocTarget(null);
          setDeleteDocError(null);
          setDeleteDocFolders(null);
        }}
        onConfirm={() => {
          const id = deleteDocTarget?.id ?? "";
          if (!id) return;
          void deleteDocById(id);
        }}
      />

      {/* Starred modal */}
      <SidebarStarredModal
        open={showStarredModal}
        onClose={() => setShowStarredModal(false)}
        routerPush={(href) => router.push(href)}
        StarIcon={StarIcon}
        starredQuery={starredQuery}
        setStarredQuery={setStarredQuery}
        setStarredModalPage={setStarredModalPage}
        starredModalTotal={starredModalTotal}
        starredModalPageClamped={starredModalPageClamped}
        starredModalMaxPage={starredModalMaxPage}
        starredModalItems={starredModalItems}
        starredValid={starredValid}
        starredMetaById={starredMetaById}
        starredDetailsById={starredDetailsById}
        docsThumbAspectById={docsThumbAspectById}
        setDocsThumbAspectById={setDocsThumbAspectById}
        moveStarredDoc={moveStarredDoc}
        formatRelative={formatRelative}
      />

      {/* Projects modal */}
      <SidebarProjectsModal
        open={showProjectsModal}
        onClose={() => setShowProjectsModal(false)}
        routerPush={(href) => router.push(href)}
        projectsQuery={projectsQuery}
        setProjectsQuery={setProjectsQuery}
        projectsModal={projectsModal}
        setProjectsModal={setProjectsModal}
        openProjectMenuId={openProjectMenuId}
        setOpenProjectMenuId={setOpenProjectMenuId}
        setOpenDocMenuId={setOpenDocMenuId}
        setDeleteProjectTarget={(p) => setDeleteProjectTarget(p)}
        setDeleteProjectError={setDeleteProjectError}
        setDeleteProjectOpen={setDeleteProjectOpen}
        formatRelative={formatRelative}
      />

      {/* Requests modal */}
      <SidebarRequestsModal
        open={showRequestsModal}
        onClose={() => setShowRequestsModal(false)}
        routerPush={(href) => router.push(href)}
        requestsQuery={requestsQuery}
        setRequestsQuery={setRequestsQuery}
        requestsModal={requestsModal}
        setRequestsModal={setRequestsModal}
        formatRelative={formatRelative}
      />

      <CreateProjectModal
        open={showCreateProjectModal}
        busy={newProjectBusy}
        error={newProjectError}
        name={newProjectName}
        setName={setNewProjectName}
        description={newProjectDescription}
        setDescription={setNewProjectDescription}
        onClose={() => {
          if (newProjectBusy) return;
          setShowCreateProjectModal(false);
          setNewProjectError(null);
          setPendingNewProjectNavId(null);
        }}
        onCreate={() => void createProject()}
      />
    </aside>
  );
}
/**
 * Render the StarIcon UI.
 */


function StarIcon({
  className,
  filled = false,
}: {
  className?: string;
  filled?: boolean;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      className={className ?? "h-4 w-4"}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"
      />
    </svg>
  );
}

/**
 * Small inline icon for the "copy" action.
 */
function ClipboardCopyIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="1.5"
      stroke="currentColor"
      aria-hidden="true"
      className="h-4.5 w-4.5 text-zinc-600"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8.25 7.5V6.108c0-1.135.845-2.098 1.976-2.192.373-.03.748-.057 1.123-.08M15.75 18H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08M15.75 18.75v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5A3.375 3.375 0 0 0 6.375 7.5H5.25m11.9-3.664A2.251 2.251 0 0 0 15 2.25h-1.5a2.251 2.251 0 0 0-2.15 1.586m5.8 0c.065.21.1.433.1.664v.75h-6V4.5c0-.231.035-.454.1-.664M6.75 7.5H4.875c-.621 0-1.125.504-1.125 1.125v12c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V16.5a9 9 0 0 0-9-9Z"
      />
    </svg>
  );
}

/**
 * Small inline icon for the "copied" state.
 */
function ClipboardCheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="1.5"
      stroke="currentColor"
      aria-hidden="true"
      className="h-4.5 w-4.5 text-emerald-700"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11.35 3.836c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m8.9-4.414c.376.023.75.05 1.124.08 1.131.094 1.976 1.057 1.976 2.192V16.5A2.25 2.25 0 0 1 18 18.75h-2.25m-7.5-10.5H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V18.75m-7.5-10.5h6.375c.621 0 1.125.504 1.125 1.125v9.375m-8.25-3 1.5 1.5 3-3.75"
      />
    </svg>
  );
}

/**
 * Small inline icon for documents in the sidebar list.
 */
/**
 * Stable centered +/- icon.
 *
 * Heroicons Plus/Minus can appear to "shift" slightly because their stroke extents differ.
 * This icon keeps a consistent viewBox and toggles only the vertical stroke.
 */
function StablePlusMinusIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-4 w-4"
    >
      {expanded ? (
        // minus (list shown)
        <path d="m19.5 8.25-7.5 7.5-7.5-7.5" />
      ) : (
        // plus (list hidden)
        <path d="m8.25 4.5 7.5 7.5-7.5 7.5" />
      )}
    </svg>
  );
}
