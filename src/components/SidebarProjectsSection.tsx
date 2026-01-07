"use client";

import {
  EllipsisHorizontalIcon,
  InboxArrowDownIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
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
  activeProjectId,
  projectsLoaded,
  projects,
  projectsForSidebar,
  projectsSidebarLimit,
  projectsCollapsedLoaded,
  projectsCollapsed,
  setProjectsCollapsedLoaded,
  setProjectsCollapsed,
  setShowProjectsModal,
  onClickNewProject,
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
  activeProjectId: string | null;
  projectsLoaded: boolean;
  projects: Paged<ProjectListItem>;
  projectsForSidebar: ProjectListItem[];
  projectsSidebarLimit: number;
  projectsCollapsedLoaded: boolean;
  projectsCollapsed: boolean;
  setProjectsCollapsedLoaded: Dispatch<SetStateAction<boolean>>;
  setProjectsCollapsed: Dispatch<SetStateAction<boolean>>;
  setShowProjectsModal: Dispatch<SetStateAction<boolean>>;
  onClickNewProject: () => void;
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
      <div className="flex items-center gap-1.5 px-2 text-[14px] font-medium text-[var(--muted-2)]">
        <button
          type="button"
          className="rounded-md px-1 py-0.5 text-left hover:bg-[var(--sidebar-hover)]"
          onClick={() => {
            setProjectsCollapsedLoaded(true);
            setProjectsCollapsed((v) => !v);
          }}
        >
          Projects
        </button>
        <IconButton
          ariaLabel={(projectsCollapsedLoaded ? projectsCollapsed : true) ? "Expand projects" : "Collapse projects"}
          variant="ghost"
          size="sm"
          className={[
            "h-6 w-6 rounded-md p-0 text-[var(--muted-2)]",
            "opacity-100",
          ].join(" ")}
          onClick={() => {
            setProjectsCollapsedLoaded(true);
            setProjectsCollapsed((v) => !v);
          }}
        >
          <StablePlusMinusIcon expanded={!(projectsCollapsedLoaded ? projectsCollapsed : true)} />
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
      ) : (
        <ul className="mt-2 space-y-0.5">
          <li>
            <button
              type="button"
              disabled={navLocked}
              className={[
                "flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[13px] font-medium text-[var(--muted)]",
                navLocked ? "cursor-not-allowed opacity-60" : "hover:bg-[var(--sidebar-hover)]",
              ].join(" ")}
              onClick={() => {
                if (navLocked) return;
                onClickNewProject();
              }}
            >
              <FolderPlusSvg className="h-4 w-4 shrink-0 text-[var(--muted-2)]" />
              <span>New project</span>
            </button>
          </li>

          {!projectsForSidebar.length ? (
            <li className="px-2 py-2 text-[13px] text-[var(--muted-2)]">No projects yet.</li>
          ) : null}

          {projectsForSidebar.map((p) => {
            const title = truncateEnd(p.name, 22);
            const isActive = Boolean(activeProjectId && activeProjectId === p.id);
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
                        <span className="text-[var(--muted-2)]">
                          {isActive ? <FolderOpenSvg className="h-4 w-4" /> : <FolderClosedSvg className="h-4 w-4" />}
                        </span>
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
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-4 w-4"
    >
      <path d="M6 12h12" />
      {!expanded ? <path d="M12 6v12" /> : null}
    </svg>
  );
}

function FolderClosedSvg({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="1.5"
      stroke="currentColor"
      className={className ?? "h-4 w-4"}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z"
      />
    </svg>
  );
}

function FolderOpenSvg({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="1.5"
      stroke="currentColor"
      className={className ?? "h-4 w-4"}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.857-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h3.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 9v.776"
      />
    </svg>
  );
}

function FolderPlusSvg({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="1.5"
      stroke="currentColor"
      className={className ?? "h-4 w-4"}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 10.5v6m3-3H9m4.06-7.19-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z"
      />
    </svg>
  );
}


