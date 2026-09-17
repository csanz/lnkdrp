"use client";

import {
  ArrowsPointingOutIcon,
  EllipsisHorizontalIcon,
  InboxArrowDownIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import type { Dispatch, SetStateAction } from "react";
import IconButton from "@/components/ui/IconButton";
import { PROJECT_NAV_OVERLAY_ID, showSwitchingOverlay } from "@/components/SwitchingOverlay";

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
  rowEnter,
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
  /** Grow-in classes for a row that just appeared (see LeftSidebar); empty strings once settled. */
  rowEnter?: (id: string) => { li: string; child: string };
}) {
  return (
    <section>
      <div className="group flex h-7 items-center gap-1 pl-2 pr-2 text-[11px] font-semibold uppercase leading-5 tracking-[0.08em] text-[var(--muted-2)]">
        <button
          type="button"
          className="inline-flex h-6 items-center rounded-md px-1 py-0 text-left hover:bg-[var(--sidebar-hover)]"
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
            "h-6 w-6 rounded-md p-0 text-[var(--muted-2)] hover:text-[var(--fg)]",
            "opacity-100",
          ].join(" ")}
          onClick={() => {
            setProjectsCollapsedLoaded(true);
            setProjectsCollapsed((v) => !v);
          }}
        >
          <StablePlusMinusIcon expanded={!(projectsCollapsedLoaded ? projectsCollapsed : true)} />
        </IconButton>
        <IconButton
          ariaLabel="Open all projects"
          title="Open all projects"
          variant="ghost"
          size="sm"
          disabled={navLocked}
          className={[
            // Revealed on hover/focus: the list modal is otherwise only reachable through "See
            // more", which a short list never shows — and archived projects live there.
            "ml-auto h-6 w-6 rounded-md p-0 text-[var(--muted-2)] opacity-0 transition-opacity hover:text-[var(--fg)]",
            "group-hover:opacity-100 focus-visible:opacity-100",
          ].join(" ")}
          onClick={() => {
            if (navLocked) return;
            setShowProjectsModal(true);
          }}
        >
          <ArrowsPointingOutIcon className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          ariaLabel="New project"
          title="New project"
          variant="ghost"
          size="sm"
          disabled={navLocked}
          className="h-6 w-6 rounded-md p-0 text-[var(--muted-2)] hover:text-[var(--fg)]"
          onClick={() => {
            if (navLocked) return;
            onClickNewProject();
          }}
        >
          <PlusIcon className="h-4 w-4" />
        </IconButton>
      </div>

      {(projectsCollapsedLoaded ? projectsCollapsed : true) ? (
        !projectsLoaded ? (
          <div className="mt-2 pl-3 pr-2 py-2 text-[13px] text-[var(--muted-2)]">Loading…</div>
        ) : !projectsForSidebar.length ? (
          <div className="mt-2 pl-3 pr-2 py-2 text-[13px] text-[var(--muted-2)]">No projects yet.</div>
        ) : (
          <div className="mt-2 flex items-center justify-between gap-3 pl-3 pr-2 py-1.5">
            <div className="text-[13px] font-medium text-[var(--muted)]">{projects.total || projectsForSidebar.length} projects</div>
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
        <div className="mt-2 pl-3 pr-2 py-2 text-[13px] text-[var(--muted-2)]">Loading…</div>
      ) : (
        <ul className="mt-2 space-y-1">
          {!projectsForSidebar.length ? (
            <li className="pl-3 pr-2 py-2 text-[13px] text-[var(--muted-2)]">No projects yet.</li>
          ) : null}

          {projectsForSidebar.map((p) => {
            const title = truncateEnd(p.name, 26);
            const isActive = Boolean(activeProjectId && activeProjectId === p.id);
            return (
              <li key={p.id} className={rowEnter?.(p.id).li ?? ""}>
                <div className={["group relative", rowEnter?.(p.id).child ?? ""].join(" ")}>
                  <div
                    role="link"
                    tabIndex={0}
                    className={[
                      "w-full cursor-pointer overflow-hidden rounded-xl pl-3 pr-2 py-1.5 text-left text-[14px]",
                      isActive ? "bg-[var(--sidebar-hover)] font-medium" : "hover:bg-[var(--sidebar-hover)]",
                    ].join(" ")}
                    onClick={() => {
                      if (!p.slug) return;
                      showSwitchingOverlay({
                        id: PROJECT_NAV_OVERLAY_ID,
                        title: "Loading project…",
                        subtitle: "Just a moment.",
                      });
                      routerPush(`/project/${p.id}`);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      if (!p.slug) return;
                      showSwitchingOverlay({
                        id: PROJECT_NAV_OVERLAY_ID,
                        title: "Loading project…",
                        subtitle: "Just a moment.",
                      });
                      routerPush(`/project/${p.id}`);
                    }}
                  >
                    <div className="flex min-w-0 items-center gap-2 pr-8">
                      {p.isRequest ? (
                        <InboxArrowDownIcon className="h-3.5 w-3.5 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                      ) : (
                        <span className="shrink-0 text-[var(--muted-2)]" aria-hidden="true">
                          {isActive ? (
                            <FolderOpenSvg className="h-3.5 w-3.5" />
                          ) : (
                            <FolderClosedSvg className="h-3.5 w-3.5" />
                          )}
                        </span>
                      )}
                      <span className="block min-w-0 flex-1 truncate text-[var(--fg)]">{title}</span>
                    </div>
                  </div>

                  <IconButton
                    ariaLabel="Project actions"
                    variant="ghost"
                    size="xs"
                    className={[
                      // IMPORTANT: keep this out of layout so it doesn't affect row height.
                      "absolute right-2 top-1/2 -translate-y-1/2 rounded-md text-[var(--muted-2)]",
                      "opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100",
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
                className="w-full rounded-xl pl-3 pr-2 py-1.5 text-left text-[13px] font-medium text-[var(--muted)] hover:bg-[var(--sidebar-hover)]"
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



