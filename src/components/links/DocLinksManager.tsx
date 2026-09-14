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
import { ArrowDownTrayIcon, CalendarDaysIcon, ClockIcon, LinkIcon, LockClosedIcon, PlusIcon } from "@heroicons/react/24/outline";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";

import { CopyButton } from "@/components/CopyButton";
import ShareLinkModal, { type ShareLinkFormValues } from "@/components/modals/ShareLinkModal";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { subscribeRealtime } from "@/lib/client/realtime";
import { refreshPlan, usePlan } from "@/lib/client/usePlan";
import { fetchJson } from "@/lib/http/fetchJson";
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
  /** False hides every mutation (create, edit, enable/disable, delete); copy stays. */
  canManage?: boolean;
};

/** "3h ago" / "12 Sep" for a link's last view; empty when it has never been viewed. */
function relativeWhen(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(ms));
}

/** "12 Sep 2026" for an expiry date. */
function formatDate(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date(ms));
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

/** One "Label · value" cell of the settings summary row. */
function SettingItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-[var(--muted-2)]">{label}</span>
      <span className="font-medium text-[var(--fg)]">{value}</span>
    </span>
  );
}

/** One stat of a link card. */
function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">{label}</div>
      <div className="mt-0.5 truncate text-[13px] font-semibold tabular-nums text-[var(--fg)]">{value}</div>
    </div>
  );
}

const DocLinksManager = forwardRef<DocLinksManagerHandle, Props>(function DocLinksManager(
  { docId, variant, canManage = true },
  ref,
) {
  const { openUpgrade } = useUpgradeModal();
  const { plan } = usePlan();
  const isFreePlan = plan?.plan === "free";

  const [links, setLinks] = useState<ShareLinkDTO[] | null>(null);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [linksRev, setLinksRev] = useState(0);
  const [linkStats, setLinkStats] = useState<Record<string, { viewers: number; views: number; downloads: number }>>({});
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchJson<{ links: ShareLinkDTO[] }>(`/api/docs/${encodeURIComponent(docId)}/links`, {
          cache: "no-store",
        });
        if (cancelled) return;
        setLinks(Array.isArray(res.links) ? res.links : []);
        setLinksError(null);
      } catch (e) {
        if (!cancelled) setLinksError(e instanceof Error ? e.message : "Failed to load links");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, linksRev]);

  // Agents and other sessions create links too: `share_link.*` activity frames refetch the list.
  useEffect(
    () =>
      subscribeRealtime("activity", (f) => {
        if (f.type !== "activity") return;
        if (typeof f.event.type === "string" && f.event.type.startsWith("share_link.")) refreshLinks();
      }),
    [refreshLinks],
  );

  // Views, viewers and downloads all come from the analytics window, in one call per link.
  //
  // The counters on the link row (`viewCount`, `downloadCount`) only started counting when links
  // shipped, so on a document with older traffic they disagree with the analytics — a card would
  // read "Views 1 · Viewers 18", which is nonsense. One source keeps the four numbers coherent;
  // the row counters are only the fallback when the request fails.
  useEffect(() => {
    if (variant !== "page") return;
    const rows = (links ?? []).slice(0, 8);
    if (!rows.length) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        rows.map(async (l) => {
          try {
            const res = await fetchJson<{ viewerCount?: number; totals?: { views?: number; downloads?: number } }>(
              `/api/docs/${encodeURIComponent(docId)}/shareviews?days=30&lite=1&shareId=${encodeURIComponent(l.shareId)}`,
              { cache: "no-store" },
            );
            const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
            return [l.id, { viewers: n(res.viewerCount), views: n(res.totals?.views), downloads: n(res.totals?.downloads) }] as const;
          } catch {
            return [l.id, null] as const;
          }
        }),
      );
      if (cancelled) return;
      setLinkStats((prev) => {
        const next = { ...prev };
        for (const [id, stats] of entries) if (stats) next[id] = stats;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, links, variant]);

  /** Default link first, then the rest in the order the API returned them. */
  const ordered = useMemo(() => {
    if (!links) return null;
    return [...links].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  }, [links]);

  const defaultLink = useMemo(
    () => (links ? (links.find((l) => l.isDefault) ?? links[0] ?? null) : null),
    [links],
  );

  /** At (or inside the grace window of) the Free cap: show the standard upgrade prompt. */
  function handlePlanWarning(warning: LinkPlanWarning | undefined) {
    if (!warning) return;
    openUpgrade("active_links", { used: warning.used, max: warning.max });
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
    const count = links?.length ?? 0;

    return (
      // Same card as the quick-stats and snapshot sections below it: bordered, rounded, on
      // --panel-2. Before this the links block was bare text at the top of the panel and read as
      // floating above two properly framed sections.
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-5 py-4">
        <div className="flex items-center justify-between gap-3 pb-3">
          <div className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
            <LinkIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
            <span className="truncate">Default link{count > 1 ? ` · ${count} total` : ""}</span>
          </div>
          {canManage ? (
            <button type="button" onClick={openCreate} className={NEW_LINK_CLASS}>
              <PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
              New link
            </button>
          ) : null}
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

        {/* The default link's own settings, so the panel answers "what does this link do?" without
            a trip to the links page. */}
        {defaultLink ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--muted)]">
            <SettingItem label="Download" value={defaultLink.allowDownload ? "on" : "off"} />
            <SettingItem label="Password" value={defaultLink.passwordEnabled ? "set" : "none"} />
            <SettingItem label="Version history" value={defaultLink.allowRevisionHistory ? "on" : "off"} />
            <SettingItem label="Expires" value={formatDate(defaultLink.expiresAt) || "Never"} />
          </div>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-x-1.5 text-[12px] text-[var(--muted)]">
          <span>
            {count <= 1 ? "No other links yet" : `${count - 1} other ${count - 1 === 1 ? "link" : "links"}`}
          </span>
          <span aria-hidden="true">·</span>
          {/* Say where it goes: "Manage" was ambiguous next to "Edit settings", which edits the
              default link here rather than opening the page. */}
          <Link
            href={`/doc/${encodeURIComponent(docId)}/links`}
            className="font-semibold text-[var(--fg)] underline-offset-4 hover:underline"
          >
            View all links
          </Link>
          {canManage && defaultLink ? (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => setLinkModal({ mode: "edit", link: defaultLink })}
                className="font-semibold text-[var(--fg)] underline-offset-4 hover:underline"
              >
                Edit settings
              </button>
            </>
          ) : null}
        </div>

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

      {/* A table, not cards: a document can carry dozens of links, and the useful comparison is
          across rows — who opened what, which are still open. Thin rows, full width, and the
          settings collapse to icons so a row stays on one line. */}
      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]">
        <table className="w-full min-w-[980px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
              <th scope="col" className="px-4 py-2.5 font-semibold">Link</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Address</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Status</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Settings</th>
              <th scope="col" className="px-3 py-2.5 text-right font-semibold">Views</th>
              <th scope="col" className="px-3 py-2.5 text-right font-semibold">Viewers</th>
              <th scope="col" className="px-3 py-2.5 text-right font-semibold">Downloads</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Last viewed</th>
              <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ordered === null ? (
              [0, 1, 2].map((i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  <td colSpan={9} className="px-4 py-3">
                    <div className="h-4 w-full animate-pulse rounded bg-[var(--panel-hover)]" aria-hidden="true" />
                  </td>
                </tr>
              ))
            ) : ordered.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center">
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

                    <td className="px-3 py-2.5 text-right tabular-nums text-[var(--fg)]">
                      {(stats ? stats.views : link.viewCount).toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-[var(--fg)]">
                      {stats ? stats.viewers.toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-[var(--fg)]">
                      {(stats ? stats.downloads : link.downloadCount).toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[var(--muted)]">
                      {relativeWhen(link.lastViewedAt) || "Never"}
                    </td>

                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {!canManage ? null : confirming ? (
                          <>
                            <span className="text-[12px] text-[var(--muted)]">Delete?</span>
                            <button type="button" disabled={busy} onClick={() => void deleteLink(link)} className={LINK_ACTION_CLASS}>
                              {busy ? "Deleting…" : "Delete"}
                            </button>
                            <button type="button" disabled={busy} onClick={() => setConfirmDeleteId(null)} className={LINK_ACTION_CLASS}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setLinkModalError(null);
                                setLinkModal({ mode: "edit", link });
                              }}
                              className={LINK_ACTION_CLASS}
                            >
                              Edit
                            </button>
                            <button type="button" disabled={busy} onClick={() => void setLinkEnabled(link, !link.enabled)} className={LINK_ACTION_CLASS}>
                              {busy ? "Saving…" : link.enabled ? "Disable" : "Enable"}
                            </button>
                            {link.isDefault ? null : (
                              <>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void makeDefault(link)}
                                  className={LINK_ACTION_CLASS}
                                  title="Show this link in the document's side panel and make it the document's primary link"
                                >
                                  Make default
                                </button>
                                <button type="button" disabled={busy} onClick={() => setConfirmDeleteId(link.id)} className={LINK_ACTION_CLASS}>
                                  Delete
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* With only the default link there is nothing to compare yet, so say what a second link is
          for. A slim strip under the table, not a card competing with it. */}
      {canManage && ordered !== null && ordered.length === 1 ? (
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
