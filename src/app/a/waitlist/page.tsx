/**
 * Admin route: `/a/waitlist`
 *
 * Who is waiting to be let in, oldest first, and the button that lets them in. Approving sends the
 * welcome email (`templates/waitlistApproved.ts`); the API only sends when the click is the one
 * that changed the row, so a double press does not email twice.
 *
 * The banner at the top is the thing an admin most needs to know and cannot see from the rows: a
 * queue that is switched off is letting every new sign-up straight through, however long this list
 * happens to be.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Button from "@/components/ui/Button";
import {
  AdminAlert,
  AdminAccessState,
  AdminFilterBar,
  AdminPageHeader,
  AdminSearchInput,
  AdminSelect,
  AdminTable,
  AdminTableEmpty,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  RowAction,
  RowActions,
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_DASH } from "@/lib/admin/ui";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { fetchJson } from "@/lib/http/fetchJson";

type WaitlistRow = {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: string | null;
  waitlistedAt: string | null;
  approvedAt: string | null;
  accessStatus: "approved" | "waitlisted";
};

const COLUMN_COUNT = 6;

export default function AdminWaitlistPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [status, setStatus] = useState<"waitlisted" | "approved">("waitlisted");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [total, setTotal] = useState(0);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [items, setItems] = useState<WaitlistRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const filtered = Boolean(q.trim());

  useEffect(() => {
    if (!canUseAdmin) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const qs = new URLSearchParams();
        qs.set("status", status);
        qs.set("limit", String(limit));
        qs.set("page", String(page));
        if (q.trim()) qs.set("q", q.trim());
        const data = await fetchJson<{ users?: unknown; total?: unknown; enabled?: unknown }>(
          `/api/admin/waitlist?${qs.toString()}`,
          { method: "GET" },
        );
        setItems(Array.isArray(data.users) ? (data.users as WaitlistRow[]) : []);
        setTotal(typeof data.total === "number" ? data.total : 0);
        setEnabled(typeof data.enabled === "boolean" ? data.enabled : null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load the queue");
        setItems([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, limit, page, q, status, reloadKey]);

  async function approve(userId: string) {
    if (!userId || busyUserId) return;
    setBusyUserId(userId);
    setActionError(null);
    try {
      const json = await fetchJson<{ ok?: boolean; emailed?: boolean; error?: string }>(
        `/api/admin/waitlist/${encodeURIComponent(userId)}/approve`,
        { method: "POST" },
      );
      if (!json || json.ok !== true) throw new Error(json?.error || "Failed to approve");
      // Drop the row rather than restyling it: this list is "who is still waiting".
      setItems((prev) => prev.filter((u) => u.id !== userId));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to approve");
    } finally {
      setBusyUserId("");
    }
  }

  if (!canUseAdmin) {
    return (
      <AdminAccessState
        access={access}
        title="Early access"
        description="Who is waiting to be let in, and the button that lets them in."
        callbackUrl="/a/waitlist"
      />
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title="Early access"
          description="Who is waiting to be let in, oldest first. Approving opens the account and emails them that it is open."
        />

        {enabled === false ? (
          <AdminAlert className="mt-4">
            The queue is off (<code>WAITLIST_ENABLED</code> is unset), so new sign-ups are going straight into the
            app. Anyone listed here queued while it was on and is still waiting.
          </AdminAlert>
        ) : null}

        <AdminFilterBar
          className="mt-4"
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setPage}
          noun={status === "approved" ? "approved" : "waiting"}
          loading={loading}
          actions={
            <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
              Refresh
            </Button>
          }
        >
          <AdminSearchInput
            value={q}
            onValueChange={(v) => {
              setPage(1);
              setQ(v);
            }}
            placeholder="Search email or name…"
            ariaLabel="Search the queue by email or name"
          />
          <AdminSelect
            ariaLabel="Filter by access status"
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value === "approved" ? "approved" : "waitlisted");
            }}
          >
            <option value="waitlisted">Waiting</option>
            <option value="approved">Let in</option>
          </AdminSelect>
        </AdminFilterBar>

        {error ? <AdminAlert className="mt-3">{error}</AdminAlert> : null}
        {actionError ? <AdminAlert className="mt-3">{actionError}</AdminAlert> : null}

        <AdminTable
          className="mt-3"
          ariaLabel="Early access queue"
          head={
            <>
              <AdminTh>Email</AdminTh>
              <AdminTh>Name</AdminTh>
              <AdminTh>Status</AdminTh>
              <AdminTh align="right">{status === "approved" ? "Let in" : "Waiting since"}</AdminTh>
              <AdminTh>User ID</AdminTh>
              <AdminTh align="right" sticky>
                Actions
              </AdminTh>
            </>
          }
        >
          {loading && items.length === 0 ? (
            <AdminTableMessage colSpan={COLUMN_COUNT}>Loading…</AdminTableMessage>
          ) : items.length === 0 ? (
            <AdminTableEmpty
              colSpan={COLUMN_COUNT}
              title={
                filtered
                  ? "Nobody matches that search"
                  : status === "approved"
                    ? "Nobody has been let in yet"
                    : "Nobody is waiting"
              }
              hint={filtered ? "Try a different email or name." : undefined}
            />
          ) : (
            items.map((u) => (
              <AdminTr key={u.id}>
                <AdminTd primary truncate="max-w-[280px]">
                  <Link
                    href={`/a/data/users/${encodeURIComponent(u.id)}`}
                    className="rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]"
                    title={u.email ?? "View user details"}
                  >
                    {u.email ?? ADMIN_DASH}
                  </Link>
                </AdminTd>
                <AdminTd truncate="max-w-[200px]">
                  <span title={u.name ?? undefined}>{u.name ?? ADMIN_DASH}</span>
                </AdminTd>
                <AdminTd>
                  {u.accessStatus === "waitlisted" ? (
                    <StatusPill tone="warning">Waiting</StatusPill>
                  ) : (
                    <StatusPill tone="positive" dot>
                      Let in
                    </StatusPill>
                  )}
                </AdminTd>
                <AdminTd align="right" numeric>
                  <TimeCell value={status === "approved" ? u.approvedAt : u.waitlistedAt ?? u.createdAt} />
                </AdminTd>
                <AdminTd>
                  <span className="font-mono text-[11px] text-[var(--muted-2)]">{u.id}</span>
                </AdminTd>
                <AdminTd align="right" sticky>
                  <RowActions>
                    {u.accessStatus === "waitlisted" ? (
                      <RowAction
                        onClick={() => void approve(u.id)}
                        disabled={Boolean(busyUserId)}
                        title="Open this account and email them that it is open"
                      >
                        {busyUserId === u.id ? "Letting in…" : "Let in"}
                      </RowAction>
                    ) : (
                      <span className="text-[12px] text-[var(--muted-2)]">{ADMIN_DASH}</span>
                    )}
                  </RowActions>
                </AdminTd>
              </AdminTr>
            ))
          )}
        </AdminTable>
      </div>
    </div>
  );
}
