"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import {
  ClipboardDocumentCheckIcon,
  EllipsisHorizontalIcon,
  FolderIcon,
  PlusIcon,
  Square2StackIcon,
} from "@heroicons/react/24/outline";
import Modal from "@/components/modals/Modal";
import DeleteProjectModal from "@/components/modals/DeleteProjectModal";
import AccountMenu from "@/components/AccountMenu";
import { buildPublicShareUrl } from "@/lib/urls";
import { getStarredDocs, STARRED_DOCS_CHANGED_EVENT, type StarredDoc } from "@/lib/starredDocs";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import {
  DOCS_CHANGED_EVENT,
  getSidebarCacheSnapshot,
  PROJECTS_CHANGED_EVENT,
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
  updatedDate: string | null;
  createdDate: string | null;
};

type Paged<T> = { items: T[]; total: number; page: number; limit: number };

type StarredMeta = { updatedDate: string | null; createdDate: string | null };
type StarredMetaById = Record<string, StarredMeta>;

const STARRED_META_CACHE_KEY = "lnkdrp.starredMetaCache.v1";

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readStarredMetaCache(): StarredMetaById {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STARRED_META_CACHE_KEY);
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

function writeStarredMetaCache(next: StarredMetaById) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STARRED_META_CACHE_KEY, JSON.stringify(next));
  } catch {
    // ignore (quota / private mode)
  }
}

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

export default function LeftSidebar({
  onAddNewFile,
  onBeforeAddNewOpen,
}: {
  onAddNewFile: (file: File) => void;
  onBeforeAddNewOpen?: () => void;
}) {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const navLocked = useNavigationLocked();
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
  const addNewInputRef = useRef<HTMLInputElement | null>(null);
  const [starredDocs, setStarredDocs] = useState<StarredDoc[]>([]);
  const [starredMetaById, setStarredMetaById] = useState<
    Record<string, { updatedDate: string | null; createdDate: string | null }>
  >({});
  // Cached meta used ONLY for sorting to avoid a brief reorder flash on refresh.
  // Keep "verified existence" logic based on `starredMetaById` (loaded from /api/docs) untouched.
  const [starredMetaCacheById, setStarredMetaCacheById] = useState<StarredMetaById>(() =>
    typeof window === "undefined" ? {} : readStarredMetaCache(),
  );
  const [docs, setDocs] = useState<Paged<DocListItem>>({
    items: [],
    total: 0,
    page: 1,
    limit: 4,
  });

  const [projects, setProjects] = useState<Paged<ProjectListItem>>({
    items: [],
    total: 0,
    page: 1,
    limit: 5,
  });
  const [projectsLoaded, setProjectsLoaded] = useState(false);

  const [showDocsModal, setShowDocsModal] = useState(false);
  const [docsQuery, setDocsQuery] = useState("");
  const [showStarredModal, setShowStarredModal] = useState(false);
  const [starredQuery, setStarredQuery] = useState("");
  const [starredModalPage, setStarredModalPage] = useState(1);
  const [showProjectsModal, setShowProjectsModal] = useState(false);
  const [projectsQuery, setProjectsQuery] = useState("");
  const starredMetaRef = useRef(starredMetaById);
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null);
  const [hideCopyIconShareId, setHideCopyIconShareId] = useState<string | null>(null);
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [deleteProjectOpen, setDeleteProjectOpen] = useState(false);
  const [deleteProjectBusy, setDeleteProjectBusy] = useState(false);
  const [deleteProjectError, setDeleteProjectError] = useState<string | null>(null);
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<ProjectListItem | null>(null);
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

  useEffect(() => {
    let cancelled = false;

    function applyFromCache() {
      const snap = getSidebarCacheSnapshot();
      if (!snap) return;
      setDocs(snap.docs);
      setProjects(snap.projects);
      setProjectsLoaded(true);
    }

    function onCacheUpdated() {
      if (cancelled) return;
      applyFromCache();
    }

    applyFromCache();
    window.addEventListener(SIDEBAR_CACHE_UPDATED_EVENT, onCacheUpdated);

    // Background refresh: keep UI stable; update silently when data changes.
    void refreshSidebarCache({ reason: "mount" }).finally(() => {
      if (!cancelled) setProjectsLoaded(true);
    });
    const id = window.setInterval(() => void refreshSidebarCache({ reason: "interval" }), 8000);

    return () => {
      cancelled = true;
      window.removeEventListener(SIDEBAR_CACHE_UPDATED_EVENT, onCacheUpdated);
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!openProjectMenuId) return;
    function onPointerDown() {
      setOpenProjectMenuId(null);
    }
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
    // Refresh projects immediately when another part of the UI creates/updates them.
    let cancelled = false;

    async function refresh() {
      try {
        await refreshSidebarCache({ reason: "projects-changed", force: true });
        if (cancelled) return;
        const snap = getSidebarCacheSnapshot();
        if (snap) {
          setProjects(snap.projects);
          setDocs(snap.docs);
          setProjectsLoaded(true);
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
      } catch {
        // ignore
      }
    }

    function onProjectsChanged() {
      void refresh();
    }

    window.addEventListener(PROJECTS_CHANGED_EVENT, onProjectsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(PROJECTS_CHANGED_EVENT, onProjectsChanged);
    };
  }, [projectsModal.limit, projectsModal.page, projectsQuery, showProjectsModal]);

  useEffect(() => {
    // Refresh docs immediately when another part of the UI changes them.
    let cancelled = false;

    async function refresh() {
      try {
        await refreshSidebarCache({ reason: "docs-changed", force: true });
        if (cancelled) return;
        const snap = getSidebarCacheSnapshot();
        if (snap) setDocs(snap.docs);
      } catch {
        // ignore
      }
    }

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
    // Keep starred docs in sync (this tab + other tabs).
    function refreshStarred() {
      setStarredDocs(getStarredDocs());
      // Seed sort metadata from cache so order is stable before the best-effort API paging completes.
      setStarredMetaCacheById(readStarredMetaCache());
    }
    function onStorage(e: StorageEvent) {
      if (e.storageArea !== window.localStorage) return;
      refreshStarred();
    }
    refreshStarred();
    window.addEventListener(STARRED_DOCS_CHANGED_EVENT, refreshStarred);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(STARRED_DOCS_CHANGED_EVENT, refreshStarred);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    starredMetaRef.current = starredMetaById;
  }, [starredMetaById]);

  useEffect(() => {
    // Best-effort: fetch updated/created dates for starred docs so we can sort by "updated date".
    // We page through `/api/docs` and stop as soon as we’ve found all starred IDs.
    if (!starredDocs.length) return;

    let cancelled = false;
    async function loadStarredMeta() {
      try {
        const ids = new Set(starredDocs.map((d) => d.id).filter(Boolean));
        if (!ids.size) return;

        const existing = starredMetaRef.current ?? {};
        const missing = new Set<string>();
        for (const id of ids) {
          if (!existing[id]) missing.add(id);
        }
        if (!missing.size) return;

        const found: Record<string, { updatedDate: string | null; createdDate: string | null }> = {};
        const limit = 50;
        let page = 1;
        // Safety cap to avoid unbounded paging in extreme cases.
        const maxPages = 10;

        while (!cancelled && missing.size && page <= maxPages) {
          const res = await fetchWithTempUser(`/api/docs?limit=${limit}&page=${page}`, {
            cache: "no-store",
          });
          if (!res.ok) break;
          const json = (await res.json()) as { docs?: DocListItem[] };
          const docsPage = Array.isArray(json.docs) ? json.docs : [];
          for (const doc of docsPage) {
            if (!doc?.id) continue;
            if (!ids.has(doc.id)) continue;
            if (found[doc.id]) continue;
            found[doc.id] = {
              updatedDate: doc.updatedDate ?? null,
              createdDate: doc.createdDate ?? null,
            };
            missing.delete(doc.id);
          }
          if (docsPage.length < limit) break;
          page += 1;
        }

        if (cancelled) return;
        if (Object.keys(found).length) {
          setStarredMetaById((prev) => ({ ...prev, ...found }));
          // Also persist to the cache so refreshes don't briefly reorder the list.
          setStarredMetaCacheById((prev) => {
            const ids = new Set(starredDocs.map((d) => d.id).filter(Boolean));
            const merged = { ...prev, ...found };
            const pruned = pruneMetaCache(merged, ids);
            writeStarredMetaCache(pruned);
            return pruned;
          });
        }
      } catch {
        // ignore
      }
    }

    void loadStarredMeta();
    return () => {
      cancelled = true;
    };
  }, [starredDocs]);

  useEffect(() => {
    if (!showDocsModal) return;
    let cancelled = false;
    async function load() {
      try {
        const q = docsQuery.trim() ? `&q=${encodeURIComponent(docsQuery.trim())}` : "";
        const res = await fetchWithTempUser(
          `/api/docs?limit=${docsModal.limit}&page=${docsModal.page}${q}`,
          { cache: "no-store" },
        );
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
    async function load() {
      try {
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
      } catch {
        // ignore
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [showProjectsModal, projectsModal.page, projectsModal.limit, projectsQuery]);

  const docsForSidebar = useMemo(() => docs.items.slice(0, 4), [docs.items]);

  const starredSorted = useMemo(() => {
    function tsFromIso(iso: string | null | undefined) {
      if (!iso) return NaN;
      const t = Date.parse(iso);
      return Number.isFinite(t) ? t : NaN;
    }
    function sortKey(d: StarredDoc) {
      // Prefer verified meta (loaded from /api), but fall back to cached meta so we don't reorder after refresh.
      const meta = starredMetaById[d.id] ?? starredMetaCacheById[d.id];
      const t = tsFromIso(meta?.updatedDate ?? meta?.createdDate ?? null);
      // Fall back to starredAt when we don’t have updated/created data yet.
      return Number.isFinite(t) ? t : d.starredAt ?? 0;
    }
    return starredDocs
      .slice()
      .sort((a, b) => sortKey(b) - sortKey(a) || (b.starredAt ?? 0) - (a.starredAt ?? 0));
  }, [starredDocs, starredMetaById, starredMetaCacheById]);

  // Only show starred docs that we can verify exist in /api/docs (via `starredMetaById`)
  // or are present in the currently-loaded docs sidebar list.
  // This prevents showing stale/phantom localStorage entries.
  const starredValid = useMemo(() => {
    return starredSorted.filter((d) => Boolean(starredMetaById[d.id]) || docs.items.some((x) => x.id === d.id));
  }, [docs.items, starredMetaById, starredSorted]);

  const starredForSidebar = useMemo(() => starredValid.slice(0, 5), [starredValid]);

  const starredFilteredForModal = useMemo(() => {
    const q = starredQuery.trim().toLowerCase();
    if (!q) return starredValid;
    return starredValid.filter((d) => (d.title ?? "").toLowerCase().includes(q));
  }, [starredQuery, starredValid]);

  const starredModalLimit = 20;
  const starredModalTotal = starredFilteredForModal.length;
  const starredModalMaxPage = Math.max(1, Math.ceil(starredModalTotal / starredModalLimit));
  const starredModalItems = useMemo(() => {
    const page = Math.max(1, Math.min(starredModalPage, starredModalMaxPage));
    const start = (page - 1) * starredModalLimit;
    return starredFilteredForModal.slice(start, start + starredModalLimit);
  }, [starredFilteredForModal, starredModalLimit, starredModalMaxPage, starredModalPage]);

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

  function isAcceptedPdfOrImage(file: File) {
    // Some platforms/drivers may provide an empty/unknown MIME type, so fall back
    // to filename extension while still enforcing "PDF or image only".
    const name = (file.name ?? "").toLowerCase();
    return file.type === "application/pdf" || name.endsWith(".pdf") || file.type.startsWith("image/");
  }

  function openAddNewPicker() {
    if (navLocked) return;
    onBeforeAddNewOpen?.();
    // Allow picking the same file twice in a row.
    if (addNewInputRef.current) addNewInputRef.current.value = "";
    addNewInputRef.current?.click();
  }

  async function deleteProjectBySlug(slug: string) {
    setDeleteProjectBusy(true);
    setDeleteProjectError(null);
    try {
      const res = await fetchWithTempUser(`/api/projects/${encodeURIComponent(slug)}`, {
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

  return (
    <aside className="h-full w-[280px] shrink-0 overflow-hidden border-r border-[var(--border)] bg-[var(--sidebar-bg)]">
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 px-4 pb-6 pt-[18px]">
          <Link href="/" className="inline-flex items-center gap-2">
            <Image src={logoSrc} alt="LinkDrop" width={32} height={32} />
          </Link>
        </div>

        <div className="px-3 pb-1">
          <div
            role="button"
            tabIndex={navLocked ? -1 : 0}
            className={[
              "group relative cursor-pointer overflow-hidden rounded-lg px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20",
              navLocked ? "cursor-not-allowed opacity-50 hover:bg-transparent" : "",
              isAddNewDropActive
                ? "bg-[var(--sidebar-hover)] text-[var(--fg)]"
                : "text-[var(--muted)] hover:bg-[var(--sidebar-hover)]",
            ].join(" ")}
            onClick={() => openAddNewPicker()}
            onKeyDown={(e) => {
              if (navLocked) return;
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              openAddNewPicker();
            }}
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
            aria-label="Add new (click or drag & drop a PDF or image)"
            aria-disabled={navLocked}
            title={navLocked ? "Disabled while uploading" : undefined}
          >
            <input
              ref={addNewInputRef}
              type="file"
              accept="application/pdf,.pdf,image/*"
              className="sr-only"
              disabled={navLocked}
              onChange={(e) => {
                if (navLocked) return;
                const file = e.target.files?.[0] ?? null;
                if (!file) return;
                if (!isAcceptedPdfOrImage(file)) return;
                onAddNewFile(file);
              }}
            />

            <div
              className={[
                "flex flex-col items-start transition-opacity",
                isAddNewDropActive ? "opacity-25" : "opacity-100",
              ].join(" ")}
            >
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                <span className="inline-flex h-4 w-4 items-center justify-center rounded-[3px] border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)]">
                  <PlusIcon className="h-3 w-3" />
                </span>
                <span>Add new</span>
              </div>
            </div>

            {isAddNewDropActive ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="rounded-full bg-[var(--panel)]/85 px-3 py-1 text-[12px] font-semibold text-[var(--fg)] shadow-sm ring-1 ring-black/5 backdrop-blur">
                  Drop to upload
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <nav className="mt-4 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-4">
          <div className="grid gap-5">
            <section>
              <div className="px-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                <span className="inline-flex items-center gap-1.5">
                  <StarIcon className="h-3.5 w-3.5 text-amber-400" />
                  <span>Starred</span>
                </span>
              </div>

              {!starredForSidebar.length ? (
                <div className="mt-2 px-2 py-2 text-[13px] text-[var(--muted-2)]">No starred docs yet.</div>
              ) : (
                <ul className="mt-2 space-y-0.5">
                  {starredForSidebar.map((d) => {
                    const href = `/doc/${d.id}`;
                    return (
                      <li key={d.id}>
                        <div
                          role="link"
                          tabIndex={0}
                          className="cursor-pointer rounded-xl px-2 py-1.5 text-left text-[14px] hover:bg-[var(--sidebar-hover)]"
                          onClick={() => router.push(href)}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            router.push(href);
                          }}
                        >
                          <div className="inline-flex max-w-full items-center gap-1.5">
                            <StarIcon className="h-4 w-4 text-amber-400" filled />
                            <div className="max-w-[calc(100%-18px)] truncate font-medium text-[var(--fg)]">
                              {d.title}
                            </div>
                          </div>
                        </div>
                      </li>
                    );
                  })}

                  {starredValid.length > 5 ? (
                    <li>
                      <button
                        type="button"
                        disabled={navLocked}
                        className={[
                          "w-full rounded-xl px-2 py-1.5 text-left text-[14px] font-medium text-[var(--muted)]",
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
              <div className="px-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                Projects
              </div>
              {!projectsLoaded ? (
                <div className="mt-2 px-2 py-2 text-[13px] text-[var(--muted-2)]">Loading…</div>
              ) : !projects.items.length ? (
                <div className="mt-2 px-2 py-2 text-[13px] text-[var(--muted-2)]">No projects yet.</div>
              ) : (
                <ul className="mt-2 space-y-0.5">
                  {projects.items.slice(0, 5).map((p) => (
                    <li key={p.id}>
                      <div className="group relative">
                        <div
                          role="link"
                          tabIndex={0}
                          className="flex cursor-pointer items-center justify-between gap-2 rounded-xl px-2 py-1.5 text-left text-[14px] hover:bg-[var(--sidebar-hover)]"
                          onClick={() => {
                            if (!p.slug) return;
                            router.push(`/project/${p.slug}`);
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            if (!p.slug) return;
                            router.push(`/project/${p.slug}`);
                          }}
                        >
                          <div className="inline-flex max-w-full items-center gap-1.5">
                            <FolderIcon className="h-4 w-4 text-[var(--muted-2)]" aria-hidden="true" />
                            <div className="max-w-[calc(100%-18px)] truncate font-medium text-[var(--fg)]">
                              {p.name}
                            </div>
                          </div>

                          <button
                            type="button"
                            className={[
                              "shrink-0 rounded-lg p-1 text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                              "opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100",
                            ].join(" ")}
                            aria-label="Project actions"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setOpenProjectMenuId((prev) => (prev === p.id ? null : p.id));
                            }}
                          >
                            <EllipsisHorizontalIcon className="h-4 w-4" />
                          </button>
                        </div>

                        {openProjectMenuId === p.id ? (
                          <div
                            className="absolute right-2 top-[calc(100%+6px)] z-50 w-[170px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-lg"
                            onPointerDown={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium text-red-700 hover:bg-red-50"
                              onClick={() => {
                                setOpenProjectMenuId(null);
                                setDeleteProjectTarget(p);
                                setDeleteProjectError(null);
                                setDeleteProjectOpen(true);
                              }}
                            >
                              <span>Delete project</span>
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}

                  {projects.total > 5 ? (
                    <li>
                      <button
                        type="button"
                        className="w-full rounded-xl px-2 py-1.5 text-left text-[14px] font-medium text-[var(--muted)] hover:bg-[var(--sidebar-hover)]"
                        onClick={() => setShowProjectsModal(true)}
                      >
                        See more
                      </button>
                    </li>
                  ) : null}
                </ul>
              )}
            </section>

            <section>
              <div className="px-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                Docs
              </div>
              <ul className="mt-2 space-y-0.5">
                {docsForSidebar.map((d) => {
                  // App navigation should always go to the internal doc page.
                  // The public `/share/:shareId` page is for external recipients.
                  const href = `/doc/${d.id}`;
                  const when = mounted ? formatRelative(d.updatedDate ?? d.createdDate) : "";
                  return (
                    <li key={d.id}>
                      <div
                        role="link"
                        tabIndex={0}
                          className="group w-full cursor-pointer overflow-hidden rounded-xl px-2 py-1.5 text-left text-[14px] hover:bg-[var(--sidebar-hover)]"
                        onClick={() => router.push(href)}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          router.push(href);
                        }}
                        onMouseEnter={() => {
                          if (d.shareId && hideCopyIconShareId === d.shareId) {
                            setHideCopyIconShareId(null);
                          }
                        }}
                      >
                        <div className="flex min-w-0 items-start justify-between gap-2">
                          <div className="min-w-0 flex-1 overflow-hidden">
                            <div className="flex max-w-full min-w-0 items-center gap-1 text-[13px] font-semibold leading-4 text-[var(--fg)]">
                              <span className="block min-w-0 flex-1 truncate">{d.title}</span>
                              {typeof d.version === "number" && Number.isFinite(d.version) ? (
                                <span className="shrink-0 rounded-md bg-[var(--panel-hover)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted-2)]">
                                  v{d.version}
                                </span>
                              ) : (d.status ?? "").toLowerCase() === "preparing" ? (
                                <span className="shrink-0 rounded-md bg-[var(--panel-hover)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted-2)]">
                                  v…
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-[var(--muted-2)]">
                              <span className="min-w-0 flex-1 truncate">{when || "-"}</span>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-1">
                            {d.shareId ? (
                              <button
                                type="button"
                                className={[
                                  "shrink-0 rounded-md p-0.5 text-[var(--muted)] hover:bg-[var(--panel-hover)]",
                                  hideCopyIconShareId === d.shareId && copiedShareId !== d.shareId
                                    ? "opacity-0"
                                    : "opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100",
                                ].join(" ")}
                                aria-label="Copy doc link"
                                title={copiedShareId === d.shareId ? "Copied" : "Copy"}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  void copyDocLink(d.shareId);
                                }}
                              >
                                {copiedShareId === d.shareId ? (
                                  <ClipboardCheckIcon />
                                ) : (
                                  <ClipboardCopyIcon />
                                )}
                              </button>
                            ) : null}
                            {/* Intentionally leaving room for a future "…" actions button */}
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}

                {docs.total > 4 ? (
                  <li>
                    <button
                      type="button"
                      className="w-full rounded-xl px-2 py-1.5 text-left text-[14px] font-medium text-[var(--muted)] hover:bg-[var(--sidebar-hover)]"
                      onClick={() => setShowDocsModal(true)}
                    >
                      See more
                    </button>
                  </li>
                ) : null}

                {!docsForSidebar.length ? (
                  <li className="px-2 py-2 text-[13px] text-[var(--muted-2)]">No docs/links yet.</li>
                ) : null}
              </ul>
            </section>
          </div>
        </nav>

        <div className="border-t border-[var(--border)] px-3 py-3">
          <AccountMenu />
        </div>
      </div>

      {/* Docs modal */}
      <Modal
        open={showDocsModal}
        onClose={() => {
          setShowDocsModal(false);
          setDocsQuery("");
          setDocsModal((s) => ({ ...s, page: 1 }));
        }}
        ariaLabel="Docs"
      >
        <div className="px-1 pb-3 text-base font-semibold text-zinc-900">Docs</div>
        <div className="mt-3 px-1 pb-2">
          <input
            value={docsQuery}
            onChange={(e) => {
              setDocsQuery(e.target.value);
              setDocsModal((s) => ({ ...s, page: 1 }));
            }}
            placeholder="Search"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-[13px] text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-black/10"
          />
        </div>
        <ul className="space-y-0.5">
          {docsModal.items.map((d) => {
            // App navigation should always go to the internal doc page.
            const href = `/doc/${d.id}`;
            const when = formatRelative(d.updatedDate ?? d.createdDate);
            return (
              <li key={d.id}>
                <div
                  role="link"
                  tabIndex={0}
                  className="group rounded-xl px-3 py-1.5 text-[13px] hover:bg-zinc-50"
                  onClick={() => {
                    setShowDocsModal(false);
                    router.push(href);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    setShowDocsModal(false);
                    router.push(href);
                  }}
                  onMouseEnter={() => {
                    if (d.shareId && hideCopyIconShareId === d.shareId) {
                      setHideCopyIconShareId(null);
                    }
                  }}
                >
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="flex max-w-full min-w-0 items-center gap-1 text-[12px] font-semibold leading-4 text-zinc-900">
                        <span className="block min-w-0 flex-1 truncate">{d.title}</span>
                        {typeof d.version === "number" && Number.isFinite(d.version) ? (
                          <span className="shrink-0 rounded-md bg-zinc-200/40 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                            v{d.version}
                          </span>
                        ) : (d.status ?? "").toLowerCase() === "preparing" ? (
                          <span className="shrink-0 rounded-md bg-zinc-200/40 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                            v…
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-zinc-400">
                        <span className="min-w-0 flex-1 truncate">{when || "-"}</span>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {d.shareId ? (
                        <button
                          type="button"
                          className={[
                            "shrink-0 rounded-md p-0.5 text-zinc-600 hover:bg-zinc-100",
                            hideCopyIconShareId === d.shareId && copiedShareId !== d.shareId
                              ? "opacity-0"
                              : "opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100",
                          ].join(" ")}
                          aria-label="Copy doc link"
                          title={
                            copiedShareId === d.shareId ? "Copied" : `Copy ${buildPublicShareUrl(d.shareId)}`
                          }
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void copyDocLink(d.shareId);
                          }}
                        >
                          {copiedShareId === d.shareId ? (
                            <ClipboardDocumentCheckIcon className="h-4 w-4" />
                          ) : (
                            <Square2StackIcon className="h-4 w-4" />
                          )}
                        </button>
                      ) : null}
                      {/* Intentionally leaving room for a future "…" actions button */}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="mt-3 flex items-center justify-between gap-3 px-1">
          <button
            type="button"
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 disabled:opacity-50"
            disabled={docsModal.page <= 1}
            onClick={() => setDocsModal((s) => ({ ...s, page: Math.max(1, s.page - 1) }))}
          >
            Prev
          </button>
          <div className="text-xs text-zinc-500">
            Page {docsModal.page} / {Math.max(1, Math.ceil(docsModal.total / docsModal.limit))}
          </div>
          <button
            type="button"
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 disabled:opacity-50"
            disabled={docsModal.page >= Math.ceil(docsModal.total / docsModal.limit)}
            onClick={() => setDocsModal((s) => ({ ...s, page: s.page + 1 }))}
          >
            Next
          </button>
        </div>
      </Modal>

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
          const slug = deleteProjectTarget?.slug ?? "";
          if (!slug) return;
          void deleteProjectBySlug(slug);
        }}
      />

      {/* Starred modal */}
      <Modal
        open={showStarredModal}
        onClose={() => {
          setShowStarredModal(false);
          setStarredQuery("");
          setStarredModalPage(1);
        }}
        ariaLabel="Starred docs"
      >
        <div className="px-1 pb-3 text-base font-semibold text-zinc-900">Starred</div>
        <div className="mt-3 px-1 pb-2">
          <input
            value={starredQuery}
            onChange={(e) => {
              setStarredQuery(e.target.value);
              setStarredModalPage(1);
            }}
            placeholder="Search"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-[13px] text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-black/10"
          />
        </div>
        <ul className="space-y-0.5">
          {starredModalItems.map((d) => {
            const href = `/doc/${d.id}`;
            const meta = starredMetaById[d.id];
            const when = formatRelative(meta?.updatedDate ?? meta?.createdDate ?? null);
            return (
              <li key={d.id}>
                <div
                  role="link"
                  tabIndex={0}
                  className="rounded-xl px-3 py-1.5 text-[13px] hover:bg-zinc-50"
                  onClick={() => {
                    setShowStarredModal(false);
                    router.push(href);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    setShowStarredModal(false);
                    router.push(href);
                  }}
                >
                  <div className="inline-flex max-w-full items-center gap-1.5">
                    <StarIcon className="h-4 w-4 text-amber-400" filled />
                    <div className="max-w-[calc(100%-18px)] truncate font-medium text-zinc-900">
                      {d.title}
                    </div>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
                    <span className="truncate">{when || "-"}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="mt-3 flex items-center justify-between gap-3 px-1">
          <button
            type="button"
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 disabled:opacity-50"
            disabled={Math.max(1, Math.min(starredModalPage, starredModalMaxPage)) <= 1}
            onClick={() => setStarredModalPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </button>
          <div className="text-xs text-zinc-500">
            Page {Math.max(1, Math.min(starredModalPage, starredModalMaxPage))} / {starredModalMaxPage}
          </div>
          <button
            type="button"
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 disabled:opacity-50"
            disabled={Math.max(1, Math.min(starredModalPage, starredModalMaxPage)) >= starredModalMaxPage}
            onClick={() => setStarredModalPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </Modal>

      {/* Projects modal */}
      <Modal
        open={showProjectsModal}
        onClose={() => {
          setShowProjectsModal(false);
          setProjectsQuery("");
          setProjectsModal((s) => ({ ...s, page: 1 }));
        }}
        ariaLabel="Projects"
      >
        <div className="px-1 pb-3 text-base font-semibold text-zinc-900">Projects</div>
        <div className="mt-3 px-1 pb-2">
          <input
            value={projectsQuery}
            onChange={(e) => {
              setProjectsQuery(e.target.value);
              setProjectsModal((s) => ({ ...s, page: 1 }));
            }}
            placeholder="Search"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-[13px] text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-black/10"
          />
        </div>
        <ul className="space-y-0.5">
          {projectsModal.items.map((p) => {
            const when = formatRelative(p.updatedDate ?? p.createdDate);
            return (
              <li key={p.id}>
                <div className="group relative rounded-xl px-3 py-2 hover:bg-zinc-50">
                  <div className="flex items-start justify-between gap-3">
                    <div
                      role="link"
                      tabIndex={0}
                      className="min-w-0 flex-1 cursor-pointer"
                      onClick={() => {
                        if (!p.slug) return;
                        setShowProjectsModal(false);
                        router.push(`/project/${p.slug}`);
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        if (!p.slug) return;
                        setShowProjectsModal(false);
                        router.push(`/project/${p.slug}`);
                      }}
                    >
                      <div className="flex items-center gap-2 text-[13px] font-semibold text-zinc-900">
                        <FolderIcon className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                        <span className="truncate">{p.name}</span>
                      </div>
                      {p.description ? (
                        <div className="mt-1 text-[12px] text-zinc-600">{p.description}</div>
                      ) : null}
                    </div>

                    <div className="shrink-0 text-[11px] text-zinc-400">{when || "-"}</div>
                  </div>

                  <button
                    type="button"
                    className={[
                      "absolute right-2 top-2 rounded-lg p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700",
                      "opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100",
                    ].join(" ")}
                    aria-label="Project actions"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setOpenProjectMenuId((prev) => (prev === p.id ? null : p.id));
                    }}
                  >
                    <EllipsisHorizontalIcon className="h-4 w-4" />
                  </button>

                  {openProjectMenuId === p.id ? (
                    <div
                      className="absolute right-2 top-10 z-50 w-[170px] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium text-red-700 hover:bg-red-50"
                        onClick={() => {
                          setOpenProjectMenuId(null);
                          setDeleteProjectTarget(p);
                          setDeleteProjectError(null);
                          setDeleteProjectOpen(true);
                        }}
                      >
                        <span>Delete project</span>
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="mt-3 flex items-center justify-between gap-3 px-1">
          <button
            type="button"
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 disabled:opacity-50"
            disabled={projectsModal.page <= 1}
            onClick={() => setProjectsModal((s) => ({ ...s, page: Math.max(1, s.page - 1) }))}
          >
            Prev
          </button>
          <div className="text-xs text-zinc-500">
            Page {projectsModal.page} / {Math.max(1, Math.ceil(projectsModal.total / projectsModal.limit))}
          </div>
          <button
            type="button"
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 disabled:opacity-50"
            disabled={projectsModal.page >= Math.ceil(projectsModal.total / projectsModal.limit)}
            onClick={() => setProjectsModal((s) => ({ ...s, page: s.page + 1 }))}
          >
            Next
          </button>
        </div>
      </Modal>
    </aside>
  );
}

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

