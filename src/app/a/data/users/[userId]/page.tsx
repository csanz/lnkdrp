/**
 * Admin route: `/a/data/users/:userId`
 *
 * User detail page for admin inspection (user record + memberships).
 */
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";

import Button from "@/components/ui/Button";
import DataTable from "@/components/ui/DataTable";
import Panel from "@/components/ui/Panel";
import { fmtDate } from "@/lib/admin/format";
import { fetchJson } from "@/lib/http/fetchJson";

type UserInfo = {
  id: string;
  isTemp: boolean;
  email: string | null;
  name: string | null;
  image: string | null;
  authProvider: string | null;
  providerAccountId: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  isActive: boolean;
  role: string | null;
  plan: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeSubscriptionStatus: string | null;
  stripeCurrentPeriodEnd: string | null;
  spendLimitCents: number | null;
  spendUsedCentsThisPeriod: number | null;
  onboardingCompleted: boolean;
  metadata: unknown;
};

type MembershipRow = {
  orgId: string;
  orgType: string | null;
  orgName: string | null;
  orgSlug: string | null;
  membershipRole: string | null;
  docUpdateEmailMode: string | null;
  repoLinkRequestEmailMode: string | null;
  membershipCreatedDate: string | null;
  membershipUpdatedDate: string | null;
};

export default function AdminUserDetailPage() {
  const params = useParams<{ userId?: string }>();
  const userId = typeof params?.userId === "string" ? params.userId : "";

  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [user, setUser] = useState<UserInfo | null>(null);
  const [memberships, setMemberships] = useState<MembershipRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [deactivateBusy, setDeactivateBusy] = useState(false);

  useEffect(() => {
    if (!canUseAdmin) return;
    if (!userId) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await fetchJson<{ user?: unknown; memberships?: unknown }>(
          `/api/admin/data/users/${encodeURIComponent(userId)}`,
          { method: "GET" },
        );
        setUser((data.user as UserInfo) ?? null);
        setMemberships(Array.isArray(data.memberships) ? (data.memberships as MembershipRow[]) : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load user");
        setUser(null);
        setMemberships([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, userId, reloadKey]);

  const title = useMemo(() => user?.email || user?.name || "User", [user?.email, user?.name]);

  async function deactivate() {
    if (!userId) return;
    if (deactivateBusy) return;
    const ok = window.confirm(`Deactivate user ${userId}?\n\nThis sets isActive=false (soft disable).`);
    if (!ok) return;
    setDeactivateBusy(true);
    setError(null);
    try {
      await fetchJson(`/api/admin/data/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
      setUser((prev) => (prev ? { ...prev, isActive: false } : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to deactivate user");
    } finally {
      setDeactivateBusy(false);
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
              onClick={() => void signIn("google", { callbackUrl: `/a/data/users/${encodeURIComponent(userId)}` })}
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
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
              <Link href="/a/data/users" className="hover:underline">
                Users
              </Link>{" "}
              / {userId}
            </div>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg)]">{title}</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">User details and workspace memberships.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" className="bg-[var(--panel-2)]" disabled={loading} onClick={() => setReloadKey((v) => v + 1)}>
              {loading ? "Loading…" : "Refresh"}
            </Button>
            <Button
              variant="secondary"
              disabled={loading || deactivateBusy || user?.isActive === false}
              onClick={() => void deactivate()}
              title="Deactivate user"
            >
              {user?.isActive === false ? "Deactivated" : deactivateBusy ? "Deactivating…" : "Deactivate"}
            </Button>
          </div>
        </div>

        {error ? <div className="mt-4 text-sm text-red-700">{error}</div> : null}

        <div className="mt-6 grid gap-4">
          <Panel className="min-w-0">
            <div className="text-sm font-semibold text-[var(--fg)]">User record</div>
            <div className="mt-3 grid gap-2 text-sm text-[var(--muted)]">
              <div>
                <span className="font-semibold text-[var(--fg)]">User ID:</span>{" "}
                <span className="font-mono text-xs text-[var(--muted)]">{userId}</span>
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Email:</span> {user?.email ?? "—"}
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Name:</span> {user?.name ?? "—"}
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Role:</span> {user?.role ?? "—"}
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Plan:</span> {user?.plan ?? "—"}
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Active:</span> {user ? (user.isActive ? "Yes" : "No") : "—"}
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Temp:</span> {user ? (user.isTemp ? "Yes" : "No") : "—"}
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Created:</span> {fmtDate(user?.createdAt ?? null) || "—"}
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Last login:</span> {fmtDate(user?.lastLoginAt ?? null) || "—"}
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Auth provider:</span> {user?.authProvider ?? "—"}
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Provider account id:</span>{" "}
                <span className="font-mono text-xs text-[var(--muted)]">{user?.providerAccountId ?? "—"}</span>
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Stripe customer:</span>{" "}
                <span className="font-mono text-xs text-[var(--muted)]">{user?.stripeCustomerId ?? "—"}</span>
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Stripe subscription:</span>{" "}
                <span className="font-mono text-xs text-[var(--muted)]">{user?.stripeSubscriptionId ?? "—"}</span>
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Stripe status:</span> {user?.stripeSubscriptionStatus ?? "—"}
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Stripe period end:</span> {fmtDate(user?.stripeCurrentPeriodEnd ?? null) || "—"}
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Spend limit (cents):</span>{" "}
                {user?.spendLimitCents ?? "—"}
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Spend used this period (cents):</span>{" "}
                {user?.spendUsedCentsThisPeriod ?? "—"}
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Onboarding completed:</span>{" "}
                {user ? (user.onboardingCompleted ? "Yes" : "No") : "—"}
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Image:</span>{" "}
                {user?.image ? (
                  <a className="break-all text-[var(--fg)] underline" href={user.image} target="_blank" rel="noreferrer">
                    {user.image}
                  </a>
                ) : (
                  "—"
                )}
              </div>
            </div>
          </Panel>

          <Panel className="min-w-0">
            <div className="text-sm font-semibold text-[var(--fg)]">Memberships</div>
            <DataTable containerClassName="mt-3 rounded-xl bg-[var(--panel-2)]">
              <thead className="border-b border-[var(--border)] bg-[var(--panel)]">
                <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                  <th className="px-4 py-3">Workspace</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Slug</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Doc updates</th>
                  <th className="px-4 py-3">Repo requests</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Updated</th>
                  <th className="px-4 py-3">Org ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {memberships.map((m) => (
                  <tr key={m.orgId}>
                    <td className="px-4 py-3">{m.orgName ?? "—"}</td>
                    <td className="px-4 py-3">{m.orgType ?? "—"}</td>
                    <td className="px-4 py-3">{m.orgSlug ?? "—"}</td>
                    <td className="px-4 py-3">{m.membershipRole ?? "—"}</td>
                    <td className="px-4 py-3">{m.docUpdateEmailMode ?? "—"}</td>
                    <td className="px-4 py-3">{m.repoLinkRequestEmailMode ?? "—"}</td>
                    <td className="px-4 py-3">{fmtDate(m.membershipCreatedDate) || "—"}</td>
                    <td className="px-4 py-3">{fmtDate(m.membershipUpdatedDate) || "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{m.orgId}</td>
                  </tr>
                ))}
                {memberships.length === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={9}>
                      No memberships.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </DataTable>
          </Panel>

          <Panel className="min-w-0">
            <div className="text-sm font-semibold text-[var(--fg)]">Metadata (raw)</div>
            <pre className="mt-3 max-h-[360px] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-4 text-xs text-[var(--muted)]">
              {JSON.stringify(user?.metadata ?? null, null, 2)}
            </pre>
          </Panel>
        </div>
      </div>
    </div>
  );
}


