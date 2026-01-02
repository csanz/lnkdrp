"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FolderIcon } from "@heroicons/react/24/outline";
import LeftSidebar from "@/components/LeftSidebar";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { usePendingUpload } from "@/lib/pendingUpload";
import DocActionsMenu from "@/components/DocActionsMenu";
import { isDocStarred, STARRED_DOCS_CHANGED_EVENT } from "@/lib/starredDocs";
import { notifyProjectsChanged, refreshSidebarCache } from "@/lib/sidebarCache";

type DocListItem = {
  id: string;
  shareId: string | null;
  title: string;
  summary?: string | null;
  status: string | null;
  version: number | null;
  projectIds?: string[];
  previewImageUrl?: string | null;
  updatedDate: string | null;
  createdDate: string | null;
};

type ProjectDTO = { id: string; name: string; slug: string; description: string };
type Paged<T> = { items: T[]; total: number; page: number; limit: number };
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
  const router = useRouter();
  const { setPendingFile } = usePendingUpload();
  const [project, setProject] = useState<ProjectDTO | null>(null);
  const [docs, setDocs] = useState<Paged<DocListItem>>({ items: [], total: 0, page: 1, limit: 25 });
  const [docsLoading, setDocsLoading] = useState(true);
  const [q, setQ] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [starredTick, setStarredTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
/**
 * Load (updates state (setDocsLoading, setNotFound, setProject); uses setDocsLoading, trim, encodeURIComponent).
 */

    async function load() {
      setDocsLoading(true);
      try {
        const qStr = q.trim() ? `&q=${encodeURIComponent(q.trim())}` : "";
        const res = await fetchWithTempUser(
          `/api/projects/${encodeURIComponent(projectSlug)}/docs?limit=${docs.limit}&page=${docs.page}${qStr}`,
          { cache: "no-store" },
        );
        if (cancelled) return;
        if (res.status === 404) {
          setNotFound(true);
          // If the project was deleted out-of-band (e.g., DB reset), prune stale sidebar cache.
          notifyProjectsChanged();
          void refreshSidebarCache({ reason: "project-not-found", force: true });
          setDocsLoading(false);
          return;
        }
        if (!res.ok) return;
        const json = (await res.json()) as {
          project?: ProjectDTO;
          docs?: DocListItem[];
          total?: number;
          page?: number;
          limit?: number;
        };
        if (cancelled) return;
        setProject(json.project ?? null);
        setDocs((prev) => ({
          items: Array.isArray(json.docs) ? json.docs : [],
          total: typeof json.total === "number" ? json.total : 0,
          page: typeof json.page === "number" ? json.page : prev.page,
          limit: typeof json.limit === "number" ? json.limit : prev.limit,
        }));
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
  }, [projectSlug, docs.page, docs.limit, q]);

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
  // This route uses `projectSlug` as the projectId; use it as a stable fallback before `project` loads.
  const projectIdForMenu = project?.id ?? projectSlug;

  return (
    <div className="flex h-[100svh] w-full bg-white text-zinc-900">
      <LeftSidebar
        onAddNewFile={(file) => {
          // Match doc page UX: push to home and let pipeline handle it.
          setPendingFile(file);
          router.push("/");
        }}
      />

      <main className="min-w-0 flex-1">
        <div className="flex h-full flex-col">
          {/* Top bar */}
          <div className="flex items-center justify-between gap-4 border-b border-zinc-200 bg-white px-6 py-4">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <FolderIcon className="h-5 w-5 text-zinc-500" aria-hidden="true" />
                {title ? (
                  <div className="min-w-0 truncate text-sm font-semibold text-zinc-900">{title}</div>
                ) : (
                  <div
                    className="h-4 w-32 animate-pulse rounded bg-zinc-200/80"
                    aria-label="Loading project name"
                  />
                )}
              </div>
            </div>
            <div className="shrink-0 text-xs text-zinc-500">{docs.total} docs</div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto bg-white">
            <div className="px-6 py-6">
              {notFound ? (
                <div className="mx-auto w-full max-w-4xl">
                  <div className="rounded-2xl border border-zinc-200 bg-white p-6 text-sm text-zinc-700">
                    Project not found.
                  </div>
                </div>
              ) : (
                <div className="mx-auto w-full max-w-4xl">
                  {subtitle ? <div className="text-xs text-zinc-500">{subtitle}</div> : null}

                  <div className={["flex items-center justify-between gap-3", subtitle ? "mt-5" : ""].join(" ")}>
                    <input
                      value={q}
                      onChange={(e) => {
                        setQ(e.target.value);
                        setDocs((s) => ({ ...s, page: 1 }));
                      }}
                      placeholder="Search docs"
                      className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-[13px] text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-black/10"
                    />
                  </div>

                  <ul className="mt-6 divide-y divide-zinc-200">
                    {docs.items.map((d) => {
                      // read from localStorage; `starredTick` forces re-render on changes
                      void starredTick;
                      const starred = isDocStarred(d.id);
                      const when = formatRelative(d.updatedDate ?? d.createdDate);
                      const summary =
                        typeof d.summary === "string" && d.summary.trim() ? d.summary.trim() : null;
                      const previewImageUrl =
                        typeof d.previewImageUrl === "string" && d.previewImageUrl.trim()
                          ? d.previewImageUrl.trim()
                          : null;
                      return (
                        <li key={d.id}>
                          <div
                            role="link"
                            tabIndex={0}
                            className="cursor-pointer px-1 py-4 hover:bg-zinc-50"
                            onClick={() => router.push(`/doc/${d.id}`)}
                            onKeyDown={(e) => {
                              if (e.key !== "Enter" && e.key !== " ") return;
                              e.preventDefault();
                              router.push(`/doc/${d.id}`);
                            }}
                          >
                            <div className="flex items-start justify-between gap-6">
                              <div className="flex min-w-0 items-start gap-3">
                                <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-white ring-1 ring-zinc-200">
                                  {previewImageUrl ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                      src={previewImageUrl}
                                      alt=""
                                      className="h-full w-full object-cover"
                                      loading="lazy"
                                      decoding="async"
                                    />
                                  ) : (
                                    <div className="grid h-full w-full place-items-center bg-zinc-100 text-[10px] font-medium text-zinc-500">
                                      PDF
                                    </div>
                                  )}
                                </div>

                                <div className="min-w-0">
                                  <div className="flex min-w-0 items-center gap-2">
                                    {starred ? (
                                      <span className="shrink-0 text-amber-500" aria-label="Starred">
                                        <SmallStarIcon filled />
                                      </span>
                                    ) : null}
                                    <div className="truncate text-[13px] font-semibold text-zinc-900">
                                      {d.title}
                                    </div>
                                  </div>
                                  {summary ? (
                                    <div className="mt-1 text-[12px] leading-5 text-zinc-600 line-clamp-2">
                                      {summary}
                                    </div>
                                  ) : null}
                                  <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
                                    <span className="truncate">{when || "-"}</span>
                                    {d.version ? (
                                      <span className="rounded-md bg-zinc-100/60 px-1.5 py-0 text-[10px] text-zinc-600 ring-1 ring-zinc-200/60">
                                        v{d.version}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                {d.status && d.status.toLowerCase() !== "ready" ? (
                                  <div className="pt-0.5 text-[11px] text-zinc-400">{d.status}</div>
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
                        <div className="py-8 text-sm text-zinc-600">Loading…</div>
                      </li>
                    ) : !docs.items.length ? (
                      <li>
                        <div className="py-8 text-sm text-zinc-600">No docs in this project yet.</div>
                      </li>
                    ) : null}
                  </ul>

                  {maxPage > 1 ? (
                    <div className="mt-6 flex items-center justify-between gap-3 border-t border-zinc-200 pt-4">
                      <button
                        type="button"
                        className={[
                          "text-sm font-medium text-zinc-700 hover:underline underline-offset-4",
                          docs.page <= 1 ? "pointer-events-none text-zinc-400" : "",
                        ].join(" ")}
                        disabled={docs.page <= 1}
                        onClick={() => setDocs((s) => ({ ...s, page: Math.max(1, s.page - 1) }))}
                      >
                        Prev
                      </button>
                      <div className="text-xs text-zinc-500">
                        Page {docs.page} / {maxPage}
                      </div>
                      <button
                        type="button"
                        className={[
                          "text-sm font-medium text-zinc-700 hover:underline underline-offset-4",
                          docs.page >= maxPage ? "pointer-events-none text-zinc-400" : "",
                        ].join(" ")}
                        disabled={docs.page >= maxPage}
                        onClick={() => setDocs((s) => ({ ...s, page: s.page + 1 }))}
                      >
                        Next
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
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




