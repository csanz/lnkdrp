/**
 * View notification emails ("someone opened your document").
 *
 * Spec: docs/prds/lnkdrp-view-notifications.md. This is the third block of
 * `sendNotificationEmails` beside doc updates and repo link requests; it reuses that runner's
 * send helper, cursor upsert, daily gate and `lastDigestDay` guard (passed in as `deps`).
 *
 * Layout, so the logic is testable without Mongo:
 * - **Pure functions** (exported): mode normalisation, event windows and caps, grouping, cursor
 *   math, identity rules and subject/text/html composition.
 * - **Loaders**: read Mongo and return plain event objects.
 * - **`runViewNotificationsForOrg`**: the per-workspace orchestration.
 *
 * Rules that matter:
 * - A *new viewer* is a recipient `ShareView` row created inside the member's window (decision 1).
 *   A *return* is a recipient `ShareVisit` created inside the window that is not that reader's first
 *   visit on the link (see `isReturnVisit`); returns only go in the digest.
 * - Returns have their own horizon (`returnsNotifiedAt` on the same cursor), separate from the
 *   new-viewer horizon (`lastNotifiedAt`). An immediate member's ticks move only the new-viewer
 *   horizon; at the end-of-day tick that member gets a returns-only digest. So a return is never
 *   skipped by an immediate tick, and switching immediate -> daily still reports it.
 * - Every timestamp compared against the cursor is server-side and indexed: `ShareView.createdDate`
 *   and `ShareVisit.createdDate` (never the browser-supplied `startedAt`).
 * - Loads stop `VIEW_EVENT_SETTLE_MS` before now: `createdDate` is stamped in the app before the
 *   insert commits, so a row stamped just before the query may not be visible yet. Cursors never
 *   move past that settled instant.
 * - A missing cursor is created at `now` and nothing is sent (no backfill). Mode `off` (and a member
 *   with no email address) sends nothing and advances the cursor to `now` every tick, so turning
 *   emails back on cannot flood.
 * - Immediate windows never reach back more than `IMMEDIATE_MAX_LOOKBACK_MS`, so switching from
 *   daily (cursor up to a day or more old) to immediate does not send a burst of stale emails.
 * - The digest counts the member's whole window: events are loaded in pages until the window is
 *   covered (up to a large safety cap per workspace), never cut by the per-member event cap. Only
 *   if that safety cap is hit does the cursor stop at the load horizon; the digest day is then left
 *   unset so the next tick sends the remainder the same day instead of carrying it into tomorrow.
 * - A member with nothing to send still has its cursor moved to the covered horizon, so events
 *   loaded and then dropped (deleted or archived documents) cannot pin the workspace's window.
 * - A failed send never skips events: the cursor stops 1 ms before the earliest event of the first
 *   failed document, so the next tick retries it (verification 6). Documents that were sent earlier
 *   in that same round and also have events after that instant are sent again; a repeated email is
 *   preferred to a lost one. A transport outage fails the first send, so it repeats nothing.
 * - Identity is Pro-only (decision 4). A Free email never names the viewer or says how far they read,
 *   in the subject, the text or the html.
 * - An immediate email names at most `IMMEDIATE_MAX_VIEWERS` readers and turns the rest into a
 *   count, the same shape the digest has for documents. The per-reader lines are built from fields
 *   an anonymous viewer supplied, so their number must not be the attacker's to choose — see the
 *   constant for the whole chain.
 * - All user content (titles, labels, audience, viewer names) is escaped in HTML and stripped of
 *   line breaks in subjects.
 * - Every email carries RFC 8058 one-click unsubscribe headers pointing at the signed off URL, and a
 *   hidden preheader that follows the same identity rule as the body.
 */
import { renderHtml, renderText, type Block, type EmailFooter, type EmailWorkspace } from "@/lib/email/layout";
import { Types } from "mongoose";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { DocModel } from "@/lib/models/Doc";
import { UserModel } from "@/lib/models/User";
import { NotificationEmailCursorModel } from "@/lib/models/NotificationEmailCursor";
import { RECIPIENT_ONLY_MATCH } from "@/lib/analytics/shareViewAggregates";
import { getWorkspacePlan } from "@/lib/billing/planLimits";
import { viewEmailsOffUrl } from "@/lib/notifications/viewEmailToken";
import { splitProjectViewerKey } from "@/lib/analytics/project/viewerKey";
import { viewerPageHref } from "@/lib/metrics/viewerRouteKey";
import { debugError } from "@/lib/debug";

// ---------------------------------------------------------------------------------------------
// Constants and copy
// ---------------------------------------------------------------------------------------------

export type ViewEmailMode = "off" | "daily" | "immediate";

export const VIEW_EMAIL_CURSOR_KEY = "share_views" as const;

/** Id of the email preferences block (`NotificationPreferences`), so the link lands on it. */
export const VIEW_EMAIL_PREFERENCES_ANCHOR = "email-preferences";

/** Where the notification preferences live (Dashboard -> Account -> Email preferences). */
export const VIEW_EMAIL_PREFERENCES_PATH = `/dashboard?tab=notifications#${VIEW_EMAIL_PREFERENCES_ANCHOR}`;

/** An anonymous open this soon after the link was created may be the owner testing it. */
export const FIRST_VIEW_HONESTY_WINDOW_MS = 10 * 60 * 1000;

export const FIRST_VIEW_HONESTY_LINE =
  "If this was you checking the link, sign in first next time and we'll know not to count it.";

export const PRO_IDENTITY_LINE = "Pro shows who opened it and how long they stayed.";

export const VIEW_EMAIL_FOOTER_REASON = "You get this because someone opened a link to a document in your workspace.";

export const TURN_OFF_LABEL = "Turn off these emails";
export const CHANGE_HOW_OFTEN_LABEL = "Change how often";
export const PRIMARY_ACTION_LABEL = "See what they read";
/** The action when the mail is about exactly one reader and we can address their page. */
export const READER_ACTION_LABEL = "See what this reader read";
/** Said of a name the reader typed in rather than one an account proved. */
export const VOLUNTEERED_IDENTITY_NOTE =
  "They told us who they are; the name and address are not verified.";

/**
 * Loads end this long before now. `createdDate` is stamped by the app before the insert commits, so
 * a row stamped at T1 can become visible after a query that already saw a row at T2 > T1; a cursor
 * moved to T2 would pass it forever. One minute is far above any real insert latency.
 */
export const VIEW_EVENT_SETTLE_MS = 60 * 1000;

/** An immediate email is about a recent open; its window never starts earlier than this. */
export const IMMEDIATE_MAX_LOOKBACK_MS = 60 * 60 * 1000;

/**
 * A reader's visit counts as a return when it is not their first visit on the link, or when it
 * started this long after their first view (covers readers whose first visit row was never written,
 * e.g. views that predate per-visit tracking).
 */
export const RETURN_MIN_GAP_MS = 30 * 60 * 1000;

/** Rows per page when loading a workspace's events. */
export const VIEW_LOAD_PAGE_SIZE = 1000;

/**
 * Safety cap on rows loaded per workspace per kind per tick. Far above a day of real traffic for one
 * workspace; if it is ever hit the load is cut at a timestamp boundary and reported
 * (`truncatedLoads`), and cursors stop at that boundary.
 */
export const VIEW_LOAD_MAX_ROWS = 20_000;

/** A digest lists at most this many documents; the counts in the subject still cover them all. */
export const DIGEST_MAX_DOCUMENTS = 50;

/**
 * An immediate email names at most this many readers; the rest become a count line.
 *
 * The digest has had `DIGEST_MAX_DOCUMENTS` since it shipped, but the immediate body had no
 * equivalent and rendered one block per claimed row — and every one of those blocks is built from
 * fields a stranger wrote. `POST /api/share/:shareId/stats` takes `viewerName` and `viewerEmail`
 * from the anonymous request body and stamps them on the `ShareView` row, and a fresh `botId`
 * mints a fresh row, so a burst of forged readers arrived here as a burst of attacker-authored
 * lines in one message to every member of the workspace. How many was set by the sender's
 * `limitEventsPerMember` (20 by default but up to 200), not by anything the owner controls.
 *
 * Capping the list bounds one forged burst to a fixed amount of stranger-written text per email.
 * It deliberately truncates rather than dropping the email: a genuine mailshot that really is
 * opened by thirty people in one tick still gets its notification, with the overflow as a count and
 * the metrics page one click away. The headline count and the subject still cover everyone, so
 * nothing the owner is told becomes wrong — only shorter.
 *
 * Matched to the sender's default `limitEventsPerMember` so ordinary ticks never truncate at all.
 *
 * This is a blast-radius bound on the mail, not the fix for the forgery itself: what stops the
 * burst existing is a ceiling on *new viewer identities* per link, which lives on the write path in
 * `src/app/api/share/[shareId]/stats/route.ts`.
 */
export const IMMEDIATE_MAX_VIEWERS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Same wording as the links UI (`DEFAULT_LINK_LABEL` in `src/lib/share/links.ts`, shown in
 * `DocLinksManager`). Not imported: that module pulls in models and billing the email code does not need.
 */
const DEFAULT_LINK_LABEL = "Default link";
const TITLE_MAX = 120;
const LABEL_MAX = 80;
const AUDIENCE_MAX = 120;
const NAME_MAX = 120;

// ---------------------------------------------------------------------------------------------
// Plain event shapes
// ---------------------------------------------------------------------------------------------

export type ViewDocInfo = {
  docId: string;
  title: string;
  /** Number of pages in the current version, or null when unknown. */
  pageCount: number | null;
};

export type ViewLinkInfo = {
  shareId: string;
  label: string | null;
  audience: string | null;
  isDefault: boolean;
  createdDate: Date | null;
  /**
   * Set when this is a data-room link. Decides which scope a reader's page lives in.
   *
   * Optional so the callers that build a link by hand — the admin email previews, the tests — do
   * not all have to say "not a project"; absent and null mean the same thing here.
   */
  projectId?: string | null;
};

/** Identity fields as stored on the analytics row. Only ever rendered on Pro. */
export type ViewerIdentity = {
  viewerUserId: string | null;
  viewerName: string | null;
  viewerEmail: string | null;
  /** Name of the signed-in user (`viewerUserId`), loaded separately; null when unknown. */
  viewerUserName: string | null;
};

export type NewViewerEvent = ViewerIdentity & {
  kind: "view";
  id: string;
  docId: string;
  shareId: string;
  shareLinkId: string | null;
  botIdHash: string;
  /** `ShareView.createdDate` — the cursor timestamp for this event. */
  at: Date;
  /** Distinct pages reached (lifetime of the viewer on this link). */
  pagesSeen: number;
  timeSpentMs: number;
};

export type ReturnEvent = ViewerIdentity & {
  kind: "return";
  id: string;
  docId: string;
  shareId: string;
  shareLinkId: string | null;
  botIdHash: string;
  /**
   * `ShareVisit.createdDate` — the cursor timestamp for this event. Server-stamped and indexed with
   * `orgId`; `startedAt` is not used because it comes from the browser.
   */
  at: Date;
  /** `ShareView.createdDate` of this reader's first open on the link; null when not found. */
  firstViewAt: Date | null;
  /** Earliest `ShareVisit.createdDate` for this reader on the link; null when not found. */
  firstVisitAt: Date | null;
  pagesSeen: number;
  timeSpentMs: number;
};

export type ViewEvent = NewViewerEvent | ReturnEvent;

export type ComposedEmail = {
  subject: string;
  text: string;
  html: string;
  /** Extra mail headers: RFC 8058 one-click unsubscribe (`List-Unsubscribe`, `List-Unsubscribe-Post`). */
  headers: Record<string, string>;
};

export type WorkspacePlan = "free" | "pro";

// ---------------------------------------------------------------------------------------------
// Pure helpers: normalisation, escaping, formatting
// ---------------------------------------------------------------------------------------------

/**
 * Anything missing or unknown means `immediate`.
 *
 * It was `daily` (PRD decision C1), and the digest is the wrong default for what this product is:
 * knowing that someone is reading your deck is worth something while they are still reading it,
 * and a summary that arrives tomorrow morning is a report. Nobody who wanted the alert was getting
 * it unless they found the setting.
 *
 * The noisy case the digest was defending against is already handled somewhere better: a *return*
 * only ever goes in the digest, so a reader flipping back to a document does not send anything,
 * and one tick that finds thirty new readers sends one email naming `IMMEDIATE_MAX_VIEWERS` of
 * them, not thirty emails. What "immediate" actually means is a few minutes — the cron runs every
 * five, and loads stop `VIEW_EVENT_SETTLE_MS` short of now so a row is never read before it has
 * committed.
 *
 * This only decides for a row with no value at all. Memberships written before the change hold
 * "daily" explicitly — whether or not their owner ever picked it — and keep it; making somebody's
 * inbox louder without asking is a surprise, not a default. New accounts are asked outright on
 * `/welcome`, and everyone can change it in Settings.
 */
export function normalizeViewEmailMode(v: unknown): ViewEmailMode {
  return v === "off" || v === "immediate" || v === "daily" ? v : "immediate";
}

/**
 * One line of untrusted text: control characters and line/paragraph separators become spaces,
 * whitespace collapses, and the result is truncated with an ellipsis. Safe for a mail subject.
 */
export function sanitizeInline(value: unknown, max = TITLE_MAX): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const s = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Re-exported: the implementation moved to the shared email layout. */
export { escapeHtml } from "@/lib/email/layout";

/** A label the sender actually chose; the default link's internal name does not count. */
export function realLinkLabel(link: ViewLinkInfo | null | undefined): string | null {
  if (!link || link.isDefault) return null;
  const label = sanitizeInline(link.label, LABEL_MAX);
  if (!label || label.toLowerCase() === DEFAULT_LINK_LABEL.toLowerCase()) return null;
  return label;
}

/** Name shown for a link in the body: its real label, else "Default link". */
export function linkDisplayName(link: ViewLinkInfo | null | undefined): string {
  return realLinkLabel(link) ?? DEFAULT_LINK_LABEL;
}

/** "45s", "3m 20s", "1h 5m"; null below one second. */
export function formatDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 1000) return null;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 16, 2026, 09:40 UTC" — digests and times are UTC for v1 (C8). */
export function formatWhenUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "4 of 12 pages · 3m 20s", "4 pages seen", or null when there is nothing to say. */
export function formatHowFar(ev: { pagesSeen: number; timeSpentMs: number }, pageCount: number | null): string | null {
  const parts: string[] = [];
  const pages = Math.max(0, Math.floor(ev.pagesSeen || 0));
  if (pages > 0) {
    if (pageCount && pageCount > 0) parts.push(`${Math.min(pages, pageCount)} of ${pageCount} page${pageCount === 1 ? "" : "s"}`);
    else parts.push(`${pages} page${pages === 1 ? "" : "s"} seen`);
  }
  const dur = formatDuration(ev.timeSpentMs);
  if (dur) parts.push(dur);
  return parts.length ? parts.join(" · ") : null;
}

/** Best-known name for a viewer: given name, else email, else the signed-in user's name. */
export function viewerDisplayName(ev: ViewerIdentity): string | null {
  return (
    sanitizeInline(ev.viewerName, NAME_MAX) ||
    sanitizeInline(ev.viewerEmail, NAME_MAX) ||
    sanitizeInline(ev.viewerUserName, NAME_MAX) ||
    null
  );
}

export function isAnonymousViewer(ev: ViewerIdentity): boolean {
  return !ev.viewerUserId && !sanitizeInline(ev.viewerName) && !sanitizeInline(ev.viewerEmail);
}

/**
 * Did this reader *tell* us who they are, rather than prove it?
 *
 * A name on a row with no account behind it was typed into the "introduce yourself" card, and
 * `POST /api/share/:shareId/stats` accepts any `viewerName`/`viewerEmail` from anyone holding the
 * link — no confirmation is required to record one (DEPLOY.md 12). On a metrics page that claim
 * carries a chip saying so. An email is the surface where it matters most and where it was least
 * visible: mail gets forwarded, screenshotted and acted on, and because identity is Pro-gated the
 * name reads as something the owner paid to be told.
 *
 * So the email marks it too. It does not refuse to show the name — the name is the product, and
 * most of the time it is exactly who they say — it just stops printing a claim in the typeface of
 * a fact.
 */
export function isVolunteeredIdentity(ev: ViewerIdentity): boolean {
  if (ev.viewerUserId) return false;
  return Boolean(sanitizeInline(ev.viewerName, NAME_MAX) || sanitizeInline(ev.viewerEmail, NAME_MAX));
}

/**
 * The honesty line: the open came within ten minutes of the link being created by someone we
 * cannot identify. On Free the anonymity half is not evaluated — whether a viewer was identified is
 * itself identity, so the line depends on timing alone there.
 */
export function needsFirstViewHonesty(ev: NewViewerEvent, link: ViewLinkInfo | null | undefined, plan: WorkspacePlan): boolean {
  const created = link?.createdDate;
  if (!created) return false;
  const delta = ev.at.getTime() - created.getTime();
  if (delta < 0 || delta > FIRST_VIEW_HONESTY_WINDOW_MS) return false;
  return plan === "pro" ? isAnonymousViewer(ev) : true;
}

export function buildMetricsUrl(appUrl: string, docId: string, shareId?: string | null): string {
  const base = `${appUrl}/doc/${encodeURIComponent(docId)}/metrics`;
  return shareId ? `${base}?shareId=${encodeURIComponent(shareId)}` : base;
}

/**
 * The page about *this reader*, when the mail is about exactly one of them.
 *
 * "Jaime Morales opened your deck" landing on the document's metrics page made the owner find the
 * row again themselves, in a list of everyone. The reader page is the answer to the sentence the
 * email just said.
 *
 * Two things it has to get right, and `null` rather than a wrong guess if it cannot:
 *
 *   - **Scope.** A read through a data-room link belongs to the project, so a document-scoped
 *     address for such a reader is a link to a page that says "no reader by that id".
 *   - **The key is a person.** On a project link the analytics key is `<digest>.<docId>`, one row
 *     per reader *per document*; the page is addressed by the bare digest. Sending the composite
 *     would 404 on the one link an owner is most likely to click.
 */
export function buildReaderUrl(
  appUrl: string,
  ev: Pick<ViewerIdentity, "viewerUserId"> & { docId: string; botIdHash: string },
  link: ViewLinkInfo | null | undefined,
): string | null {
  const kind = ev.viewerUserId ? "authed" : "anon";
  const key = ev.viewerUserId ?? splitProjectViewerKey(ev.botIdHash).botIdHash;
  if (!key) return null;
  return viewerPageHref({ appUrl, projectId: link?.projectId ?? null, docId: ev.docId, kind, key });
}

export function buildPreferencesUrl(appUrl: string): string {
  return `${appUrl}${VIEW_EMAIL_PREFERENCES_PATH}`;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers: windows, caps, grouping, cursor math
// ---------------------------------------------------------------------------------------------

/** Events strictly after the cursor and at or before `now`, oldest first. */
export function eventsInWindow<T extends { at: Date }>(events: readonly T[], cursor: Date, now: Date): T[] {
  const lo = cursor.getTime();
  const hi = now.getTime();
  return events.filter((e) => e.at.getTime() > lo && e.at.getTime() <= hi).sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The latest instant a tick may load or move a cursor to (see `VIEW_EVENT_SETTLE_MS`). */
export function settledUntil(now: Date): Date {
  return new Date(now.getTime() - VIEW_EVENT_SETTLE_MS);
}

/**
 * Where a member's window starts: their cursor, never earlier than the default lookback and, for
 * immediate mode, never earlier than `IMMEDIATE_MAX_LOOKBACK_MS` ago.
 */
export function memberWindowStart(mode: Exclude<ViewEmailMode, "off">, cursor: Date, now: Date, lookbackDays: number): Date {
  let floor = now.getTime() - lookbackDays * DAY_MS;
  if (mode === "immediate") floor = Math.max(floor, now.getTime() - IMMEDIATE_MAX_LOOKBACK_MS);
  return cursor.getTime() < floor ? new Date(floor) : cursor;
}

/**
 * Take the first `limit` events (sorted oldest first) without splitting a millisecond.
 *
 * The cursor is a timestamp, so a batch that ends at T while an unsent event also sits at T would
 * advance the cursor past that event forever. Trailing events tied with the first excluded one are
 * dropped; if that empties the batch, the whole tied group is taken (going over `limit`).
 */
export function capAtTimestampBoundary<T extends { at: Date }>(sorted: readonly T[], limit: number): { batch: T[]; truncated: boolean } {
  if (sorted.length <= limit) return { batch: sorted.slice(), truncated: false };
  const nextAt = sorted[limit].at.getTime();
  let end = limit;
  while (end > 0 && sorted[end - 1].at.getTime() === nextAt) end -= 1;
  if (end === 0) {
    end = limit;
    while (end < sorted.length && sorted[end].at.getTime() === nextAt) end += 1;
  }
  return { batch: sorted.slice(0, end), truncated: end < sorted.length };
}

/**
 * Cut a load that fetched more than `maxRows` rows (sorted oldest first) at a timestamp boundary.
 *
 * `rawTimes` are the timestamps of every raw row fetched, in order (unparseable rows included, so
 * a skipped row cannot hide that the load was cut). When `rawTimes.length <= maxRows` the window is
 * fully covered: every event is kept and the horizon is null. Otherwise the first excluded row sits
 * at `B = rawTimes[maxRows]`; events before `B` are kept and the horizon is `B - 1 ms`, so the next
 * load starts exactly at `B`. If nothing precedes `B` (a single millisecond holding more than
 * `maxRows` rows) every loaded event is kept and the horizon is `B`.
 */
export function cutLoadAtBoundary<T extends { at: Date }>(
  events: readonly T[],
  rawTimes: readonly Date[],
  maxRows: number,
): { batch: T[]; truncated: boolean; horizon: Date | null } {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (rawTimes.length <= maxRows) return { batch: sorted, truncated: false, horizon: null };
  const boundary = rawTimes[maxRows].getTime();
  const before = sorted.filter((e) => e.at.getTime() < boundary);
  if (before.length > 0 || rawTimes[0].getTime() < boundary) {
    return { batch: before, truncated: true, horizon: new Date(boundary - 1) };
  }
  return { batch: sorted.filter((e) => e.at.getTime() <= boundary), truncated: true, horizon: new Date(boundary) };
}

/** Earliest of the non-null horizons; events after it may not have been loaded. */
export function combineHorizons(...hs: Array<Date | null>): Date | null {
  let out: Date | null = null;
  for (const h of hs) if (h && (!out || h < out)) out = h;
  return out;
}

export type DocumentGroup<T extends { docId: string; at: Date }> = { docId: string; events: T[]; earliestAt: Date };

/** Group events by document, documents ordered by their earliest event, events oldest first. */
export function groupByDocument<T extends { docId: string; at: Date }>(events: readonly T[]): DocumentGroup<T>[] {
  const byDoc = new Map<string, T[]>();
  for (const e of [...events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const arr = byDoc.get(e.docId) ?? [];
    arr.push(e);
    byDoc.set(e.docId, arr);
  }
  return Array.from(byDoc.entries())
    .map(([docId, evs]) => ({ docId, events: evs, earliestAt: evs[0].at }))
    .sort((a, b) => a.earliestAt.getTime() - b.earliestAt.getTime());
}

/** Group events by link (shareId), links ordered by their earliest event. */
export function groupByLink<T extends { shareId: string; at: Date }>(events: readonly T[]): Array<{ shareId: string; events: T[] }> {
  const byLink = new Map<string, T[]>();
  for (const e of [...events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const arr = byLink.get(e.shareId) ?? [];
    arr.push(e);
    byLink.set(e.shareId, arr);
  }
  return Array.from(byLink.entries()).map(([shareId, evs]) => ({ shareId, events: evs }));
}

/**
 * Where the cursor may move after a round of sends, or null to leave it.
 *
 * - All sent: the latest event timestamp that was emailed.
 * - Some failed: never past 1 ms before the earliest failed event, so the next tick retries that
 *   document (a document sent earlier in the round may be resent — a duplicate beats a lost event).
 * - Never moves backwards.
 */
export function nextCursorAfterSends(
  current: Date,
  results: ReadonlyArray<{ events: ReadonlyArray<{ at: Date }>; sent: boolean }>,
): Date | null {
  let sentMax: number | null = null;
  let failedMin: number | null = null;
  for (const r of results) {
    for (const e of r.events) {
      const t = e.at.getTime();
      if (r.sent) sentMax = sentMax === null ? t : Math.max(sentMax, t);
      else failedMin = failedMin === null ? t : Math.min(failedMin, t);
    }
  }
  let target: number | null = sentMax;
  if (failedMin !== null) target = target === null ? failedMin - 1 : Math.min(target, failedMin - 1);
  if (target === null || target <= current.getTime()) return null;
  return new Date(target);
}

/**
 * Whether a visit is a reader coming back rather than their first open.
 *
 * The reader must have a `ShareView` (otherwise there is nothing to come back to), and the visit
 * must either not be their earliest visit on the link (a second tab minutes later counts, even on
 * the day of the first open) or have been created at least `RETURN_MIN_GAP_MS` after their first
 * view (a reader whose first visit row was never written, e.g. one from before per-visit tracking).
 */
export function isReturnVisit(v: Pick<ReturnEvent, "at" | "firstViewAt" | "firstVisitAt">): boolean {
  if (!v.firstViewAt) return false;
  if (v.firstVisitAt && v.at.getTime() > v.firstVisitAt.getTime()) return true;
  return v.at.getTime() - v.firstViewAt.getTime() >= RETURN_MIN_GAP_MS;
}

/**
 * Returns among one member's window of visits (already windowed): visits that pass
 * `isReturnVisit`, one entry per (shareId, botIdHash), keeping that reader's latest visit.
 */
export function selectReturns(visits: readonly ReturnEvent[]): ReturnEvent[] {
  const byPair = new Map<string, ReturnEvent>();
  for (const v of visits) {
    if (!isReturnVisit(v)) continue;
    const key = `${v.shareId}\u0000${v.botIdHash}`;
    const prev = byPair.get(key);
    if (!prev || v.at > prev.at) byPair.set(key, v);
  }
  return Array.from(byPair.values()).sort((a, b) => a.at.getTime() - b.at.getTime());
}

// ---------------------------------------------------------------------------------------------
// Pure composition
// ---------------------------------------------------------------------------------------------

export type ComposeContext = {
  appUrl: string;
  /** Signed one-click off link for this member (C4). */
  offUrl: string;
  plan: WorkspacePlan;
  /**
   * Which workspace this is about.
   *
   * Optional only so a caller that cannot resolve it still sends — an email missing its heading is
   * far better than no email. Every real send should pass it: "2 people opened Series A deck" is
   * ambiguous the moment the reader belongs to two workspaces, and a workspace can be a different
   * company entirely.
   */
  workspace?: EmailWorkspace | null;
};

function peopleCount(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

/** Subject for an immediate email about one document (decision 7: one email per document). */
export function immediateSubject(title: string, events: readonly NewViewerEvent[], links: ReadonlyMap<string, ViewLinkInfo>): string {
  const t = sanitizeInline(title, TITLE_MAX) || "Untitled document";
  if (events.length === 1) {
    const label = realLinkLabel(links.get(events[0].shareId));
    return `${label ?? "Someone"} opened "${t}"`;
  }
  return `${events.length} people opened "${t}"`;
}

/**
 * The period a digest covers, for its subject. The digest goes out on the last UTC hour of the day
 * and covers everything since the previous digest, so a normal window is "today". A longer window
 * (the first digest after missed days, or a long-idle cursor) names the day it starts from.
 */
export function digestPeriodPhrase(windowStart: Date, now: Date): string {
  if (now.getTime() - windowStart.getTime() <= DAY_MS + 60 * 60 * 1000) return "today";
  return `since ${MONTHS[windowStart.getUTCMonth()]} ${windowStart.getUTCDate()}`;
}

export function digestSubject(newViewers: number, returning: number, period = "today"): string {
  if (newViewers > 0) return `${peopleCount(newViewers)} opened your documents ${period}`;
  return `${peopleCount(returning)} came back to your documents ${period}`;
}

/**
 * RFC 8058 one-click unsubscribe headers. Gmail and Yahoo show their own Unsubscribe button only
 * when both are present; the mail provider POSTs `List-Unsubscribe=One-Click` to the off URL.
 */
export function viewEmailHeaders(offUrl: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${offUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/** "09:40 UTC". */
export function formatTimeUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** Time only when every event is on the same UTC day, else the full date and time. */
function eventTimeFormatter(events: ReadonlyArray<{ at: Date }>): (d: Date) => string {
  const oneDay = new Set(events.map((e) => e.at.toISOString().slice(0, 10))).size <= 1;
  return oneDay ? formatTimeUtc : formatWhenUtc;
}

/**
 * Inbox preview line (hidden preheader) for an immediate email. Pro: link and how far (and the
 * viewer's name when known). Free: link and when only; never a name, pages or time on page.
 */
export function immediatePreheader(
  doc: ViewDocInfo,
  events: readonly NewViewerEvent[],
  links: ReadonlyMap<string, ViewLinkInfo>,
  plan: WorkspacePlan,
): string {
  const pro = plan === "pro";
  if (!events.length) return "";
  if (events.length === 1) {
    const ev = events[0];
    const parts: string[] = [];
    const name = pro ? viewerDisplayName(ev) : null;
    if (name) parts.push(name);
    parts.push(linkDisplayName(links.get(ev.shareId)));
    parts.push(pro ? (formatHowFar(ev, doc.pageCount) ?? "Just opened") : formatWhenUtc(ev.at));
    return parts.join(" · ");
  }
  const shareIds = new Set(events.map((e) => e.shareId));
  const linkPart = shareIds.size === 1 ? linkDisplayName(links.get(events[0].shareId)) : `${shareIds.size} links`;
  const parts = [linkPart, peopleCount(events.length)];
  if (pro) {
    const furthest = [...events].sort((a, b) => b.pagesSeen - a.pagesSeen || b.timeSpentMs - a.timeSpentMs)[0];
    const howFar = formatHowFar(furthest, doc.pageCount);
    parts.push(howFar ? `furthest ${howFar}` : "just opened");
  } else {
    parts.push(`latest ${formatWhenUtc(events[events.length - 1].at)}`);
  }
  return parts.join(" · ");
}

/** Inbox preview line for a digest: counts only (identical on Free and Pro). */
export function digestPreheader(newViewers: number, returning: number, documents: number): string {
  const parts: string[] = [];
  if (newViewers > 0) parts.push(`${newViewers} opened`);
  if (returning > 0) parts.push(`${returning} came back`);
  if (documents > 0) parts.push(`${documents} document${documents === 1 ? "" : "s"}`);
  return parts.join(" · ");
}



/**
 * Why this arrived and how to stop it — the half of the footer only notifications have.
 *
 * Transactional mail passes a signature instead: there is no "off" for a download approval, and a
 * footer implying there is would be worse than none.
 */
function viewFooter(ctx: ComposeContext): EmailFooter {
  const name = (ctx.workspace?.name ?? "").trim();
  return {
    // Naming the workspace here answers "why am I getting this" and "for which company" in the
    // same breath, which is the question a member of several workspaces actually has.
    reason: name
      ? `You get this because someone opened a link to a document in ${name}.`
      : VIEW_EMAIL_FOOTER_REASON,
    links: [
      { label: TURN_OFF_LABEL, url: ctx.offUrl },
      { label: CHANGE_HOW_OFTEN_LABEL, url: buildPreferencesUrl(ctx.appUrl) },
    ],
  };
}

function composed(subject: string, preheader: string, blocks: readonly Block[], ctx: ComposeContext): ComposedEmail {
  const footer = viewFooter(ctx);
  const workspace = ctx.workspace ?? null;
  return {
    subject,
    text: renderText(blocks, footer, workspace),
    html: renderHtml({ subject, preheader, blocks, footer, workspace }),
    headers: viewEmailHeaders(ctx.offUrl),
  };
}

/**
 * Immediate email for one document and one member: every new viewer of that document since the
 * cursor. Pro names viewers and says how far they read; Free says which link and when only.
 */
export function composeImmediateEmail(params: {
  ctx: ComposeContext;
  doc: ViewDocInfo;
  events: readonly NewViewerEvent[];
  links: ReadonlyMap<string, ViewLinkInfo>;
}): ComposedEmail {
  const { ctx, doc, events, links } = params;
  const pro = ctx.plan === "pro";
  const title = sanitizeInline(doc.title, TITLE_MAX) || "Untitled document";
  const subject = immediateSubject(title, events, links);
  const shareIds = Array.from(new Set(events.map((e) => e.shareId)));
  /**
   * One reader gets a link to that reader; several get the document, which is where a list lives.
   * Falls back to the document page whenever the reader page cannot be addressed, so the mail
   * always has somewhere to go.
   */
  const single = events.length === 1 ? events[0] : null;
  const readerUrl = single ? buildReaderUrl(ctx.appUrl, single, links.get(single.shareId)) : null;
  const actionUrl = readerUrl ?? buildMetricsUrl(ctx.appUrl, doc.docId, shareIds.length === 1 ? shareIds[0] : null);
  const actionLabel = readerUrl ? READER_ACTION_LABEL : PRIMARY_ACTION_LABEL;

  const blocks: Block[] = [];
  if (single) {
    const ev = single;
    const link = links.get(ev.shareId);
    const label = realLinkLabel(link);
    const name = pro ? viewerDisplayName(ev) : null;
    const who = name ?? (label ? `Someone on the ${label} link` : "Someone");
    blocks.push({ kind: "heading", text: `${who} opened "${title}"` });
    blocks.push({ kind: "rows", rows: viewerRows(ev, link, doc, pro) });
    // Only where a name was actually printed: on Free nothing was said about who they are, so
    // there is no claim on the page to qualify.
    if (name && isVolunteeredIdentity(ev)) blocks.push({ kind: "muted", text: VOLUNTEERED_IDENTITY_NOTE });
  } else {
    blocks.push({ kind: "heading", text: `${events.length} people opened "${title}"` });
    const when = eventTimeFormatter(events);
    // Only the first `IMMEDIATE_MAX_VIEWERS` readers get a line of their own. `events` is oldest
    // first here (the loaders and `groupByDocument` both sort that way), so the slice keeps the
    // same end the digest's document slice does. The heading above and the subject still count
    // every reader — the cap shortens the list, it does not hide anyone from the totals.
    const listed = events.slice(0, IMMEDIATE_MAX_VIEWERS);
    const overflow = events.length - listed.length;
    if (shareIds.length === 1) {
      // Every viewer came through the same link: say it once, then one line per viewer.
      blocks.push({ kind: "rows", rows: linkRows(links.get(shareIds[0])) });
      for (const ev of listed) {
        const parts: string[] = [];
        const name = pro ? viewerDisplayName(ev) : null;
        if (name) parts.push(name);
        parts.push(when(ev.at));
        if (pro) parts.push(formatHowFar(ev, doc.pageCount) ?? "Just opened");
        blocks.push({ kind: "subheading", text: parts.join(" · "), compact: true });
      }
    } else {
      for (const ev of listed) {
        const link = links.get(ev.shareId);
        const name = pro ? viewerDisplayName(ev) : null;
        blocks.push({ kind: "subheading", text: [...(name ? [name] : []), linkDisplayName(link), when(ev.at)].join(" · ") });
        const rows: Array<[string, string]> = [];
        const audience = sanitizeInline(link?.audience, AUDIENCE_MAX);
        if (audience) rows.push(["Audience", audience]);
        if (pro) rows.push(["How far", formatHowFar(ev, doc.pageCount) ?? "Just opened"]);
        if (rows.length) blocks.push({ kind: "rows", rows });
      }
    }
    if (overflow > 0) {
      blocks.push({
        kind: "muted",
        text: `${overflow} more ${overflow === 1 ? "reader is" : "readers are"} included in the count above; see them all on the metrics page.`,
      });
    }
  }

  if (events.some((ev) => needsFirstViewHonesty(ev, links.get(ev.shareId), ctx.plan))) {
    blocks.push({ kind: "muted", text: FIRST_VIEW_HONESTY_LINE });
  }
  blocks.push({ kind: "action", label: actionLabel, url: actionUrl });
  if (!pro) blocks.push({ kind: "muted", text: PRO_IDENTITY_LINE });

  return composed(subject, immediatePreheader(doc, events, links, ctx.plan), blocks, ctx);
}

/** Link and audience rows for a link. */
function linkRows(link: ViewLinkInfo | undefined): Array<[string, string]> {
  const rows: Array<[string, string]> = [["Link", linkDisplayName(link)]];
  const audience = sanitizeInline(link?.audience, AUDIENCE_MAX);
  if (audience) rows.push(["Audience", audience]);
  return rows;
}

/** Rows for a single-viewer email. "Who" only when the viewer can be named (Pro). */
function viewerRows(ev: NewViewerEvent, link: ViewLinkInfo | undefined, doc: ViewDocInfo, pro: boolean): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const name = pro ? viewerDisplayName(ev) : null;
  if (name) rows.push(["Who", name]);
  rows.push(...linkRows(link));
  rows.push(["When", formatWhenUtc(ev.at)]);
  if (pro) {
    const howFar = formatHowFar(ev, doc.pageCount);
    rows.push(["How far", howFar ? `${howFar} so far` : "Just opened"]);
  }
  return rows;
}

/** Pro-only: the reader on a link who spent longest, when they can be named. */
export function topNamedViewer(events: readonly ViewEvent[]): ViewEvent | null {
  let best: ViewEvent | null = null;
  for (const e of events) {
    if (!viewerDisplayName(e)) continue;
    if (!best || e.timeSpentMs > best.timeSpentMs) best = e;
  }
  return best;
}

/**
 * Daily digest for one member: one section per document, one line per link, new viewers and
 * returns as counts, the top viewer named on Pro.
 */
export function composeDigestEmail(params: {
  ctx: ComposeContext;
  docs: ReadonlyMap<string, ViewDocInfo>;
  views: readonly NewViewerEvent[];
  returns: readonly ReturnEvent[];
  links: ReadonlyMap<string, ViewLinkInfo>;
  /** Subject period, from `digestPeriodPhrase`; defaults to "today". */
  period?: string;
}): ComposedEmail {
  const { ctx, docs, views, returns, links } = params;
  const pro = ctx.plan === "pro";
  const subject = digestSubject(views.length, returns.length, params.period);

  const blocks: Block[] = [{ kind: "heading", text: subject }];
  if (views.length > 0 && returns.length > 0) {
    blocks.push({ kind: "p", text: `${peopleCount(returns.length)} came back for another look.` });
  }

  const all: ViewEvent[] = [...views, ...returns];
  const groups = groupByDocument(all).filter((g) => docs.has(g.docId));
  for (const group of groups.slice(0, DIGEST_MAX_DOCUMENTS)) {
    const doc = docs.get(group.docId);
    if (!doc) continue;
    const title = sanitizeInline(doc.title, TITLE_MAX) || "Untitled document";
    blocks.push({ kind: "subheading", text: title });
    const items: string[] = [];
    const linkGroups = groupByLink(group.events);
    for (const lg of linkGroups) {
      const link = links.get(lg.shareId);
      const opened = lg.events.filter((e) => e.kind === "view").length;
      const back = lg.events.filter((e) => e.kind === "return").length;
      const counts: string[] = [];
      if (opened) counts.push(`${opened} opened`);
      if (back) counts.push(`${back} came back`);
      let line = `${linkDisplayName(link)}: ${counts.join(", ")}`;
      const audience = sanitizeInline(link?.audience, AUDIENCE_MAX);
      if (audience) line = `${linkDisplayName(link)} (${audience}): ${counts.join(", ")}`;
      if (pro) {
        const top = topNamedViewer(lg.events);
        if (top) {
          const howFar = formatHowFar(top, doc.pageCount);
          line += ` · top: ${viewerDisplayName(top)}${howFar ? ` (${howFar})` : ""}`;
        }
      }
      items.push(line);
    }
    blocks.push({ kind: "bullets", items });
    blocks.push({
      kind: "action",
      label: PRIMARY_ACTION_LABEL,
      url: buildMetricsUrl(ctx.appUrl, doc.docId, linkGroups.length === 1 ? linkGroups[0].shareId : null),
    });
  }
  const moreDocs = groups.length - DIGEST_MAX_DOCUMENTS;
  if (moreDocs > 0) {
    blocks.push({
      kind: "muted",
      text: `${moreDocs} more document${moreDocs === 1 ? "" : "s"} also had activity and are included in the total above.`,
    });
  }

  if (views.some((ev) => needsFirstViewHonesty(ev, links.get(ev.shareId), ctx.plan))) {
    blocks.push({ kind: "muted", text: FIRST_VIEW_HONESTY_LINE });
  }
  if (!pro) blocks.push({ kind: "muted", text: PRO_IDENTITY_LINE });

  return composed(subject, digestPreheader(views.length, returns.length, groups.length), blocks, ctx);
}

// ---------------------------------------------------------------------------------------------
// Loaders (Mongo -> plain objects)
// ---------------------------------------------------------------------------------------------

function idString(v: unknown): string | null {
  const s = v ? String(v) : "";
  return Types.ObjectId.isValid(s) ? s : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function distinctPages(v: unknown): number {
  if (!Array.isArray(v)) return 0;
  return new Set(v.filter((n) => Number.isFinite(n) && Number(n) >= 1).map((n) => Math.floor(Number(n)))).size;
}

function nonNegative(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function dateOf(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(v as string | number | Date);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type LoadedEvents<T> = {
  /** Events in the loaded range, oldest first. */
  batch: T[];
  /** True when the safety cap cut the load before `until`. */
  truncated: boolean;
  /** When truncated: the latest instant the batch fully covers. Null when the window is covered. */
  horizon: Date | null;
};

export type LoadRangeParams = {
  orgId: Types.ObjectId;
  since: Date;
  until: Date;
  /** Rows per query (default `VIEW_LOAD_PAGE_SIZE`). */
  pageSize?: number;
  /** Safety cap on rows loaded (default `VIEW_LOAD_MAX_ROWS`). */
  maxRows?: number;
};

/**
 * Page through a (`createdDate`, `_id`)-sorted range until it is exhausted or more than `maxRows`
 * rows were fetched. `fetchPage` receives the keyset of the previous page's last row.
 */
async function fetchCreatedDatePages(
  fetchPage: (after: { at: Date; id: unknown } | null, limit: number) => Promise<unknown[]>,
  pageSize: number,
  maxRows: number,
): Promise<{ rows: any[]; rawTimes: Date[] }> {
  const rows: any[] = [];
  let after: { at: Date; id: unknown } | null = null;
  for (;;) {
    const want = Math.min(pageSize, maxRows + 1 - rows.length);
    if (want <= 0) break;
    const page = (await fetchPage(after, want)) as any[];
    rows.push(...page);
    if (page.length < want) break;
    const last = page[page.length - 1];
    const lastAt = dateOf(last?.createdDate);
    if (!lastAt || last?._id == null) break;
    after = { at: lastAt, id: last._id };
  }
  const rawTimes = rows.map((r) => dateOf(r?.createdDate)).filter((d): d is Date => Boolean(d));
  return { rows, rawTimes };
}

/** The window filter plus, after the first page, the keyset continuation. */
function createdDateRangeFilter(
  p: LoadRangeParams,
  after: { at: Date; id: unknown } | null,
): Record<string, unknown> {
  return {
    orgId: p.orgId,
    createdDate: { $gt: p.since, $lte: p.until },
    ...RECIPIENT_ONLY_MATCH,
    ...(after ? { $or: [{ createdDate: { $gt: after.at } }, { createdDate: after.at, _id: { $gt: after.id } }] } : {}),
  };
}

/** The fields a `NewViewerEvent` is built from, so both loaders read the same row shape. */
const SHARE_VIEW_EVENT_FIELDS = {
  _id: 1,
  shareId: 1,
  docId: 1,
  shareLinkId: 1,
  botIdHash: 1,
  createdDate: 1,
  pagesSeen: 1,
  timeSpentMs: 1,
  viewerUserId: 1,
  viewerEmail: 1,
  viewerName: 1,
  viewerEmailSnapshot: 1,
} as const;

/** One `ShareView` row as an event, or null when it is missing something the email needs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toNewViewerEvent(r: any): NewViewerEvent | null {
  const id = idString(r?._id);
  const docId = idString(r?.docId);
  const shareId = str(r?.shareId);
  const at = dateOf(r?.createdDate);
  if (!id || !docId || !shareId || !at) return null;
  return {
    kind: "view",
    id,
    docId,
    shareId,
    shareLinkId: idString(r?.shareLinkId),
    botIdHash: str(r?.botIdHash) ?? "",
    at,
    pagesSeen: distinctPages(r?.pagesSeen),
    timeSpentMs: nonNegative(r?.timeSpentMs),
    viewerUserId: idString(r?.viewerUserId),
    viewerName: str(r?.viewerName),
    viewerEmail: str(r?.viewerEmailSnapshot) ?? str(r?.viewerEmail),
    viewerUserName: null,
  };
}

/**
 * Recipient views created in (since, until], oldest first. Loaded in pages until the range is
 * covered; only the `maxRows` safety cap can cut it, at a timestamp boundary (`cutLoadAtBoundary`).
 */
export async function loadNewViewerEvents(params: LoadRangeParams): Promise<LoadedEvents<NewViewerEvent>> {
  const pageSize = params.pageSize ?? VIEW_LOAD_PAGE_SIZE;
  const maxRows = params.maxRows ?? VIEW_LOAD_MAX_ROWS;
  const { rows, rawTimes } = await fetchCreatedDatePages(
    (after, limit) =>
      ShareViewModel.find(createdDateRangeFilter(params, after))
        .sort({ createdDate: 1, _id: 1 })
        .limit(limit)
        .select(SHARE_VIEW_EVENT_FIELDS)
        .lean(),
    pageSize,
    maxRows,
  );

  const events: NewViewerEvent[] = [];
  for (const r of rows) {
    const event = toNewViewerEvent(r);
    if (event) events.push(event);
  }
  return cutLoadAtBoundary(events, rawTimes, maxRows);
}

/**
 * The same recipient views, addressed by id instead of by window.
 *
 * The notification queue names the `ShareView` row each email is owed for (M3 drains rows rather
 * than scanning a time range), but that row is still what knows how far the reader got, so the
 * email cannot be rendered from the queue entry alone. Owner previews are filtered here as well as
 * at enqueue: a view flagged as a preview after the fact must not go out as "someone opened it".
 *
 * A row that no longer exists is simply absent from the result — what a notification about a
 * deleted view means is the caller's decision, not the loader's.
 */
export async function loadNewViewerEventsByIds(
  orgId: Types.ObjectId,
  shareViewIds: readonly string[],
): Promise<Map<string, NewViewerEvent>> {
  const out = new Map<string, NewViewerEvent>();
  const ids = Array.from(new Set(shareViewIds)).filter((id) => Types.ObjectId.isValid(id));
  for (const part of chunk(ids, 500)) {
    const rows = await ShareViewModel.find({
      _id: { $in: part.map((id) => new Types.ObjectId(id)) },
      orgId,
      ...RECIPIENT_ONLY_MATCH,
    })
      .select(SHARE_VIEW_EVENT_FIELDS)
      .lean();
    for (const r of rows as any[]) {
      const event = toNewViewerEvent(r);
      if (event) out.set(event.id, event);
    }
  }
  return out;
}

/**
 * Recipient visits created in (since, until] (server `createdDate`, not the browser's `startedAt`),
 * each joined to its reader's `ShareView.createdDate` (`firstViewAt`) and earliest visit
 * (`firstVisitAt`). Whether a visit is a return is decided by `selectReturns`.
 */
export async function loadVisitEvents(params: LoadRangeParams): Promise<LoadedEvents<ReturnEvent>> {
  const pageSize = params.pageSize ?? VIEW_LOAD_PAGE_SIZE;
  const maxRows = params.maxRows ?? VIEW_LOAD_MAX_ROWS;
  const { rows, rawTimes } = await fetchCreatedDatePages(
    (after, limit) =>
      ShareVisitModel.find(createdDateRangeFilter(params, after))
        .sort({ createdDate: 1, _id: 1 })
        .limit(limit)
        .select({
          _id: 1,
          shareId: 1,
          docId: 1,
          shareLinkId: 1,
          botIdHash: 1,
          createdDate: 1,
          pagesSeen: 1,
          timeSpentMs: 1,
          viewerUserId: 1,
          viewerEmail: 1,
          viewerName: 1,
          viewerEmailSnapshot: 1,
        })
        .lean(),
    pageSize,
    maxRows,
  );

  const events: ReturnEvent[] = [];
  for (const r of rows) {
    const id = idString(r?._id);
    const docId = idString(r?.docId);
    const shareId = str(r?.shareId);
    const botIdHash = str(r?.botIdHash);
    const at = dateOf(r?.createdDate);
    if (!id || !docId || !shareId || !botIdHash || !at) continue;
    events.push({
      kind: "return",
      id,
      docId,
      shareId,
      shareLinkId: idString(r?.shareLinkId),
      botIdHash,
      at,
      firstViewAt: null,
      firstVisitAt: null,
      pagesSeen: distinctPages(r?.pagesSeen),
      timeSpentMs: nonNegative(r?.timeSpentMs),
      viewerUserId: idString(r?.viewerUserId),
      viewerName: str(r?.viewerName),
      viewerEmail: str(r?.viewerEmailSnapshot) ?? str(r?.viewerEmail),
      viewerUserName: null,
    });
  }
  const loaded = cutLoadAtBoundary(events, rawTimes, maxRows);
  if (!loaded.batch.length) return loaded;

  const pairKey = (shareId: string, botIdHash: string) => `${shareId}\u0000${botIdHash}`;
  const pairs = new Map<string, { shareId: string; botIdHash: string }>();
  for (const e of loaded.batch) pairs.set(pairKey(e.shareId, e.botIdHash), { shareId: e.shareId, botIdHash: e.botIdHash });

  const firstViewByPair = new Map<string, Date>();
  const firstVisitByPair = new Map<string, Date>();
  for (const part of chunk(Array.from(pairs.values()), 500)) {
    const match = {
      shareId: { $in: Array.from(new Set(part.map((p) => p.shareId))) },
      botIdHash: { $in: Array.from(new Set(part.map((p) => p.botIdHash))) },
    };
    const views = await ShareViewModel.find(match).select({ shareId: 1, botIdHash: 1, createdDate: 1 }).lean();
    for (const v of views as any[]) {
      const sid = str(v?.shareId);
      const bid = str(v?.botIdHash);
      const at = dateOf(v?.createdDate);
      if (sid && bid && at) firstViewByPair.set(pairKey(sid, bid), at);
    }
    const firstVisits = await ShareVisitModel.aggregate([
      { $match: match },
      { $group: { _id: { shareId: "$shareId", botIdHash: "$botIdHash" }, first: { $min: "$createdDate" } } },
    ]);
    for (const g of firstVisits as any[]) {
      const sid = str(g?._id?.shareId);
      const bid = str(g?._id?.botIdHash);
      const at = dateOf(g?.first);
      if (sid && bid && at) firstVisitByPair.set(pairKey(sid, bid), at);
    }
  }
  for (const e of loaded.batch) {
    e.firstViewAt = firstViewByPair.get(pairKey(e.shareId, e.botIdHash)) ?? null;
    e.firstVisitAt = firstVisitByPair.get(pairKey(e.shareId, e.botIdHash)) ?? null;
  }
  return loaded;
}

/** Documents of the workspace that are neither deleted nor archived. */
export async function loadViewDocs(orgId: Types.ObjectId, docIds: readonly string[]): Promise<Map<string, ViewDocInfo>> {
  const out = new Map<string, ViewDocInfo>();
  const ids = Array.from(new Set(docIds)).filter((id) => Types.ObjectId.isValid(id));
  for (const part of chunk(ids, 1000)) {
    const docs = await DocModel.find({
      _id: { $in: part.map((id) => new Types.ObjectId(id)) },
      orgId,
      isDeleted: { $ne: true },
      isArchived: { $ne: true },
    })
      .select({ _id: 1, title: 1, "slideNodes.pageNumber": 1 })
      .lean();
    for (const d of docs as any[]) {
      const id = idString(d?._id);
      if (!id) continue;
      const nodes = Array.isArray(d?.slideNodes) ? d.slideNodes : [];
      const nums = nodes.map((n: any) => Number(n?.pageNumber)).filter((n: number) => Number.isFinite(n) && n >= 1);
      const pageCount = nums.length ? Math.max(...nums) : nodes.length || null;
      out.set(id, { docId: id, title: str(d?.title) ?? "Untitled document", pageCount });
    }
  }
  return out;
}

/** Link label/audience by shareId, falling back to shareLinkId. Link state is deliberately ignored. */
export async function loadViewLinks(events: readonly ViewEvent[]): Promise<Map<string, ViewLinkInfo>> {
  const out = new Map<string, ViewLinkInfo>();
  const shareIds = Array.from(new Set(events.map((e) => e.shareId)));
  const linkIds = Array.from(new Set(events.map((e) => e.shareLinkId).filter((id): id is string => Boolean(id))));
  if (!shareIds.length) return out;
  const rows = await ShareLinkModel.find({
    $or: [{ shareId: { $in: shareIds } }, ...(linkIds.length ? [{ _id: { $in: linkIds.map((id) => new Types.ObjectId(id)) } }] : [])],
  })
    .select({ _id: 1, shareId: 1, label: 1, audience: 1, isDefault: 1, createdDate: 1, projectId: 1 })
    .lean();
  const byLinkId = new Map<string, ViewLinkInfo>();
  for (const r of rows as any[]) {
    const shareId = str(r?.shareId);
    if (!shareId) continue;
    const info: ViewLinkInfo = {
      shareId,
      label: str(r?.label),
      audience: str(r?.audience),
      isDefault: r?.isDefault === true,
      createdDate: r?.createdDate ? new Date(r.createdDate) : null,
      projectId: idString(r?.projectId),
    };
    out.set(shareId, info);
    const lid = idString(r?._id);
    if (lid) byLinkId.set(lid, info);
  }
  for (const e of events) {
    if (out.has(e.shareId) || !e.shareLinkId) continue;
    const info = byLinkId.get(e.shareLinkId);
    if (info) out.set(e.shareId, info);
  }
  return out;
}

/** Names of signed-in viewers (Pro only). */
export async function loadViewerUserNames(userIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(userIds)).filter((id) => Types.ObjectId.isValid(id));
  if (!ids.length) return out;
  const users = await UserModel.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
    .select({ _id: 1, name: 1 })
    .lean();
  for (const u of users as any[]) {
    const id = idString(u?._id);
    const name = str(u?.name);
    if (id && name) out.set(id, name);
  }
  return out;
}

type ViewCursor = { lastNotifiedAt: Date | null; returnsNotifiedAt: Date | null; lastDigestDay: string | null };

async function loadViewCursors(orgId: Types.ObjectId, userIds: readonly string[]): Promise<Map<string, ViewCursor>> {
  const out = new Map<string, ViewCursor>();
  if (!userIds.length) return out;
  const rows = await NotificationEmailCursorModel.find({
    orgId,
    userId: { $in: userIds.map((id) => new Types.ObjectId(id)) },
    key: VIEW_EMAIL_CURSOR_KEY,
  })
    .select({ userId: 1, lastNotifiedAt: 1, returnsNotifiedAt: 1, lastDigestDay: 1 })
    .lean();
  for (const c of rows as any[]) {
    const uid = idString(c?.userId);
    if (!uid) continue;
    out.set(uid, {
      lastNotifiedAt: c?.lastNotifiedAt ? new Date(c.lastNotifiedAt) : null,
      returnsNotifiedAt: c?.returnsNotifiedAt ? new Date(c.returnsNotifiedAt) : null,
      lastDigestDay: typeof c?.lastDigestDay === "string" ? c.lastDigestDay : null,
    });
  }
  return out;
}

type CursorAdvance = { userId: string; lastNotifiedAt?: Date; returnsNotifiedAt?: Date };

/**
 * Move the new-viewer and/or returns horizon for many members in one round trip (off, first seen,
 * nothing to send). Entries for the same member are merged into one update. Never moves a cursor
 * backwards.
 */
async function setCursors(orgId: Types.ObjectId, entries: ReadonlyArray<CursorAdvance>): Promise<void> {
  const byUser = new Map<string, { lastNotifiedAt?: Date; returnsNotifiedAt?: Date }>();
  for (const e of entries) {
    const cur = byUser.get(e.userId) ?? {};
    if (e.lastNotifiedAt && (!cur.lastNotifiedAt || e.lastNotifiedAt > cur.lastNotifiedAt)) cur.lastNotifiedAt = e.lastNotifiedAt;
    if (e.returnsNotifiedAt && (!cur.returnsNotifiedAt || e.returnsNotifiedAt > cur.returnsNotifiedAt)) {
      cur.returnsNotifiedAt = e.returnsNotifiedAt;
    }
    byUser.set(e.userId, cur);
  }
  if (!byUser.size) return;
  // Same filter shape as `upsertCursor` in sendNotificationEmails.ts, batched. `$max` so an
  // overlapping or delayed run can never rewind a cursor another run already moved further.
  const ops = Array.from(byUser.entries()).map(([uid, fields]) => {
    const userId = new Types.ObjectId(uid);
    return {
      updateOne: {
        filter: { orgId, userId, key: VIEW_EMAIL_CURSOR_KEY },
        update: { $max: fields, $setOnInsert: { orgId, userId, key: VIEW_EMAIL_CURSOR_KEY } },
        upsert: true,
      },
    };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await NotificationEmailCursorModel.bulkWrite(ops as any, { ordered: false });
}

// ---------------------------------------------------------------------------------------------
// Orchestration — DEPRECATED, no longer called by the send path
//
// `sendNotificationEmails` drains the notification queue instead of scanning behind these cursors
// (docs/prds/lnkdrp-notification-queue.md, M3). Everything below — the totals, the cursor loads and
// `runViewNotificationsForOrg` — is kept for one release for the same reason the cursor model is
// (decision 7): work in flight against it must not break at import time. Nothing calls it; do not
// wire it back up. The composition and loaders above are what the queue reader reuses.
// ---------------------------------------------------------------------------------------------

export type ViewNotificationTotals = {
  immediate: { members: number; emails: number; events: number; failed: number };
  /**
   * Digests. Immediate-mode members get a returns-only digest at the end-of-day tick (returns are
   * never sent immediately), and those count here too.
   */
  daily: { members: number; emails: number; events: number; returns: number; failed: number; sentTodayUtc: boolean };
  /** Members on `off` whose cursor was moved to now. */
  off: { members: number };
  /** Cursors created at now with nothing sent (first sight of a member). */
  cursorsInitialized: number;
  /**
   * Workspace loads cut by the per-tick safety cap (`VIEW_LOAD_MAX_ROWS`). Nothing is lost: cursors
   * stop at the cut and the next tick continues from there. Non-zero means unusual volume.
   */
  truncatedLoads: number;
  /** Workspaces whose view block threw (logged; other blocks and workspaces carry on). */
  errors: number;
};

export function emptyViewNotificationTotals(allowDaily: boolean): ViewNotificationTotals {
  return {
    immediate: { members: 0, emails: 0, events: 0, failed: 0 },
    daily: { members: 0, emails: 0, events: 0, returns: 0, failed: 0, sentTodayUtc: allowDaily },
    off: { members: 0 },
    cursorsInitialized: 0,
    truncatedLoads: 0,
    errors: 0,
  };
}

export type ViewMember = { membershipId: string; userId: string; mode: ViewEmailMode };

export type ViewNotificationDeps = {
  send: (args: {
    to: string;
    subject: string;
    text: string;
    html: string;
    /**
     * RFC 8058 one-click unsubscribe headers (`viewEmailHeaders`). The sender must pass them to
     * `sendTextEmail` so Gmail and Yahoo offer their own Unsubscribe button.
     */
    headers: Record<string, string>;
    context: { orgId: string; userId: string; mode: ViewEmailMode };
  }) => Promise<boolean>;
  /** Sets only the fields given (a missing field is left as it is). */
  upsertCursor: (args: {
    orgId: Types.ObjectId;
    userId: Types.ObjectId;
    lastNotifiedAt?: Date;
    returnsNotifiedAt?: Date;
    lastDigestDay?: string;
  }) => Promise<void>;
};

export async function runViewNotificationsForOrg(
  params: {
    orgId: string;
    members: readonly ViewMember[];
    recipients: ReadonlyMap<string, { email: string | null }>;
    now: Date;
    dryRun: boolean;
    allowDaily: boolean;
    todayUtc: string;
    /** Immediate emails only: max new viewers per member per tick (the rest follow next tick). */
    limitEventsPerMember: number;
    defaultLookbackDays: number;
    appUrl: string;
    /** Rows per load query (default `VIEW_LOAD_PAGE_SIZE`). */
    loadPageSize?: number;
    /** Safety cap on rows loaded per kind (default `VIEW_LOAD_MAX_ROWS`). */
    loadMaxRows?: number;
  },
  deps: ViewNotificationDeps,
  totals: ViewNotificationTotals,
): Promise<{ sendFailures: number }> {
  const { now, dryRun } = params;
  const orgId = new Types.ObjectId(params.orgId);
  let sendFailures = 0;
  if (!params.members.length) return { sendFailures };

  const until = settledUntil(now);
  const cursors = await loadViewCursors(
    orgId,
    params.members.map((m) => m.userId),
  );

  // Cursors set to now with nothing sent: off, first sight, or no address to send to.
  const resetIds: string[] = [];
  const active: Array<{
    member: ViewMember & { mode: "daily" | "immediate" };
    to: string;
    /** New-viewer horizon (`lastNotifiedAt`). */
    viewsCursor: Date;
    /** Returns horizon (`returnsNotifiedAt`, falling back to `lastNotifiedAt` on older cursors). */
    returnsCursor: Date;
    /**
     * Set only on an older cursor with no `returnsNotifiedAt`: the fallback horizon, written as
     * `returnsNotifiedAt` alongside any new-viewer advance. Without it the fallback would follow
     * `lastNotifiedAt` and every immediate tick would push unreported returns behind the horizon.
     */
    returnsSeed: Date | null;
    /** New-viewer window start this tick; null when there is no new-viewer work. */
    viewsStart: Date | null;
    /** Digest window start for returns; null when no digest is due this tick. */
    returnsStart: Date | null;
  }> = [];

  for (const m of params.members) {
    const cur = cursors.get(m.userId);
    if (m.mode === "off") {
      totals.off.members += 1;
      resetIds.push(m.userId);
      continue;
    }
    if (!cur?.lastNotifiedAt) {
      totals.cursorsInitialized += 1;
      resetIds.push(m.userId);
      continue;
    }
    const to = params.recipients.get(m.userId)?.email ?? null;
    if (!to) {
      resetIds.push(m.userId);
      continue;
    }
    const viewsCursor = cur.lastNotifiedAt;
    const returnsCursor = cur.returnsNotifiedAt ?? cur.lastNotifiedAt;
    const returnsSeed = cur.returnsNotifiedAt ? null : returnsCursor;
    const digestDue = params.allowDaily && cur.lastDigestDay !== params.todayUtc;
    const open = (d: Date): Date | null => (d < until ? d : null);
    const digestStart = (c: Date) => open(memberWindowStart("daily", c, now, params.defaultLookbackDays));
    let viewsStart: Date | null;
    let returnsStart: Date | null;
    if (m.mode === "immediate") {
      viewsStart = open(memberWindowStart("immediate", viewsCursor, now, params.defaultLookbackDays));
      returnsStart = digestDue ? digestStart(returnsCursor) : null;
    } else {
      if (!digestDue) continue;
      viewsStart = digestStart(viewsCursor);
      returnsStart = digestStart(returnsCursor);
    }
    if (!viewsStart && !returnsStart) continue;
    active.push({ member: { ...m, mode: m.mode }, to, viewsCursor, returnsCursor, returnsSeed, viewsStart, returnsStart });
  }

  if (!dryRun) {
    await setCursors(
      orgId,
      resetIds.map((userId) => ({ userId, lastNotifiedAt: now, returnsNotifiedAt: now })),
    );
  }
  if (!active.length) return { sendFailures };

  if (!/^https?:\/\//i.test(params.appUrl)) {
    // Every link in a view email (the action, the one-click off link, preferences) would be relative
    // and dead in a mail client. Send nothing and move no send cursor, so the events go out once the
    // site URL is configured.
    throw new Error("[view-emails] no absolute site URL (set NEXT_PUBLIC_SITE_URL); view emails not sent");
  }

  const minStart = (starts: Array<Date | null>): Date | null =>
    starts.reduce<Date | null>((min, d) => (d && (!min || d < min) ? d : min), null);
  const viewsSince = minStart(active.map((a) => a.viewsStart));
  const visitsSince = minStart(active.map((a) => a.returnsStart));
  const rangeFrom = (since: Date): LoadRangeParams => ({ orgId, since, until, pageSize: params.loadPageSize, maxRows: params.loadMaxRows });
  const viewsLoad: LoadedEvents<NewViewerEvent> = viewsSince
    ? await loadNewViewerEvents(rangeFrom(viewsSince))
    : { batch: [], truncated: false, horizon: null };
  const visitsLoad: LoadedEvents<ReturnEvent> = visitsSince
    ? await loadVisitEvents(rangeFrom(visitsSince))
    : { batch: [], truncated: false, horizon: null };
  if (viewsLoad.truncated || visitsLoad.truncated) {
    totals.truncatedLoads += 1;
    debugError(1, "[view-emails] load hit the per-tick safety cap; continuing next tick", {
      orgId: params.orgId,
      viewsHorizon: viewsLoad.horizon?.toISOString() ?? null,
      visitsHorizon: visitsLoad.horizon?.toISOString() ?? null,
    });
  }

  // Everything up to these instants was loaded (and possibly filtered out), so cursors may move there.
  const viewsCovered = viewsLoad.horizon ?? until;
  const digestTruncated = viewsLoad.truncated || visitsLoad.truncated;
  const digestCovered = combineHorizons(viewsLoad.horizon, visitsLoad.horizon) ?? until;

  const loadedEvents: ViewEvent[] = [...viewsLoad.batch, ...visitsLoad.batch];
  const docs = loadedEvents.length ? await loadViewDocs(orgId, loadedEvents.map((e) => e.docId)) : new Map<string, ViewDocInfo>();
  const views = viewsLoad.batch.filter((e) => docs.has(e.docId));
  const visits = visitsLoad.batch.filter((e) => docs.has(e.docId));

  let plan: WorkspacePlan = "free";
  let links = new Map<string, ViewLinkInfo>();
  if (views.length || visits.length) {
    try {
      plan = (await getWorkspacePlan(orgId)) === "pro" ? "pro" : "free";
    } catch (err) {
      // Unknown plan: fall back to Free so identity can never leak.
      debugError(1, "[view-emails] plan lookup failed; treating as free", {
        orgId: params.orgId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    links = await loadViewLinks([...views, ...visits]);
    if (plan === "pro") {
      const names = await loadViewerUserNames([...views, ...visits].map((e) => e.viewerUserId).filter((id): id is string => Boolean(id)));
      for (const e of [...views, ...visits]) if (e.viewerUserId) e.viewerUserName = names.get(e.viewerUserId) ?? null;
    }
  }

  // Members with nothing to send still move to the covered instant (one bulk write at the end).
  const advances: CursorAdvance[] = [];

  for (const { member, to, viewsCursor, returnsCursor, returnsSeed, viewsStart, returnsStart } of active) {
    const userObjectId = new Types.ObjectId(member.userId);
    // Pins an older cursor's returns horizon where it is before the new-viewer horizon moves.
    const seedReturns = returnsSeed ? { returnsNotifiedAt: returnsSeed } : {};
    const ctx = (): ComposeContext => ({ appUrl: params.appUrl, offUrl: viewEmailsOffUrl(params.appUrl, member.membershipId, { now }), plan });

    if (member.mode === "immediate" && viewsStart) {
      const pending = eventsInWindow(views, viewsStart, viewsCovered);
      if (!pending.length) {
        if (viewsCovered > viewsCursor) advances.push({ userId: member.userId, lastNotifiedAt: viewsCovered, ...seedReturns });
      } else {
        const { batch, truncated: capped } = capAtTimestampBoundary(pending, params.limitEventsPerMember);
        const context = ctx();

        const results: Array<{ events: NewViewerEvent[]; sent: boolean }> = [];
        for (const group of groupByDocument(batch)) {
          const doc = docs.get(group.docId);
          if (!doc) continue;
          const email = composeImmediateEmail({ ctx: context, doc, events: group.events, links });
          const sent = await deps.send({
            to,
            ...email,
            context: { orgId: params.orgId, userId: member.userId, mode: "immediate" },
          });
          results.push({ events: group.events, sent });
          if (!sent) {
            sendFailures += 1;
            totals.immediate.failed += 1;
            // The cursor cannot pass this document; later documents would only be resent next tick.
            break;
          }
          totals.immediate.emails += 1;
          totals.immediate.events += group.events.length;
        }
        if (results.some((r) => r.sent)) totals.immediate.members += 1;

        const failed = results.some((r) => !r.sent);
        const next = failed
          ? nextCursorAfterSends(viewsStart, results)
          : capped
            ? batch[batch.length - 1].at
            : viewsCovered;
        if (next && next > viewsCursor && !dryRun) {
          await deps.upsertCursor({ orgId, userId: userObjectId, lastNotifiedAt: next, ...seedReturns });
        }
      }
    }

    // Digest (allowDaily and the lastDigestDay guard were checked above). A daily member's digest
    // has new viewers and returns; an immediate member's has returns only, since its new viewers
    // were emailed as they happened. Counts cover the whole window; no per-member cap applies.
    const isDaily = member.mode === "daily";
    if (!isDaily && !returnsStart) continue;
    const memberViews = isDaily && viewsStart ? eventsInWindow(views, viewsStart, digestCovered) : [];
    const memberReturns = returnsStart ? selectReturns(eventsInWindow(visits, returnsStart, digestCovered)) : [];
    const moveViews = isDaily && digestCovered > viewsCursor;
    const moveReturns = Boolean(returnsStart) && digestCovered > returnsCursor;
    if (!memberViews.length && !memberReturns.length) {
      if (moveViews || moveReturns) {
        advances.push({
          userId: member.userId,
          ...(moveViews ? { lastNotifiedAt: digestCovered } : {}),
          ...(moveReturns ? { returnsNotifiedAt: digestCovered } : {}),
        });
      }
      continue;
    }

    const email = composeDigestEmail({
      ctx: ctx(),
      docs,
      views: memberViews,
      returns: memberReturns,
      links,
      period: digestPeriodPhrase(minStart([isDaily ? viewsStart : null, returnsStart]) ?? until, now),
    });
    const sent = await deps.send({ to, ...email, context: { orgId: params.orgId, userId: member.userId, mode: "daily" } });
    if (!sent) {
      sendFailures += 1;
      totals.daily.failed += 1;
      continue;
    }
    totals.daily.members += 1;
    totals.daily.emails += 1;
    totals.daily.events += memberViews.length;
    totals.daily.returns += memberReturns.length;

    if (!dryRun) {
      await deps.upsertCursor({
        orgId,
        userId: userObjectId,
        ...(moveViews ? { lastNotifiedAt: digestCovered } : {}),
        ...(moveReturns ? { returnsNotifiedAt: digestCovered } : {}),
        // A load cut by the safety cap leaves today's digest open, so the next tick sends the rest
        // today rather than folding it into tomorrow's digest.
        ...(digestTruncated ? {} : { lastDigestDay: params.todayUtc }),
      });
    }
  }

  if (!dryRun) await setCursors(orgId, advances);
  return { sendFailures };
}
