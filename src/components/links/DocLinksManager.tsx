/**
 * DocLinksManager — the one place that owns a document's share links (docs/prds/lnkdrp-multi-links.md).
 *
 * Moved out of `DocSharePanel` so link management has a home of its own: the doc side panel keeps a
 * compact summary (`variant="panel"`), the dedicated `/doc/:docId/links` page renders the full list
 * (`variant="page"`). Both share the same data and the same mutations — the fetch of
 * `GET /api/docs/:docId/links`, per-link unique-viewer counts, create/edit through `ShareLinkModal`,
 * enable/disable, delete behind an inline confirm, copy, the `share_link.*` realtime refetch and the
 * `planWarning` upgrade prompt.
 */
"use client";

import Link from "next/link";
import {
  ArrowDownTrayIcon,
  CalendarDaysIcon,
  ChartBarIcon,
  ClockIcon,
  EllipsisHorizontalIcon,
  LinkIcon,
  LockClosedIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { CopyButton } from "@/components/CopyButton";
import ShareLinkModal, { type ShareLinkFormValues } from "@/components/modals/ShareLinkModal";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { subscribeRealtime } from "@/lib/client/realtime";
import { refreshPlan, usePlan } from "@/lib/client/usePlan";
import { fetchJson } from "@/lib/http/fetchJson";
import { awaitingFirstOpen } from "@/lib/analytics/reading";
import { formatRelative } from "@/lib/analytics/reading/format";
import { buildPublicShareUrl } from "@/lib/urls";
import type { ShareLinkDTO } from "@/lib/share/links";

/** `planWarning` from the links API: the Free-cap state behind the upgrade prompt. */
type LinkPlanWarning = { limit?: string; used?: number; max?: number } | null;
type LinkMutationResponse = { link: ShareLinkDTO; planWarning?: LinkPlanWarning };

/** Lets a page header's "New link" button open the create modal this component owns. */
export type DocLinksManagerHandle = { openCreate: () => void };

type Props = {
  docId: string;
  /** `panel` = compact summary for the doc side rail; `page` = the full list. */
  variant: "panel" | "page";
  /**
   * Override for "may edit links". Normally left unset: the role comes from the workspace plan
   * snapshot, so no call site can forget it and hand a viewer controls the server will refuse
   * (mt_j7nN3wG65Q — both call sites used to omit it, and the default was `true`).
   */
  canManage?: boolean;
};

/** "12 Sep 2026" for an expiry date. */
function formatDate(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date(ms));
}

/** A link's state from its own fields, the same precedence as the reading analytics' `linkStatus`. */
function linkStatusOf(l: Pick<ShareLinkDTO, "status" | "enabled" | "expiresAt">): ShareLinkDTO["status"] {
  if (l.status === "archived") return "archived";
  if (!l.enabled) return "disabled";
  if (l.expiresAt && Date.parse(l.expiresAt) <= Date.now()) return "expired";
  return "active";
}

const LINK_STATUS_PILL: Record<ShareLinkDTO["status"], { label: string; className: string }> = {
  active: {
    label: "Active",
    className: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-0",
  },
  disabled: {
    label: "Disabled",
    className: "bg-[var(--panel)] text-[var(--muted)] ring-[var(--border)]",
  },
  expired: {
    label: "Expired",
    className: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-0",
  },
  archived: {
    label: "Deleted",
    className: "bg-[var(--panel)] text-[var(--muted-2)] ring-[var(--border)]",
  },
};

const LINK_ACTION_CLASS =
  "rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--fg)] transition-colors hover:bg-[var(--panel-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-50";

const NEW_LINK_CLASS =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 text-[12px] font-semibold text-[var(--fg)] shadow-sm transition-colors hover:bg-[var(--panel-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]";

const ROW_MENU_WIDTH = 200;

type RowMenuItem = {
  label: string;
  onSelect: () => void;
  /** Extra line under the label, for the action whose consequence is not obvious from its name. */
  hint?: string;
  destructive?: boolean;
};

/**
 * The "⋯" at the end of a link row, holding the management actions that used to be laid out as
 * buttons — five per row on a `min-w-[980px]` table inside `overflow-x-auto`, so the last one,
 * Delete, was cut off rather than wrapped, and "Make default" wrapping to two lines made the
 * default row and the others come out different heights.
 *
 * Rendered through a portal with `position: fixed`, the same way `DocActionsMenu` does it: an
 * absolutely-positioned menu inside the scroll container would be clipped by the very overflow
 * that caused the problem. Opens below the button, right-aligned to it, and flips above when the
 * viewport ends first.
 *
 * Nothing destructive completes in here. Delete only *starts* the row's existing inline confirm
 * ("Delete? / Delete / Cancel"), so a mis-click in a popover cannot remove a link that has analytics.
 */
function RowMenu({ label, items, disabled }: { label: string; items: RowMenuItem[]; disabled?: boolean }) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const reposition = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    const left = Math.max(margin, Math.min(window.innerWidth - ROW_MENU_WIDTH - margin, rect.right - ROW_MENU_WIDTH));
    const measuredH = menuRef.current?.getBoundingClientRect().height ?? 160;
    let top = rect.bottom + gap;
    if (top + measuredH + margin > window.innerHeight) top = Math.max(margin, rect.top - gap - measuredH);
    setPos({ top, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    // Position after paint so the menu can be measured, then the first item takes focus so the
    // keyboard path works: Escape closes, Tab moves through the items, Enter picks.
    window.requestAnimationFrame(() => {
      reposition();
      menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (buttonRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, reposition]);

  const menu = open ? (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: ROW_MENU_WIDTH }}
      className="fixed z-[1000] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] p-1 shadow-lg"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            item.onSelect();
          }}
          className={[
            "block w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors focus:outline-none focus-visible:bg-[var(--panel-hover)] hover:bg-[var(--panel-hover)]",
            item.destructive ? "text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40" : "text-[var(--fg)]",
          ].join(" ")}
        >
          <span className="block font-medium">{item.label}</span>
          {item.hint ? <span className="block text-[11px] leading-4 text-[var(--muted)]">{item.hint}</span> : null}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
        className={`${LINK_ACTION_CLASS} inline-flex h-[30px] w-[30px] items-center justify-center px-0!`}
      >
        <EllipsisHorizontalIcon className="h-4 w-4" aria-hidden="true" />
      </button>
      {menu && typeof document !== "undefined" ? createPortal(menu, document.body) : null}
    </>
  );
}

/** One "Label · value" cell of the settings summary row. */
/**
 * One part of the panel's "what does this link do" line. A setting still at its default reads as
 * plain words ("View only"); one that was changed from it is a pill, so a password or an expiry
 * stands out at a glance instead of sitting in a row of identical label/value pairs.
 */
function LinkStatePart({ children, changed, tone, title }: { children: React.ReactNode; changed: boolean; tone?: "warn"; title?: string }) {
  if (!changed) {
    return (
      <span className="whitespace-nowrap" title={title}>
        {children}
      </span>
    );
  }
  return (
    <span
      title={title}
      className={
        tone === "warn"
          ? "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-300"
          : "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[var(--border)] bg-[var(--panel)] px-2 py-0.5 font-medium text-[var(--fg)]"
      }
    >
      {children}
    </span>
  );
}

/**
 * The analytics window the per-link numbers are *requested* for.
 *
 * Never printed: the server clamps it by plan (`clampAnalyticsDays`; Free is 7 days) and reports
 * the window it actually served as `days`. The headers used to hardcode "(30d)" from this
 * constant, so a Free workspace read a table headed "Views (30d)" over seven days of data and a
 * link that was busy ten days ago looked dead.
 */
const LINK_STATS_DAYS = 30;

/**
 * Rows per page of the full links table. A document can carry hundreds of links (the runaway
 * guard is 50 today and is meant to move, not stay); this is the number that keeps the table a
 * table instead of a scroll of a thousand rows. The panel variant uses the same size for its one
 * fetch, purely to give `ShareLinkModal`'s "copy settings from" list something to draw from — the
 * panel itself never renders more than the default link.
 */
const LINKS_PAGE_SIZE = 25;

const DocLinksManager = forwardRef<DocLinksManagerHandle, Props>(function DocLinksManager(
  { docId, variant, canManage: canManageProp },
  ref,
) {
  const { openUpgrade } = useUpgradeModal();
  const { plan } = usePlan();
  const isFreePlan = plan?.plan === "free";
  // Fail closed while the snapshot loads: a viewer must never see a manage control, and the plan
  // is memoised across components, so a warm cache means no flash for the owner.
  const canManage = canManageProp ?? plan?.canManageLinks ?? false;
  const canRevealPassword = plan?.canRevealPassword ?? false;

  /**
   * The metrics page, already scoped to one link. `?shareId=` is the metrics page's own filter, so
   * the destination opens showing this link's numbers rather than the document's, and the address
   * can be bookmarked or sent to someone.
   */
  function metricsHref(shareId: string): string {
    return `/doc/${encodeURIComponent(docId)}/metrics?shareId=${encodeURIComponent(shareId)}`;
  }

  const [links, setLinks] = useState<ShareLinkDTO[] | null>(null);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [linksRev, setLinksRev] = useState(0);
  /** 1-based; only the page table ever moves this off 1. */
  const [linksPage, setLinksPage] = useState(1);
  /** From the paginated response — the true count, never `links.length` once there is more than one page. */
  const [linksTotal, setLinksTotal] = useState<number | null>(null);
  const [linkStats, setLinkStats] = useState<
    Record<string, { viewers: number; downloads: number; lastViewedAt: string | null }>
  >({});
  /** The window the server served (plan-clamped), used verbatim in the column headings. */
  const [statsDays, setStatsDays] = useState<number | null>(null);
  /** Panel only: the default link's viewers over the served analytics window. */
  const [panelViewers, setPanelViewers] = useState<{ viewers: number; days: number | null; lastViewedAt: string | null } | null>(null);
  /**
   * Traffic on links this table cannot show: slugs the analytics still carry but no live link row
   * owns — deleted links, whose rows stay in the document's totals by design. Without this row the
   * table quietly fails to add up to the document's figures, and the only surface that used to
   * explain the gap (the compare table on the metrics page) is gone at the owner's request. This
   * is now the one place that says so.
   */
  const [deletedLinkResidual, setDeletedLinkResidual] = useState<{ count: number; viewers: number; downloads: number } | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [linkModal, setLinkModal] = useState<{ mode: "create" } | { mode: "edit"; link: ShareLinkDTO } | null>(null);
  const [linkSaving, setLinkSaving] = useState(false);
  const [linkModalError, setLinkModalError] = useState<string | null>(null);

  const refreshLinks = useCallback(() => setLinksRev((r) => r + 1), []);

  const openCreate = useCallback(() => {
    setLinkModalError(null);
    setLinkModal({ mode: "create" });
  }, []);

  useImperativeHandle(ref, () => ({ openCreate }), [openCreate]);

  // The doc changed out from under this instance (a different document's manager reusing the
  // component): start back at page 1 rather than asking for a page that may not exist there.
  useEffect(() => setLinksPage(1), [docId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchJson<{ total: number; page: number; limit: number; links: ShareLinkDTO[] }>(
          `/api/docs/${encodeURIComponent(docId)}/links?page=${linksPage}&limit=${LINKS_PAGE_SIZE}`,
          { cache: "no-store" },
        );
        if (cancelled) return;
        setLinks(Array.isArray(res.links) ? res.links : []);
        setLinksTotal(typeof res.total === "number" ? res.total : null);
        setLinksError(null);
        // A mutation (delete, archive) can leave `linksPage` past the new last page — most visibly
        // when someone deletes the only link on the last page. Clamp back rather than showing an
        // table that looks like the link count went to zero.
        const lastPage = Math.max(1, Math.ceil((res.total ?? 0) / (res.limit || LINKS_PAGE_SIZE)));
        if (linksPage > lastPage) setLinksPage(lastPage);
      } catch (e) {
        if (!cancelled) setLinksError(e instanceof Error ? e.message : "Failed to load links");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, linksRev, linksPage]);

  // Agents and other sessions create links too: `share_link.*` activity frames refetch the list.
  useEffect(
    () =>
      subscribeRealtime("activity", (f) => {
        if (f.type !== "activity") return;
        if (typeof f.event.type === "string" && f.event.type.startsWith("share_link.")) refreshLinks();
      }),
    [refreshLinks],
  );

  // Views, viewers and downloads all come from the analytics window — one request for the whole
  // table (`?byLink=1`), grouped by link slug server-side.
  //
  // The counters on the link row (`viewCount`, `downloadCount`) only started counting when links
  // shipped, so on a document with older traffic they disagree with the analytics — a card would
  // read "Views 1 · Viewers 18", which is nonsense. One source keeps the numbers coherent, and
  // when the request fails the cells say "—" rather than quietly swapping in a lifetime counter.
  //
  // It used to be one request per link, capped at 8: link 9 onwards then fell back to those
  // counters and printed "—" for viewers forever, so a busy link that happened to sort last read
  // as a dead one. One request has no cap to hit.
  useEffect(() => {
    if (variant !== "page") return;
    if (!links?.length) return;
    let cancelled = false;
    void (async () => {
      try {
        // `shareIds` scopes the byLink rows to exactly this page's links, so the request stays
        // cheap and its size stays flat no matter how many links the document has in total; the
        // orphan summary (`deletedLinkResidual`) is document-wide regardless — the server computes
        // it as one row, never as a list, so asking for it costs nothing proportional to link count.
        const shareIds = links.map((l) => l.shareId).filter(Boolean).join(",");
        const res = await fetchJson<{
          days?: number;
          byLink?: Array<{ shareId?: string; views?: number; viewers?: number; downloads?: number; lastViewedAt?: string | null }>;
          deletedLinkResidual?: { count: number; viewers: number; downloads: number } | null;
        }>(
          `/api/docs/${encodeURIComponent(docId)}/shareviews?days=${LINK_STATS_DAYS}&lite=1&byLink=1&shareIds=${encodeURIComponent(shareIds)}`,
          { cache: "no-store" },
        );
        if (cancelled) return;
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
        const bySlug = new Map((res.byLink ?? []).map((r) => [String(r.shareId ?? ""), r]));
        // The window the server actually served, not the one we asked for.
        setStatsDays(n(res.days) || null);
        setDeletedLinkResidual(res.deletedLinkResidual ?? null);
        setLinkStats(() => {
          const next: Record<string, { viewers: number; downloads: number; lastViewedAt: string | null }> = {};
          for (const l of links) {
            const row = bySlug.get(l.shareId);
            next[l.id] = {
              viewers: n(row?.viewers),
              downloads: n(row?.downloads),
              lastViewedAt: typeof row?.lastViewedAt === "string" ? row.lastViewedAt : null,
            };
          }
          return next;
        });
      } catch {
        // the row counters stay as the fallback
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, links, variant]);

  // Panel: the same analytics source as the table, for the default link alone, so the number next
  // to "Analytics" agrees with the Links page and the metrics page it opens.
  const panelShareId = variant === "panel" ? (links?.find((l) => l.isDefault) ?? links?.[0])?.shareId ?? null : null;
  useEffect(() => {
    if (!panelShareId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchJson<{ days?: number; byLink?: Array<{ shareId?: string; viewers?: number; lastViewedAt?: string | null }> }>(
          `/api/docs/${encodeURIComponent(docId)}/shareviews?days=${LINK_STATS_DAYS}&lite=1&byLink=1&shareIds=${encodeURIComponent(panelShareId)}`,
          { cache: "no-store" },
        );
        if (cancelled) return;
        const row = (res.byLink ?? []).find((r) => r.shareId === panelShareId);
        const viewers = typeof row?.viewers === "number" && Number.isFinite(row.viewers) ? Math.max(0, Math.floor(row.viewers)) : 0;
        setPanelViewers({
          viewers,
          days: typeof res.days === "number" && res.days > 0 ? Math.floor(res.days) : null,
          lastViewedAt: typeof row?.lastViewedAt === "string" ? row.lastViewedAt : null,
        });
      } catch {
        if (!cancelled) setPanelViewers(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, panelShareId]);


  /** Default link first, then the rest in the order the API returned them. */
  const ordered = useMemo(() => {
    if (!links) return null;
    return [...links].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  }, [links]);

  const defaultLink = useMemo(
    () => (links ? (links.find((l) => l.isDefault) ?? links[0] ?? null) : null),
    [links],
  );

  /** Back to page 1 after an action that reorders the table (a new link, or a new default) — the
   * result is at the top, so a person is looking at the right page without hunting for it. */
  const jumpToFirstPage = useCallback(() => setLinksPage(1), []);

  /** At (or inside the grace window of) the Free cap: show the standard upgrade prompt. */
  function handlePlanWarning(warning: LinkPlanWarning | undefined) {
    if (!warning) return;
    openUpgrade("documents", { used: warning.used, max: warning.max });
  }

  /** Copy one link's public URL and flash the check icon on that row. */
  async function copyLinkUrl(link: ShareLinkDTO) {
    const url = buildPublicShareUrl(link.shareId);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLinkId(link.id);
      window.setTimeout(() => setCopiedLinkId((c) => (c === link.id ? null : c)), 1200);
    } catch {
      // clipboard blocked: the URL stays selectable in the row
    }
  }

  /** Enable or disable one link (enabling re-checks the Free cap server-side). */
  async function setLinkEnabled(link: ShareLinkDTO, enabled: boolean) {
    setRowBusyId(link.id);
    setLinksError(null);
    try {
      const res = await fetchJson<LinkMutationResponse>(
        `/api/docs/${encodeURIComponent(docId)}/links/${encodeURIComponent(link.id)}`,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) },
      );
      handlePlanWarning(res?.planWarning);
      refreshLinks();
      refreshPlan();
    } catch (e) {
      setLinksError(e instanceof Error ? e.message : "Failed to update the link");
    } finally {
      setRowBusyId(null);
    }
  }

  /**
   * Promote a link to the document's default: it becomes the one the side panel shows and the one
   * `Doc.shareId` points at. The old default keeps its URL and its stats, and becomes deletable.
   */
  async function makeDefault(link: ShareLinkDTO) {
    setRowBusyId(link.id);
    setLinksError(null);
    try {
      await fetchJson<LinkMutationResponse>(`/api/docs/${encodeURIComponent(docId)}/links/${encodeURIComponent(link.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isDefault: true }),
      });
      jumpToFirstPage();
      refreshLinks();
    } catch (e) {
      setLinksError(e instanceof Error ? e.message : "Failed to set the default link");
    } finally {
      setRowBusyId(null);
    }
  }

  /** Delete (soft-archive) a link; its stats stay. The default link cannot be deleted. */
  async function deleteLink(link: ShareLinkDTO) {
    setRowBusyId(link.id);
    setLinksError(null);
    try {
      await fetchJson<null>(`/api/docs/${encodeURIComponent(docId)}/links/${encodeURIComponent(link.id)}`, {
        method: "DELETE",
      });
      setConfirmDeleteId(null);
      refreshLinks();
      refreshPlan();
    } catch (e) {
      setLinksError(e instanceof Error ? e.message : "Failed to delete the link");
    } finally {
      setRowBusyId(null);
    }
  }

  /** Create or save the link the modal is editing. */
  async function submitLinkModal(values: ShareLinkFormValues) {
    if (!linkModal) return;
    setLinkSaving(true);
    setLinkModalError(null);
    try {
      const editing = linkModal.mode === "edit" ? linkModal.link : null;
      const res = await fetchJson<LinkMutationResponse>(
        editing
          ? `/api/docs/${encodeURIComponent(docId)}/links/${encodeURIComponent(editing.id)}`
          : `/api/docs/${encodeURIComponent(docId)}/links`,
        {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(values),
        },
      );
      setLinkModal(null);
      handlePlanWarning(res?.planWarning);
      // A new link lands right after the default on page 1 (default-first, then newest); an edit
      // does not move anything, so only creating jumps the page.
      if (!editing) jumpToFirstPage();
      refreshLinks();
      refreshPlan();
    } catch (e) {
      setLinkModalError(e instanceof Error ? e.message : "Failed to save the link");
    } finally {
      setLinkSaving(false);
    }
  }

  const modal = (
    <ShareLinkModal
      canRevealPassword={canRevealPassword}
      open={Boolean(linkModal)}
      mode={linkModal?.mode ?? "create"}
      link={linkModal?.mode === "edit" ? linkModal.link : null}
      links={links ?? []}
      saving={linkSaving}
      error={linkModalError}
      showProPill={isFreePlan}
      onProPillClick={() => openUpgrade("version_history")}
      onClose={() => {
        setLinkModal(null);
        setLinkModalError(null);
      }}
      onSubmit={(values) => void submitLinkModal(values)}
    />
  );

  // --- Panel: the default link, the count, and a way out to the page -------------------------
  if (variant === "panel") {
    const defaultUrl = defaultLink ? buildPublicShareUrl(defaultLink.shareId) : "";
    // The true count, not `links.length`: this fetch is capped at `LINKS_PAGE_SIZE` like every
    // other, so `links.length` alone under-counts a document with more links than that.
    const count = linksTotal ?? links?.length ?? 0;

    return (
      // Same card as the quick-stats and snapshot sections below it: bordered, rounded, on
      // --panel-2. Before this the links block was bare text at the top of the panel and read as
      // floating above two properly framed sections.
      // `@container`: the side panel is ~300px wide on a laptop and much wider on a big screen, so
      // the header sizes itself to this card, not to the window.
      <div className="@container rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-5 py-4">
        <div className="mb-3 flex items-center justify-between gap-3 border-b border-[var(--divider)] pb-3">
          <div className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
            <LinkIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
            <span className="truncate">Default link</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* The one way to the Links page. It used to be said three times ("· 2 total",
                "1 other link", "View all links"); the count is the link. */}
            {count > 1 ? (
              <Link
                href={`/doc/${encodeURIComponent(docId)}/links`}
                className="inline-flex h-8 items-center rounded-lg px-2 text-[12px] font-semibold text-[var(--muted)] transition-colors hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
              >
                {count} links →
              </Link>
            ) : null}
            {canManage ? (
              <button type="button" onClick={openCreate} className={NEW_LINK_CLASS} aria-label="New link" title="New link">
                <PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
                {/* Icon-only in a narrow card, so "Default link" isn't cut off. */}
                <span className="hidden @sm:inline">New link</span>
              </button>
            ) : null}
          </div>
        </div>

        <div className="flex items-stretch gap-2">
          <input
            value={defaultUrl || (links === null ? "Loading…" : "Generating link…")}
            readOnly
            className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 text-[13px] font-medium text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !defaultLink) return;
              e.preventDefault();
              void copyLinkUrl(defaultLink);
            }}
            aria-label="Share link"
          />
          <CopyButton
            copyDone={Boolean(defaultLink && copiedLinkId === defaultLink.id)}
            disabled={!defaultUrl}
            onCopy={() => {
              if (defaultLink) void copyLinkUrl(defaultLink);
            }}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--primary-bg)] text-[var(--primary-fg)] shadow-sm transition-colors duration-150 hover:bg-[var(--primary-hover-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--primary-ring)] focus:ring-offset-2 focus:ring-offset-[var(--panel)] disabled:opacity-50"
            copyAriaLabel="Copy link"
            copiedAriaLabel="Copied"
          />
        </div>

        {/* One line that answers "what does this link do?": the recipient's experience on the left
            (changed settings as pills), its numbers and the edit action on the right. */}
        {defaultLink ? (
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-[12px] text-[var(--muted)]">
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
              {(() => {
                const expiresLabel = formatDate(defaultLink.expiresAt);
                const expired = Boolean(defaultLink.expiresAt && Date.parse(defaultLink.expiresAt) <= Date.now());
                const parts = [
                  <LinkStatePart
                    key="download"
                    changed={defaultLink.allowDownload}
                    title={
                      defaultLink.allowDownload
                        ? "Recipients can download the PDF."
                        : "Downloads are off: recipients can view the PDF but not download it."
                    }
                  >
                    {defaultLink.allowDownload ? (
                      <>
                        <ArrowDownTrayIcon className="h-3 w-3" aria-hidden="true" />
                        Downloads on
                      </>
                    ) : (
                      "View only"
                    )}
                  </LinkStatePart>,
                  defaultLink.passwordEnabled && canRevealPassword ? (
                    // Knowing a password exists is half the answer: the link's settings can show
                    // it (Show in the edit modal), so the pill opens them. Gated on the reveal
                    // permission, not on `canManage` — a member may edit the link but not read its
                    // password back, and a pill that opens a refusal is worse than a plain label.
                    <button
                      key="password"
                      type="button"
                      onClick={() => setLinkModal({ mode: "edit", link: defaultLink })}
                      className="rounded-full focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                    >
                      <LinkStatePart changed title="Recipients need a password to open it. Click to see or change it.">
                        <LockClosedIcon className="h-3 w-3" aria-hidden="true" />
                        Password
                      </LinkStatePart>
                    </button>
                  ) : (
                    <LinkStatePart key="password" changed={defaultLink.passwordEnabled} title={defaultLink.passwordEnabled ? "Recipients need a password to open it." : undefined}>
                      {defaultLink.passwordEnabled ? (
                        <>
                          <LockClosedIcon className="h-3 w-3" aria-hidden="true" />
                          Password
                        </>
                      ) : (
                        "No password"
                      )}
                    </LinkStatePart>
                  ),
                  <LinkStatePart key="expires" changed={Boolean(expiresLabel)} tone={expired ? "warn" : undefined}>
                    {expiresLabel ? (
                      <>
                        <CalendarDaysIcon className="h-3 w-3" aria-hidden="true" />
                        {expired ? `Expired ${expiresLabel}` : `Expires ${expiresLabel}`}
                      </>
                    ) : (
                      "Never expires"
                    )}
                  </LinkStatePart>,
                ];
                // Version history is only worth a word when it is on; off is the default and
                // restricts nothing a recipient would notice.
                if (defaultLink.allowRevisionHistory) {
                  parts.push(
                    <LinkStatePart key="history" changed title="Recipients can browse earlier versions.">
                      <ClockIcon className="h-3 w-3" aria-hidden="true" />
                      Version history
                    </LinkStatePart>,
                  );
                }
                return parts.flatMap((part, i) =>
                  i === 0
                    ? [part]
                    : [
                        <span key={`dot-${i}`} aria-hidden="true" className="text-[var(--muted-2)]">
                          ·
                        </span>,
                        part,
                      ],
                );
              })()}
            </div>
            <div className="flex shrink-0 items-center gap-x-3">
              {/* The default link's own numbers: on a one-link document this is the only per-link
                  route on the page. */}
              <Link
                href={metricsHref(defaultLink.shareId)}
                className="inline-flex items-center gap-1 font-semibold text-[var(--fg)] underline-offset-4 hover:underline"
                title={panelViewers?.days ? `People on this link in the last ${panelViewers.days} days` : "Analytics for this link"}
              >
                <ChartBarIcon className="h-3.5 w-3.5 text-[var(--muted)]" aria-hidden="true" />
                {/* The window is in the badge: the Analytics card below counts a different scope, and a
                    bare "1 person" read as contradicting it. */}
                {/* "Not opened yet" follows the metrics page rule: an unused default link beside other
                    links is not waiting on anyone, and the Analytics card's not-opened count leaves it out. */}
                {panelViewers
                  ? panelViewers.viewers === 0 &&
                    awaitingFirstOpen(
                      {
                        shareId: defaultLink.shareId,
                        isDefault: defaultLink.isDefault,
                        status: linkStatusOf(defaultLink),
                        everOpened: Boolean(panelViewers.lastViewedAt ?? defaultLink.lastViewedAt),
                      },
                      (links ?? []).map((l) => ({ shareId: l.shareId, status: linkStatusOf(l) })),
                    )
                    ? "Not opened yet"
                    : `${panelViewers.viewers} ${panelViewers.viewers === 1 ? "person" : "people"} · ${panelViewers.days ?? LINK_STATS_DAYS} days`
                  : "Analytics"}
              </Link>
              {canManage ? (
                <button
                  type="button"
                  onClick={() => setLinkModal({ mode: "edit", link: defaultLink })}
                  className="font-semibold text-[var(--fg)] underline-offset-4 hover:underline"
                >
                  Edit
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {linksError ? <div className="mt-2 text-[12px] font-medium text-red-700">{linksError}</div> : null}

        {/* a11y: announce copy state */}
        <div className="sr-only" aria-live="polite">
          {copiedLinkId ? "Copied to clipboard" : ""}
        </div>

        {modal}
      </div>
    );
  }

  // --- Page: a table of every link ---------------------------------------------------------------
  return (
    <div>
      {linksError ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800 dark:border-red-300/30 dark:bg-red-400/10 dark:text-red-200">
          {linksError}
        </div>
      ) : null}

      {/* The window the SERVER served (Free is clamped to 7 days), named once for the whole table;
          blank until the stats land, never a guess. */}
      <div className="mb-2 min-h-[16px] text-[12px] leading-4 text-[var(--muted)]">{statsDays ? `Last ${statsDays} days` : null}</div>

      {/* A table, not cards: a document can carry dozens of links, and the useful comparison is
          across rows — who opened what, which are still open. Thin rows, full width, and the
          settings collapse to icons so a row stays on one line. */}
      <div className="relative overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]">
        <table className="w-full min-w-[980px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
              <th scope="col" className="px-4 py-2.5 font-semibold">Link</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Address</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Status</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Settings</th>
              {/* Both cover the window named in the caption above the table.
                  There is no separate "Views" column: a `ShareView` row is unique per (link,
                  viewer) for life, so the per-link view count and the per-link viewer count are
                  the same number by construction, and printing both invited the reader to compare
                  them. */}
              <th scope="col" className="px-3 py-2.5 text-right font-semibold">People</th>
              <th scope="col" className="px-3 py-2.5 text-right font-semibold">Downloads</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Last opened</th>
              <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ordered === null ? (
              [0, 1, 2].map((i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  <td colSpan={8} className="px-4 py-3">
                    <div className="h-4 w-full animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                  </td>
                </tr>
              ))
            ) : ordered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center">
                  <div className="text-sm font-semibold text-[var(--fg)]">No links yet</div>
                  <div className="mx-auto mt-1 max-w-sm text-[13px] text-[var(--muted)]">
                    Create one link per audience — each keeps its own settings and its own stats.
                  </div>
                  {canManage ? (
                    <button type="button" onClick={openCreate} className={`${NEW_LINK_CLASS} mt-4`}>
                      <PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
                      New link
                    </button>
                  ) : null}
                </td>
              </tr>
            ) : (
              ordered.map((link) => {
                const pill = LINK_STATUS_PILL[link.status] ?? LINK_STATUS_PILL.disabled;
                const stats = linkStats[link.id];
                const busy = rowBusyId === link.id;
                const confirming = confirmDeleteId === link.id;
                const url = buildPublicShareUrl(link.shareId) || `/s/${link.shareId}`;
                const expires = formatDate(link.expiresAt);

                return (
                  <tr
                    key={link.id}
                    className={[
                      "border-b border-[var(--border)] align-middle last:border-0 hover:bg-[var(--panel-hover)]",
                      link.status === "active" ? "" : "text-[var(--muted)]",
                    ].join(" ")}
                  >
                    <td className="max-w-[260px] px-4 py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium text-[var(--fg)]">{link.label}</span>
                        {link.isDefault ? (
                          <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted-2)] ring-1 ring-inset ring-[var(--border)]">
                            Default
                          </span>
                        ) : null}
                      </div>
                      {link.audience ? <div className="truncate text-[12px] text-[var(--muted)]">{link.audience}</div> : null}
                    </td>

                    <td className="max-w-[280px] px-3 py-2.5">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-mono text-[12px] text-[var(--muted)]" title={url}>
                          /s/{link.shareId}
                        </span>
                        <CopyButton
                          copyDone={copiedLinkId === link.id}
                          onCopy={() => void copyLinkUrl(link)}
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted)] transition-colors hover:bg-[var(--panel-2)] hover:text-[var(--fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                          copyAriaLabel={`Copy the link for ${link.label}`}
                          copiedAriaLabel="Copied"
                        />
                      </div>
                    </td>

                    <td className="px-3 py-2.5">
                      <span
                        className={[
                          "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset",
                          pill.className,
                        ].join(" ")}
                      >
                        {pill.label}
                      </span>
                    </td>

                    {/* Icons, not words: four settings spelled out would push the row onto two lines. */}
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-[var(--muted)]">
                        {link.allowDownload ? <ArrowDownTrayIcon className="h-4 w-4" title="Downloads allowed" /> : null}
                        {link.passwordEnabled ? <LockClosedIcon className="h-4 w-4" title="Password protected" /> : null}
                        {link.allowRevisionHistory ? <ClockIcon className="h-4 w-4" title="Recipients can browse versions" /> : null}
                        {expires ? <CalendarDaysIcon className="h-4 w-4" title={`Expires ${expires}`} /> : null}
                        {!link.allowDownload && !link.passwordEnabled && !link.allowRevisionHistory && !expires ? (
                          <span className="text-[12px] text-[var(--muted-2)]">—</span>
                        ) : null}
                      </div>
                    </td>

                    {/* "—" when the analytics request failed, never `link.viewCount` /
                        `link.downloadCount`: those are all-time counters, and printing them under a
                        windowed heading put two different quantities in one column depending on
                        whether a fetch happened to succeed.

                        Both numbers link into the metrics page already scoped to this link. They
                        are the most clickable-looking things on the row and they used to do
                        nothing: a reader who wanted to know who those 18 viewers were had to guess
                        that the answer lived on a different page, behind an unfiltered table, and
                        that clicking a link's name there would narrow it. */}
                    <td className="px-3 py-2.5 text-right tabular-nums text-[var(--fg)]">
                      {stats ? (
                        <Link
                          href={metricsHref(link.shareId)}
                          className="underline-offset-2 hover:underline"
                        >
                          {stats.viewers.toLocaleString()}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-[var(--fg)]">
                      {stats ? (
                        <Link
                          href={metricsHref(link.shareId)}
                          className="underline-offset-2 hover:underline"
                        >
                          {stats.downloads.toLocaleString()}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    {/* Prefer the analytics timestamp (newest row activity on this link) over the
                        link row's own `lastViewedAt`, which only started moving when links shipped:
                        a link that adopted a document's older traffic printed "Never" next to a
                        non-zero Views cell, and readers took "Never" as the authoritative one. */}
                    {(() => {
                      const lastIso = stats?.lastViewedAt ?? link.lastViewedAt;
                      const lastMs = lastIso ? Date.parse(lastIso) : NaN;
                      return (
                        <td
                          className="whitespace-nowrap px-3 py-2.5 text-[var(--muted)]"
                          title={Number.isFinite(lastMs) ? new Date(lastMs).toLocaleString() : undefined}
                        >
                          {Number.isFinite(lastMs) ? formatRelative(lastMs, Date.now()) : "Not opened yet"}
                        </td>
                      );
                    })()}

                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* First, and present whatever the row's state or the reader's role: seeing
                            how a link performed is the thing people come to this table for, and it
                            was the one thing the table did not offer. The numbers in the Viewers and
                            Downloads columns link to the same place, but an underlined number is not
                            a control anybody reads as "analytics" — this is the labelled version of
                            that path, and it is why the complaint was "I still don't see the link". */}
                        {/* The confirm beat takes the whole cell, Analytics included. Squeezed in
                            beside the other controls it was wider than Analytics · Edit · ⋯ and
                            reflowed every column header onto two lines for as long as the question
                            stood; on its own it fits in the same space. */}
                        {confirming ? null : (
                          <Link
                            href={metricsHref(link.shareId)}
                            className={`${LINK_ACTION_CLASS} inline-flex items-center gap-1.5`}
                            title={`Views, viewers and time on page for ${link.label}`}
                          >
                            <ChartBarIcon className="h-3.5 w-3.5 text-[var(--muted)]" aria-hidden="true" />
                            Analytics
                          </Link>
                        )}
                        {/* A hairline, so the read action does not read as the third management
                            button. It is also the only control here carrying an icon; keep it that way. */}
                        {canManage && !confirming ? <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-[var(--border)]" /> : null}
                        {!canManage ? null : confirming ? (
                          <>
                            <span className="whitespace-nowrap text-[12px] text-[var(--muted)]">Delete?</span>
                            <button type="button" disabled={busy} onClick={() => void deleteLink(link)} className={LINK_ACTION_CLASS}>
                              {busy ? "Deleting…" : "Delete"}
                            </button>
                            <button type="button" disabled={busy} onClick={() => setConfirmDeleteId(null)} className={LINK_ACTION_CLASS}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            {/* Edit stays a button: it is the management action people reach for in
                                a normal sitting, and the modal it opens is where every other setting
                                lives. The rest go behind "⋯" — every row then has the same two
                                controls and the same height, whether or not it is the default. */}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setLinkModalError(null);
                                setLinkModal({ mode: "edit", link });
                              }}
                              className={LINK_ACTION_CLASS}
                            >
                              {busy ? "Saving…" : "Edit"}
                            </button>
                            <RowMenu
                              label={`More actions for ${link.label}`}
                              disabled={busy}
                              items={[
                                {
                                  label: link.enabled ? "Disable link" : "Enable link",
                                  hint: link.enabled ? "The address stops resolving; its stats stay" : undefined,
                                  onSelect: () => void setLinkEnabled(link, !link.enabled),
                                },
                                ...(link.isDefault
                                  ? []
                                  : [
                                      {
                                        label: "Make default",
                                        hint: "Shown in the side panel as the document's primary link",
                                        onSelect: () => void makeDefault(link),
                                      },
                                      {
                                        label: "Delete…",
                                        destructive: true,
                                        // Starts the inline confirm; nothing is deleted from the menu.
                                        onSelect: () => setConfirmDeleteId(link.id),
                                      },
                                    ]),
                              ]}
                            />
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
            {/* Deleted links keep their analytics — that is the promise the delete confirm makes —
                and their traffic is in the document totals, but no row above can carry it. Shown
                unlinked and muted: there is nothing left to open or filter to, only a number to
                account for. Hidden when there is nothing to account for, so a healthy table has no
                mysterious extra row. */}
            {deletedLinkResidual ? (
              <tr className="border-t border-[var(--border)] text-[var(--muted)]">
                <td className="px-4 py-2.5" colSpan={4}>
                  <span className="font-medium">
                    {deletedLinkResidual.count === 1 ? "1 deleted link" : `${deletedLinkResidual.count} deleted links`}
                  </span>
                  <div className="mt-0.5 text-[11px] text-[var(--muted-2)]">Still counted in the document&apos;s totals; nothing left to open.</div>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{deletedLinkResidual.viewers.toLocaleString()}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{deletedLinkResidual.downloads.toLocaleString()}</td>
                <td className="px-3 py-2.5 text-[var(--muted-2)]">—</td>
                <td className="px-4 py-2.5" />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Prev/Next, not "show all": at 25 rows a page this never grows past a screen's worth
          regardless of whether the document has 30 links or 3,000. Hidden entirely at one page,
          so a document that fits already reads exactly as it did before pagination existed. */}
      {linksTotal !== null && linksTotal > LINKS_PAGE_SIZE ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[12px] text-[var(--muted)]">
          <span className="tabular-nums">
            {(linksPage - 1) * LINKS_PAGE_SIZE + 1}–{Math.min(linksPage * LINKS_PAGE_SIZE, linksTotal)} of{" "}
            {linksTotal.toLocaleString()} links
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={linksPage <= 1}
              onClick={() => setLinksPage((p) => Math.max(1, p - 1))}
              className={LINK_ACTION_CLASS}
            >
              Previous
            </button>
            <span className="px-1 tabular-nums">
              Page {linksPage} of {Math.max(1, Math.ceil(linksTotal / LINKS_PAGE_SIZE))}
            </span>
            <button
              type="button"
              disabled={linksPage >= Math.ceil(linksTotal / LINKS_PAGE_SIZE)}
              onClick={() => setLinksPage((p) => p + 1)}
              className={LINK_ACTION_CLASS}
            >
              Next
            </button>
          </div>
        </div>
      ) : null}

      {/* With only the default link there is nothing to compare yet, so say what a second link is
          for. A slim strip under the table, not a card competing with it. Gated on the true total,
          not the current page's row count, so it does not reappear on the last page of a document
          that has plenty of links. */}
      {canManage && linksTotal === 1 ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-xl border border-dashed border-[var(--border)] px-4 py-3">
          <div className="min-w-0 text-[13px] leading-6 text-[var(--muted)]">
            <span className="font-semibold text-[var(--fg)]">Add a link per audience.</span> The same document, a separate
            link for each person or firm — see which one opened it, revoke one without touching the rest, give one a
            password or an expiry.
          </div>
          <button type="button" onClick={openCreate} className={`${NEW_LINK_CLASS} shrink-0`}>
            <PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
            New link
          </button>
        </div>
      ) : null}

      {/* a11y: announce copy state */}
      <div className="sr-only" aria-live="polite">
        {copiedLinkId ? "Copied to clipboard" : ""}
      </div>

      {modal}
    </div>
  );
});

export default DocLinksManager;
