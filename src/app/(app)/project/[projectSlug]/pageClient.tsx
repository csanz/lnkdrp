"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Cog6ToothIcon, FolderIcon } from "@heroicons/react/24/outline";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import DocActionsMenu from "@/components/DocActionsMenu";
import { isDocStarred, STARRED_DOCS_CHANGED_EVENT } from "@/lib/starredDocs";
import { PROJECTS_CHANGED_EVENT } from "@/lib/sidebarCache";
import Modal from "@/components/modals/Modal";

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

type ProjectDTO = { id: string; name: string; slug: string; description: string; autoAddFiles: boolean };
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

const PROJECT_DOCS_CACHE_MAX = 75;
const PROJECT_DOCS_CACHE_TTL_MS = 3 * 60 * 1000;
const projectDocsCache = new Map<string, ProjectDocsCacheEntry>();

function projectDocsCacheKey(params: { projectSlug: string; page: number; limit: number; q: string }) {
  return [
    encodeURIComponent(params.projectSlug),
    String(params.page),
    String(params.limit),
    params.q.trim(),
  ].join("|");
}

function projectDocsCacheGet(key: string): ProjectDocsCacheEntry | null {
  const e = projectDocsCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > PROJECT_DOCS_CACHE_TTL_MS) {
    projectDocsCache.delete(key);
    return null;
  }
  return e;
}

function projectDocsCacheSet(key: string, entry: Omit<ProjectDocsCacheEntry, "ts">) {
  projectDocsCache.set(key, { ...entry, ts: Date.now() });
  if (projectDocsCache.size <= PROJECT_DOCS_CACHE_MAX) return;
  const entries = Array.from(projectDocsCache.entries()).sort((a, b) => a[1].ts - b[1].ts);
  for (let i = 0; i < Math.max(0, entries.length - PROJECT_DOCS_CACHE_MAX); i++) {
    projectDocsCache.delete(entries[i]![0]);
  }
}

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

export default function ProjectPageClient({ projectSlug }: { projectSlug: string }) {
  const router = useRouter();
  const [project, setProject] = useState<ProjectDTO | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftAutoAddFiles, setDraftAutoAddFiles] = useState(false);
  const [docs, setDocs] = useState<Paged<DocListItem>>({ items: [], total: 0, page: 1, limit: 25 });
  const [docsLoading, setDocsLoading] = useState(true);
  const [q, setQ] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [starredTick, setStarredTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
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
  }, [projectSlug, docs.page, docs.limit, q]);

  useEffect(() => {
    if (!project) return;
    // When navigating between projects, reset the draft to the loaded values.
    setDraftName(project.name ?? "");
    setDraftDescription(project.description ?? "");
    setDraftAutoAddFiles(Boolean(project.autoAddFiles));
    setSaveError(null);
  }, [project?.id]);

  useEffect(() => {
    function onChanged() {
      setStarredTick((t) => t + 1);
    }
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

  const hasUnsavedChanges = useMemo(() => {
    if (!project) return false;
    return (
      draftName.trim() !== (project.name ?? "") ||
      draftDescription.trim() !== (project.description ?? "") ||
      Boolean(draftAutoAddFiles) !== Boolean(project.autoAddFiles)
    );
  }, [draftAutoAddFiles, draftDescription, draftName, project]);

  async function saveProject() {
    if (!project) return;
    const name = draftName.trim();
    if (!name) {
      setSaveError("Project name is required.");
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
      }
      // Best-effort: notify other UI surfaces (sidebar cache) that projects changed.
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
      setShowSettings(false);
    } catch {
      setSaveError("Failed to save project.");
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
            <FolderIcon className="h-5 w-5 text-[var(--muted-2)]" aria-hidden="true" />
            {title ? (
              <div className="min-w-0 truncate text-sm font-semibold text-[var(--fg)]">{title}</div>
            ) : (
              <div
                className="h-4 w-32 animate-pulse rounded bg-[var(--panel-hover)]"
                aria-label="Loading project name"
              />
            )}
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

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
        <div className="px-6 py-6">
          {notFound ? (
            <div className="mx-auto w-full max-w-4xl">
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6 text-sm text-[var(--muted)]">
                Project not found.
              </div>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-4xl">
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
                  </div>

                  <ul className="mt-6 divide-y divide-[var(--border)]">
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
                            className="cursor-pointer px-1 py-4 hover:bg-[var(--panel-hover)]"
                            onClick={() => router.push(`/doc/${d.id}`)}
                            onKeyDown={(e) => {
                              if (e.key !== "Enter" && e.key !== " ") return;
                              e.preventDefault();
                              router.push(`/doc/${d.id}`);
                            }}
                          >
                            <div className="flex items-start justify-between gap-6">
                              <div className="flex min-w-0 items-start gap-3">
                                <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-[var(--panel)] ring-1 ring-[var(--border)]">
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
                                    <div className="grid h-full w-full place-items-center bg-[var(--panel-2)] text-[10px] font-medium text-[var(--muted-2)]">
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
                                    <div className="truncate text-[13px] font-semibold text-[var(--fg)]">
                                      {d.title}
                                    </div>
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
                                <div
                                  onClickCapture={(e) => e.stopPropagation()}
                                  onPointerDownCapture={(e) => e.stopPropagation()}
                                >
                                  <DocActionsMenu
                                    docId={d.id}
                                    currentProjectId={project?.id ?? null}
                                    onOpenQualityReview={() => router.push(`/doc/${d.id}/review`)}
                                    onDocPatched={(patch) => {
                                      // If the doc is no longer in this project, drop it from this list.
                                      if (!project?.id) return;
                                      if (Array.isArray(patch.projectIds) && !patch.projectIds.includes(project.id)) {
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
            </div>
          )}
        </div>
      </div>

      <Modal
        open={showSettings}
        ariaLabel="Project settings"
        onClose={() => {
          setShowSettings(false);
          setSaveError(null);
          if (project) {
            setDraftName(project.name ?? "");
            setDraftDescription(project.description ?? "");
            setDraftAutoAddFiles(Boolean(project.autoAddFiles));
          }
        }}
      >
        <div className="px-1 pb-3 text-base font-semibold text-[var(--fg)]">Project settings</div>

        <div className="mt-3 grid gap-3">
          <label className="grid gap-1">
            <span className="text-[11px] font-medium text-[var(--muted)]">Name</span>
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
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

          <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-[var(--fg)]">
                Add files to this folder automatically
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                When enabled, AI can place new uploads into this project based on the description.
              </div>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={draftAutoAddFiles}
              aria-label="Add files to this folder automatically"
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
                }
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-xl bg-[var(--primary-bg)] px-3 py-2 text-[13px] font-medium text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:opacity-50"
              disabled={!project || !hasUnsavedChanges || saving}
              onClick={() => void saveProject()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

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


