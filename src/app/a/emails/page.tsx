/**
 * Admin route: `/a/emails`
 *
 * Every email the product can send, where its body is built, and what evidence exists that one went
 * out. The last part is the reason the page exists: only download-request emails are recorded per
 * message. Everything else leaves run-level counters or nothing, and the page says which rather
 * than implying a send log that does not exist.
 */
"use client";

import { signIn, useSession } from "next-auth/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import DataTable from "@/components/ui/DataTable";
import Panel from "@/components/ui/Panel";
import Select from "@/components/ui/Select";
import { fmtDate, fmtDuration } from "@/lib/admin/format";
import { sendStateLabel, traceLabel } from "@/lib/admin/emailsAdmin";
import type {
  EmailCatalogRow,
  NotificationRunSummary,
  PlanLimitsRunSummary,
  SendOutcome,
} from "@/lib/admin/emailsAdmin";
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
  notification: { snapshot: SnapshotRow; run: NotificationRunSummary | null };
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
  shareId: string | null;
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

const PAGE_TITLE = "Admin / Emails";

/** Colour for a cron job's status badge. */
function statusPill(status: string | null): string {
  if (status === "running") return "bg-blue-100 text-blue-800";
  if (status === "error") return "bg-red-100 text-red-800";
  return "bg-emerald-100 text-emerald-800";
}

/** Colour for how well a send is recorded: green per-send, amber run totals, grey nothing. */
function tracePill(trace: EmailCatalogRow["trace"]): string {
  if (trace === "per_send") return "bg-emerald-100 text-emerald-800";
  if (trace === "run_totals") return "bg-amber-100 text-amber-900";
  return "bg-[var(--panel-2)] text-[var(--muted-2)]";
}

/** Colour for one recorded send outcome. */
function outcomePill(state: SendOutcome["state"]): string {
  if (state === "sent") return "bg-emerald-100 text-emerald-800";
  if (state === "failed") return "bg-red-100 text-red-800";
  return "bg-[var(--panel-2)] text-[var(--muted-2)]";
}

/** A number the server actually returned, or an em dash when the field was absent. */
function n(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "—";
}

/** A small status badge, in the shape the other admin pages use. */
function Pillish({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${className}`}>
      {children}
    </span>
  );
}

/** One recorded send: state, when it happened, and the error when it failed. */
function OutcomeCell({ outcome }: { outcome: SendOutcome }) {
  return (
    <div className="min-w-0">
      <Pillish className={outcomePill(outcome.state)}>{sendStateLabel(outcome.state)}</Pillish>
      {outcome.at ? <div className="mt-1 text-xs text-[var(--muted-2)]">{fmtDate(outcome.at) || "—"}</div> : null}
      {outcome.error ? <div className="mt-1 break-words text-xs text-red-700">{outcome.error}</div> : null}
    </div>
  );
}

/** The header line for a cron job: status, last run, duration, schedule. */
function JobSnapshot({ snapshot }: { snapshot: SnapshotRow }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--muted)]">
      <Pillish className={statusPill(snapshot.status)}>{snapshot.status ?? "never run"}</Pillish>
      <span>
        <span className="font-semibold text-[var(--fg)]">Last run:</span> {fmtDate(snapshot.lastRunAt) || "—"}
      </span>
      <span>
        <span className="font-semibold text-[var(--fg)]">Duration:</span>{" "}
        {fmtDuration(snapshot.lastDurationMs) || "—"}
      </span>
      <span>
        <span className="font-semibold text-[var(--fg)]">Schedule:</span>{" "}
        {snapshot.schedule ? (
          <>
            <span className="font-mono text-xs">{snapshot.schedule}</span> ({snapshot.scheduleHuman})
          </>
        ) : (
          "—"
        )}
      </span>
    </div>
  );
}

/** Render the Emails admin page (fetches the catalog, previews and download-request rows). */
export default function AdminEmailsPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

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

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil((requestsTotal || 0) / limit)),
    [requestsTotal, limit],
  );

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
        setOverview({
          catalog: Array.isArray(overviewData.catalog) ? (overviewData.catalog as EmailCatalogRow[]) : [],
          notification: overviewData.notification as OverviewPayload["notification"],
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

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">{PAGE_TITLE}</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] px-5 py-2.5 text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/emails" })}
            >
              Sign in
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!canUseAdmin) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">{PAGE_TITLE}</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You don’t have access to this page.</p>
        </div>
      </div>
    );
  }

  const catalog = overview?.catalog ?? [];
  // Several previews can share a catalog id (three plan-limit kinds, free and pro view emails), so
  // the anchor the catalog table links to goes on the first of them only — one id, one element.
  const anchorKeys = new Set<string>();
  const anchoredCatalogIds = new Set<string>();
  for (const preview of previews) {
    if (anchoredCatalogIds.has(preview.catalogId)) continue;
    anchoredCatalogIds.add(preview.catalogId);
    anchorKeys.add(preview.key);
  }
  const notificationRun = overview?.notification?.run ?? null;
  const planLimitsRun = overview?.planLimits?.run ?? null;
  const notRecorded = catalog.filter((row) => row.trace !== "per_send");

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">{PAGE_TITLE}</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Every email the product can send, a preview of each template that has a builder, and the last
              run of the jobs that send them.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/a"
              className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)]"
            >
              Admin home
            </Link>
            <Button
              variant="outline"
              className="bg-[var(--panel-2)]"
              disabled={loading}
              onClick={() => setReloadKey((v) => v + 1)}
            >
              {loading ? "Loading…" : "Refresh"}
            </Button>
          </div>
        </div>

        {error ? <div className="mt-4 text-sm text-red-700">{error}</div> : null}

        <Alert variant="info" className="mt-5 text-sm">
          Sends are not logged. Only the three download-request emails are recorded per message (in{" "}
          <span className="font-mono text-xs">ShareDownloadRequest</span>); everything else leaves run
          counters on the cron snapshot, or nothing at all. &quot;Sent&quot; here means the POST to Resend
          returned 2xx — there is no bounce, open or complaint data anywhere in the product.
        </Alert>

        {/* ------------------------------------------------------------------ catalog */}
        <h2 className="mt-8 text-base font-semibold text-[var(--fg)]">What we send</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          From <span className="font-mono text-xs">EMAIL_CATALOG</span> in{" "}
          <span className="font-mono text-xs">src/lib/email/templates</span>. It is hand-maintained
          documentation, not derived from the senders, so it can drift from what actually sends.
        </p>

        {loading && !overview ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : (
          <DataTable containerClassName="mt-4 rounded-xl bg-[var(--panel-2)]">
            <thead className="border-b border-[var(--border)] bg-[var(--panel)]">
              <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">To</th>
                <th className="px-4 py-3">What it says</th>
                <th className="px-4 py-3">Body built in</th>
                <th className="px-4 py-3">Recorded</th>
                <th className="px-4 py-3">Preview</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {catalog.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs font-semibold text-[var(--fg)]">{row.id}</div>
                    {row.flagGated ? (
                      <div className="mt-1 text-xs text-amber-800">
                        only sends when {row.flagGated}=1
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">{row.to}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{row.what}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{row.builtBy}</td>
                  <td className="px-4 py-3">
                    <Pillish className={tracePill(row.trace)}>{traceLabel(row.trace)}</Pillish>
                    <div className="mt-1 max-w-[28rem] text-xs text-[var(--muted-2)]">{row.traceNote}</div>
                  </td>
                  <td className="px-4 py-3">
                    {row.previewable ? (
                      <a href={`#preview-${row.id}`} className="text-sm font-semibold text-[var(--fg)] hover:underline">
                        Below
                      </a>
                    ) : (
                      <div className="max-w-[20rem] text-xs text-[var(--muted-2)]">{row.previewNote ?? "—"}</div>
                    )}
                  </td>
                </tr>
              ))}
              {catalog.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={6}>
                    No catalog rows.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </DataTable>
        )}

        {notRecorded.length > 0 ? (
          <Panel className="mt-4">
            <div className="text-sm font-semibold text-[var(--fg)]">Not recorded</div>
            <div className="mt-2 grid gap-1 text-sm text-[var(--muted)]">
              {notRecorded.map((row) => (
                <div key={row.id}>
                  not recorded: <span className="font-mono text-xs text-[var(--fg)]">{row.id}</span> — {row.traceNote}
                </div>
              ))}
            </div>
          </Panel>
        ) : null}

        {/* ------------------------------------------------- notification job last run */}
        <h2 className="mt-8 text-base font-semibold text-[var(--fg)]">Notification job — last run</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          One snapshot per job, overwritten on every tick. There is no run history, so nothing here adds up
          over time.
        </p>

        <Panel className="mt-4">
          {overview ? <JobSnapshot snapshot={overview.notification.snapshot} /> : null}
          {overview?.notification?.snapshot?.lastError ? (
            <div className="mt-2 text-xs text-red-700">{overview.notification.snapshot.lastError}</div>
          ) : null}

          {notificationRun ? (
            <>
              <div className="mt-3 text-sm text-[var(--muted)]">
                Run at {fmtDate(notificationRun.now) || "—"} • workspaces{" "}
                {n(notificationRun.workspacesProcessed)} • members {n(notificationRun.membersProcessed)} • send
                failures {n(notificationRun.sendFailures)}
                {notificationRun.dryRun ? " • dry run (nothing sent, no cursor moved)" : ""}
                {notificationRun.membersTruncated ? " • member scan was truncated" : ""}
              </div>
              <DataTable containerClassName="mt-4 rounded-xl bg-[var(--panel-2)]">
                <thead className="border-b border-[var(--border)] bg-[var(--panel)]">
                  <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Emails</th>
                    <th className="px-4 py-3">Recipients</th>
                    <th className="px-4 py-3">Events covered</th>
                    <th className="px-4 py-3">Returns</th>
                    <th className="px-4 py-3">Failed</th>
                    <th className="px-4 py-3">Daily gate open</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {notificationRun.buckets.map((b) => (
                    <tr key={b.key}>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-[var(--fg)]">{b.label}</div>
                        <div className="mt-1 font-mono text-xs text-[var(--muted-2)]">{b.key}</div>
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)]">{n(b.emails)}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{n(b.members)}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{n(b.events)}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{n(b.returns)}</td>
                      <td className={`px-4 py-3 ${b.failed ? "text-red-700" : "text-[var(--muted)]"}`}>
                        {n(b.failed)}
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)]">
                        {b.sentTodayUtc === null ? "—" : b.sentTodayUtc ? "yes" : "no"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
              <div className="mt-3 grid gap-1 text-xs text-[var(--muted-2)]">
                <div>
                  Emails = messages sent. Events covered = source rows (viewers, doc changes, uploads) folded
                  into them. Daily gate open says the digest window was open this tick, not that a digest went
                  out.
                </div>
                <div>
                  Cursor moves with nothing sent: {n(notificationRun.viewsOffMembers)} members with view emails
                  off, {n(notificationRun.viewsCursorsInitialized)} cursors seeded.{" "}
                  {n(notificationRun.viewsErrors)} workspaces threw in the views block.
                </div>
              </div>
            </>
          ) : (
            <div className="mt-3 text-sm text-[var(--muted)]">
              No run counters on this snapshot (the job may not have run since deploy, or the last tick was
              skipped because another run held the lease).
            </div>
          )}
        </Panel>

        {/* --------------------------------------------------- plan limits job last run */}
        <h2 className="mt-8 text-base font-semibold text-[var(--fg)]">Plan-limit job — last run</h2>
        <Panel className="mt-4">
          {overview ? <JobSnapshot snapshot={overview.planLimits.snapshot} /> : null}
          {overview?.planLimits?.snapshot?.lastError ? (
            <div className="mt-2 text-xs text-red-700">{overview.planLimits.snapshot.lastError}</div>
          ) : null}
          {planLimitsRun ? (
            <>
              <div className="mt-3 grid gap-2 text-sm text-[var(--muted)] sm:grid-cols-2">
                <div>
                  <span className="font-semibold text-[var(--fg)]">Workspaces scanned:</span>{" "}
                  {n(planLimitsRun.scanned)}
                </div>
                <div>
                  <span className="font-semibold text-[var(--fg)]">Grace started:</span> {n(planLimitsRun.started)}
                </div>
                <div>
                  <span className="font-semibold text-[var(--fg)]">Reminded:</span> {n(planLimitsRun.reminded)}
                </div>
                <div>
                  <span className="font-semibold text-[var(--fg)]">Blocked:</span> {n(planLimitsRun.blocked)}
                </div>
                <div>
                  <span className="font-semibold text-[var(--fg)]">Cleared:</span> {n(planLimitsRun.cleared)}
                </div>
                <div>
                  <span className="font-semibold text-[var(--fg)]">Upgraded:</span> {n(planLimitsRun.upgraded)}
                </div>
                <div className={planLimitsRun.errors ? "text-red-700" : undefined}>
                  <span className="font-semibold text-[var(--fg)]">Errors:</span> {n(planLimitsRun.errors)}
                </div>
                <div>
                  <span className="font-semibold text-[var(--fg)]">Dry run:</span>{" "}
                  {planLimitsRun.dryRun === null ? "—" : planLimitsRun.dryRun ? "yes" : "no"}
                </div>
              </div>
              <div className="mt-3 text-xs text-[var(--muted-2)]">
                Started / reminded / blocked count state transitions, each of which sends one email per owner.
                Errors mixes failed sends and failed writes; the sweep does not separate them, so a nonzero
                errors count does not say how many owners went unmailed.
              </div>
            </>
          ) : (
            <div className="mt-3 text-sm text-[var(--muted)]">No sweep counters on this snapshot yet.</div>
          )}
        </Panel>

        {/* ----------------------------------------------------------------- previews */}
        <h2 className="mt-8 text-base font-semibold text-[var(--fg)]">Previews</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Real bodies from the real builders, called with the sample inputs shown on each card. Nothing is
          read from the database and nothing is sent.
        </p>

        {unavailable.length > 0 ? (
          <Panel className="mt-4">
            <div className="text-sm font-semibold text-[var(--fg)]">No preview available</div>
            <div className="mt-2 grid gap-1 text-sm text-[var(--muted)]">
              {unavailable.map((row) => (
                <div key={row.catalogId}>
                  <span className="font-mono text-xs text-[var(--fg)]">{row.catalogId}</span> — body is built
                  inline in <span className="font-mono text-xs">{row.builtBy}</span>, with no exported builder
                  to call.
                </div>
              ))}
            </div>
          </Panel>
        ) : null}

        <div className="mt-4 grid gap-4">
          {previews.map((preview) => {
            const mode = previewMode[preview.key] ?? "text";
            return (
              <Panel
                key={preview.key}
                id={anchorKeys.has(preview.key) ? `preview-${preview.catalogId}` : undefined}
                className="min-w-0 scroll-mt-6"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[var(--fg)]">{preview.label}</div>
                    <div className="mt-1 font-mono text-xs text-[var(--muted-2)]">{preview.catalogId}</div>
                  </div>
                  {preview.html ? (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className={mode === "text" ? "bg-[var(--panel-hover)]" : "bg-[var(--panel-2)]"}
                        onClick={() => setMode(preview.key, "text")}
                      >
                        Text part
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className={mode === "html" ? "bg-[var(--panel-hover)]" : "bg-[var(--panel-2)]"}
                        onClick={() => setMode(preview.key, "html")}
                      >
                        HTML part
                      </Button>
                    </div>
                  ) : (
                    <div className="text-xs text-[var(--muted-2)]">text only — this email has no HTML part</div>
                  )}
                </div>

                <div className="mt-3 text-sm text-[var(--muted)]">
                  <span className="font-semibold text-[var(--fg)]">Subject:</span> {preview.subject}
                </div>

                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted-2)]">
                  {preview.inputs.map((input) => (
                    <span key={input.label}>
                      <span className="font-semibold">{input.label}:</span> {input.value}
                    </span>
                  ))}
                </div>

                {mode === "html" && preview.html ? (
                  // sandboxed and empty-allowlist: the email HTML is rendered, never run, and cannot
                  // reach the admin page around it
                  <iframe
                    sandbox=""
                    srcDoc={preview.html}
                    title={`${preview.label} — HTML part`}
                    className="mt-3 h-[560px] w-full rounded-xl border border-[var(--border)] bg-white"
                  />
                ) : (
                  <pre className="mt-3 max-h-[560px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-4 font-mono text-xs leading-5 text-[var(--fg)]">
                    {preview.text}
                  </pre>
                )}

                {preview.headers ? (
                  <div className="mt-3 grid gap-1 text-xs text-[var(--muted-2)]">
                    {preview.headers.map((h) => (
                      <div key={h.name}>
                        <span className="font-semibold text-[var(--fg)]">{h.name}:</span>{" "}
                        <span className="font-mono break-words">{h.value}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </Panel>
            );
          })}
          {!loading && previews.length === 0 ? (
            <Panel>
              <div className="text-sm text-[var(--muted)]">No previews.</div>
            </Panel>
          ) : null}
        </div>

        {/* -------------------------------------------------------- download requests */}
        <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[var(--fg)]">Download-request emails</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              The only emails recorded per message. Denials send no email at all, by design, so a denied
              request shows nothing in the claim column.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              className="w-[160px] max-w-full"
              value={requestStatus}
              onChange={(e) => {
                setPage(1);
                setRequestStatus(e.target.value);
              }}
            >
              <option value="">All statuses</option>
              <option value="pending">pending</option>
              <option value="approved">approved</option>
              <option value="denied">denied</option>
            </Select>
            <div className="text-xs text-[var(--muted-2)]">
              Page {page} / {totalPages} • {requestsTotal} total
            </div>
            <Button
              variant="outline"
              className="bg-[var(--panel-2)]"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              className="bg-[var(--panel-2)]"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>

        {requestsError ? <div className="mt-4 text-sm text-red-700">{requestsError}</div> : null}

        {requestsLoading ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : (
          <DataTable containerClassName="mt-4 rounded-xl bg-[var(--panel-2)]">
            <thead className="border-b border-[var(--border)] bg-[var(--panel)]">
              <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                <th className="px-4 py-3">Requested</th>
                <th className="px-4 py-3">Requester</th>
                <th className="px-4 py-3">Link</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Receipt</th>
                <th className="px-4 py-3">Owner mail</th>
                <th className="px-4 py-3">Claim mail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {requests.map((row) => (
                <tr key={row.requestId}>
                  <td className="px-4 py-3 text-[var(--muted)]">{fmtDate(row.createdDate) || "—"}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{row.requesterEmail ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{row.shareId ?? "—"}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{row.status ?? "—"}</td>
                  <td className="px-4 py-3">
                    <OutcomeCell outcome={row.requesterEmailOutcome} />
                  </td>
                  <td className="px-4 py-3">
                    <OutcomeCell outcome={row.ownerEmailOutcome} />
                  </td>
                  <td className="px-4 py-3">
                    <OutcomeCell outcome={row.claimEmailOutcome} />
                  </td>
                </tr>
              ))}
              {requests.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={7}>
                    No download requests.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </DataTable>
        )}

        <p className="mt-3 text-xs text-[var(--muted-2)]">
          &quot;Not attempted&quot; means the row has neither a sent-at nor an error. Those are two different
          things the schema cannot tell apart: the send was never tried, or it happened and the write that
          would have stamped it failed.
        </p>
      </div>
    </div>
  );
}
