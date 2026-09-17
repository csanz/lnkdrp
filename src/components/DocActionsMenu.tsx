"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArchiveBoxIcon,
  ArchiveBoxXMarkIcon,
  ChevronRightIcon,
  DocumentMagnifyingGlassIcon,
  EllipsisHorizontalIcon,
  FlagIcon,
  FolderIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import Modal from "@/components/modals/Modal";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { fetchJson } from "@/lib/http/fetchJson";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { parsePlanLimitError, planLimitGraceHint } from "@/lib/client/planLimit";
import { upsellKeyForLimit } from "@/lib/client/upsellCopy";
import { refreshPlan } from "@/lib/client/usePlan";
import { notifyDocLeaving, notifyDocsChanged, notifyProjectsChanged, optimisticallyAddProjectToSidebarCache } from "@/lib/sidebarCache";

type ProjectDTO = { id: string; name: string; slug?: string };

// Temporary: hide unfinished actions from the doc menu.
const SHOW_QUALITY_REVIEW = false;
const SHOW_REPORT = false;

/** Width of the main menu and of the projects submenu (px); keep in sync with their `w-[…]` classes. */
const MENU_WIDTH = 220;
const SUBMENU_WIDTH = 260;
const SUBMENU_GAP = 10;
const MENU_ITEM_SELECTOR = '[role="menuitem"],[role="menuitemcheckbox"]';

/**
 * Trigger looks:
 * - `outline` (default): the bordered 32px button on project and doc pages.
 * - `ghost`: hover-revealed, the "..." on rows of the sidebar "See more" modals.
 * - `sidebar`: hover-revealed, the "..." on left-sidebar rows (same as the project rows there).
 */
type TriggerVariant = "outline" | "ghost" | "sidebar";

/**
 * Render the DocActionsMenu UI (uses effects, local state).
 *
 * The menu and its dialogs render through portals, so a caller inside a scrolling list or a
 * transformed modal panel never clips them. Clicks and Enter/Space inside it don't reach the row
 * that hosts it (rows here are usually clickable links).
 */
export default function DocActionsMenu({
  docId,
  currentProjectId,
  currentProjectIds,
  disabled,
  onDocPatched,
  onDeleted,
  onOpenQualityReview,
  variant = "outline",
  className,
  projectsLabel = "Projects",
  showRemoveFromProject = true,
  showArchive = false,
  isArchived = false,
  showDelete = true,
  onRequestDelete,
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
  variant?: TriggerVariant;
  /** Classes for the wrapper (e.g. absolute positioning inside a row). */
  className?: string;
  /** Label of the item that opens the project picker. */
  projectsLabel?: string;
  /** Show "Remove from this project" when `currentProjectId` is set. */
  showRemoveFromProject?: boolean;
  /** Show Archive (or Unarchive when `isArchived`). */
  showArchive?: boolean;
  isArchived?: boolean;
  showDelete?: boolean;
  /** When set, Delete hands off to the caller's own confirm dialog instead of the built-in one. */
  onRequestDelete?: () => void;
}) {
  const { openUpgrade } = useUpgradeModal();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const projectsItemRef = useRef<HTMLButtonElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsLastLoadedAt, setProjectsLastLoadedAt] = useState<number>(0);
  const [projectMembershipBusyId, setProjectMembershipBusyId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [submenuSide, setSubmenuSide] = useState<"left" | "right">("left");
  // Membership looked up on demand when the caller doesn't know it (e.g. rows from `/api/docs`).
  const [fetchedProjectIds, setFetchedProjectIds] = useState<string[] | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

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

  const closeMenu = useCallback((opts?: { focusTrigger?: boolean }) => {
    setOpen(false);
    setProjectsOpen(false);
    setMenuPos(null);
    if (opts?.focusTrigger) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    /**
     * Keyboard: Escape closes the submenu, then the menu (and doesn't reach a hosting modal's own
     * Escape handler); arrows move between items; Tab leaves the menu. Capture phase on `window`
     * so it runs before bubble-phase Escape listeners such as `Modal`'s.
     */
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (projectsOpen) {
          setProjectsOpen(false);
          projectsItemRef.current?.focus();
          return;
        }
        closeMenu({ focusTrigger: true });
        return;
      }
      const menuEl = menuRef.current;
      if (!menuEl) return;
      if (e.key === "Tab") {
        if (menuEl.contains(document.activeElement)) closeMenu({ focusTrigger: true });
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
      const scope =
        projectsOpen && submenuRef.current && submenuRef.current.contains(document.activeElement)
          ? submenuRef.current
          : menuEl;
      const items = Array.from(scope.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
        (el) => !(el as HTMLButtonElement).disabled && (scope === submenuRef.current || !submenuRef.current?.contains(el)),
      );
      if (!items.length) return;
      e.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLElement);
      let next = 0;
      if (e.key === "End") next = items.length - 1;
      else if (e.key === "ArrowDown") next = idx < 0 ? 0 : (idx + 1) % items.length;
      else if (e.key === "ArrowUp") next = idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length;
      items[next]?.focus();
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
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, projectsOpen, closeMenu]);

  useEffect(() => {
    if (!open) return;
    // Move focus into the menu so keyboard users land on the first item.
    const id = window.requestAnimationFrame(() => {
      const first = menuRef.current?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR);
      first?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!projectsOpen) return;
    const id = window.requestAnimationFrame(() => {
      const first = submenuRef.current?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR);
      first?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(id);
  }, [projectsOpen]);

  const repositionMenu = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();

    const margin = 8;
    const gap = 10;
    const width = MENU_WIDTH;

    let left = rect.right - width;
    left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));
    // The projects submenu opens to the left; flip it right when that would leave the viewport
    // (rows in the left sidebar).
    setSubmenuSide(left - SUBMENU_GAP - SUBMENU_WIDTH < margin ? "right" : "left");

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
    // Callers that don't know the doc's projects (e.g. rows listed from `/api/docs`) get the
    // membership looked up once, so the picker can show checkmarks and toggle a project off.
    if (!Array.isArray(currentProjectIds) && !currentProjectId && fetchedProjectIds === null) {
      void fetchJson<{ doc?: { projectIds?: string[] } }>(`/api/docs/${encodeURIComponent(docId)}?lite=1`, {
        method: "GET",
      })
        .then((r) => setFetchedProjectIds(Array.isArray(r?.doc?.projectIds) ? r.doc.projectIds : []))
        .catch(() => {
          // best-effort: without membership the picker still adds
        });
    }
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
      if (Array.isArray(res?.doc?.projectIds)) setFetchedProjectIds(res.doc.projectIds);
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
   * Archive or unarchive the doc. Un-archiving a shared doc can hit the Free document cap (402), which
   * opens the upgrade modal instead of an inline error.
   */
  async function setArchived(next: boolean) {
    if (archiveBusy) return;
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      const res = await fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isArchived: next }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
        const limitErr = res.status === 402 ? parsePlanLimitError(json) : null;
        if (limitErr) {
          // Un-archiving a shared doc counts against the Free document cap.
          closeMenu();
          openUpgrade(upsellKeyForLimit(limitErr.limit), {
            used: limitErr.used,
            max: limitErr.max,
            graceHint: planLimitGraceHint(limitErr),
          });
          return;
        }
        throw new Error(typeof json?.error === "string" && json.error ? json.error : `Request failed (${res.status})`);
      }
      if (next) notifyDocLeaving({ docId, reason: "archived" });
      onDocPatched?.({ isArchived: next });
      notifyDocsChanged();
      // Archiving affects project doc counts (active docs only).
      notifyProjectsChanged();
      // Archived docs don't count as shared documents on the Free plan.
      refreshPlan();
      closeMenu({ focusTrigger: false });
    } catch (e) {
      setArchiveError(e instanceof Error ? e.message : next ? "Failed to archive" : "Failed to unarchive");
    } finally {
      setArchiveBusy(false);
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
      notifyDocLeaving({ docId, reason: "deleted" });
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
    "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13px] text-[var(--fg)] hover:bg-[var(--panel-hover)] focus:outline-none focus-visible:bg-[var(--panel-hover)]";

  const disabledClass = disabled ? "cursor-not-allowed opacity-60 hover:bg-[var(--panel)]" : "";
  const selectedProjectIds = new Set(
    (Array.isArray(currentProjectIds) ? currentProjectIds : null) ??
      (currentProjectId ? [currentProjectId] : (fetchedProjectIds ?? [])),
  );

  const projectsPanel = (
    <div
      ref={submenuRef}
      role="menu"
      aria-label={projectsLabel}
      className={[
        "absolute top-0 z-50 w-[260px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-lg",
        submenuSide === "right" ? "left-[calc(100%+10px)]" : "right-[calc(100%+10px)]",
      ].join(" ")}
    >
      <ul className="max-h-[320px] overflow-auto py-1">
        <li>
          <button
            type="button"
            role="menuitem"
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
                role="menuitemcheckbox"
                aria-checked={selectedProjectIds.has(p.id)}
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
                        if (Array.isArray(r?.doc?.projectIds)) setFetchedProjectIds(r.doc.projectIds);
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

  const archiveLabel = isArchived ? "Unarchive" : "Archive";

  const renderedMenu =
    open && !disabled ? (
      <div
        ref={menuRef}
        role="menu"
        aria-label="Document actions"
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
              ref={projectsItemRef}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={projectsOpen}
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
                <span>{projectsLabel}</span>
              </span>
              <ChevronRightIcon className="h-4 w-4 text-[var(--muted-2)]" />
            </button>
            {projectsOpen ? projectsPanel : null}
          </li>

          {currentProjectId && showRemoveFromProject ? (
            <li>
              <button
                type="button"
                role="menuitem"
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

          {showArchive || SHOW_QUALITY_REVIEW || SHOW_REPORT || showDelete ? (
            <li className="my-1 h-px bg-[var(--border)]" role="separator" />
          ) : null}

          {SHOW_QUALITY_REVIEW ? (
            <li>
              <button
                type="button"
                role="menuitem"
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

          {showArchive ? (
            <li>
              <button
                type="button"
                role="menuitem"
                className={menuItemBase}
                disabled={archiveBusy}
                aria-disabled={archiveBusy}
                onClick={() => void setArchived(!isArchived)}
              >
                <span className="inline-flex items-center gap-2">
                  <span className="text-[var(--muted-2)]">
                    {isArchived ? (
                      <ArchiveBoxXMarkIcon className="h-4 w-4" />
                    ) : (
                      <ArchiveBoxIcon className="h-4 w-4" />
                    )}
                  </span>
                  <span>{archiveLabel}</span>
                </span>
                {archiveBusy ? <Spinner className="h-4 w-4 text-[var(--muted-2)]" /> : null}
              </button>
              {archiveError ? (
                <div className="px-3 pb-2 text-[12px] font-medium text-red-600" role="alert">
                  {archiveError}
                </div>
              ) : null}
            </li>
          ) : null}

          {SHOW_REPORT ? (
            <li>
              <button
                type="button"
                role="menuitem"
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
          {showDelete ? (
            <li>
              <button
                type="button"
                role="menuitem"
                className={[menuItemBase, "text-red-700 hover:bg-red-50"].join(" ")}
                onClick={() => {
                  closeMenu();
                  if (onRequestDelete) {
                    onRequestDelete();
                    return;
                  }
                  setShowDeleteConfirm(true);
                  setDeleteError(null);
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
          ) : null}
        </ul>
      </div>
    ) : null;

  const triggerClass =
    variant === "ghost"
      ? [
          // Same as the hover-revealed "..." on the sidebar "See more" modal rows.
          "inline-flex items-center justify-center rounded-lg p-1 text-[var(--muted-2)] transition-opacity hover:bg-[var(--panel)] hover:text-[var(--fg)]",
          "focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
          open ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        ].join(" ")
      : variant === "sidebar"
        ? [
            // Same as the "..." on left-sidebar project rows (`IconButton` ghost, xs).
            "inline-flex items-center justify-center rounded-md p-1 text-[var(--muted-2)] transition-opacity hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
            "focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
            open ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          ].join(" ")
        : [
            "inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors",
            "border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
          ].join(" ");

  /** Dialogs render at `document.body` so a transformed ancestor (a modal panel) can't trap them. */
  const portal = (node: React.ReactNode) =>
    typeof document !== "undefined" ? createPortal(node, document.body) : null;

  return (
    <div
      ref={rootRef}
      // No positioning of its own: the menu and dialogs are portals, so callers may place this freely.
      className={className}
      // Rows hosting this menu are usually clickable links. React bubbles events from the portals
      // up through this element, so stop clicks and Enter/Space here instead of in every caller.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") e.stopPropagation();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-disabled={disabled}
        className={[triggerClass, disabledClass].join(" ")}
        aria-label="Document actions"
        title="Document actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          if (disabled) return;
          // Compute position immediately so the menu never renders "invisible".
          repositionMenu();
          setOpen((v) => {
            const next = !v;
            if (next) {
              setProjectsOpen(false);
              setArchiveError(null);
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

      {renderedMenu ? portal(renderedMenu) : null}

      {showNewProject
        ? portal(
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
          )
        : null}

      {showReport
        ? portal(
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
          )
        : null}

      {showDeleteConfirm
        ? portal(
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
          )
        : null}
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





