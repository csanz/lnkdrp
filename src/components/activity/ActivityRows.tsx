"use client";

/**
 * How one activity row looks, in the one place both feeds read it from.
 *
 * `/activity` owned all of this privately: the icon per type, the avatar pair, the sentence, the
 * per-row controls, the day grouping and the Previous/Next rail. The contributor pages
 * (`/people/:id`, `/agents/:client/:owner`) are the same feed under a different filter, and a
 * second copy of a row that decides between four hrefs, splits a suffix on a document title and
 * opens a change preview would drift from this one inside a release. So the row moved here whole
 * and `/activity` imports it; nothing in the move changed what it renders.
 *
 * What did change is the subject: the name at the head of the sentence is now a link to that
 * contributor's page (see {@link subjectHrefFor}), which is the whole point of the feature - the
 * feed is where you notice that an agent has been busy, and it was the one place you could not
 * click through to find out what it had been doing.
 */

import Link from "next/link";
import { useState, type ComponentType, type SVGProps } from "react";
import {
  AdjustmentsHorizontalIcon,
  ArchiveBoxIcon,
  ArchiveBoxXMarkIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUpTrayIcon,
  CheckCircleIcon,
  ClockIcon,
  CpuChipIcon,
  DocumentPlusIcon,
  EyeIcon,
  GlobeAltIcon,
  InboxArrowDownIcon,
  KeyIcon,
  LinkIcon,
  LinkSlashIcon,
  LockClosedIcon,
  LockOpenIcon,
  TrashIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";

import AgentMark from "@/components/AgentMark";
import ChangePreviewModal from "@/components/activity/ChangePreviewModal";
import { projectLinkMetricsHref } from "@/lib/analytics/workspace/shape";
import { initialsFromNameOrEmail } from "@/lib/format/initials";
import {
  ACTIVITY_FILTERS,
  actorDisplayName,
  describeActivity,
  type ActivityFilterId,
  type ActivityItem,
} from "@/lib/activity/labels";

/** Page sizes the feed's own selector offers. */
export const ACTIVITY_PAGE_SIZES = [25, 50, 100] as const;
/** Rows per page before anyone touches the selector. */
export const DEFAULT_ACTIVITY_PAGE_SIZE = 25;

/**
 * The name at the head of the row's sentence, as a link, in priority order.
 *
 * 1. `readerHref` - a recipient. A reader is not a contributor: their page is the reading page for
 *    that link, and they must never be addressed by a contributor key (see brief 1.4).
 * 2. `agent.href` - the row is the agent's action, so the subject is the agent even when the
 *    sentence reads "Alice and Claude Code". The owner is one click away on the agent's page,
 *    which is the right depth for it: crediting the row to Alice would file her agent's work
 *    under her name.
 * 3. `actor.href` - a member acting in the app.
 * 4. null - a system row (a cron, the pipeline) belongs to nobody, so it stays plain text.
 *
 * Exported for its own test: the precedence is the whole rule, and it is the kind of thing a later
 * edit reorders by accident.
 */
export function subjectHrefFor(item: ActivitySubject): string | null {
  return item.readerHref || item.agent?.href || item.actor?.href || null;
}

/**
 * Just enough of a row to choose the subject's link.
 *
 * Structural rather than `ActivityItem` so the helper can be tested with a two-field literal, and
 * so it keeps compiling while `/api/activity` grows the `href` fields (`src/lib/activity/labels.ts`,
 * owned by the API change).
 */
export type ActivitySubject = {
  readerHref?: string | null;
  agent?: { href?: string | null } | null;
  actor?: { href?: string | null } | null;
};

type HeroIcon = ComponentType<SVGProps<SVGSVGElement>>;

const ICON_BY_TYPE: Record<string, HeroIcon> = {
  "doc.created": DocumentPlusIcon,
  "doc.imported_url": GlobeAltIcon,
  "upload.completed": ArrowUpTrayIcon,
  "doc.processed": CpuChipIcon,
  "doc.replaced": ArrowPathIcon,
  "doc.deleted": TrashIcon,
  "doc.archived": ArchiveBoxIcon,
  "doc.unarchived": ArchiveBoxXMarkIcon,
  "share.viewed": EyeIcon,
  "share.downloaded": ArrowDownTrayIcon,
  "share_link.created": LinkIcon,
  "share_link.updated": AdjustmentsHorizontalIcon,
  "share_link.revoked": LinkSlashIcon,
  "share_link.password_revealed": KeyIcon,
  "share.updated": LinkIcon,
  "share.password_set": LockClosedIcon,
  "share.password_cleared": LockOpenIcon,
  "request_repo.created": InboxArrowDownIcon,
  "request.upload_received": InboxArrowDownIcon,
  "download_request.created": ArrowDownTrayIcon,
  "download_request.approved": CheckCircleIcon,
  "download_request.denied": XCircleIcon,
};

/** Render a user-friendly relative time string for ISO timestamps. */
function formatRelative(iso: string | null) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60000);
  if (mins <= 1) return "Just now";
  if (mins < 60) return `${mins} ${mins === 1 ? "min" : "mins"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? "hr" : "hrs"} ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return "Yesterday";
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** Local-date key (YYYY-MM-DD) used to group rows by day. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "unknown";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** "Today" / "Yesterday" / "Sep 10, 2026" for a day key. */
function dayLabel(key: string): string {
  if (key === "unknown") return "Earlier";
  const today = dayKey(new Date().toISOString());
  const yesterday = dayKey(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  const [y, m, d] = key.split("-").map((s) => Number(s));
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Where a row should link: the doc (unless deleted), else the project, else nowhere. */
export function hrefFor(item: ActivityItem): string | null {
  if (item.doc?.id && item.type !== "doc.deleted" && !item.doc?.deleted) return `/doc/${encodeURIComponent(item.doc.id)}`;
  if (item.project?.id) return `/project/${encodeURIComponent(item.project.id)}`;
  return null;
}

/**
 * Who did it, as avatars. A person alone is one initials circle; an agent acting for a person is
 * the pair stacked like GitHub's co-authored commits (person in front, agent behind); an agent with
 * no known person is the agent circle alone.
 */
export function ActorAvatar({ item }: { item: ActivityItem }) {
  const name = actorDisplayName(item.actor);
  const agent = item.agent;
  const agentTitle = agent ? (agent.version ? `${agent.label} ${agent.version}` : agent.label) : null;
  const person = name ? (
    <div
      className="grid h-7 w-7 place-items-center rounded-full bg-[var(--panel-hover)] text-[10px] font-semibold text-[var(--muted)] ring-1 ring-[var(--border)]"
      title={item.actor.email ?? name}
    >
      {initialsFromNameOrEmail(name)}
    </div>
  ) : null;
  const bot = agent ? (
    <div
      className="grid h-7 w-7 place-items-center rounded-full bg-[var(--panel)] text-[var(--muted)] ring-1 ring-[var(--border)]"
      title={agentTitle ?? undefined}
    >
      <AgentMark client={agent.client} label={agent.label} className="h-3.5 w-3.5" />
    </div>
  ) : null;
  if (person && bot) {
    return (
      <div className="flex shrink-0 items-center" aria-hidden="true">
        <div className="relative z-10 rounded-full ring-2 ring-[var(--panel)]">{person}</div>
        <div className="-ml-1.5">{bot}</div>
      </div>
    );
  }
  if (person) return <div className="shrink-0" aria-hidden="true">{person}</div>;
  if (bot) return <div className="shrink-0" aria-hidden="true">{bot}</div>;
  return (
    <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--panel-hover)] text-[10px] font-semibold text-[var(--muted)] ring-1 ring-[var(--border)]" aria-hidden="true">
      ?
    </div>
  );
}

/** How a row enters: staggered page enter, the live-arrival highlight, or nothing (already shown). */
export type RowEnter = "fresh" | "none";

/**
 * One line of the feed: who did what to which thing, when, and the ways into it.
 *
 * The sentence comes from `describeActivity` and is rendered in three pieces so each can link
 * somewhere different - the subject to the contributor, the bold object to the link's own numbers
 * or to the document, and the document title inside the suffix to the document. The second row
 * carries the timestamp and whichever of Share link / Analytics / What changed the event supports.
 */
export function ActivityRow({ item, enter = "none" }: { item: ActivityItem; enter?: RowEnter }) {
  // A "replaced" row announces a new version and says nothing about it; this opens that version's
  // entry from the document's history without leaving the feed.
  const [changeOpen, setChangeOpen] = useState(false);
  const replacedVersion =
    item.type === "doc.replaced" && typeof item.meta?.version === "number" && Number.isFinite(item.meta.version)
      ? Number(item.meta.version)
      : null;
  const canPreviewChange = item.type === "doc.replaced" && Boolean(item.doc?.id) && !item.doc?.deleted;
  const docGone = item.type === "doc.deleted" || Boolean(item.doc?.deleted);
  const Icon = item.type === "doc.imported_url" && item.meta?.via === "bytes" ? ArrowUpTrayIcon : ICON_BY_TYPE[item.type] ?? ClockIcon;
  // Open the link the event came through (meta.shareId), not always the document's default link.
  const eventShareId = typeof item.meta?.shareId === "string" && item.meta.shareId ? item.meta.shareId : null;
  const shareId = eventShareId ?? item.doc?.shareId ?? null;
  /**
   * A project link is one slug for a whole data room: it lives at `/p/:shareId`, and its numbers
   * live on the project's metrics page. The event says which it is — a read through a project link
   * records `meta.projectId` alongside the document it opened, and a project `share_link.*` row
   * carries `meta.scope: "project"` with no document at all. Without this branch both controls on
   * such a row were built as if the slug were a document link: `/s/:slug` 404s, and the document
   * metrics page renders 0 views for traffic that exists on the project page.
   */
  const eventProjectId =
    typeof item.meta?.projectId === "string" && item.meta.projectId
      ? item.meta.projectId
      : item.meta?.scope === "project"
        ? item.project?.id ?? null
        : null;
  const isProjectLinkRow = Boolean(eventShareId && eventProjectId);
  const shareHref = shareId
    ? `${isProjectLinkRow ? "/p/" : "/s/"}${encodeURIComponent(shareId)}`
    : null;
  /**
   * That link's own numbers, not the document's.
   *
   * The feed is where an owner finds out someone read the deck, and it already knows which link the
   * event came through (`meta.shareId`) — but the only control on the row opened the recipient's
   * view of the file. "Sequoia opened it" and "so how is the Sequoia link doing" is one thought,
   * and answering it meant leaving the feed, finding the document, opening its links table and
   * picking the row. Gone once the document is deleted: there is nothing left to scope to.
   */
  const linkMetricsHref =
    isProjectLinkRow && shareId && eventProjectId
      ? projectLinkMetricsHref(encodeURIComponent(eventProjectId), shareId)
      : shareId && item.doc?.id && !docGone
        ? `/doc/${encodeURIComponent(item.doc.id)}/metrics?shareId=${encodeURIComponent(shareId)}`
        : null;
  const s = describeActivity(item);
  const when = formatRelative(item.createdDate);
  const exact = new Date(item.createdDate).toLocaleString();

  // On a `share_link.*` row the bold name is the LINK, so it goes to that link's own numbers.
  // It used to go to the document, which made the two halves of the sentence — the link and the
  // document it is on — lead to the same page, and left no way to reach the link itself.
  const isLinkRow = item.type.startsWith("share_link.");
  const href = (isLinkRow ? linkMetricsHref : null) ?? hrefFor(item);
  const readerHref = item.readerHref ?? null;
  // The head of the sentence. `readerHref` still wins, so a recipient row renders exactly as it
  // did; a member or agent row that used to be plain text now goes to that contributor's page.
  const subjectHref = subjectHrefFor(item);
  /**
   * The tooltip names the destination when the subject is not the thing it links to.
   *
   * On an agent row the bold name can still be the *owner's*: `describeActivity` writes
   * "Christian Sanz replaced X" for `doc.replaced` even when an agent did it (the avatar pair is
   * what says so). The row belongs to the agent, so the link does too - but "See everything they
   * changed" over a person's name, landing on Claude Code's page, reads as a mistake. Naming the
   * agent in the title costs nothing and makes the jump predictable.
   */
  const subjectTitle = readerHref
    ? "See what they read"
    : item.agent && subjectHrefFor({ agent: item.agent })
      ? `See everything ${item.agent.label} changed`
      : "See everything they changed";
  const docHref = item.doc?.id && !docGone ? `/doc/${encodeURIComponent(item.doc.id)}` : null;

  const linkClass = "font-semibold text-[var(--fg)] hover:underline underline-offset-4";
  const objectNode = s.object ? (
    href ? (
      <Link href={href} className={linkClass}>
        {s.object}
      </Link>
    ) : (
      <span className="font-semibold text-[var(--fg)]">{s.object}</span>
    )
  ) : null;

  // The document's title is the tail of the suffix ("for USAVX MEMO", "on Meridian Robotics"), and
  // `describeActivity` builds it from this same title, so the split is exact rather than a guess.
  // Only the title becomes a link; the preposition in front of it stays plain text.
  const docTitle = item.doc?.title?.trim() || "Untitled document";
  const suffixNode = (() => {
    if (!s.suffix) return null;
    if (s.object === docTitle || !s.suffix.endsWith(docTitle)) return <span>{s.suffix}</span>;
    const lead = s.suffix.slice(0, s.suffix.length - docTitle.length);
    return (
      <>
        {lead ? <span>{lead.trimEnd()}</span> : null}
        {docHref ? (
          <Link href={docHref} className={linkClass}>
            {docTitle}
          </Link>
        ) : (
          // A deleted document keeps the same bold object styling, just without the link.
          <span className="font-semibold text-[var(--fg)]">{docTitle}</span>
        )}
      </>
    );
  })();

  return (
    <li
      className={[
        // Grid wrapper: a live arrival animates grid-template-rows 0fr -> 1fr, so the rows below
        // slide down with it instead of jumping; the inner div clips during the expand.
        "grid",
        // Only a row that arrived live (a realtime frame while the page is open) animates: it expands
        // into place, holds a soft tint and fades back. Rows from a load, refresh, filter or page
        // change render still; a row that finished its highlight goes back to "none" without a blink.
        enter === "fresh" ? "motion-safe:animate-[ldFeedRowNew_7s_cubic-bezier(0.22,0.61,0.36,1)_both]" : "",
      ].join(" ")}
    >
      <div className="min-h-0 overflow-hidden">
      <div className="flex items-start gap-3 px-4 py-3">
      <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--panel-hover)] text-[var(--muted-2)] ring-1 ring-[var(--border)]">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
      <ActorAvatar item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] leading-5 text-[var(--muted)]">
          {/* The person, where there is a page about them: a viewer row names someone who opened
              something, and what they did is a page away.

              Underlined at rest, not only on hover. It shipped styled exactly like the plain text
              beside it, which made a working link invisible — reported as "you still don't show the
              link" while it was already there. A dotted rule is the quiet version of the object
              links further along the sentence: enough to say this name goes somewhere, not enough
              to compete with the document title. */}
          {subjectHref ? (
            <Link
              href={subjectHref}
              title={subjectTitle}
              className="font-medium text-[var(--fg)] underline decoration-dotted decoration-[var(--muted-2)] underline-offset-4 transition-colors hover:decoration-solid hover:decoration-[var(--fg)]"
            >
              {s.subject}
            </Link>
          ) : (
            <span className="font-medium text-[var(--fg)]">{s.subject}</span>
          )}
          <span>{s.verb}</span>
          {objectNode}
          {suffixNode}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--muted-2)]">
          <time dateTime={item.createdDate} title={exact}>
            {when}
          </time>
          {shareHref && !docGone && item.type !== "share_link.revoked" && item.type !== "doc.archived" ? (
            <>
              <span aria-hidden="true">·</span>
              <Link
                href={shareHref}
                className="hover:text-[var(--fg)] hover:underline underline-offset-4"
                target="_blank"
                rel="noreferrer"
              >
                Share link
              </Link>
            </>
          ) : null}
          {/* Stays available on a revoked or archived link, unlike "Share link": the link no longer
              opens, and what it did while it was live is exactly what an owner wants at that point. */}
          {linkMetricsHref ? (
            <>
              <span aria-hidden="true">·</span>
              <Link href={linkMetricsHref} className="hover:text-[var(--fg)] hover:underline underline-offset-4">
                Analytics
              </Link>
            </>
          ) : null}
          {canPreviewChange ? (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="hover:text-[var(--fg)] hover:underline underline-offset-4"
                onClick={() => setChangeOpen(true)}
              >
                What changed
              </button>
            </>
          ) : null}
        </div>
      </div>
      </div>
      </div>
      {canPreviewChange && item.doc?.id ? (
        <ChangePreviewModal
          open={changeOpen}
          onClose={() => setChangeOpen(false)}
          docId={item.doc.id}
          docTitle={item.doc?.title?.trim() || "This document"}
          version={replacedVersion}
        />
      ) : null}
    </li>
  );
}

/** One day's worth of rows, in the order the feed received them. */
export type ActivityDayGroup = { key: string; label: string; items: ActivityItem[] };

/**
 * Split a page of rows into consecutive days.
 *
 * Consecutive, not bucketed: the feed is already sorted newest first, so walking it and starting a
 * new group when the day key changes keeps the server's order exactly. Grouping into a map would
 * quietly re-sort a page whose rows share a timestamp.
 */
export function groupByDay(items: ActivityItem[]): ActivityDayGroup[] {
  const out: ActivityDayGroup[] = [];
  for (const item of items) {
    const key = dayKey(item.createdDate);
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(item);
    else out.push({ key, label: dayLabel(key), items: [item] });
  }
  return out;
}

/** The small caps label above a day's card - also the "In progress" heading, so they match. */
export function DayHeading({ children }: { children: React.ReactNode }) {
  return <ColumnHeading>{children}</ColumnHeading>;
}

/**
 * The small label that sits above a column of cards.
 *
 * Both columns of a contributor's page use it - the feed's day headings on the left, the rail's
 * card titles on the right - because the two have to start on the same line. They did not: the
 * rail's title lived inside its card, so the card's own top padding pushed "Documents" below
 * "Yesterday" and the page read as two lists that had slipped out of step.
 */
export function ColumnHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">
      {children}
    </div>
  );
}

/**
 * A page of rows, as day sections of cards.
 *
 * Both feeds render this rather than each writing the section/card/list wrapper themselves: the
 * card's `overflow-hidden` is load-bearing (the live-arrival tint has to clip to its corners) and
 * is exactly the sort of detail a second copy loses.
 */
export function ActivityDayGroups({
  groups,
  freshIds,
}: {
  groups: ActivityDayGroup[];
  /** Ids that arrived live while the page was open; they play the arrival animation once. */
  freshIds?: ReadonlySet<string>;
}) {
  return (
    <>
      {groups.map((g) => (
        <section key={g.key} aria-label={g.label}>
          <DayHeading>{g.label}</DayHeading>
          {/* overflow-hidden: the live-arrival tint on the first/last row must clip to the card's corners. */}
          <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
            <ul className="divide-y divide-[var(--border)]">
              {g.items.map((item) => (
                <ActivityRow key={item.id} item={item} enter={freshIds?.has(item.id) ? "fresh" : "none"} />
              ))}
            </ul>
          </div>
        </section>
      ))}
    </>
  );
}

/**
 * Six pulsing rows, for the wait that is long enough to need them.
 *
 * Paired with `useSkeletonDelay` at every call site: nothing at all for the first fifth of a
 * second, because six rows that resolve into "no activity yet" promise a feed that was never
 * coming.
 */
export function ActivityFeedSkeleton() {
  return (
    <div className="grid gap-6" aria-hidden="true">
      <div className="mb-2 h-3 w-16 rounded bg-[var(--panel-hover)]" />
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
        <ul className="divide-y divide-[var(--border)]">
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-3 motion-safe:animate-pulse" style={{ animationDelay: `${i * 80}ms` }}>
              <div className="h-8 w-8 rounded-full bg-[var(--panel-hover)]" />
              <div className="min-w-0 flex-1">
                <div className="h-3.5 w-[min(420px,70%)] rounded bg-[var(--panel-hover)]" />
                <div className="mt-2 h-3 w-24 rounded bg-[var(--panel-hover)]" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The pill class both filter rails use, so the two axes cannot drift apart. */
export function activityTabClass(active: boolean): string {
  return [
    "h-8 rounded-full px-3 text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
    active
      ? "bg-[var(--fg)] text-[var(--bg)]"
      : "border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
  ].join(" ");
}

/** The "All / Uploads / Sharing / ..." rail. A contributor page carries it; the who-rail is `/activity`'s alone. */
export function ActivityTypeTabs({
  value,
  onChange,
}: {
  value: ActivityFilterId;
  onChange: (id: ActivityFilterId) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Activity filters">
      {ACTIVITY_FILTERS.map((f) => {
        const active = f.id === value;
        return (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(f.id)}
            className={activityTabClass(active)}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Previous / Next and the page-size selector.
 *
 * Renders nothing at all until there is somewhere to go: a workspace with four rows should not be
 * told it is on page 1 of 1. `itemCount >= pageSize` is the third case - a full page whose
 * `nextCursor` came back null still shows the rail, because the count alone cannot say whether the
 * feed ended exactly on the boundary.
 */
export function ActivityPager({
  pageIndex,
  pageSize,
  onPageSize,
  nextCursor,
  itemCount,
  loading,
  pending,
  onGoToPage,
}: {
  pageIndex: number;
  pageSize: number;
  onPageSize: (n: number) => void;
  nextCursor: string | null;
  itemCount: number;
  /** A fetch is in flight: both arrows go quiet. */
  loading: boolean;
  /** A page transition is running: the arrows go quiet and the label says so. */
  pending: boolean;
  onGoToPage: (index: number) => void;
}) {
  if (!(pageIndex > 0 || nextCursor || itemCount >= pageSize)) return null;
  return (
    <nav aria-label="Activity pages" className="flex flex-wrap items-center justify-between gap-3 pt-1">
      <label className="flex items-center gap-2 text-[12px] text-[var(--muted-2)]">
        <span>Per page</span>
        <select
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
          className="h-8 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 text-[12px] text-[var(--fg)]"
        >
          {ACTIVITY_PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pageIndex === 0 || loading || pending}
          onClick={() => onGoToPage(pageIndex - 1)}
          className="h-9 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 text-[13px] font-medium text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Previous
        </button>
        <span className="min-w-[4.5rem] text-center text-[12px] tabular-nums text-[var(--muted-2)]" aria-live="polite">
          {pending ? "Loading…" : `Page ${pageIndex + 1}`}
        </span>
        <button
          type="button"
          disabled={!nextCursor || loading || pending}
          onClick={() => onGoToPage(pageIndex + 1)}
          className="h-9 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 text-[13px] font-medium text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </nav>
  );
}
