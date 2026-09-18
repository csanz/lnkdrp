/**
 * Admin route: `/a/deletions`
 *
 * Who asked to delete their account, when, why, and when the purge job may remove their data.
 * Read-only: nothing here deletes or restores. The reason is whatever the person chose and typed on
 * the way out, which is the only place the product hears it.
 */
"use client";

import { useEffect, useState } from "react";

import {
  AdminAccessState,
  AdminAlert,
  AdminPageHeader,
  AdminSection,
  AdminSelect,
  AdminTable,
  AdminTableEmpty,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  IdCell,
  StatTile,
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_DASH } from "@/lib/admin/ui";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { daysUntilPurge } from "@/lib/accounts/deletion";
import { fetchJson } from "@/lib/http/fetchJson";

type DeletionRow = {
  userId: string;
  email: string | null;
  name: string | null;
  requestedAt: string | null;
  reasonCode: string | null;
  reasonLabel: string | null;
  reasonText: string | null;
  purgeAfter: string | null;
  purgedAt: string | null;
  workspaces: number;
};

type DeletionsResponse = {
  graceDays: number;
  job: { status: string | null; lastRunAt: string | null; lastError: string | null } | null;
  deletions: DeletionRow[];
};

const DESCRIPTION = "Accounts that asked to be deleted, the reason they gave, and when their data is removed.";

export default function AdminDeletionsPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [state, setState] = useState("all");
  const [data, setData] = useState<DeletionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canUseAdmin) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const json = await fetchJson<DeletionsResponse>(`/api/admin/deletions?state=${encodeURIComponent(state)}`);
        setData(json);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load deletions");
        setData(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, state]);

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Deletions" description={DESCRIPTION} callbackUrl="/a/deletions" />;
  }

  const rows = data?.deletions ?? [];
  const pending = rows.filter((r) => !r.purgedAt);
  const due = pending.filter((r) => daysUntilPurge(r.purgeAfter) === 0);

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader title="Deletions" description={DESCRIPTION} />

        {error ? <AdminAlert className="mt-3">{error}</AdminAlert> : null}

        <div className="mt-4 grid gap-2 sm:grid-cols-4">
          <StatTile label="Waiting" value={String(pending.length)} hint={`Inside the ${data?.graceDays ?? 30}-day window`} />
          <StatTile label="Due now" value={String(due.length)} hint="The next purge run removes these" />
          <StatTile label="Purged" value={String(rows.length - pending.length)} hint="Data already removed" />
          <StatTile
            label="Purge job"
            value={data?.job?.status ?? "never run"}
            hint={data?.job?.lastRunAt ? `Last run ${new Date(data.job.lastRunAt).toLocaleString()}` : "No run recorded"}
          />
        </div>

        <AdminSection
          title="Requests"
          description="Newest first. The reason is optional, so a blank one means they chose not to say."
          actions={
            <AdminSelect ariaLabel="Filter by state" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="all">All</option>
              <option value="pending">Waiting</option>
              <option value="purged">Purged</option>
            </AdminSelect>
          }
        >
          <AdminTable
            ariaLabel="Account deletions"
            head={
              <>
                <AdminTh>Account</AdminTh>
                <AdminTh>Reason</AdminTh>
                <AdminTh>What they said</AdminTh>
                <AdminTh align="right">Requested</AdminTh>
                <AdminTh align="right">Data removed</AdminTh>
                <AdminTh>State</AdminTh>
                <AdminTh>User id</AdminTh>
              </>
            }
          >
            {loading ? (
              <AdminTableMessage colSpan={7}>Loading deletions…</AdminTableMessage>
            ) : !rows.length ? (
              <AdminTableEmpty
                colSpan={7}
                title={state === "all" ? "Nobody has deleted their account" : "No accounts in this state"}
                hint={state === "all" ? "Requests appear here the moment someone asks." : "Try another filter."}
              />
            ) : (
              rows.map((r) => {
                const days = daysUntilPurge(r.purgeAfter);
                return (
                  <AdminTr key={r.userId}>
                    <AdminTd primary truncate="max-w-[240px]">
                      <span title={r.email ?? undefined}>{r.email ?? ADMIN_DASH}</span>
                      {r.name ? <span className="ml-2 text-[var(--muted-2)]">{r.name}</span> : null}
                    </AdminTd>
                    <AdminTd>{r.reasonLabel ?? <span className="text-[var(--muted-2)]">Rather not say</span>}</AdminTd>
                    <AdminTd truncate="max-w-[320px]">
                      <span title={r.reasonText ?? undefined}>{r.reasonText ?? ADMIN_DASH}</span>
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      <TimeCell value={r.requestedAt} />
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      {r.purgedAt ? <TimeCell value={r.purgedAt} /> : <TimeCell value={r.purgeAfter} mode="date" />}
                    </AdminTd>
                    <AdminTd>
                      {r.purgedAt ? (
                        <StatusPill tone="quiet">Purged</StatusPill>
                      ) : days === 0 ? (
                        <StatusPill tone="warning">Due now</StatusPill>
                      ) : (
                        <StatusPill tone="neutral">{days === null ? "Waiting" : `${days}d left`}</StatusPill>
                      )}
                    </AdminTd>
                    <AdminTd>
                      <IdCell value={r.userId} label="user id" href={`/a/data/users/${encodeURIComponent(r.userId)}`} />
                    </AdminTd>
                  </AdminTr>
                );
              })
            )}
          </AdminTable>
        </AdminSection>
      </div>
    </div>
  );
}
