/**
 * Admin route: `/a/data/users`
 *
 * Lists users for admin inspection (paged).
 */
"use client";

import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import DataTable from "@/components/ui/DataTable";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import Link from "next/link";
import { fmtDate } from "@/lib/admin/format";
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

export default function AdminDataUsersPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

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

  const totalPages = useMemo(() => Math.max(1, Math.ceil((total || 0) / limit)), [total, limit]);

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
  }, [canUseAdmin, limit, page, q, roleFilter, sortField, sortOrder]);

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

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Users</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] px-5 py-2.5 text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/data/users" })}
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
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Users</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You don’t have access to this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin / Data / Users</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">Paged list of users.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-[260px] max-w-full"
              placeholder="Search email or name…"
              value={q}
              onChange={(e) => {
                setPage(1);
                setQ(e.target.value);
              }}
            />
            <Select
              className="w-[160px] max-w-full"
              value={roleFilter}
              onChange={(e) => {
                setPage(1);
                setRoleFilter(e.target.value);
              }}
              title="Filter by role"
            >
              <option value="">All roles</option>
              <option value="admin">admin</option>
              <option value="user">user</option>
              <option value="temp">temp</option>
            </Select>
            <Select
              className="w-[170px] max-w-full"
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
              title="Sort"
            >
              <option value="createdAt:desc">Created (newest)</option>
              <option value="createdAt:asc">Created (oldest)</option>
              <option value="lastLoginAt:desc">Last login (newest)</option>
              <option value="lastLoginAt:asc">Last login (oldest)</option>
            </Select>
            <div className="text-xs text-[var(--muted-2)]">
              Page {page} / {totalPages} • {total} total
            </div>
            <Button
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>

        {error ? (
          <Alert variant="info" className="mt-5 border border-[var(--border)] bg-[var(--panel)] text-sm text-red-700">
            {error}
          </Alert>
        ) : null}
        {planError ? (
          <Alert variant="info" className="mt-3 border border-[var(--border)] bg-[var(--panel)] text-sm text-red-700">
            {planError}
          </Alert>
        ) : null}

        {loading ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : (
          <DataTable containerClassName="mt-6">
            <thead className="border-b border-[var(--border)] bg-[var(--panel-2)]">
              <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Active</th>
                <th className="px-4 py-3">Temp</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Last login</th>
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {items.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/a/data/users/${encodeURIComponent(u.id)}`}
                      className="font-semibold text-[var(--fg)] hover:underline"
                      title="View user details"
                    >
                      {u.email ?? "—"}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{u.name ?? "—"}</td>
                  <td className="px-4 py-3">{u.role ?? "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-[var(--panel-hover)] px-2 py-1 text-xs font-semibold text-[var(--fg)]">
                        {(u.plan ?? "free").toLowerCase() === "pro" ? "Pro" : "Free"}
                      </span>
                      <button
                        type="button"
                        className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] disabled:opacity-60"
                        disabled={Boolean(planBusyUserId) && planBusyUserId !== u.id}
                        onClick={() => void setUserPlan(u.id, "pro")}
                        title="Admin override: set plan to Pro"
                      >
                        {planBusyUserId === u.id ? "Saving…" : "Set Pro"}
                      </button>
                      <button
                        type="button"
                        className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] disabled:opacity-60"
                        disabled={Boolean(planBusyUserId) && planBusyUserId !== u.id}
                        onClick={() => void setUserPlan(u.id, "free")}
                        title="Admin override: set plan to Free"
                      >
                        {planBusyUserId === u.id ? "Saving…" : "Set Free"}
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3">{u.isActive ? "Yes" : "No"}</td>
                  <td className="px-4 py-3">{u.isTemp ? "Yes" : "No"}</td>
                  <td className="px-4 py-3">{fmtDate(u.createdAt) || "—"}</td>
                  <td className="px-4 py-3">{fmtDate(u.lastLoginAt) || "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{u.id}</td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs font-semibold text-red-500 hover:bg-[var(--panel-hover)] disabled:opacity-60"
                      disabled={(Boolean(deactivateBusyUserId) && deactivateBusyUserId !== u.id) || u.isActive === false}
                      onClick={() => void deactivateUser(u.id)}
                      title="Deactivate user (sets isActive=false)"
                    >
                      {u.isActive === false ? "Deactivated" : deactivateBusyUserId === u.id ? "Deactivating…" : "Deactivate"}
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={10}>
                    No users.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </DataTable>
        )}
      </div>
    </div>
  );
}



