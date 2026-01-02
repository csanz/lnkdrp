/**
 * Admin route: `/a/data/users`
 *
 * Lists users for admin inspection (paged).
 */
"use client";

import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";

type UserRow = {
  id: string;
  email: string | null;
  name: string | null;
  role: string | null;
  isTemp: boolean;
  isActive: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
};

type OrgRow = {
  id: string;
  type: string | null;
  name: string | null;
  slug: string | null;
  personalForUserId: string | null;
  createdDate: string | null;
};

type OrgMemberRow = {
  userId: string;
  memberRole: string | null;
  email: string | null;
  name: string | null;
  userRole: string | null;
  isActive: boolean;
  isTemp: boolean;
  lastLoginAt: string | null;
};

function fmtDate(v: string | null | undefined) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.valueOf())) return v;
  return d.toLocaleString();
}

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
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [selectedOrgId, setSelectedOrgId] = useState<string>("");
  const [members, setMembers] = useState<OrgMemberRow[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [membersReloadKey, setMembersReloadKey] = useState(0);

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
        const res = await fetch(`/api/admin/data/users?${qs.toString()}`, { method: "GET" });
        const data = (await res.json().catch(() => ({}))) as {
          error?: unknown;
          users?: unknown;
          total?: unknown;
        };
        if (!res.ok) {
          setError(typeof data.error === "string" ? data.error : "Failed to load users");
          setItems([]);
          setTotal(0);
          return;
        }
        setItems(Array.isArray(data.users) ? (data.users as UserRow[]) : []);
        setTotal(typeof data.total === "number" ? data.total : Number(data.total ?? 0) || 0);
      } catch {
        setError("Failed to load users");
        setItems([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, limit, page, q]);

  // Load org list once (used by org member viewer).
  useEffect(() => {
    if (!canUseAdmin) return;
    setOrgsLoading(true);
    setOrgsError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/admin/data/orgs?limit=500`, { method: "GET" });
        const data = (await res.json().catch(() => ({}))) as { error?: unknown; orgs?: unknown };
        if (!res.ok) {
          setOrgsError(typeof data.error === "string" ? data.error : "Failed to load orgs");
          setOrgs([]);
          return;
        }
        const list = Array.isArray(data.orgs) ? (data.orgs as OrgRow[]) : [];
        setOrgs(list);
        // Default to the signed-in active org if present and list contains it.
        const preferred = session?.activeOrgId ?? "";
        if (preferred && list.some((o) => o.id === preferred)) setSelectedOrgId(preferred);
      } catch {
        setOrgsError("Failed to load orgs");
        setOrgs([]);
      } finally {
        setOrgsLoading(false);
      }
    })();
  }, [canUseAdmin, session?.activeOrgId]);

  // Load members for selected org.
  useEffect(() => {
    if (!canUseAdmin) return;
    if (!selectedOrgId) {
      setMembers([]);
      setMembersError(null);
      setMembersLoading(false);
      return;
    }
    setMembersLoading(true);
    setMembersError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/admin/data/orgs/${encodeURIComponent(selectedOrgId)}/members`, { method: "GET" });
        const data = (await res.json().catch(() => ({}))) as { error?: unknown; members?: unknown };
        if (!res.ok) {
          setMembersError(typeof data.error === "string" ? data.error : "Failed to load members");
          setMembers([]);
          return;
        }
        setMembers(Array.isArray(data.members) ? (data.members as OrgMemberRow[]) : []);
      } catch {
        setMembersError("Failed to load members");
        setMembers([]);
      } finally {
        setMembersLoading(false);
      }
    })();
  }, [canUseAdmin, selectedOrgId, membersReloadKey]);

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
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-xl bg-[var(--primary-bg)] px-5 py-2.5 text-sm font-semibold text-[var(--primary-fg)] shadow-sm transition hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/data/users" })}
            >
              Sign in
            </button>
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
            <input
              className="w-[260px] max-w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm text-[var(--fg)]"
              placeholder="Search email or name…"
              value={q}
              onChange={(e) => {
                setPage(1);
                setQ(e.target.value);
              }}
            />
            <div className="text-xs text-[var(--muted-2)]">
              Page {page} / {totalPages} • {total} total
            </div>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)] disabled:opacity-60"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)] disabled:opacity-60"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </button>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-base font-semibold text-[var(--fg)]">Organization members</div>
              <div className="mt-1 text-sm text-[var(--muted)]">Select an org to view its users.</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="w-[340px] max-w-full rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm text-[var(--fg)] disabled:opacity-60"
                value={selectedOrgId}
                disabled={orgsLoading || Boolean(orgsError)}
                onChange={(e) => setSelectedOrgId(e.target.value)}
              >
                <option value="">{orgsLoading ? "Loading orgs…" : "Select an org…"}</option>
                {orgs.map((o) => {
                  const label = `${o.name ?? "Untitled"}${o.type ? ` (${o.type})` : ""}${o.slug ? ` · ${o.slug}` : ""}`;
                  return (
                    <option key={o.id} value={o.id}>
                      {label}
                    </option>
                  );
                })}
              </select>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)] disabled:opacity-60"
                disabled={!selectedOrgId || membersLoading}
                onClick={() => {
                  setMembersReloadKey((v) => v + 1);
                }}
              >
                {membersLoading ? "Loading…" : "Refresh"}
              </button>
              <div className="text-xs text-[var(--muted-2)]">{members.length ? `${members.length} members` : ""}</div>
            </div>
          </div>

          {orgsError ? <div className="mt-3 text-sm text-red-700">{orgsError}</div> : null}
          {membersError ? <div className="mt-3 text-sm text-red-700">{membersError}</div> : null}

          {!selectedOrgId ? (
            <div className="mt-4 text-sm text-[var(--muted)]">Pick an org above to view members.</div>
          ) : membersLoading ? (
            <div className="mt-4 text-sm text-[var(--muted)]">Loading members…</div>
          ) : (
            <div className="mt-4 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel-2)]">
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="border-b border-[var(--border)] bg-[var(--panel)]">
                    <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                      <th className="px-4 py-3">Email</th>
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Member role</th>
                      <th className="px-4 py-3">User role</th>
                      <th className="px-4 py-3">Active</th>
                      <th className="px-4 py-3">Temp</th>
                      <th className="px-4 py-3">Last login</th>
                      <th className="px-4 py-3">User ID</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {members.map((m) => (
                      <tr key={m.userId}>
                        <td className="px-4 py-3">{m.email ?? "—"}</td>
                        <td className="px-4 py-3">{m.name ?? "—"}</td>
                        <td className="px-4 py-3">{m.memberRole ?? "—"}</td>
                        <td className="px-4 py-3">{m.userRole ?? "—"}</td>
                        <td className="px-4 py-3">{m.isActive ? "Yes" : "No"}</td>
                        <td className="px-4 py-3">{m.isTemp ? "Yes" : "No"}</td>
                        <td className="px-4 py-3">{fmtDate(m.lastLoginAt) || "—"}</td>
                        <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{m.userId}</td>
                      </tr>
                    ))}
                    {members.length === 0 ? (
                      <tr>
                        <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={8}>
                          No members.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {error ? (
          <div className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : (
          <div className="mt-6 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-[var(--border)] bg-[var(--panel-2)]">
                  <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                    <th className="px-4 py-3">Email</th>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Role</th>
                    <th className="px-4 py-3">Active</th>
                    <th className="px-4 py-3">Temp</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3">Last login</th>
                    <th className="px-4 py-3">ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {items.map((u) => (
                    <tr key={u.id}>
                      <td className="px-4 py-3">{u.email ?? "—"}</td>
                      <td className="px-4 py-3">{u.name ?? "—"}</td>
                      <td className="px-4 py-3">{u.role ?? "—"}</td>
                      <td className="px-4 py-3">{u.isActive ? "Yes" : "No"}</td>
                      <td className="px-4 py-3">{u.isTemp ? "Yes" : "No"}</td>
                      <td className="px-4 py-3">{fmtDate(u.createdAt) || "—"}</td>
                      <td className="px-4 py-3">{fmtDate(u.lastLoginAt) || "—"}</td>
                      <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{u.id}</td>
                    </tr>
                  ))}
                  {items.length === 0 ? (
                    <tr>
                      <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={8}>
                        No users.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}



