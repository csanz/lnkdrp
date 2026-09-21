/**
 * Admin route: `/a/deployments`
 *
 * What Vercel built, and when. The rest of the admin area answers questions about the product; this
 * answers the one question none of those pages can, which is whether the code an admin is looking
 * at is the code that is actually running.
 *
 * It is read-only and it is optional. On a deployment with no Vercel token the page says so, names
 * the variables to set, and stops. Nothing else in the admin area changes either way.
 */
"use client";

import { useEffect, useMemo, useState } from "react";

import Button from "@/components/ui/Button";
import {
  AdminAccessState,
  AdminAlert,
  AdminFilterBar,
  AdminPageHeader,
  AdminSection,
  AdminTable,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_DASH, ADMIN_PANEL_TEXT, type AdminTone } from "@/lib/admin/ui";
import { fmtDuration } from "@/lib/admin/format";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { fetchJson } from "@/lib/http/fetchJson";

const COLUMN_COUNT = 7;
const DESCRIPTION = "The last twenty builds of this project, read from Vercel. Read-only, and cached for a minute.";

/** The reduced deployment the API returns. Mirrors `VercelDeployment` in `src/lib/vercel/client.ts`. */
type Deployment = {
  id: string;
  url: string | null;
  state: string | null;
  target: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  commitRef: string | null;
  creator: string | null;
  createdAt: number | null;
  buildingAt: number | null;
  readyAt: number | null;
  durationMs: number | null;
  inspectorUrl: string | null;
};

type Payload = {
  configured?: boolean;
  missing?: string[];
  teamScoped?: boolean;
  deployments?: Deployment[];
  upstream?: { reason: string; status: number | null; message: string } | null;
  fetchedAt?: string;
  cached?: boolean;
};

/**
 * Colour is the state, never decoration.
 *
 * A build in flight is `info` rather than `warning`: nothing is wrong with a build that is running,
 * and a board of amber chips every time somebody pushes trains an admin to ignore amber.
 */
function stateTone(state: string | null): AdminTone {
  switch ((state ?? "").toUpperCase()) {
    case "READY":
      return "positive";
    case "ERROR":
      return "danger";
    case "BUILDING":
    case "INITIALIZING":
    case "QUEUED":
      return "info";
    case "CANCELED":
      return "quiet";
    default:
      return "neutral";
  }
}

/** True while Vercel is still working on it, which is what makes the chip pulse. */
function inFlight(state: string | null): boolean {
  const s = (state ?? "").toUpperCase();
  return s === "BUILDING" || s === "INITIALIZING" || s === "QUEUED";
}

/** "production" reads as Production; a preview has no target at all. */
function targetLabel(target: string | null): string {
  if (!target) return "Preview";
  return target.charAt(0).toUpperCase() + target.slice(1);
}

/** Vercel's deployment board. */
export default function DeploymentsAdminPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(
    () => (Array.isArray(payload?.deployments) ? (payload?.deployments as Deployment[]) : []),
    [payload],
  );
  const configured = payload?.configured !== false;
  const missing = Array.isArray(payload?.missing) ? (payload?.missing as string[]) : [];
  const upstream = payload?.upstream ?? null;
  const failing = useMemo(() => rows.filter((d) => (d.state ?? "").toUpperCase() === "ERROR"), [rows]);

  /** Read the board. The route answers 200 even when Vercel does not, so a failure lands in `upstream`. */
  async function load() {
    setLoading(true);
    setError(null);
    try {
      setPayload(await fetchJson<Payload>("/api/admin/deployments?limit=20", { method: "GET" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load deployments");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!canUseAdmin) return;
    void load();
  }, [canUseAdmin]);

  if (!canUseAdmin) {
    return (
      <AdminAccessState
        access={access}
        title="Deployments"
        description={DESCRIPTION}
        callbackUrl="/a/deployments"
      />
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader title="Deployments" description={DESCRIPTION} />

        <AdminFilterBar
          className="mt-4"
          page={1}
          pageSize={Math.max(1, rows.length)}
          total={rows.length}
          noun="deployments"
          loading={loading}
          actions={
            <Button variant="outline" onClick={() => void load()} disabled={loading}>
              {loading ? "Loading…" : "Refresh"}
            </Button>
          }
        />

        {error ? <AdminAlert className="mt-3">{error}</AdminAlert> : null}

        {payload && !configured ? (
          // Not an error state. This deployment has no Vercel credentials, which is a fine way to
          // run, so the panel is instructions rather than an alarm.
          <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
            <div className="text-[13px] font-semibold text-[var(--fg)]">Not configured</div>
            <p className={`mt-1 ${ADMIN_PANEL_TEXT}`}>
              This deployment has no Vercel credentials, so there is nothing to read. Nothing else in the admin area
              depends on them. To turn this page on, set the following in the environment:
            </p>
            <ul className="mt-3 grid gap-1.5 text-[13px] leading-5 text-[var(--fg)]">
              {(missing.length ? missing : ["VERCEL_API_TOKEN", "VERCEL_PROJECT_ID"]).map((name) => (
                <li key={name} className="font-mono text-[12px]">
                  {name}
                </li>
              ))}
              <li className="font-mono text-[12px] text-[var(--muted-2)]">VERCEL_TEAM_ID (team-scoped projects only)</li>
            </ul>
            <p className={`mt-3 ${ADMIN_PANEL_TEXT}`}>
              The token needs read access only. Create one under Vercel account settings, Tokens, scoped to the team
              that owns this project.
            </p>
          </div>
        ) : null}

        {payload && configured && upstream ? (
          <AdminAlert className="mt-3">
            <div className="font-semibold">Vercel could not be read</div>
            <div className="mt-1">{upstream.message}</div>
          </AdminAlert>
        ) : null}

        {failing.length ? (
          <AdminAlert className="mt-3">
            <div className="font-semibold">
              {failing.length} of the last {rows.length} {failing.length === 1 ? "build" : "builds"} failed
            </div>
            <div className="mt-1 grid gap-1">
              {failing.slice(0, 5).map((d) => (
                <div key={d.id}>
                  <span className="font-mono text-[12px]">{d.commitSha ?? d.id}</span>
                  {d.commitMessage ? <> {d.commitMessage}</> : null}
                </div>
              ))}
            </div>
          </AdminAlert>
        ) : null}

        {configured ? (
          <AdminSection
            title="Recent deployments"
            description={
              payload?.fetchedAt ? (
                <>
                  Newest first. Duration is build start to ready. Read at{" "}
                  <span className="tabular-nums">{new Date(payload.fetchedAt).toLocaleTimeString()}</span>
                  {payload.cached ? " (cached)" : ""}.
                </>
              ) : (
                "Newest first. Duration is build start to ready."
              )
            }
          >
            <AdminTable
              ariaLabel="Recent deployments"
              head={
                <>
                  <AdminTh>Commit</AdminTh>
                  <AdminTh>State</AdminTh>
                  <AdminTh>Target</AdminTh>
                  <AdminTh>Branch</AdminTh>
                  <AdminTh>By</AdminTh>
                  <AdminTh align="right">Created</AdminTh>
                  <AdminTh align="right">Duration</AdminTh>
                </>
              }
            >
              {loading && rows.length === 0 ? (
                <AdminTableMessage colSpan={COLUMN_COUNT}>Loading deployments…</AdminTableMessage>
              ) : rows.length === 0 ? (
                <AdminTableMessage colSpan={COLUMN_COUNT}>
                  {upstream ? "Nothing to show while Vercel cannot be read." : "No deployments yet."}
                </AdminTableMessage>
              ) : (
                rows.map((d) => (
                  <AdminTr key={d.id}>
                    {/* Two lines, like the cron board's job cell: a sha alone says nothing about
                        what shipped, and that is the question this board is opened with. */}
                    <AdminTd primary truncate="max-w-[380px]">
                      {d.inspectorUrl ? (
                        <a
                          href={d.inspectorUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="font-mono underline decoration-[var(--border)] underline-offset-2 hover:decoration-[var(--fg)]"
                          title={d.id}
                        >
                          {d.commitSha ?? d.id}
                        </a>
                      ) : (
                        <span className="font-mono" title={d.id}>
                          {d.commitSha ?? d.id}
                        </span>
                      )}
                      <span
                        className="block truncate text-[12px] font-normal leading-4 text-[var(--muted-2)]"
                        title={d.commitMessage ?? d.url ?? ""}
                      >
                        {d.commitMessage ?? d.url ?? ADMIN_DASH}
                      </span>
                    </AdminTd>
                    <AdminTd>
                      <StatusPill tone={stateTone(d.state)} dot={(d.state ?? "").toUpperCase() !== "ERROR"}>
                        <span className={inFlight(d.state) ? "motion-safe:animate-pulse" : undefined}>
                          {d.state ?? "Unknown"}
                        </span>
                      </StatusPill>
                    </AdminTd>
                    <AdminTd>{targetLabel(d.target)}</AdminTd>
                    <AdminTd truncate="max-w-[180px]">
                      <span className="font-mono text-[12px]" title={d.commitRef ?? undefined}>
                        {d.commitRef ?? ADMIN_DASH}
                      </span>
                    </AdminTd>
                    <AdminTd truncate="max-w-[160px]">{d.creator ?? ADMIN_DASH}</AdminTd>
                    <AdminTd align="right" numeric>
                      {d.createdAt ? <TimeCell value={d.createdAt} /> : ADMIN_DASH}
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      {fmtDuration(d.durationMs) || ADMIN_DASH}
                    </AdminTd>
                  </AdminTr>
                ))
              )}
            </AdminTable>
          </AdminSection>
        ) : null}
      </div>
    </div>
  );
}
