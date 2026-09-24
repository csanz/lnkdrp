/**
 * Admin route: `/a/emails`
 *
 * Every email the product can send, where its body is built, and what evidence exists that one went
 * out. The last part is the reason the page exists: only download-request emails are recorded per
 * message. Everything else leaves run-level counters or nothing, and the page says which rather
 * than implying a send log that does not exist.
 *
 * The notification queue section is the one place that answers the other half of the question —
 * what is *owed* right now, and what gave up trying (docs/prds/lnkdrp-notification-queue.md, M4).
 * Its counts are live, not from a run, which is why it sits above the last-run panel.
 *
 * The previews are real bodies from the real builders, and there are a dozen of them — they open
 * on demand rather than all at once, so the catalog above them stays the thing you land on.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import Button from "@/components/ui/Button";
import Panel from "@/components/ui/Panel";
import {
  AdminAlert,
  AdminAccessState,
  AdminFilterBar,
  AdminPageHeader,
  AdminSelect,
  AdminTable,
  AdminTableEmpty,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  RowAction,
  StatusPill,
  TimeCell,
  useAdminAccess,
  AdminSection,
  RowActions,
} from "@/components/admin";
import { fmtDuration } from "@/lib/admin/format";
import {
  sendStateLabel,
  summarizeNotificationQueue,
  toDeadNotificationRows,
  traceLabel,
} from "@/lib/admin/emailsAdmin";
import type {
  DeadNotificationRow,
  EmailCatalogRow,
  EmailTrace,
  NotificationQueueSummary,
  NotificationRunSummary,
  PlanLimitsRunSummary,
  SendOutcome,
} from "@/lib/admin/emailsAdmin";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import {
  ADMIN_CODE_BLOCK,
  ADMIN_DASH,
  ADMIN_FIELD_LABEL,
  ADMIN_FIELD_VALUE,
  ADMIN_NOTE,
  type AdminTone,
  toneTextStyle,
  ADMIN_ROW_ACTION_LINK,
} from "@/lib/admin/ui";
import { fetchJson } from "@/lib/http/fetchJson";

type SnapshotRow = {
  jobKey: string;
  status: string | null;
  lastRunAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  lastErrorAt: string | null;
  lastError: string | null;
  schedule: string;
  scheduleHuman: string;
};

type OverviewPayload = {
  catalog: EmailCatalogRow[];
  notification: {
    snapshot: SnapshotRow;
    run: NotificationRunSummary | null;
    /** What the queue holds now. Null when the collection could not be read. */
    queue: NotificationQueueSummary | null;
    dead: DeadNotificationRow[];
  };
  planLimits: { snapshot: SnapshotRow; run: PlanLimitsRunSummary | null };
};

type PreviewRow = {
  key: string;
  catalogId: string;
  label: string;
  inputs: { label: string; value: string }[];
  subject: string;
  text: string;
  html: string | null;
  headers: { name: string; value: string }[] | null;
};

type UnavailablePreview = { catalogId: string; what: string; builtBy: string };

type DownloadRequestRow = {
  requestId: string;
  docId: string | null;
  requesterEmail: string | null;
  status: string | null;
  createdDate: string | null;
  approvedAt: string | null;
  deniedAt: string | null;
  requesterEmailOutcome: SendOutcome;
  ownerEmailOutcome: SendOutcome;
  claimEmailOutcome: SendOutcome;
};

const CATALOG_COLUMNS = 7;
const BUCKET_COLUMNS = 8;
const REQUEST_COLUMNS = 6;
const DEAD_COLUMNS = 6;

/** A cron job's state. `ok` is the boring case; only a failure gets a hue. */
function jobTone(status: string | null): AdminTone {
  if (status === "error") return "danger";
  if (status === "running") return "info";
  return "quiet";
}

/** How well a send is recorded: per-message is the good case, nothing at all is the bad one. */
function traceTone(trace: EmailTrace): AdminTone {
  if (trace === "per_send") return "positive";
  if (trace === "run_totals") return "warning";
  return "quiet";
}

/** A number the server actually returned, or an em dash when the field was absent. */
function n(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : ADMIN_DASH;
}

/**
 * One recorded send, on one line. A success is quiet — a column of green ticks says nothing —
 * and the timestamp or the error that explains the state lives in the cell's title.
 */
function OutcomeCell({ outcome }: { outcome: SendOutcome }) {
  const when = outcome.at ? new Date(outcome.at).toLocaleString() : null;
  if (outcome.state === "failed") {
    return (
      <StatusPill tone="danger" title={[when, outcome.error].filter(Boolean).join(": ") || undefined}>
        {outcome.error ? outcome.error : sendStateLabel(outcome.state)}
      </StatusPill>
    );
  }
  if (outcome.state === "sent") {
    return (
      <StatusPill tone="quiet" title={when ?? undefined}>
        {sendStateLabel(outcome.state)}
      </StatusPill>
    );
  }
  return (
    <span
      className="text-[var(--muted-2)]"
      title="Neither a sent-at stamp nor an error: never attempted, or the write that would have stamped it failed."
    >
      {ADMIN_DASH}
    </span>
  );
}

/** One labelled fact about a cron job. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={ADMIN_FIELD_LABEL}>{label}</dt>
      <dd className={`mt-0.5 truncate ${ADMIN_FIELD_VALUE}`}>{children}</dd>
    </div>
  );
}

/** The header line for a cron job: status, last run, duration, schedule. */
function JobSnapshot({ snapshot }: { snapshot: SnapshotRow }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
      <Fact label="Status">
        <StatusPill tone={jobTone(snapshot.status)} dot={snapshot.status !== "error"}>
          {snapshot.status ?? "never run"}
        </StatusPill>
      </Fact>
      <Fact label="Last run">
        <span className="tabular-nums">
          <TimeCell value={snapshot.lastRunAt} />
        </span>
      </Fact>
      <Fact label="Duration">
        <span className="tabular-nums">{fmtDuration(snapshot.lastDurationMs) || ADMIN_DASH}</span>
      </Fact>
      <Fact label="Schedule">
        {snapshot.schedule ? (
          <span title={`${snapshot.schedule} (${snapshot.scheduleHuman})`}>
            <span className="font-mono text-[12px]">{snapshot.schedule}</span>{" "}
            <span className="text-[var(--muted-2)]">({snapshot.scheduleHuman})</span>
          </span>
        ) : (
          ADMIN_DASH
        )}
      </Fact>
    </dl>
  );
}

/** Render the Emails admin page (fetches the catalog, previews and download-request rows). */
export default function AdminEmailsPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [previews, setPreviews] = useState<PreviewRow[]>([]);
  const [unavailable, setUnavailable] = useState<UnavailablePreview[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [requests, setRequests] = useState<DownloadRequestRow[]>([]);
  const [requestsTotal, setRequestsTotal] = useState(0);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [requestStatus, setRequestStatus] = useState("");
  const [page, setPage] = useState(1);
  const limit = 50;

  /** Which part of a preview is on screen: the text part, or the HTML part when it has one. */
  const [previewMode, setPreviewMode] = useState<Record<string, "text" | "html">>({});
  /** Which previews are unrolled. A dozen full email bodies at once is not a page. */
  const [openPreviews, setOpenPreviews] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!canUseAdmin) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [overviewData, previewData] = await Promise.all([
          fetchJson<{ catalog?: unknown; notification?: unknown; planLimits?: unknown }>(
            "/api/admin/emails/overview",
            { method: "GET" },
          ),
          fetchJson<{ previews?: unknown; unavailable?: unknown }>("/api/admin/emails/previews", {
            method: "GET",
          }),
        ]);
        const notification = (overviewData.notification ?? {}) as OverviewPayload["notification"];
        setOverview({
          catalog: Array.isArray(overviewData.catalog) ? (overviewData.catalog as EmailCatalogRow[]) : [],
          // The queue block is narrowed rather than cast: it is newer than the route's other
          // fields, so a response without it has to render as "no counts" and not as an
          // empty queue — the two mean opposite things.
          notification: {
            ...notification,
            queue: summarizeNotificationQueue(notification.queue),
            dead: toDeadNotificationRows(notification.dead),
          },
          planLimits: overviewData.planLimits as OverviewPayload["planLimits"],
        });
        setPreviews(Array.isArray(previewData.previews) ? (previewData.previews as PreviewRow[]) : []);
        setUnavailable(
          Array.isArray(previewData.unavailable) ? (previewData.unavailable as UnavailablePreview[]) : [],
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load emails");
        setOverview(null);
        setPreviews([]);
        setUnavailable([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, reloadKey]);

  useEffect(() => {
    if (!canUseAdmin) return;
    setRequestsLoading(true);
    setRequestsError(null);
    const qs = new URLSearchParams({ limit: String(limit), page: String(page) });
    if (requestStatus) qs.set("status", requestStatus);
    void (async () => {
      try {
        const data = await fetchJson<{ items?: unknown; total?: unknown }>(
          `/api/admin/emails/download-requests?${qs.toString()}`,
          { method: "GET" },
        );
        setRequests(Array.isArray(data.items) ? (data.items as DownloadRequestRow[]) : []);
        setRequestsTotal(typeof data.total === "number" ? data.total : Number(data.total ?? 0) || 0);
      } catch (e) {
        setRequestsError(e instanceof Error ? e.message : "Failed to load download requests");
        setRequests([]);
        setRequestsTotal(0);
      } finally {
        setRequestsLoading(false);
      }
    })();
  }, [canUseAdmin, page, requestStatus, reloadKey]);

  const setMode = useCallback((key: string, mode: "text" | "html") => {
    setPreviewMode((prev) => ({ ...prev, [key]: mode }));
  }, []);

  // Several previews can share a catalog id (three plan-limit kinds, free and pro view emails), so
  // the anchor the catalog table links to goes on the first of them only — one id, one element.
  const anchorKeys = useMemo(() => {
    const keys = new Set<string>();
    const seen = new Set<string>();
    for (const preview of previews) {
      if (seen.has(preview.catalogId)) continue;
      seen.add(preview.catalogId);
      keys.add(preview.key);
    }
    return keys;
  }, [previews]);

  // A link from the catalog lands on a folded preview; unfold the one it named.
  useEffect(() => {
    if (previews.length === 0) return;
    /** Unfold the preview the location hash names, if it is one of ours. */
    function openFromHash() {
      const hash = window.location.hash.replace(/^#preview-/, "");
      if (!hash || hash === window.location.hash) return;
      const target = previews.find((p) => p.catalogId === hash && anchorKeys.has(p.key));
      if (target) setOpenPreviews((prev) => ({ ...prev, [target.key]: true }));
    }
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [previews, anchorKeys]);

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Emails" description="Every email the product can send, a preview of each one with a builder, and the jobs that send them." callbackUrl="/a/emails" />;
  }

  const catalog = overview?.catalog ?? [];
  const notificationRun = overview?.notification?.run ?? null;
  const planLimitsRun = overview?.planLimits?.run ?? null;
  const queue = overview?.notification?.queue ?? null;
  const dead = overview?.notification?.dead ?? [];

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        {/* One header shape: title, one line, one action. The advisory that used to sit in a
            full-width grey box above the first section is the second half of the description —
            no other admin page opens with a callout, and this one said nothing the sections
            could not say where they are read. */}
        {/* One sentence, like every other admin page. The longer version ran the header past
            two lines, which wrapped Refresh underneath the prose instead of leaving it on the
            right where every other page puts it; the caveat it carried is already the opening
            line of both sections it applies to. */}
        <AdminPageHeader
          title="Emails"
          description="Every email the product can send, a preview of each one, and the jobs that send them."
          actions={
            <Button variant="outline" disabled={loading} onClick={() => setReloadKey((v) => v + 1)}>
              {loading ? "Loading…" : "Refresh"}
            </Button>
          }
        />

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}

        {/* ------------------------------------------------------------ catalog */}
        <AdminSection
          title="What we send"
          description={
            <>
              From <span className="font-mono text-[12px]">EMAIL_CATALOG</span>, hand-maintained, so it can drift from
              what actually sends. Recorded says what proof a send leaves: per message, run totals only, or nothing.
            </>
          }
        >
        <AdminTable
          ariaLabel="Email catalog"
          head={
            <>
              {/* The gate chip has its own column: sharing the Email cell with the id made it
                  an atomic flex item inside a truncating cell, so it was sliced to "fl". */}
              {/* Every column but the prose one is capped to what it actually holds, and the
                  prose column takes whatever is left — otherwise the two columns a reader is
                  here for (the id, and the sentence) were the two that ended in "…". */}
              <AdminTh width="w-[232px]">Email</AdminTh>
              <AdminTh width="w-[52px]">Gate</AdminTh>
              <AdminTh width="w-[84px]">To</AdminTh>
              <AdminTh width="w-full">What it says</AdminTh>
              <AdminTh width="w-[162px]">Built in</AdminTh>
              <AdminTh width="w-[100px]">Recorded</AdminTh>
              <AdminTh align="right" sticky>
                Preview
              </AdminTh>
            </>
          }
        >
          {loading && catalog.length === 0 ? (
            <AdminTableMessage colSpan={CATALOG_COLUMNS}>Loading the catalog…</AdminTableMessage>
          ) : catalog.length === 0 ? (
            <AdminTableEmpty
              colSpan={CATALOG_COLUMNS}
              title="No catalog rows"
              hint="EMAIL_CATALOG came back empty, which means the overview route could not read it."
            />
          ) : (
            catalog.map((row) => (
              <AdminTr key={row.id}>
                <AdminTd primary mono truncate="max-w-[232px]">
                  <span title={row.id}>{row.id}</span>
                </AdminTd>
                <AdminTd>
                  {row.flagGated ? (
                    <StatusPill tone="warning" title={`Only sends when ${row.flagGated}=1`}>
                      Flagged
                    </StatusPill>
                  ) : (
                    <span className="text-[var(--muted-2)]">{ADMIN_DASH}</span>
                  )}
                </AdminTd>
                <AdminTd truncate="max-w-[84px]">
                  <span title={row.to}>{row.to}</span>
                </AdminTd>
                {/* `w-full` + `max-w-0`: the sentence contributes nothing to the table's
                    intrinsic width, so it fills the slack instead of pushing a scrollbar. */}
                <AdminTd truncate="w-full max-w-0">
                  <span title={row.what}>{row.what}</span>
                </AdminTd>
                {/* The path is 60 characters of repeated prefix; the file is the answer and the
                    full path is one hover away, so the prose column gets the slack. */}
                <AdminTd mono truncate="max-w-[162px]">
                  <span title={row.builtBy}>{row.builtBy.split("/").pop() || row.builtBy}</span>
                </AdminTd>
                <AdminTd>
                  <StatusPill tone={traceTone(row.trace)} title={row.traceNote}>
                    {traceLabel(row.trace)}
                  </StatusPill>
                </AdminTd>
                <AdminTd align="right" sticky actions>
                  {/* "Below" described a location; this is the jump itself, sized like every
                      other row action so the column reads as actionable. */}
                  <RowActions>
                    {row.previewable ? (
                      <a className={ADMIN_ROW_ACTION_LINK} href={`#preview-${row.id}`} title="Jump to this preview">
                        Preview
                      </a>
                    ) : (
                      <span className="text-[var(--muted-2)]" title={row.previewNote ?? undefined}>
                        {ADMIN_DASH}
                      </span>
                    )}
                  </RowActions>
                </AdminTd>
              </AdminTr>
            ))
          )}
        </AdminTable>
        </AdminSection>

        {/* --------------------------------------------------- notification queue */}
        {/* Above the last-run panel on purpose: "what is owed" is the question this page could
            never answer, and the run counters below are only what one tick happened to do. */}
        <AdminSection
          title="Notification queue"
          description="One row is one email owed to one person, written down when the thing happened. These counts are live, not from a run: pending is what the next tick will try, dead gave up after five attempts and stays until someone deals with it."
        >
          <Panel padding="md" rounded="xl" className="min-w-0">
            {queue ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                <Fact label="Pending">
                  <span className="tabular-nums">{queue.pending}</span>{" "}
                  <span className="text-[var(--muted-2)]" title="Pending rows whose next attempt is already due">
                    ({queue.due} due)
                  </span>
                </Fact>
                <Fact label="Sending">
                  {queue.sending ? (
                    <StatusPill
                      tone="info"
                      title="Claimed by a runner right now. A count that stays up belongs to a run that died mid-send; the stale sweep hands those back after ten minutes."
                    >
                      {String(queue.sending)}
                    </StatusPill>
                  ) : (
                    <span className="tabular-nums">0</span>
                  )}
                </Fact>
                <Fact label="Sent (24h)">
                  {/* A window, not a total: sent rows expire after 30 days, so a lifetime count
                      would fall over time and read as mail going missing. */}
                  <span className="tabular-nums" title="Rows marked sent in the last 24 hours">
                    {queue.sent24h}
                  </span>
                </Fact>
                <Fact label="Dead">
                  {queue.dead ? (
                    <StatusPill tone="danger" title="Used up every attempt. Never retried automatically.">
                      {String(queue.dead)}
                    </StatusPill>
                  ) : (
                    <span className="tabular-nums">0</span>
                  )}
                </Fact>
                <Fact label="Skipped">
                  <span className="tabular-nums" title="Never sent on purpose: the member had it off, or the thing is gone.">
                    {queue.skipped}
                  </span>
                </Fact>
                <Fact label="Oldest pending">
                  {/* Event time, not insert time: this is how far behind delivery actually is. */}
                  <span className="tabular-nums">
                    <TimeCell value={queue.oldestPendingAt} />
                  </span>
                </Fact>
              </dl>
            ) : (
              <p className={ADMIN_NOTE}>
                No queue counts on this response: the collection could not be read. That is not the same as an empty
                queue.
              </p>
            )}
          </Panel>

          <AdminTable
            className="mt-3"
            ariaLabel="Dead notifications"
            head={
              <>
                {/* Both times, because the gap between them is the answer to "how long has this
                    been failing?" — the event, then the attempt that gave up on it. */}
                <AdminTh align="right" width="w-[150px]">
                  Occurred
                </AdminTh>
                <AdminTh align="right" width="w-[150px]">
                  Gave up
                </AdminTh>
                <AdminTh width="w-[150px]">Kind</AdminTh>
                <AdminTh align="right" width="w-[84px]">
                  Attempts
                </AdminTh>
                <AdminTh width="w-[280px]">Queue row</AdminTh>
                <AdminTh width="w-full">Last error</AdminTh>
              </>
            }
          >
            {loading && dead.length === 0 ? (
              <AdminTableMessage colSpan={DEAD_COLUMNS}>Loading dead letters…</AdminTableMessage>
            ) : dead.length === 0 ? (
              <AdminTableEmpty
                colSpan={DEAD_COLUMNS}
                title="Nothing has given up"
                hint="A row goes dead after five failed attempts, and keeps the error it died on."
              />
            ) : (
              dead.map((row) => (
                <AdminTr key={row.id}>
                  <AdminTd align="right" numeric>
                    <TimeCell value={row.occurredAt} />
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    <TimeCell value={row.failedAt} />
                  </AdminTd>
                  <AdminTd primary truncate="max-w-[150px]">
                    <span title={row.kind}>{row.kind}</span>
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    {row.attempts}
                  </AdminTd>
                  {/* The dedupe key is the whole identity of the mail: kind, recipient and the
                      source row it is about. What the email would have said is not here and is
                      not fetched — see src/lib/admin/docPrivacy.ts. */}
                  <AdminTd mono truncate="max-w-[280px]">
                    <span title={row.dedupeKey}>{row.dedupeKey}</span>
                  </AdminTd>
                  <AdminTd truncate="w-full max-w-0">
                    {row.lastError ? (
                      <span style={toneTextStyle("danger")} title={row.lastError}>
                        {row.lastError}
                      </span>
                    ) : (
                      <span className="text-[var(--muted-2)]" title="The row died without an error being recorded.">
                        {ADMIN_DASH}
                      </span>
                    )}
                  </AdminTd>
                </AdminTr>
              ))
            )}
          </AdminTable>

          {queue && queue.dead > dead.length ? (
            <p className={ADMIN_NOTE}>
              Showing the {dead.length} most recent of {queue.dead} dead rows.
            </p>
          ) : null}
        </AdminSection>

        {/* ------------------------------------------- notification job last run */}
        <AdminSection
          title="Notification job: last run"
          description="One snapshot per job, overwritten every tick. There is no run history, so nothing here adds up over time. Emails are messages sent; events are the source rows folded into them. The daily gate says the digest window was open this tick, not that a digest went out."
        >
          <Panel padding="md" rounded="xl" className="min-w-0">
            {overview ? <JobSnapshot snapshot={overview.notification.snapshot} /> : null}
            {overview?.notification?.snapshot?.lastError ? (
              <p className="mt-2 text-[12px] leading-5" style={toneTextStyle("danger")}>
                {overview.notification.snapshot.lastError}
              </p>
            ) : null}
            {/* The same `Fact` grid the plan-limit panel uses: two panels showing the same kind
                of snapshot were a 4-field grid beside a run-on sentence. */}
            {notificationRun ? (
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                <Fact label="Run at">
                  <span className="tabular-nums">
                    <TimeCell value={notificationRun.now} />
                  </span>
                </Fact>
                <Fact label="Workspaces">
                  <span className="tabular-nums">{n(notificationRun.workspacesProcessed)}</span>
                </Fact>
                <Fact label="Members">
                  <span className="tabular-nums">{n(notificationRun.membersProcessed)}</span>
                </Fact>
                <Fact label="Send failures">
                  {notificationRun.sendFailures ? (
                    <StatusPill tone="danger">{n(notificationRun.sendFailures)}</StatusPill>
                  ) : (
                    <span className="tabular-nums">{n(notificationRun.sendFailures)}</span>
                  )}
                </Fact>
                <Fact label="View emails off">
                  <span className="tabular-nums">{n(notificationRun.viewsOffMembers)}</span>
                </Fact>
                <Fact label="Cursors seeded">
                  <span className="tabular-nums">{n(notificationRun.viewsCursorsInitialized)}</span>
                </Fact>
                <Fact label="Views errors">
                  {notificationRun.viewsErrors ? (
                    <StatusPill tone="danger">{n(notificationRun.viewsErrors)}</StatusPill>
                  ) : (
                    <span className="tabular-nums">{n(notificationRun.viewsErrors)}</span>
                  )}
                </Fact>
                <Fact label="Dry run">
                  {notificationRun.dryRun ? (
                    <StatusPill tone="warning" title="Nothing sent, no cursor moved">
                      Yes
                    </StatusPill>
                  ) : (
                    <span className="text-[var(--muted-2)]">No</span>
                  )}
                </Fact>
              </dl>
            ) : (
              <p className={ADMIN_NOTE}>
                No run counters on this snapshot (the job may not have run since deploy, or the last tick was skipped
                because another run held the lease).
              </p>
            )}
          </Panel>

          {notificationRun ? (
            <AdminTable
              className="mt-3"
              ariaLabel="Notification buckets on the last run"
              head={
                <>
                  <AdminTh>Type</AdminTh>
                  <AdminTh>Key</AdminTh>
                  <AdminTh align="right">Emails</AdminTh>
                  <AdminTh align="right">Recipients</AdminTh>
                  <AdminTh align="right">Events</AdminTh>
                  <AdminTh align="right">Returns</AdminTh>
                  <AdminTh align="right">Failed</AdminTh>
                  <AdminTh>Daily gate</AdminTh>
                </>
              }
            >
              {notificationRun.buckets.length === 0 ? (
                <AdminTableEmpty colSpan={BUCKET_COLUMNS} title="The last run reported no buckets" />
              ) : (
                notificationRun.buckets.map((b) => (
                  <AdminTr key={b.key}>
                    <AdminTd primary truncate="max-w-[220px]">
                      <span title={b.label}>{b.label}</span>
                    </AdminTd>
                    <AdminTd mono truncate="max-w-[200px]">
                      <span title={b.key}>{b.key}</span>
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      {n(b.emails)}
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      {n(b.members)}
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      {n(b.events)}
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      {n(b.returns)}
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      {b.failed ? (
                        <StatusPill tone="danger">{n(b.failed)}</StatusPill>
                      ) : (
                        <span className="text-[var(--muted-2)]">{n(b.failed)}</span>
                      )}
                    </AdminTd>
                    <AdminTd>
                      {b.sentTodayUtc === null ? (
                        ADMIN_DASH
                      ) : b.sentTodayUtc ? (
                        <StatusPill tone="quiet" title="The digest window was open this tick">
                          Open
                        </StatusPill>
                      ) : (
                        <span className="text-[var(--muted-2)]">Closed</span>
                      )}
                    </AdminTd>
                  </AdminTr>
                ))
              )}
            </AdminTable>
          ) : null}
        </AdminSection>

        {/* --------------------------------------------- plan limits job last run */}
        <AdminSection
          title="Plan-limit job: last run"
          description="Started, reminded and blocked count state transitions; each one sends one email to the owner. Errors mixes failed sends with failed writes, so a nonzero count does not say how many owners went unmailed."
        >
        <Panel padding="md" rounded="xl" className="min-w-0">
          {overview ? <JobSnapshot snapshot={overview.planLimits.snapshot} /> : null}
          {overview?.planLimits?.snapshot?.lastError ? (
            <p className="mt-2 text-[12px] leading-5" style={toneTextStyle("danger")}>{overview.planLimits.snapshot.lastError}</p>
          ) : null}

          {planLimitsRun ? (
            <>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                <Fact label="Scanned">
                  <span className="tabular-nums">{n(planLimitsRun.scanned)}</span>
                </Fact>
                <Fact label="Grace started">
                  <span className="tabular-nums">{n(planLimitsRun.started)}</span>
                </Fact>
                <Fact label="Reminded">
                  <span className="tabular-nums">{n(planLimitsRun.reminded)}</span>
                </Fact>
                <Fact label="Blocked">
                  <span className="tabular-nums">{n(planLimitsRun.blocked)}</span>
                </Fact>
                <Fact label="Cleared">
                  <span className="tabular-nums">{n(planLimitsRun.cleared)}</span>
                </Fact>
                <Fact label="Upgraded">
                  <span className="tabular-nums">{n(planLimitsRun.upgraded)}</span>
                </Fact>
                <Fact label="Errors">
                  {planLimitsRun.errors ? (
                    <StatusPill tone="danger">{n(planLimitsRun.errors)}</StatusPill>
                  ) : (
                    <span className="tabular-nums">{n(planLimitsRun.errors)}</span>
                  )}
                </Fact>
                <Fact label="Dry run">
                  {planLimitsRun.dryRun === null ? (
                    ADMIN_DASH
                  ) : planLimitsRun.dryRun ? (
                    <StatusPill tone="warning">Yes</StatusPill>
                  ) : (
                    <span className="text-[var(--muted-2)]">No</span>
                  )}
                </Fact>
              </dl>
            </>
          ) : (
            <p className={ADMIN_NOTE}>No sweep counters on this snapshot yet.</p>
          )}
        </Panel>
        </AdminSection>

        {/* ----------------------------------------------------------- previews */}
        <AdminSection
          title="Previews"
          description="Real bodies from the real builders, called with sample inputs. Nothing is read from the database and nothing is sent."
        >
        <div className="grid gap-2">
          {previews.map((preview) => {
            const mode = previewMode[preview.key] ?? "text";
            const open = Boolean(openPreviews[preview.key]);
            return (
              <details
                key={preview.key}
                id={anchorKeys.has(preview.key) ? `preview-${preview.catalogId}` : undefined}
                open={open}
                onToggle={(e) =>
                  setOpenPreviews((prev) => ({ ...prev, [preview.key]: (e.target as HTMLDetailsElement).open }))
                }
                className="min-w-0 scroll-mt-6 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)]"
              >
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fg)]">
                  <span className="text-[13px] font-medium leading-5 text-[var(--fg)]">{preview.label}</span>
                  <span className="truncate font-mono text-[12px] leading-5 text-[var(--muted-2)]">
                    {preview.catalogId}
                  </span>
                  <span className="ml-auto truncate text-[12px] leading-5 text-[var(--muted-2)]" title={preview.subject}>
                    {preview.subject}
                  </span>
                  {preview.html ? <StatusPill tone="quiet">text + html</StatusPill> : <StatusPill tone="quiet">text</StatusPill>}
                </summary>

                <div className="border-t border-[var(--border)] px-3.5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] leading-5 text-[var(--muted-2)]">
                      {preview.inputs.map((input) => (
                        <span key={input.label}>
                          <span className="font-medium">{input.label}:</span> {input.value}
                        </span>
                      ))}
                    </div>
                    {preview.html ? (
                      <div className="flex items-center gap-1.5">
                        <RowAction
                          aria-pressed={mode === "text"}
                          className={mode === "text" ? "bg-[var(--panel-hover)] text-[var(--fg)]" : undefined}
                          onClick={() => setMode(preview.key, "text")}
                        >
                          Text part
                        </RowAction>
                        <RowAction
                          aria-pressed={mode === "html"}
                          className={mode === "html" ? "bg-[var(--panel-hover)] text-[var(--fg)]" : undefined}
                          onClick={() => setMode(preview.key, "html")}
                        >
                          HTML part
                        </RowAction>
                      </div>
                    ) : null}
                  </div>

                  {mode === "html" && preview.html ? (
                    // sandboxed and empty-allowlist: the email HTML is rendered, never run, and cannot
                    // reach the admin page around it
                    <iframe
                      sandbox=""
                      srcDoc={preview.html}
                      title={`${preview.label}: HTML part`}
                      className="mt-2.5 h-[460px] w-full rounded-lg border border-[var(--border)] bg-white"
                    />
                  ) : (
                    <pre className={`mt-2.5 max-h-[420px] ${ADMIN_CODE_BLOCK}`}>{preview.text}</pre>
                  )}

                  {preview.headers ? (
                    <div className="mt-2 grid gap-1 text-[12px] leading-5 text-[var(--muted-2)]">
                      {preview.headers.map((h) => (
                        <div key={h.name} className="truncate" title={`${h.name}: ${h.value}`}>
                          <span className="font-medium text-[var(--fg)]">{h.name}:</span>{" "}
                          <span className="font-mono">{h.value}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </details>
            );
          })}

          {!loading && previews.length === 0 ? (
            <Panel padding="md" rounded="xl">
              <div className="text-[13px] text-[var(--muted-2)]">No previews.</div>
            </Panel>
          ) : null}
        </div>

        {/* The one caveat this section has, in the section, not dangling under it. */}
        {unavailable.length > 0 ? (
          <p className={ADMIN_NOTE}>
            No builder to call, so no preview:{" "}
            {unavailable.map((row, i) => (
              <span key={row.catalogId}>
                {i > 0 ? ", " : ""}
                <span className="font-mono text-[12px] text-[var(--muted)]" title={`body is built inline in ${row.builtBy}`}>
                  {row.catalogId}
                </span>
              </span>
            ))}
            . Each of those is built inline in its sender.
          </p>
        ) : null}
        </AdminSection>

        {/* -------------------------------------------------- download requests */}
        <AdminSection
          title="Download-request emails"
          description="The only emails recorded per message. A denial sends nothing, by design, so it shows no claim mail. A dash in a mail column means neither a sent-at stamp nor an error: never attempted, or the write that would have stamped it failed."
        >
        <AdminFilterBar
          page={page}
          pageSize={limit}
          total={requestsTotal}
          onPageChange={setPage}
          noun="requests"
          loading={requestsLoading}
        >
          <AdminSelect
            ariaLabel="Filter by request status"
            value={requestStatus}
            onChange={(e) => {
              setPage(1);
              setRequestStatus(e.target.value);
            }}
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="denied">Denied</option>
          </AdminSelect>
        </AdminFilterBar>

        {requestsError ? (
          <AdminAlert className="mt-3">
            {requestsError}
          </AdminAlert>
        ) : null}

        <AdminTable
          className="mt-3"
          ariaLabel="Download-request emails"
          head={
            <>
              <AdminTh align="right">Requested</AdminTh>
              <AdminTh>Requester</AdminTh>
              <AdminTh>Status</AdminTh>
              <AdminTh>Receipt</AdminTh>
              <AdminTh>Owner mail</AdminTh>
              <AdminTh>Claim mail</AdminTh>
            </>
          }
        >
          {requestsLoading && requests.length === 0 ? (
            <AdminTableMessage colSpan={REQUEST_COLUMNS}>Loading download requests…</AdminTableMessage>
          ) : requests.length === 0 ? (
            <AdminTableEmpty
              colSpan={REQUEST_COLUMNS}
              title={requestStatus ? "No requests with that status" : "No download requests"}
              hint={requestStatus ? "Try another status, or clear the filter." : undefined}
            />
          ) : (
            requests.map((row) => (
              <AdminTr key={row.requestId}>
                <AdminTd align="right" numeric>
                  <TimeCell value={row.createdDate} />
                </AdminTd>
                <AdminTd primary truncate="max-w-[240px]">
                  <span title={row.requesterEmail ?? undefined}>{row.requesterEmail ?? ADMIN_DASH}</span>
                </AdminTd>
                <AdminTd>
                  {row.status === "pending" ? (
                    <StatusPill tone="warning">Pending</StatusPill>
                  ) : row.status === "denied" ? (
                    <StatusPill tone="neutral">Denied</StatusPill>
                  ) : row.status ? (
                    <StatusPill tone="quiet">{row.status}</StatusPill>
                  ) : (
                    ADMIN_DASH
                  )}
                </AdminTd>
                <AdminTd truncate="max-w-[200px]">
                  <OutcomeCell outcome={row.requesterEmailOutcome} />
                </AdminTd>
                <AdminTd truncate="max-w-[200px]">
                  <OutcomeCell outcome={row.ownerEmailOutcome} />
                </AdminTd>
                <AdminTd truncate="max-w-[200px]">
                  <OutcomeCell outcome={row.claimEmailOutcome} />
                </AdminTd>
              </AdminTr>
            ))
          )}
        </AdminTable>
        </AdminSection>
      </div>
    </div>
  );
}
