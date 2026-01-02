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
  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
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
              <div
                className="group relative rounded-xl px-3 py-2 hover:bg-zinc-50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div
                    role="link"
                    tabIndex={0}
                    className="min-w-0 flex-1 cursor-pointer"
                    onClick={() => {
                      if (!p.slug) return;
                      onClose();
                      routerPush(`/project/${p.id}`);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      if (!p.slug) return;
                      onClose();
                      routerPush(`/project/${p.id}`);
                    }}
                  >
                    <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-zinc-900">
                      {p.isRequest ? (
                        <InboxArrowDownIcon className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                      ) : (
                        <FolderIcon className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                      )}
                      <span className="block min-w-0 flex-1 truncate">{p.name}</span>
                    </div>
                    {p.description ? <div className="mt-1 text-[12px] text-zinc-600">{p.description}</div> : null}
                  </div>

                  <div className="shrink-0 text-[11px] text-zinc-400">{when || "-"}</div>
                </div>

                <button
                  type="button"
                  className={[
                    "absolute right-2 top-2 rounded-lg p-1 text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                    "opacity-70 transition-opacity hover:opacity-100 focus:opacity-100",
                  ].join(" ")}
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
  );
}


