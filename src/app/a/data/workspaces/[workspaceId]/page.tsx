/**
 * Admin route: `/a/data/workspaces/:workspaceId`
 *
 * The workspace hub: what is going on with one workspace, in one screen — identity, plan and
 * Stripe state, credits and the recent ledger, the API keys agents connect with, content totals,
 * the activity tail, and the member list.
 *
 * Read-only by design. It answers support questions; it does not change anything.
 */
"use client";

import Link from "next/link";
import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Button from "@/components/ui/Button";
import DataTable from "@/components/ui/DataTable";
import Panel from "@/components/ui/Panel";
import Pill from "@/components/ui/Pill";
import { fmtDate } from "@/lib/admin/format";
import {
  billableLabel,
  cancelText,
  creditSummary,
  fmtCap,
  fmtCents,
  fmtCount,
  graceState,
  isProPlan,
  keyStateLabel,
  kindLabel,
  ledgerBucketLabel,
  ledgerCredits,
  planLabel,
  usageVsLimit,
  type WorkspaceHubDTO,
} from "@/lib/admin/workspaceHub";
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

/** One labelled number in the content strip. Missing numbers render an em dash, never blank. */
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-[var(--fg)]">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-[var(--muted-2)]">{hint}</div> : null}
    </div>
  );
}

/** A key/value line inside a detail panel, in the shape every other admin detail page uses. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="font-semibold text-[var(--fg)]">{label}:</span> {children}
    </div>
  );
}

/** An id, rendered so it can be copied and does not overflow its cell. */
function Mono({ children }: { children: React.ReactNode }) {
  return <span className="break-all font-mono text-xs text-[var(--muted)]">{children}</span>;
}

/** The workspace hub page. */
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

  const [hub, setHub] = useState<WorkspaceHubDTO | null>(null);
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
        const id = encodeURIComponent(workspaceId);
        const [hubData, memberData] = await Promise.all([
          fetchJson<Partial<WorkspaceHubDTO>>(`/api/admin/data/workspaces/${id}/hub`, { method: "GET" }),
          fetchJson<{ members?: unknown }>(`/api/admin/data/workspaces/${id}/members`, { method: "GET" }),
        ]);
        setHub(hubData && hubData.workspace ? (hubData as WorkspaceHubDTO) : null);
        setMembers(Array.isArray(memberData.members) ? (memberData.members as MemberRow[]) : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load workspace");
        setHub(null);
        setMembers([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, workspaceId, reloadKey]);

  const plan = hub?.plan ?? null;
  const limits = hub?.limits ?? null;
  const content = hub?.content ?? null;
  const creditRules = hub?.creditRules ?? null;
  const ledger = useMemo(() => (Array.isArray(hub?.ledger) ? hub.ledger : []), [hub]);
  const apiKeys = useMemo(() => (Array.isArray(hub?.apiKeys) ? hub.apiKeys : []), [hub]);
  const activity = useMemo(() => (Array.isArray(hub?.activity) ? hub.activity : []), [hub]);
  const owners = useMemo(() => (Array.isArray(hub?.owners) ? hub.owners : []), [hub]);
  const credits = useMemo(
    () => creditSummary({ balance: hub?.balance ?? null, isPro: isProPlan(plan) }),
    [hub?.balance, plan],
  );
  // `new Date()` at render: the grace countdown is relative to now, and there is nothing to
  // memoise it against that would make it more correct.
  const grace = graceState(hub?.grace ?? null, new Date());

  const docsVsCap = usageVsLimit(content?.liveDocs ?? Number.NaN, limits?.documents ?? null);
  const projectsVsCap = usageVsLimit(content?.projects ?? Number.NaN, limits?.projects ?? null);

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
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg)]">
              {hub?.workspace?.name ?? "Workspace"}
            </h1>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Plan, credits, agents, content and activity for this workspace. Read-only.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill>{planLabel(plan)}</Pill>
            <Pill>{hub?.workspace?.type ?? "—"}</Pill>
            <Button variant="outline" className="bg-[var(--panel-2)]" disabled={loading} onClick={() => setReloadKey((v) => v + 1)}>
              {loading ? "Loading…" : "Refresh"}
            </Button>
          </div>
        </div>

        {error ? <div className="mt-4 text-sm text-red-700">{error}</div> : null}

        {loading && !hub ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : null}

        {/* Identity and plan, side by side. */}
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Panel className="min-w-0">
            <div className="text-sm font-semibold text-[var(--fg)]">Identity</div>
            <div className="mt-3 grid gap-2 text-sm text-[var(--muted)]">
              <Row label="Name">{hub?.workspace?.name ?? "—"}</Row>
              <Row label="Type">{hub?.workspace?.type ?? "—"}</Row>
              <Row label="Slug">{hub?.workspace?.slug ?? "—"}</Row>
              <Row label="Created">{fmtDate(hub?.workspace?.createdDate ?? null) || "—"}</Row>
              <Row label="Updated">{fmtDate(hub?.workspace?.updatedDate ?? null) || "—"}</Row>
              <Row label="Members">{fmtCount(content?.members)}</Row>
              <Row label="Owners">
                {owners.length ? owners.map((o) => o.email ?? o.name ?? o.userId).join(", ") : "—"}
              </Row>
              <Row label="Workspace ID">
                <Mono>{workspaceId}</Mono>
              </Row>
              <Row label="Created by userId">
                <Mono>{hub?.workspace?.createdByUserId ?? "—"}</Mono>
              </Row>
              <Row label="Personal for userId">
                <Mono>{hub?.workspace?.personalForUserId ?? "—"}</Mono>
              </Row>
            </div>
          </Panel>

          <Panel className="min-w-0">
            <div className="text-sm font-semibold text-[var(--fg)]">Plan and subscription</div>
            <div className="mt-3 grid gap-2 text-sm text-[var(--muted)]">
              <Row label="Plan">{planLabel(plan)}</Row>
              <Row label="Stripe status">{plan?.status ?? "—"}</Row>
              <Row label="Kind">{kindLabel(plan)}</Row>
              <Row label="Billable">{billableLabel(plan)}</Row>
              <Row label="Plan name (cosmetic)">{plan?.planName ?? "—"}</Row>
              <Row label="Cancels at period end">
                {plan ? cancelText(plan.cancelAtPeriodEnd, fmtDate(plan.currentPeriodEnd)) : "—"}
              </Row>
              <Row label="Current period">
                {plan?.currentPeriodStart || plan?.currentPeriodEnd
                  ? `${fmtDate(plan?.currentPeriodStart ?? null) || "—"} → ${fmtDate(plan?.currentPeriodEnd ?? null) || "—"}`
                  : "—"}
              </Row>
              <Row label="Stripe customer">
                <Mono>{plan?.stripeCustomerId ?? "—"}</Mono>
              </Row>
              <Row label="Stripe subscription">
                <Mono>{plan?.stripeSubscriptionId ?? "—"}</Mono>
              </Row>
              <Row label="Metered item">
                <Mono>{plan?.stripeSubscriptionItemId ?? "—"}</Mono>
              </Row>
              <Row label="Plan grace">
                {grace.state === "none"
                  ? "None"
                  : grace.state === "blocked"
                    ? `Blocked ${fmtDate(hub?.grace?.blockedAt ?? null) || ""}`.trim()
                    : `${grace.daysLeft === null ? "—" : `${grace.daysLeft} day(s) left`} (ends ${fmtDate(hub?.grace?.endsAt ?? null) || "—"})`}
              </Row>
            </div>
          </Panel>
        </div>

        {/* Content totals. Each one is its own count; see the route for the filters. */}
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Live docs" value={docsVsCap.text} hint={docsVsCap.over ? "over the plan cap" : undefined} />
          <Stat label="Archived docs" value={fmtCount(content?.archivedDocs)} hint={`${fmtCount(content?.totalDocs)} total`} />
          <Stat label="Projects" value={projectsVsCap.text} hint={projectsVsCap.over ? "over the plan cap" : undefined} />
          <Stat label="Doc links" value={fmtCount(content?.docLinks)} hint={`${fmtCount(content?.projectLinks)} project links`} />
          <Stat label="Viewers" value={fmtCount(content?.viewers)} hint="unique per link, owner previews excluded" />
          <Stat label="Members" value={fmtCount(content?.members)} hint={limits ? `${limits.collaborators} collaborator(s) included` : undefined} />
          {/* Counted from the listed rows, which the route caps at 20 — say so rather than imply a total. */}
          <Stat
            label="API keys"
            value={fmtCount(apiKeys.filter((k) => !k.revokedAt).length)}
            hint={`live, of ${fmtCount(apiKeys.length)} newest listed`}
          />
          <Stat label="Credits left" value={fmtCount(credits.total)} hint={credits.hasRow ? undefined : "no balance row yet"} />
        </div>

        {/* Credits. Read straight from the balance row: computing a snapshot here would seed one. */}
        <Panel className="mt-6 min-w-0">
          <div className="text-sm font-semibold text-[var(--fg)]">Credits</div>
          {credits.hasRow ? null : (
            <p className="mt-2 text-sm text-[var(--muted)]">
              This workspace has no credit balance row yet — it gets one the first time it runs or opens the credits view.
            </p>
          )}
          <div className="mt-3 grid gap-2 text-sm text-[var(--muted)] md:grid-cols-2">
            <Row label={creditRules ? `Starter (free ${fmtCount(creditRules.starterGrant)})` : "Starter"}>
              {fmtCount(credits.starter)}
            </Row>
            <Row
              label={
                creditRules ? `Included (Pro ${fmtCount(creditRules.includedPerCycle)}/cycle)` : "Included (Pro cycle)"
              }
            >
              {fmtCount(credits.included)}
            </Row>
            <Row label="Purchased (packs)">{fmtCount(credits.purchased)}</Row>
            <Row label="Total remaining">{fmtCount(credits.total)}</Row>
            <Row label="Daily cap">{credits.hasRow ? fmtCap(credits.dailyCap) : "—"}</Row>
            <Row label="Monthly cap">{credits.hasRow ? fmtCap(credits.monthlyCap) : "—"}</Row>
            <Row label="On-demand eligible">
              {credits.onDemandEligible
                ? `Yes — up to ${fmtCents(credits.onDemandMonthlyLimitCents)}/cycle`
                : credits.onDemandStored
                  ? "No — toggle is on but on-demand is Pro-only"
                  : "No"}
            </Row>
            <Row label="Balance cycle">
              {hub?.balance?.currentPeriodStart || hub?.balance?.currentPeriodEnd
                ? `${fmtDate(hub?.balance?.currentPeriodStart ?? null) || "—"} → ${fmtDate(hub?.balance?.currentPeriodEnd ?? null) || "—"}`
                : "—"}
            </Row>
          </div>
        </Panel>

        {/* Ledger tail. Newest first, capped server-side. */}
        <div className="mt-6 text-sm font-semibold text-[var(--fg)]">Recent credit ledger</div>
        <DataTable containerClassName="mt-3 rounded-xl bg-[var(--panel-2)]">
          <thead className="border-b border-[var(--border)] bg-[var(--panel)]">
            <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Event</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Tier</th>
              <th className="px-4 py-3">Credits</th>
              <th className="px-4 py-3">Paid from</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {ledger.map((r) => {
              const credit = ledgerCredits(r);
              return (
                <tr key={r.id}>
                  <td className="px-4 py-3">{fmtDate(r.createdDate) || "—"}</td>
                  <td className="px-4 py-3">{r.eventType ?? "—"}</td>
                  <td className="px-4 py-3">{r.actionType ?? "—"}</td>
                  <td className="px-4 py-3">{r.qualityTier ?? "—"}</td>
                  <td className="px-4 py-3 tabular-nums">
                    {fmtCount(credit.value)}
                    <span className="ml-1 text-xs text-[var(--muted-2)]">{credit.basis}</span>
                  </td>
                  <td className="px-4 py-3">{ledgerBucketLabel(r)}</td>
                  <td className="px-4 py-3">{r.status ?? "—"}</td>
                  <td className="px-4 py-3">{r.source ?? "—"}</td>
                </tr>
              );
            })}
            {ledger.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={8}>
                  No credit ledger rows.
                </td>
              </tr>
            ) : null}
          </tbody>
        </DataTable>

        {/* Agents. The support question is which key an agent is using and when it last worked. */}
        <div className="mt-6 text-sm font-semibold text-[var(--fg)]">Agent keys</div>
        <DataTable containerClassName="mt-3 rounded-xl bg-[var(--panel-2)]">
          <thead className="border-b border-[var(--border)] bg-[var(--panel)]">
            <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Prefix</th>
              <th className="px-4 py-3">Scopes</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Last used</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Uses</th>
              <th className="px-4 py-3">State</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {apiKeys.map((k) => (
              <tr key={k.id}>
                <td className="px-4 py-3">{k.name ?? "—"}</td>
                <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{k.prefix ?? "—"}</td>
                <td className="px-4 py-3">{k.scopes.length ? k.scopes.join(", ") : "—"}</td>
                <td className="px-4 py-3">{fmtDate(k.createdDate) || "—"}</td>
                <td className="px-4 py-3">{fmtDate(k.lastUsedAt) || "—"}</td>
                <td className="px-4 py-3">{k.lastUsedClient ?? "—"}</td>
                <td className="px-4 py-3 tabular-nums">{fmtCount(k.useCount)}</td>
                <td className="px-4 py-3">
                  {keyStateLabel(k) === "revoked" ? `revoked ${fmtDate(k.revokedAt) || ""}`.trim() : "live"}
                </td>
              </tr>
            ))}
            {apiKeys.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={8}>
                  No API keys.
                </td>
              </tr>
            ) : null}
          </tbody>
        </DataTable>

        {/* Activity tail. `title` is denormalised at write time, so no joins are needed. */}
        <div className="mt-6 text-sm font-semibold text-[var(--fg)]">Recent activity</div>
        <DataTable containerClassName="mt-3 rounded-xl bg-[var(--panel-2)]">
          <thead className="border-b border-[var(--border)] bg-[var(--panel)]">
            <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Title</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Agent</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {activity.map((a) => (
              <tr key={a.id}>
                <td className="px-4 py-3">{fmtDate(a.createdDate) || "—"}</td>
                <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{a.type ?? "—"}</td>
                <td className="px-4 py-3">{a.title ?? "—"}</td>
                <td className="px-4 py-3">{a.actorKind ?? "—"}</td>
                <td className="px-4 py-3">{a.agentClient ?? "—"}</td>
              </tr>
            ))}
            {activity.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={5}>
                  No activity.
                </td>
              </tr>
            ) : null}
          </tbody>
        </DataTable>

        <div className="mt-6 text-sm font-semibold text-[var(--fg)]">Members</div>
        <DataTable containerClassName="mt-3 rounded-xl bg-[var(--panel-2)]">
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

        <p className="mt-6 text-xs text-[var(--muted-2)]">
          Viewer totals come from ShareView rows carrying a workspace id; rows written before that field existed are not
          counted until the analytics backfill has run. Ledger, keys and activity show the newest 20 rows.
        </p>
      </div>
    </div>
  );
}
