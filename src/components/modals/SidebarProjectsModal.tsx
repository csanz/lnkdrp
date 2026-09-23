"use client";

import { EllipsisHorizontalIcon, FolderIcon, InboxArrowDownIcon } from "@heroicons/react/24/outline";
import type { Dispatch, SetStateAction } from "react";
import Modal from "@/components/modals/Modal";

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

type Paged<T> = { items: T[]; total: number; page: number; limit: number };

/**
 * Render the SidebarProjectsModal UI.
 */
export default function SidebarProjectsModal({
  open,
  onClose,
  routerPush,
  projectsQuery,
  setProjectsQuery,
  projectsModal,
  setProjectsModal,
  openProjectMenuId,
  setOpenProjectMenuId,
  setOpenDocMenuId,
  setDeleteProjectTarget,
  setDeleteProjectError,
  setDeleteProjectOpen,
  formatRelative,
}: {
  open: boolean;
  onClose: () => void;
  routerPush: (href: string) => void;
  projectsQuery: string;
  setProjectsQuery: (v: string) => void;
  projectsModal: Paged<ProjectListItem>;
  setProjectsModal: Dispatch<SetStateAction<Paged<ProjectListItem>>>;
  openProjectMenuId: string | null;
  setOpenProjectMenuId: Dispatch<SetStateAction<string | null>>;
  setOpenDocMenuId: Dispatch<SetStateAction<string | null>>;
  setDeleteProjectTarget: (p: ProjectListItem) => void;
  setDeleteProjectError: (v: string | null) => void;
  setDeleteProjectOpen: (v: boolean) => void;
  formatRelative: (iso: string | null) => string;
}) {
  const pages = Math.max(1, Math.ceil(projectsModal.total / projectsModal.limit));
  return (
    // Same frame as the Docs "See more" modal: fixed-height panel, scrolling list, theme tokens only.
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setProjectsQuery("");
        setProjectsModal((s) => ({ ...s, page: 1 }));
      }}
      ariaLabel="Projects"
      panelClassName="w-[min(860px,calc(100vw-32px))]"
      contentClassName="h-[min(82vh,860px)] max-h-none overflow-hidden px-6 pb-6 pt-5"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-3 pr-10">
          <div className="text-base font-semibold text-[var(--fg)]">Projects</div>
          <div className="text-xs text-[var(--muted-2)]">{projectsModal.total ? `${projectsModal.total} total` : ""}</div>
        </div>

        <div className="mt-3">
          <input
            autoFocus
            value={projectsQuery}
            onChange={(e) => {
              setProjectsQuery(e.target.value);
              setProjectsModal((s) => ({ ...s, page: 1 }));
            }}
            placeholder="Search"
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-black/10 dark:focus:ring-white/10"
          />
        </div>

        <ul className="mt-3 min-h-0 flex-1 space-y-1 overflow-auto pr-1">
          {projectsModal.items.map((p) => {
            const when = formatRelative(p.updatedDate ?? p.createdDate);
            const openProject = () => {
              if (!p.slug) return;
              onClose();
              routerPush(`/project/${p.id}`);
            };
            const docCount = typeof p.docCount === "number" && Number.isFinite(p.docCount) ? p.docCount : null;
            return (
              <li key={p.id}>
                <div
                  role="link"
                  tabIndex={0}
                  className="group relative rounded-xl border border-transparent px-3 py-2.5 text-[13px] hover:bg-[var(--panel-hover)] focus:border-[var(--border)] focus:outline-none"
                  onClick={openProject}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    openProject();
                  }}
                >
                  <div className="flex min-w-0 items-start gap-3 pr-8">
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-[var(--border)] bg-[var(--panel-hover)]">
                      {p.isRequest ? (
                        <InboxArrowDownIcon className="h-5 w-5 text-[var(--muted-2)]" aria-hidden="true" />
                      ) : (
                        <FolderIcon className="h-5 w-5 text-[var(--muted-2)]" aria-hidden="true" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2 leading-5">
                        <span className="min-w-0 truncate font-semibold text-[var(--fg)]">{p.name}</span>
                        {docCount !== null ? (
                          <span className="shrink-0 rounded-md bg-[var(--panel-hover)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted-2)]">
                            {docCount} {docCount === 1 ? "doc" : "docs"}
                          </span>
                        ) : null}
                        <span className="ml-auto shrink-0 text-[11px] text-[var(--muted-2)]">{when || ""}</span>
                      </div>
                      {p.description ? <div className="mt-0.5 line-clamp-2 text-[12px] text-[var(--muted-2)]">{p.description}</div> : null}
                    </div>
                  </div>

                  <button
                    type="button"
                    // Faint rather than hidden: on a touch screen `opacity-0` is an invisible live control.
                    className="absolute right-2 top-2.5 rounded-lg p-1 text-[var(--muted-2)] opacity-45 transition-opacity hover:bg-[var(--panel)] hover:text-[var(--fg)] focus:opacity-100 group-hover:opacity-100"
                    aria-label="Project actions"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setOpenDocMenuId(null);
                      setOpenProjectMenuId((prev) => (prev === p.id ? null : p.id));
                    }}
                  >
                    <EllipsisHorizontalIcon className="h-4 w-4" />
                  </button>

                  {openProjectMenuId === p.id ? (
                    <div
                      className="absolute right-2 top-10 z-50 w-[170px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-lg"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium text-red-600 transition-colors hover:bg-[var(--panel-hover)]"
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
          {!projectsModal.items.length ? (
            <li className="px-3 py-6 text-center text-[13px] text-[var(--muted-2)]">
              {projectsQuery.trim() ? "No projects match that search." : "No projects yet."}
            </li>
          ) : null}
        </ul>

        {pages > 1 ? (
          <div className="mt-3 flex items-center justify-between gap-3">
            <button
              type="button"
              className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
              disabled={projectsModal.page <= 1}
              onClick={() => setProjectsModal((s) => ({ ...s, page: Math.max(1, s.page - 1) }))}
            >
              Prev
            </button>
            <div className="text-xs text-[var(--muted-2)]">
              Page {projectsModal.page} / {pages}
            </div>
            <button
              type="button"
              className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
              disabled={projectsModal.page >= pages}
              onClick={() => setProjectsModal((s) => ({ ...s, page: s.page + 1 }))}
            >
              Next
            </button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}


