/**
 * Admin route: `/a/data/users/:userId`
 *
 * User detail: the account record, its billing state, and the workspaces it belongs to.
 * Built from the shared admin pieces — the panels carry the same label/value rhythm as
 * every other detail page, and the memberships table is the same density as the lists.
 */
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import Button from "@/components/ui/Button";
import {
  AdminAlert,
  AdminAccessState,
  AdminPageHeader,
  AdminTable,
  AdminTableEmpty,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  BoolState,
  DetailGrid,
  DetailPanel,
  DetailRow,
  DetailSection,
  IdCell,
  JsonBlock,
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_DASH } from "@/lib/admin/ui";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
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

const MEMBERSHIP_COLUMNS = 9;

/** Cents as money, with an em dash when the field was never set. */
function centsText(cents: number | null | undefined): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "";
  return `$${(cents / 100).toFixed(2)}`;
}

/** The user detail page. */
export default function AdminUserDetailPage() {
  const params = useParams<{ userId?: string }>();
  const userId = typeof params?.userId === "string" ? params.userId : "";

  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

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
  const plan = (user?.plan ?? "").toLowerCase() === "pro" ? "pro" : user?.plan ? "free" : null;

  /** Soft-disable the account (confirms first), then mark the loaded row inactive. */
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

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="User" callbackUrl={`/a/data/users/${encodeURIComponent(userId)}`} />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title={title}
          description="One account: its record, billing state and workspace memberships."
          actions={
            <>
              <Button variant="outline" disabled={loading} onClick={() => setReloadKey((v) => v + 1)}>
                {loading ? "Loading…" : "Refresh"}
              </Button>
              <Button
                variant="secondary"
                disabled={loading || deactivateBusy || user?.isActive === false}
                onClick={() => void deactivate()}
                title="Deactivate user (sets isActive=false)"
              >
                {user?.isActive === false ? "Deactivated" : deactivateBusy ? "Deactivating…" : "Deactivate"}
              </Button>
            </>
          }
        />

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <DetailPanel title="Account" description="Who this user is and how they sign in.">
            <DetailGrid>
              <DetailRow label="Email" title={user?.email ?? undefined}>
                {user?.email}
              </DetailRow>
              <DetailRow label="Name">{user?.name}</DetailRow>
              <DetailRow label="Role">
                {user?.role === "admin" ? (
                  <StatusPill tone="accent">Admin</StatusPill>
                ) : user?.role ? (
                  <span className="capitalize">{user.role}</span>
                ) : null}
              </DetailRow>
              <DetailRow label="Status">
                {user ? (
                  <span className="inline-flex items-center gap-1.5">
                    {user.isActive === false ? (
                      <StatusPill tone="danger">Inactive</StatusPill>
                    ) : (
                      <StatusPill tone="quiet" dot>
                        Active
                      </StatusPill>
                    )}
                    {user.isTemp ? <StatusPill tone="warning">Temp</StatusPill> : null}
                  </span>
                ) : null}
              </DetailRow>
              <DetailRow label="Onboarding">
                {user ? <BoolState value={user.onboardingCompleted} trueLabel="Completed" /> : null}
              </DetailRow>
              <DetailRow label="Created">{user ? <TimeCell value={user.createdAt} /> : null}</DetailRow>
              <DetailRow label="Last login">{user ? <TimeCell value={user.lastLoginAt} /> : null}</DetailRow>
              <DetailRow label="Auth provider">{user?.authProvider}</DetailRow>
              <DetailRow label="Avatar">
                {user?.image ? (
                  <a
                    className="block truncate rounded text-[var(--fg)] underline decoration-[var(--border)] underline-offset-2 hover:decoration-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]"
                    href={user.image}
                    target="_blank"
                    rel="noreferrer"
                    title={user.image}
                  >
                    {user.image}
                  </a>
                ) : null}
              </DetailRow>
              <DetailRow label="User ID">
                <IdCell value={userId} label="user id" />
              </DetailRow>
              <DetailRow label="Provider account">
                <IdCell value={user?.providerAccountId} label="provider account id" head={8} tail={4} />
              </DetailRow>
            </DetailGrid>
          </DetailPanel>

          <DetailPanel title="Plan and billing" description="Plan override, Stripe state and the spend guardrail.">
            <DetailGrid>
              <DetailRow label="Plan">
                {plan ? (
                  <StatusPill tone={plan === "pro" ? "info" : "quiet"}>{plan === "pro" ? "Pro" : "Free"}</StatusPill>
                ) : null}
              </DetailRow>
              <DetailRow label="Stripe status">
                {user?.stripeSubscriptionStatus ? (
                  <StatusPill tone={user.stripeSubscriptionStatus === "active" ? "positive" : "warning"}>
                    {user.stripeSubscriptionStatus}
                  </StatusPill>
                ) : null}
              </DetailRow>
              <DetailRow label="Period end">
                {user?.stripeCurrentPeriodEnd ? <TimeCell value={user.stripeCurrentPeriodEnd} mode="date" /> : null}
              </DetailRow>
              <DetailRow label="Spend limit">
                <span className="tabular-nums">{centsText(user?.spendLimitCents)}</span>
              </DetailRow>
              <DetailRow label="Spent this period">
                <span className="tabular-nums">{centsText(user?.spendUsedCentsThisPeriod)}</span>
              </DetailRow>
              <DetailRow label="Stripe customer">
                <IdCell value={user?.stripeCustomerId} label="Stripe customer id" head={10} tail={4} />
              </DetailRow>
              <DetailRow label="Stripe subscription">
                <IdCell value={user?.stripeSubscriptionId} label="Stripe subscription id" head={10} tail={4} />
              </DetailRow>
            </DetailGrid>
          </DetailPanel>
        </div>

        <DetailSection
          className="mt-5"
          title="Memberships"
          description="Every workspace this user belongs to, and how it emails them."
        />
        <AdminTable
          className="mt-2"
          ariaLabel="Memberships"
          head={
            <>
              <AdminTh>Workspace</AdminTh>
              <AdminTh>Type</AdminTh>
              <AdminTh>Slug</AdminTh>
              <AdminTh>Role</AdminTh>
              <AdminTh>Doc updates</AdminTh>
              <AdminTh>Repo requests</AdminTh>
              <AdminTh align="right">Created</AdminTh>
              <AdminTh align="right">Updated</AdminTh>
              <AdminTh>Workspace ID</AdminTh>
            </>
          }
        >
          {loading && memberships.length === 0 ? (
            <AdminTableMessage colSpan={MEMBERSHIP_COLUMNS}>Loading memberships…</AdminTableMessage>
          ) : memberships.length === 0 ? (
            <AdminTableEmpty
              colSpan={MEMBERSHIP_COLUMNS}
              title="No memberships"
              hint="This user does not belong to any workspace yet."
            />
          ) : (
            memberships.map((m) => (
              <AdminTr key={m.orgId}>
                <AdminTd primary truncate="max-w-[220px]">
                  <Link
                    href={`/a/data/workspaces/${encodeURIComponent(m.orgId)}`}
                    className="rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]"
                    title={m.orgName ?? "View workspace"}
                  >
                    {m.orgName ?? ADMIN_DASH}
                  </Link>
                </AdminTd>
                <AdminTd>
                  {m.orgType ? <span className="capitalize">{m.orgType}</span> : ADMIN_DASH}
                </AdminTd>
                <AdminTd truncate="max-w-[160px]">
                  <span title={m.orgSlug ?? undefined}>{m.orgSlug ?? ADMIN_DASH}</span>
                </AdminTd>
                <AdminTd>
                  {m.membershipRole ? <span className="capitalize">{m.membershipRole}</span> : ADMIN_DASH}
                </AdminTd>
                <AdminTd>{m.docUpdateEmailMode ?? ADMIN_DASH}</AdminTd>
                <AdminTd>{m.repoLinkRequestEmailMode ?? ADMIN_DASH}</AdminTd>
                <AdminTd align="right" numeric>
                  <TimeCell value={m.membershipCreatedDate} />
                </AdminTd>
                <AdminTd align="right" numeric>
                  <TimeCell value={m.membershipUpdatedDate} />
                </AdminTd>
                <AdminTd>
                  <IdCell
                    value={m.orgId}
                    label="workspace id"
                    href={`/a/data/workspaces/${encodeURIComponent(m.orgId)}`}
                  />
                </AdminTd>
              </AdminTr>
            ))
          )}
        </AdminTable>

        <DetailPanel
          className="mt-5"
          title="Metadata"
          description="The raw metadata object on the user record."
          bodyClassName="p-2"
        >
          <JsonBlock text={JSON.stringify(user?.metadata ?? null, null, 2)} maxHeight="max-h-[360px]" />
        </DetailPanel>
      </div>
    </div>
  );
}
