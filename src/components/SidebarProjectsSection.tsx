"use client";

import { EllipsisHorizontalIcon, FolderIcon, InboxArrowDownIcon, MinusIcon, PlusSmallIcon } from "@heroicons/react/24/outline";
import type { Dispatch, SetStateAction } from "react";
import IconButton from "@/components/ui/IconButton";

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

export default function SidebarProjectsSection({
  navLocked,
  projectsLoaded,
  projects,
  projectsForSidebar,
  projectsSidebarLimit,
  projectsCollapsedLoaded,
  projectsCollapsed,
  setProjectsCollapsedLoaded,
  setProjectsCollapsed,
  setShowProjectsModal,
  routerPush,
  openProjectMenuId,
  setOpenProjectMenuId,
  setOpenDocMenuId,
  setDeleteProjectTarget,
  setDeleteProjectError,
  setDeleteProjectOpen,
  truncateEnd,
}: {
  navLocked: boolean;
  projectsLoaded: boolean;
  projects: Paged<ProjectListItem>;
  projectsForSidebar: ProjectListItem[];
  projectsSidebarLimit: number;
  projectsCollapsedLoaded: boolean;
  projectsCollapsed: boolean;
  setProjectsCollapsedLoaded: Dispatch<SetStateAction<boolean>>;
  setProjectsCollapsed: Dispatch<SetStateAction<boolean>>;
  setShowProjectsModal: Dispatch<SetStateAction<boolean>>;
  routerPush: (href: string) => void;
  openProjectMenuId: string | null;
  setOpenProjectMenuId: Dispatch<SetStateAction<string | null>>;
  setOpenDocMenuId: Dispatch<SetStateAction<string | null>>;
  setDeleteProjectTarget: (p: ProjectListItem) => void;
  setDeleteProjectError: (v: string | null) => void;
  setDeleteProjectOpen: (v: boolean) => void;
  truncateEnd: (text: string, maxChars: number) => string;
}) {
  return (
    <section>
      <div className="group flex items-center justify-between gap-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
        <span>Projects</span>
        <IconButton
          ariaLabel={(projectsCollapsedLoaded ? projectsCollapsed : true) ? "Expand projects" : "Collapse projects"}
          variant="ghost"
          size="sm"
          className={[
            "rounded-md p-0.5 text-[var(--muted-2)]",
            "opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100",
          ].join(" ")}
          onClick={() => {
            setProjectsCollapsedLoaded(true);
            setProjectsCollapsed((v) => !v);
          }}
        >
          {(projectsCollapsedLoaded ? projectsCollapsed : true) ? (
            <PlusSmallIcon className="h-4 w-4" />
          ) : (
            <MinusIcon className="h-4 w-4" />
          )}
        </IconButton>
      </div>

      {(projectsCollapsedLoaded ? projectsCollapsed : true) ? (
        !projectsLoaded ? (
          <div className="mt-2 px-2 py-2 text-[13px] text-[var(--muted-2)]">Loading…</div>
        ) : !projectsForSidebar.length ? (
          <div className="mt-2 px-2 py-2 text-[13px] text-[var(--muted-2)]">No projects yet.</div>
        ) : (
          <div className="mt-2 flex items-center justify-between gap-3 px-2 py-1.5">
            <div className="text-[13px] font-medium text-[var(--muted-2)]">{projects.total || projectsForSidebar.length} projects</div>
            <button
              type="button"
              disabled={navLocked}
              className={[
                "rounded-lg px-2 py-1 text-[13px] font-medium text-[var(--muted)]",
                navLocked ? "cursor-not-allowed opacity-60" : "hover:bg-[var(--sidebar-hover)]",
              ].join(" ")}
              onClick={() => {
                if (navLocked) return;
                setShowProjectsModal(true);
              }}
            >
              See more
            </button>
          </div>
        )
      ) : !projectsLoaded ? (
        <div className="mt-2 px-2 py-2 text-[13px] text-[var(--muted-2)]">Loading…</div>
      ) : !projectsForSidebar.length ? (
        <div className="mt-2 px-2 py-2 text-[13px] text-[var(--muted-2)]">No projects yet.</div>
      ) : (
        <ul className="mt-2 space-y-0.5">
          {projectsForSidebar.map((p) => {
            const title = truncateEnd(p.name, 22);
            return (
              <li key={p.id}>
                <div className="group relative">
                  <div
                    role="link"
                    tabIndex={0}
                    className="flex cursor-pointer items-center justify-between gap-2 rounded-xl px-2 py-1.5 text-left text-[14px] hover:bg-[var(--sidebar-hover)]"
                    onClick={() => {
                      if (!p.slug) return;
                      routerPush(`/project/${p.id}`);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      if (!p.slug) return;
                      routerPush(`/project/${p.id}`);
                    }}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      {p.isRequest ? (
                        <InboxArrowDownIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                      ) : (
                        <FolderIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                      )}
                      <span className="block min-w-0 flex-1 truncate font-medium text-[var(--fg)]">{title}</span>
                    </div>

                    <IconButton
                      ariaLabel="Project actions"
                      variant="ghost"
                      size="sm"
                      className={[
                        "shrink-0 rounded-lg p-1 text-[var(--muted-2)]",
                        "opacity-70 transition-opacity hover:opacity-100 focus:opacity-100",
                      ].join(" ")}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setOpenDocMenuId(null);
                        setOpenProjectMenuId((prev) => (prev === p.id ? null : p.id));
                      }}
                    >
                      <EllipsisHorizontalIcon className="h-4 w-4" />
                    </IconButton>
                  </div>

                  {openProjectMenuId === p.id ? (
                    <div
                      className="absolute right-2 top-[calc(100%+6px)] z-50 w-[170px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-lg"
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

          {projects.total > projectsSidebarLimit ? (
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
  );
}


