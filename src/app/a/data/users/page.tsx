/**
 * Admin route: `/a/data/users`
 *
 * Lists users for admin inspection (paged). Reference implementation for the shared
 * admin UI in `@/components/admin` — header, filter band, dense table, row actions.
 */
"use client";

import { useSession } from "next-auth/react";
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
  IdCell,
  RowAction,
  RowActions,
  SegmentedAction,
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_DASH } from "@/lib/admin/ui";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { fetchJson } from "@/lib/http/fetchJson";

type UserRow = {
  id: string;
  email: string | null;
  name: string | null;
  role: string | null;
  plan: string | null;
  isTemp: boolean;
  isActive: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
};

type SortField = "createdAt" | "lastLoginAt";
type SortOrder = "desc" | "asc";

const COLUMN_COUNT = 8;

const PLAN_OPTIONS = [
  { value: "free" as const, label: "Free", title: "Admin override: set plan to Free" },
  { value: "pro" as const, label: "Pro", title: "Admin override: set plan to Pro" },
];

export default function AdminDataUsersPage() {
  const { data: session } = useSession();
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("");
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planBusyUserId, setPlanBusyUserId] = useState<string>("");
  const [planError, setPlanError] = useState<string | null>(null);
  const [deactivateBusyUserId, setDeactivateBusyUserId] = useState<string>("");
  const [reloadKey, setReloadKey] = useState(0);

  const filtered = Boolean(q.trim() || roleFilter);

  useEffect(() => {
    if (!canUseAdmin) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const qs = new URLSearchParams();
        qs.set("limit", String(limit));
        qs.set("page", String(page));
        if (q.trim()) qs.set("q", q.trim());
        if (roleFilter) qs.set("role", roleFilter);
        qs.set("sort", sortField);
        qs.set("order", sortOrder);
        const data = await fetchJson<{ users?: unknown; total?: unknown }>(`/api/admin/data/users?${qs.toString()}`, {
          method: "GET",
        });
        setItems(Array.isArray(data.users) ? (data.users as UserRow[]) : []);
        setTotal(typeof data.total === "number" ? data.total : Number(data.total ?? 0) || 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load users");
        setItems([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, limit, page, q, roleFilter, sortField, sortOrder, reloadKey]);

  async function setUserPlan(userId: string, plan: "free" | "pro") {
    if (!userId) return;
    if (planBusyUserId) return;
    setPlanBusyUserId(userId);
    setPlanError(null);
    try {
      const json = await fetchJson<{ ok?: boolean; plan?: string; error?: string }>(`/api/admin/users/${encodeURIComponent(userId)}/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      if (!json || json.ok !== true) throw new Error(json?.error || "Failed to update plan");

      // Update the row optimistically so the admin table reflects the override immediately.
      setItems((prev) => prev.map((u) => (u.id === userId ? { ...u, plan: (json.plan ?? plan) as any } : u)));

      // Clear cached plan used by the workspace pill (best-effort).
      if (typeof window !== "undefined") {
        const userKey = (session?.user?.email ?? "").trim();
        if (userKey) window.sessionStorage.removeItem(`lnkdrp_billing_plan_${userKey}`);
      }
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : "Failed to update plan");
    } finally {
      setPlanBusyUserId("");
    }
  }

  async function deactivateUser(userId: string) {
    if (!userId) return;
    if (deactivateBusyUserId) return;
    const ok = window.confirm(`Deactivate user ${userId}?\n\nThis sets isActive=false (soft disable).`);
    if (!ok) return;
    setDeactivateBusyUserId(userId);
    setPlanError(null);
    try {
      await fetchJson(`/api/admin/data/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
      setItems((prev) => prev.map((u) => (u.id === userId ? { ...u, isActive: false } : u)));
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : "Failed to deactivate user");
    } finally {
      setDeactivateBusyUserId("");
    }
  }

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Users" description="Every account on this deployment. The plan control in Actions is both the current plan and the override." callbackUrl="/a/data/users" />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title="Users"
          description="Every account on this deployment. The plan control in Actions is both the current plan and the override."
        />

        <AdminFilterBar
          className="mt-4"
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setPage}
          noun="users"
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
            ariaLabel="Search users by email or name"
          />
          <AdminSelect
            ariaLabel="Filter by role"
            value={roleFilter}
            onChange={(e) => {
              setPage(1);
              setRoleFilter(e.target.value);
            }}
          >
            <option value="">All roles</option>
            <option value="admin">Admin</option>
            <option value="user">User</option>
            <option value="temp">Temp</option>
          </AdminSelect>
          <AdminSelect
            ariaLabel="Sort users"
            value={`${sortField}:${sortOrder}`}
            onChange={(e) => {
              const raw = e.target.value || "createdAt:desc";
              const [f, o] = raw.split(":");
              const nextField = (f === "lastLoginAt" ? "lastLoginAt" : "createdAt") as SortField;
              const nextOrder = (o === "asc" ? "asc" : "desc") as SortOrder;
              setPage(1);
              setSortField(nextField);
              setSortOrder(nextOrder);
            }}
          >
            <option value="createdAt:desc">Created (newest)</option>
            <option value="createdAt:asc">Created (oldest)</option>
            <option value="lastLoginAt:desc">Last login (newest)</option>
            <option value="lastLoginAt:asc">Last login (oldest)</option>
          </AdminSelect>
        </AdminFilterBar>

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}
        {planError ? (
          <AdminAlert className="mt-3">
            {planError}
          </AdminAlert>
        ) : null}

        <AdminTable
          className="mt-3"
          ariaLabel="Users"
          head={
            <>
              <AdminTh>Email</AdminTh>
              <AdminTh>Name</AdminTh>
              <AdminTh>Role</AdminTh>
              <AdminTh>Status</AdminTh>
              <AdminTh align="right">Created</AdminTh>
              <AdminTh align="right">Last login</AdminTh>
              <AdminTh>User ID</AdminTh>
              <AdminTh align="right" sticky>Actions</AdminTh>
            </>
          }
        >
          {loading && items.length === 0 ? (
            <AdminTableMessage colSpan={COLUMN_COUNT}>Loading users…</AdminTableMessage>
          ) : items.length === 0 ? (
            <AdminTableEmpty
              colSpan={COLUMN_COUNT}
              title={filtered ? "No users match that search" : "No users yet"}
              hint={filtered ? "Try a different email, name or role filter." : undefined}
            />
          ) : (
            items.map((u) => {
              const plan = (u.plan ?? "free").toLowerCase() === "pro" ? "pro" : "free";
              const planBusy = planBusyUserId === u.id;
              const otherPlanBusy = Boolean(planBusyUserId) && !planBusy;
              return (
                <AdminTr key={u.id}>
                  <AdminTd primary truncate="max-w-[260px]">
                    <Link
                      href={`/a/data/users/${encodeURIComponent(u.id)}`}
                      className="rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]"
                      title={u.email ?? "View user details"}
                    >
                      {u.email ?? ADMIN_DASH}
                    </Link>
                  </AdminTd>
                  <AdminTd truncate="max-w-[180px]">
                    <span title={u.name ?? undefined}>{u.name ?? ADMIN_DASH}</span>
                  </AdminTd>
                  <AdminTd>
                    {u.role === "admin" ? (
                      <StatusPill tone="accent">Admin</StatusPill>
                    ) : u.role ? (
                      <span className="capitalize">{u.role}</span>
                    ) : (
                      ADMIN_DASH
                    )}
                  </AdminTd>
                  {/* No Plan column: the segmented control in Actions already shows the
                      current plan, and two "Free" chips per row read as two states. */}
                  <AdminTd>
                    <span className="inline-flex items-center gap-1.5">
                      {u.isActive === false ? (
                        <StatusPill tone="danger">Inactive</StatusPill>
                      ) : (
                        <StatusPill tone="positive" dot>
                          Active
                        </StatusPill>
                      )}
                      {u.isTemp ? <StatusPill tone="warning">Temp</StatusPill> : null}
                    </span>
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    <TimeCell value={u.createdAt} />
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    <TimeCell value={u.lastLoginAt} />
                  </AdminTd>
                  <AdminTd>
                    <IdCell value={u.id} label="user id" href={`/a/data/users/${encodeURIComponent(u.id)}`} />
                  </AdminTd>
                  <AdminTd align="right" sticky actions>
                    <RowActions>
                      <SegmentedAction
                        options={PLAN_OPTIONS}
                        value={plan}
                        onSelect={(next) => void setUserPlan(u.id, next)}
                        ariaLabel={`Plan for ${u.email ?? u.id}`}
                        disabled={otherPlanBusy}
                        busy={planBusy}
                      />
                      <RowAction
                        tone="danger"
                        busy={deactivateBusyUserId === u.id}
                        busyLabel="Deactivating…"
                        disabled={
                          (Boolean(deactivateBusyUserId) && deactivateBusyUserId !== u.id) || u.isActive === false
                        }
                        title="Deactivate user (sets isActive=false)"
                        onClick={() => void deactivateUser(u.id)}
                      >
                        {u.isActive === false ? "Deactivated" : "Deactivate"}
                      </RowAction>
                    </RowActions>
                  </AdminTd>
                </AdminTr>
              );
            })
          )}
        </AdminTable>
      </div>
    </div>
  );
}
