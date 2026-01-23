"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArchiveBoxIcon,
  ChevronRightIcon,
  DocumentMagnifyingGlassIcon,
  EllipsisHorizontalIcon,
  FlagIcon,
  FolderIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import Modal from "@/components/modals/Modal";
import { fetchJson } from "@/lib/http/fetchJson";
import { notifyDocsChanged, notifyProjectsChanged, optimisticallyAddProjectToSidebarCache } from "@/lib/sidebarCache";

type ProjectDTO = { id: string; name: string; slug?: string };

// Temporary: hide unfinished actions from the doc menu.
const SHOW_QUALITY_REVIEW = false;
const SHOW_ARCHIVE = false;
const SHOW_REPORT = false;
/**
 * Render the DocActionsMenu UI (uses effects, local state).
 */


export default function DocActionsMenu({
  docId,
  currentProjectId,
  currentProjectIds,
  disabled,
  onDocPatched,
  onDeleted,
  onOpenQualityReview,
}: {
  docId: string;
  currentProjectId?: string | null;
  currentProjectIds?: string[] | null;
  disabled?: boolean;
  onDocPatched?: (patch: {
    projectId?: string | null;
    project?: { id: string; name: string } | null;
    projectIds?: string[];
    projects?: Array<{ id: string; name: string; slug?: string }>;
    isArchived?: boolean;
  }) => void;
  onDeleted?: () => void;
  onOpenQualityReview?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsLastLoadedAt, setProjectsLastLoadedAt] = useState<number>(0);
  const [projectMembershipBusyId, setProjectMembershipBusyId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDesc, setNewProjectDesc] = useState("");
  const [newProjectError, setNewProjectError] = useState<string | null>(null);
  const [newProjectBusy, setNewProjectBusy] = useState(false);

  const [showReport, setShowReport] = useState(false);
  const [reportMessage, setReportMessage] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportDone, setReportDone] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
/**
 * Handle key down events; updates state (setOpen, setProjectsOpen); uses setOpen, setProjectsOpen.
 */

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setProjectsOpen(false);
      }
    }
/**
 * Handle pointer down events; updates state (setOpen, setProjectsOpen); uses contains, setOpen, setProjectsOpen.
 */

    function onPointerDown(e: MouseEvent | PointerEvent) {
      const el = rootRef.current;
      const menuEl = menuRef.current;
      if (!el && !menuEl) return;
      if (
        e.target instanceof Node &&
        !(el && el.contains(e.target)) &&
        !(menuEl && menuEl.contains(e.target))
      ) {
        setOpen(false);
        setProjectsOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const repositionMenu = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();

    const margin = 8;
    const gap = 10;
    const width = 220; // matches menu width class

    let left = rect.right - width;
    left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));

    let top = rect.bottom + gap;
    const menuEl = menuRef.current;
    const measuredH = menuEl ? menuEl.getBoundingClientRect().height : 260;
    if (top + measuredH + margin > window.innerHeight) {
      top = Math.max(margin, rect.top - gap - measuredH);
    }
    setMenuPos({ top, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    // Position after render so `menuRef` can be measured.
    window.requestAnimationFrame(() => repositionMenu());
    window.addEventListener("resize", repositionMenu);
    // capture scrolls from nested containers too
    window.addEventListener("scroll", repositionMenu, true);
    return () => {
      window.removeEventListener("resize", repositionMenu);
      window.removeEventListener("scroll", repositionMenu, true);
    };
  }, [open, repositionMenu]);
/**
 * Load Projects (updates state (setProjectsLoading, setProjectsError, setProjects); uses setProjectsLoading, setProjectsError, fetchJson).
 */


  async function loadProjects() {
    // Avoid refetching on every open; keeps the picker feeling instant.
    // Still allow refresh after a short window or after an error.
    const now = Date.now();
    if (projects.length && !projectsError && now - projectsLastLoadedAt < 15_000) return;
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const res = await fetchJson<{ projects?: ProjectDTO[] }>(`/api/projects?limit=50&page=1&lite=1`, {
        method: "GET",
      });
      setProjects(Array.isArray(res.projects) ? res.projects : []);
      setProjectsLastLoadedAt(Date.now());
    } catch (e) {
      setProjectsError(e instanceof Error ? e.message : "Failed to load projects");
    } finally {
      setProjectsLoading(false);
    }
  }
/**
 * Add To Project (updates state (setOpen, setProjectsOpen, setProjectsError); uses fetchJson, stringify, onDocPatched).
 */


  async function addToProject(projectId: string) {
    try {
      setProjectMembershipBusyId(projectId);
      const res = await fetchJson<{
        doc?: {
          projectId?: string | null;
          project?: { id: string; name: string } | null;
          projectIds?: string[];
          projects?: Array<{ id: string; name: string; slug?: string }>;
        };
      }>(
        `/api/docs/${docId}`,
        {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addProjectId: projectId }),
        },
      );
      onDocPatched?.({
        projectId: typeof res?.doc?.projectId === "string" ? res.doc.projectId : null,
        project: res?.doc?.project ?? null,
        projectIds: Array.isArray(res?.doc?.projectIds) ? res.doc.projectIds : undefined,
        projects: Array.isArray(res?.doc?.projects) ? res.doc.projects : undefined,
      });
      notifyDocsChanged();
      // Adding to a project changes the cached project docCount; refresh sidebar projects immediately.
      notifyProjectsChanged();
      setOpen(false);
      setProjectsOpen(false);
    } catch {
      // Keep menu open; errors show in projects panel.
      setProjectsError("Failed to add to project");
    } finally {
      setProjectMembershipBusyId(null);
    }
  }
/**
 * Create Project And Move (updates state (setNewProjectError, setNewProjectBusy, setProjects); uses trim, setNewProjectError, setNewProjectBusy).
 */


  async function createProjectAndMove() {
    const name = newProjectName.trim();
    const description = newProjectDesc.trim();
    if (!name) {
      setNewProjectError("Project name is required");
      return;
    }
    setNewProjectBusy(true);
    setNewProjectError(null);
    try {
      const res = await fetchJson<{ project: ProjectDTO }>("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      const id = res?.project?.id;
      if (typeof id === "string" && id) {
        // refresh projects list and add immediately
        setProjects((prev) => [{ id, name, description }, ...prev]);
        optimisticallyAddProjectToSidebarCache({
          id,
          name,
          slug: typeof res?.project?.slug === "string" ? res.project.slug : "",
          description,
          isRequest: false,
          docCount: 0,
          updatedDate: new Date().toISOString(),
          createdDate: new Date().toISOString(),
        });
        // Notify other UI (sidebar, etc) to refresh projects immediately.
        notifyProjectsChanged();
        await addToProject(id);
      } else {
        throw new Error("Failed to create project");
      }
      setShowNewProject(false);
      setNewProjectName("");
      setNewProjectDesc("");
    } catch (e) {
      setNewProjectError(e instanceof Error ? e.message : "Failed to create project");
    } finally {
      setNewProjectBusy(false);
    }
  }
/**
 * Remove From This Project (updates state (setOpen, setProjectsOpen, setProjectsError); uses fetchJson, stringify, onDocPatched).
 */


  async function removeFromThisProject() {
    if (!currentProjectId) return;
    try {
      setProjectMembershipBusyId(currentProjectId);
      const res = await fetchJson<{
        doc?: {
          projectId?: string | null;
          project?: { id: string; name: string } | null;
          projectIds?: string[];
          projects?: Array<{ id: string; name: string; slug?: string }>;
        };
      }>(
        `/api/docs/${docId}`,
        {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ removeProjectId: currentProjectId }),
        },
      );
      onDocPatched?.({
        projectId: typeof res?.doc?.projectId === "string" ? res.doc.projectId : null,
        project: res?.doc?.project ?? null,
        projectIds: Array.isArray(res?.doc?.projectIds) ? res.doc.projectIds : undefined,
        projects: Array.isArray(res?.doc?.projects) ? res.doc.projects : undefined,
      });
      notifyDocsChanged();
      // Removing from a project changes the cached project docCount; refresh sidebar projects immediately.
      notifyProjectsChanged();
      setOpen(false);
      setProjectsOpen(false);
    } catch {
      setProjectsError("Failed to remove from project");
    } finally {
      setProjectMembershipBusyId(null);
    }
  }
/**
 * Archive Doc (updates state (setOpen, setProjectsOpen); uses fetchJson, stringify, onDocPatched).
 */


  async function archiveDoc() {
    try {
      await fetchJson(`/api/docs/${docId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isArchived: true }),
      });
      onDocPatched?.({ isArchived: true });
      notifyDocsChanged();
      // Archiving affects project doc counts (active docs only).
      notifyProjectsChanged();
      setOpen(false);
      setProjectsOpen(false);
      // Archiving removes it from `/api/docs` lists; the current page is still valid.
    } catch {
      // ignore (best-effort)
    }
  }
/**
 * Submit Report (updates state (setReportBusy, setReportError, setReportDone); uses setReportBusy, setReportError, fetchJson).
 */


  async function submitReport() {
    setReportBusy(true);
    setReportError(null);
    try {
      await fetchJson(`/api/docs/${docId}/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: reportMessage.trim() }),
      });
      setReportDone(true);
      window.setTimeout(() => {
        setShowReport(false);
        setReportDone(false);
        setReportMessage("");
      }, 650);
    } catch (e) {
      setReportError(e instanceof Error ? e.message : "Failed to report");
    } finally {
      setReportBusy(false);
    }
  }
/**
 * Delete Doc (updates state (setDeleteBusy, setDeleteError, setShowDeleteConfirm); uses setDeleteBusy, setDeleteError, fetchJson).
 */


  async function deleteDoc() {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await fetchJson(`/api/docs/${docId}`, { method: "DELETE" });
      setShowDeleteConfirm(false);
      setOpen(false);
      setProjectsOpen(false);
      notifyDocsChanged();
      // Deleting affects project doc counts (active docs only).
      notifyProjectsChanged();
      onDeleted?.();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setDeleteBusy(false);
    }
  }

  const menuItemBase =
    "flex w-full items-center justify-between gap-3 px-3 py-2 text-[13px] text-[var(--fg)] hover:bg-[var(--panel-hover)]";

  const disabledClass = disabled ? "cursor-not-allowed opacity-60 hover:bg-[var(--panel)]" : "";
  const selectedProjectIds = new Set(
    (Array.isArray(currentProjectIds) ? currentProjectIds : null) ??
      (currentProjectId ? [currentProjectId] : []),
  );

  const projectsPanel = (
    <div
      role="menu"
      className="absolute right-[calc(100%+10px)] top-0 z-50 w-[260px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-lg"
    >
      <ul className="max-h-[320px] overflow-auto py-1">
        <li>
          <button
            type="button"
            className={menuItemBase}
            onClick={() => {
              setShowNewProject(true);
              setOpen(false);
              setProjectsOpen(false);
              setNewProjectError(null);
            }}
          >
            <span className="inline-flex items-center gap-2">
              <span className="text-[var(--muted-2)]">
                <PlusIcon className="h-4 w-4" />
              </span>
              <span>New project</span>
            </span>
          </button>
        </li>
        <li className="my-1 h-px bg-[var(--border)]" />
        {projectsLoading ? (
          <li className="px-3 py-2 text-[13px] text-[var(--muted-2)]">Loading…</li>
        ) : projectsError ? (
          <li className="px-3 py-2 text-[13px] text-red-700">{projectsError}</li>
        ) : projects.length ? (
          projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={menuItemBase}
                disabled={Boolean(projectMembershipBusyId)}
                aria-disabled={Boolean(projectMembershipBusyId)}
                onClick={() => {
                  if (projectMembershipBusyId) return;
                  if (selectedProjectIds.has(p.id)) {
                    // Best-effort: allow toggling off if we know this doc is already in the project.
                    setProjectMembershipBusyId(p.id);
                    void fetchJson<{
                      doc?: {
                        projectId?: string | null;
                        project?: { id: string; name: string } | null;
                        projectIds?: string[];
                        projects?: Array<{ id: string; name: string; slug?: string }>;
                      };
                    }>(`/api/docs/${docId}`, {
                      method: "PATCH",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ removeProjectId: p.id }),
                    })
                      .then((r) => {
                        onDocPatched?.({
                          projectId: typeof r?.doc?.projectId === "string" ? r.doc.projectId : null,
                          project: r?.doc?.project ?? null,
                          projectIds: Array.isArray(r?.doc?.projectIds) ? r.doc.projectIds : undefined,
                          projects: Array.isArray(r?.doc?.projects) ? r.doc.projects : undefined,
                        });
                        notifyDocsChanged();
                        notifyProjectsChanged();
                        setOpen(false);
                        setProjectsOpen(false);
                      })
                      .catch(() => setProjectsError("Failed to remove from project"))
                      .finally(() => setProjectMembershipBusyId(null));
                    return;
                  }
                  void addToProject(p.id);
                }}
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  <span className="text-[var(--muted-2)]">
                    <FolderIcon className="h-4 w-4" />
                  </span>
                  <span className="truncate">{p.name}</span>
                </span>
                <span className="shrink-0">
                  {projectMembershipBusyId === p.id ? (
                    <Spinner className="h-4 w-4 text-[var(--muted-2)]" />
                  ) : selectedProjectIds.has(p.id) ? (
                    <span className="text-[12px] font-semibold text-[var(--muted-2)]">✓</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))
        ) : (
          <li className="px-3 py-2 text-[13px] text-[var(--muted-2)]">No projects yet.</li>
        )}
      </ul>
    </div>
  );

  const renderedMenu =
    open && !disabled ? (
      <div
        ref={menuRef}
        role="menu"
        className="fixed z-[1000] w-[220px] overflow-visible rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-lg"
        style={{
          // Always render visibly; if positioning hasn't computed yet, fall back to a safe default.
          top: menuPos?.top ?? 16,
          left: menuPos?.left ?? 16,
        }}
      >
        <ul className="py-1">
          <li className="relative">
            <button
              type="button"
              className={menuItemBase}
              onClick={() => {
                const next = !projectsOpen;
                setProjectsOpen(next);
                setProjectsError(null);
                if (next) void loadProjects();
                // menu height can change; ensure we re-fit to viewport
                window.requestAnimationFrame(() => repositionMenu());
              }}
            >
              <span className="inline-flex items-center gap-2">
                <span className="text-[var(--muted-2)]">
                  <FolderIcon className="h-4 w-4" />
                </span>
                <span>Projects</span>
              </span>
              <ChevronRightIcon className="h-4 w-4 text-[var(--muted-2)]" />
            </button>
            {projectsOpen ? projectsPanel : null}
          </li>

          {currentProjectId ? (
            <li>
              <button
                type="button"
                className={menuItemBase}
                onClick={() => {
                  setProjectsError(null);
                  void removeFromThisProject();
                }}
              >
                <span className="inline-flex items-center gap-2">
                  <span className="text-[var(--muted-2)]">
                    <FolderIcon className="h-4 w-4" />
                  </span>
                  <span>Remove from this project</span>
                </span>
              </button>
            </li>
          ) : null}

          <li className="my-1 h-px bg-[var(--border)]" />

          {SHOW_QUALITY_REVIEW ? (
            <li>
              <button
                type="button"
                className={menuItemBase}
                onClick={() => {
                  setOpen(false);
                  setProjectsOpen(false);
                  onOpenQualityReview?.();
                }}
              >
                <span className="inline-flex items-center gap-2">
                  <span className="text-zinc-500">
                    <DocumentMagnifyingGlassIcon className="h-4 w-4" />
                  </span>
                  <span>Quality review</span>
                </span>
              </button>
            </li>
          ) : null}

          {SHOW_ARCHIVE ? (
            <li>
              <button type="button" className={menuItemBase} onClick={() => void archiveDoc()}>
                <span className="inline-flex items-center gap-2">
                  <span className="text-zinc-500">
                    <ArchiveBoxIcon className="h-4 w-4" />
                  </span>
                  <span>Archive</span>
                </span>
              </button>
            </li>
          ) : null}

          {SHOW_REPORT ? (
            <li>
              <button
                type="button"
                className={menuItemBase}
                onClick={() => {
                  setShowReport(true);
                  setReportError(null);
                  setReportDone(false);
                  setOpen(false);
                  setProjectsOpen(false);
                }}
              >
                <span className="inline-flex items-center gap-2">
                  <span className="text-zinc-500">
                    <FlagIcon className="h-4 w-4" />
                  </span>
                  <span>Report</span>
                </span>
              </button>
            </li>
          ) : null}
          <li>
            <button
              type="button"
              className={[menuItemBase, "text-red-700 hover:bg-red-50"].join(" ")}
              onClick={() => {
                setShowDeleteConfirm(true);
                setDeleteError(null);
                setOpen(false);
                setProjectsOpen(false);
              }}
            >
              <span className="inline-flex items-center gap-2">
                <span className="text-red-600">
                  <TrashIcon className="h-4 w-4" />
                </span>
                <span>Delete document…</span>
              </span>
            </button>
          </li>
        </ul>
      </div>
    ) : null;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-disabled={disabled}
        className={[
          "inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors",
          "border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
          disabledClass,
        ].join(" ")}
        aria-label="Document actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (disabled) return;
          // Compute position immediately so the menu never renders "invisible".
          repositionMenu();
          setOpen((v) => {
            const next = !v;
            if (next) {
              setProjectsOpen(false);
              // Ensure menu is positioned even when inside scroll containers (avoids clipping).
              window.requestAnimationFrame(() => repositionMenu());
            } else {
              setMenuPos(null);
            }
            return next;
          });
        }}
      >
        <EllipsisHorizontalIcon className="h-4 w-4" />
      </button>

      {renderedMenu && typeof document !== "undefined" ? createPortal(renderedMenu, document.body) : null}

      <Modal
        open={showNewProject}
        onClose={() => {
          if (newProjectBusy) return;
          setShowNewProject(false);
        }}
        ariaLabel="New project"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-base font-semibold text-[var(--fg)]">New project</div>
            {newProjectBusy ? (
              <div
                className="inline-flex items-center gap-2 text-xs font-medium text-[var(--muted-2)]"
                aria-live="polite"
              >
                <Spinner className="h-4 w-4 text-[var(--muted-2)]" />
                <span>Creating…</span>
              </div>
            ) : null}
          </div>
          <div className="text-sm text-[var(--muted)]">
            Give it a short name and describe it so AI can auto-add docs to this project later.
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Name</div>
            <input
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              disabled={newProjectBusy}
              placeholder="e.g. Lnkdrp fundraising"
              className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
              Description
            </div>
            <textarea
              value={newProjectDesc}
              onChange={(e) => setNewProjectDesc(e.target.value)}
              disabled={newProjectBusy}
              placeholder="What kinds of docs belong here?"
              className="mt-1 min-h-[96px] w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>
          {newProjectError ? (
            <div className="text-sm font-medium text-red-700">{newProjectError}</div>
          ) : null}
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
              disabled={newProjectBusy}
              onClick={() => setShowNewProject(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-lg bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:opacity-50"
              disabled={newProjectBusy}
              onClick={() => void createProjectAndMove()}
            >
              {newProjectBusy ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner className="h-4 w-4 text-[var(--primary-fg)]" />
                  <span>Creating…</span>
                </span>
              ) : (
                "Create project"
              )}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={showReport}
        onClose={() => {
          if (reportBusy) return;
          setShowReport(false);
        }}
        ariaLabel="Report"
      >
        <div className="space-y-4">
          <div className="text-base font-semibold text-[var(--fg)]">Report</div>
          <div className="text-sm text-[var(--muted)]">Tell us what’s wrong (optional).</div>
          <textarea
            value={reportMessage}
            onChange={(e) => setReportMessage(e.target.value)}
            placeholder="Describe the issue…"
            className="min-h-[120px] w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
          />
          {reportError ? <div className="text-sm font-medium text-red-700">{reportError}</div> : null}
          {reportDone ? <div className="text-sm font-medium text-emerald-700">Reported.</div> : null}
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
              disabled={reportBusy}
              onClick={() => setShowReport(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-lg bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:opacity-50"
              disabled={reportBusy}
              onClick={() => void submitReport()}
            >
              {reportBusy ? "Sending…" : "Send report"}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={showDeleteConfirm}
        onClose={() => {
          if (deleteBusy) return;
          setShowDeleteConfirm(false);
        }}
        ariaLabel="Delete document"
      >
        <div className="space-y-4">
          <div className="text-base font-semibold text-[var(--fg)]">Delete document?</div>
          <div className="text-sm text-[var(--muted)]">
            This will permanently delete the document. This can’t be undone.
          </div>
          {deleteError ? <div className="text-sm font-medium text-red-700">{deleteError}</div> : null}
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
              disabled={deleteBusy}
              onClick={() => setShowDeleteConfirm(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              disabled={deleteBusy}
              onClick={() => void deleteDoc()}
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
/**
 * Render the Spinner UI.
 */


function Spinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={["animate-spin", className ?? "h-4 w-4"].join(" ")}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        className="opacity-25"
      />
      <path
        fill="currentColor"
        className="opacity-75"
        d="M12 3a9 9 0 0 1 9 9h-3a6 6 0 0 0-6-6V3z"
      />
    </svg>
  );
}





