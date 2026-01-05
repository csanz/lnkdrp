/**
 * Admin route: `/a/data/workspaces/:workspaceId`
 *
 * Workspace detail: show workspace members.
 */
"use client";

import Link from "next/link";
import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Button from "@/components/ui/Button";
import DataTable from "@/components/ui/DataTable";
import { fmtDate } from "@/lib/admin/format";
import { fetchJson } from "@/lib/http/fetchJson";

type MemberRow = {
  userId: string;
  memberRole: string | null;
  email: string | null;
  name: string | null;
  userRole: string | null;
  isActive: boolean;
  isTemp: boolean;
  lastLoginAt: string | null;
};

export default function AdminWorkspaceDetailPage() {
  const params = useParams<{ workspaceId?: string }>();
  const workspaceId = typeof params?.workspaceId === "string" ? params.workspaceId : "";

  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!canUseAdmin) return;
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await fetchJson<{ members?: unknown }>(
          `/api/admin/data/workspaces/${encodeURIComponent(workspaceId)}/members`,
          { method: "GET" },
        );
        setMembers(Array.isArray(data.members) ? (data.members as MemberRow[]) : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load members");
        setMembers([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, workspaceId, reloadKey]);

  const membersCountText = useMemo(() => (members.length ? `${members.length} members` : ""), [members.length]);

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Workspaces</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] px-5 py-2.5 text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: `/a/data/workspaces/${encodeURIComponent(workspaceId)}` })}
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
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Workspaces</div>
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
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
              <Link href="/a/data/workspaces" className="hover:underline">
                Workspaces
              </Link>{" "}
              / {workspaceId}
            </div>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg)]">Workspace members</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">Members (and roles) for this workspace.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-xs text-[var(--muted-2)]">{membersCountText}</div>
            <Button variant="outline" className="bg-[var(--panel-2)]" disabled={loading} onClick={() => setReloadKey((v) => v + 1)}>
              {loading ? "Loading…" : "Refresh"}
            </Button>
          </div>
        </div>

        {error ? <div className="mt-4 text-sm text-red-700">{error}</div> : null}

        {loading ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : (
          <DataTable containerClassName="mt-6 rounded-xl bg-[var(--panel-2)]">
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
          </DataTable>
        )}
      </div>
    </div>
  );
}


