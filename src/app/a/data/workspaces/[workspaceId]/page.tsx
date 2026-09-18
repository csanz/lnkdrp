/**
 * Admin route: `/a/data/workspaces/:workspaceId`
 *
 * The workspace hub: what is going on with one workspace, in one screen — identity, plan and
 * Stripe state, credits and the recent ledger, the API keys agents connect with, content totals,
 * the activity tail, and the member list.
 *
 * Read-only by design. It answers support questions; it does not change anything.
 *
 * Shape: header → summary strip → paired detail panels → titled tables, all on the shared
 * admin pieces, so the densest page in the admin area still reads like the rest of it.
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
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
  DetailGrid,
  DetailPanel,
  DetailRow,
  DetailSection,
  IdCell,
  StatTile,
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_DASH, fmtAdminDate, type AdminTone } from "@/lib/admin/ui";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
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
  ledgerBucketNames,
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

/**
 * A leading right-aligned timestamp column, sized to `17 Sep, 14:14`.
 *
 * An auto-layout table hands its leftover width to the first column, which on a
 * right-aligned date meant ~65px of dead space before every row — three tables here read
 * as if they were indented for no reason. Capping `When` and marking one text column as
 * the one that takes the slack puts the first value back on the panel's padding edge.
 */
const WHEN_COL = "w-[116px]";

/** The column that absorbs the table's leftover width, so no other column has to. */
const SLACK_COL = "w-full";

const LEDGER_COLUMNS = 8;
const KEY_COLUMNS = 8;
const ACTIVITY_COLUMNS = 5;
const MEMBER_COLUMNS = 7;

/**
 * The second line under a `used / cap` tile.
 *
 * "against the plan cap" under a bare `2` promised a comparison the tile never showed: a Pro
 * plan has no document cap, so there is nothing to compare against and the caption has to
 * say so.
 */
function capHint(limit: number | null, over: boolean): string {
  if (limit === null || !Number.isFinite(limit)) return "no cap on this plan";
  return over ? "over the plan cap" : "against the plan cap";
}

/** A ledger row's status: only the states that need attention carry a hue. */
function ledgerStatusTone(status: string | null): AdminTone {
  const s = (status ?? "").toLowerCase();
  if (s === "failed" || s === "error" || s === "refunded" || s === "voided") return "danger";
  if (s === "pending" || s === "reserved") return "warning";
  return "quiet";
}

/** The workspace hub page. */
export default function AdminWorkspaceDetailPage() {
  const params = useParams<{ workspaceId?: string }>();
  const workspaceId = typeof params?.workspaceId === "string" ? params.workspaceId : "";

  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

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
  const ownerLabel = owners.length ? owners.map((o) => o.email ?? o.name ?? o.userId).join(", ") : "";

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Workspace" callbackUrl={`/a/data/workspaces/${encodeURIComponent(workspaceId)}`} />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title={hub?.workspace?.name ?? "Workspace"}
          description="Plan, credits, agents, content and activity for this workspace. Read-only."
          actions={
            <>
              {/* The one plan statement on the page. The panel below spells the plan out in
                  words; repeating the chip there made five rows say "this is a paying Pro". */}
              <StatusPill tone={isProPlan(plan) ? "info" : "quiet"}>{planLabel(plan)}</StatusPill>
              <Button variant="outline" disabled={loading} onClick={() => setReloadKey((v) => v + 1)}>
                {loading ? "Loading…" : "Refresh"}
              </Button>
            </>
          }
        />

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}

        {/* Identity and plan, side by side: who this is, and what they are paying for. */}
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <DetailPanel title="Identity" description="The workspace record itself.">
            <DetailGrid>
              <DetailRow label="Name">{hub?.workspace?.name}</DetailRow>
              <DetailRow label="Type">
                {hub?.workspace?.type ? <span className="capitalize">{hub.workspace.type}</span> : null}
              </DetailRow>
              <DetailRow label="Slug">{hub?.workspace?.slug}</DetailRow>
              <DetailRow label="Created">
                {hub?.workspace?.createdDate ? <TimeCell value={hub.workspace.createdDate} /> : null}
              </DetailRow>
              <DetailRow label="Updated">
                {hub?.workspace?.updatedDate ? <TimeCell value={hub.workspace.updatedDate} /> : null}
              </DetailRow>
              <DetailRow label="Members">{hub ? fmtCount(content?.members) : null}</DetailRow>
              <DetailRow label="Owners" title={ownerLabel || undefined}>
                {ownerLabel ? <span className="block truncate">{ownerLabel}</span> : null}
              </DetailRow>
              <DetailRow label="Workspace ID">
                <IdCell value={workspaceId} label="workspace id" />
              </DetailRow>
              <DetailRow label="Created by">
                {hub?.workspace?.createdByUserId ? (
                  <IdCell
                    value={hub.workspace.createdByUserId}
                    label="creator user id"
                    href={`/a/data/users/${encodeURIComponent(hub.workspace.createdByUserId)}`}
                  />
                ) : null}
              </DetailRow>
              <DetailRow label="Personal for">
                {hub?.workspace?.personalForUserId ? (
                  <IdCell
                    value={hub.workspace.personalForUserId}
                    label="personal-for user id"
                    href={`/a/data/users/${encodeURIComponent(hub.workspace.personalForUserId)}`}
                  />
                ) : null}
              </DetailRow>
            </DetailGrid>
          </DetailPanel>

          {/* One coloured chip in this panel, on the one field that can actually go wrong.
              Everything else is the plain value: the plan is stated once, in the header. */}
          <DetailPanel title="Plan and subscription" description="What Stripe says, and what the product enforces.">
            <DetailGrid>
              <DetailRow label="Plan">{planLabel(plan)}</DetailRow>
              <DetailRow label="Stripe status">
                {plan?.status ? (
                  <StatusPill tone={plan.status === "active" ? "positive" : "danger"}>{plan.status}</StatusPill>
                ) : null}
              </DetailRow>
              <DetailRow label="Kind">{kindLabel(plan)}</DetailRow>
              <DetailRow label="Billable">
                {/* The lib owns the rule; the page only decides how the answer looks. */}
                {billableLabel(plan) === "Yes" ? "Billable" : "Not billable"}
              </DetailRow>
              <DetailRow label="Plan name">{plan?.planName}</DetailRow>
              <DetailRow
                label="Cancels at period end"
                title={plan?.cancelAtPeriodEnd ? cancelText(true, fmtAdminDate(plan.currentPeriodEnd)) : undefined}
              >
                {plan?.cancelAtPeriodEnd
                  ? fmtAdminDate(plan.currentPeriodEnd)
                    ? `Ends ${fmtAdminDate(plan.currentPeriodEnd)}`
                    : "End date unknown"
                  : null}
              </DetailRow>
              <DetailRow label="Current period">
                {plan?.currentPeriodStart || plan?.currentPeriodEnd
                  ? `${fmtAdminDate(plan?.currentPeriodStart ?? null) || ADMIN_DASH} → ${
                      fmtAdminDate(plan?.currentPeriodEnd ?? null) || ADMIN_DASH
                    }`
                  : null}
              </DetailRow>
              <DetailRow label="Plan grace">
                {grace.state === "none" ? (
                  "None"
                ) : grace.state === "blocked" ? (
                  <StatusPill tone="danger">
                    {`Blocked ${fmtAdminDate(hub?.grace?.blockedAt ?? null)}`.trim()}
                  </StatusPill>
                ) : (
                  <StatusPill tone="warning">
                    {`${grace.daysLeft === null ? ADMIN_DASH : `${grace.daysLeft} day(s) left`} — ends ${
                      fmtAdminDate(hub?.grace?.endsAt ?? null) || ADMIN_DASH
                    }`}
                  </StatusPill>
                )}
              </DetailRow>
              <DetailRow label="Stripe customer">
                <IdCell value={plan?.stripeCustomerId} label="Stripe customer id" head={10} tail={4} />
              </DetailRow>
              <DetailRow label="Stripe subscription">
                <IdCell value={plan?.stripeSubscriptionId} label="Stripe subscription id" head={10} tail={4} />
              </DetailRow>
              <DetailRow label="Metered item">
                <IdCell value={plan?.stripeSubscriptionItemId} label="Stripe metered item id" head={10} tail={4} />
              </DetailRow>
            </DetailGrid>
          </DetailPanel>
        </div>

        {/* Content totals, under the same heading shape the tables below use. The viewer
            caveat lives here rather than as a loose paragraph at the foot of the page: a
            footnote nobody can attach to a number is a footnote nobody reads. */}
        <DetailSection
          className="mt-5"
          title="Content"
          description="Counts for this workspace. Viewer totals come from ShareView rows carrying a workspace id, so rows written before that field existed are not counted until the analytics backfill has run."
        />
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Live docs"
            value={docsVsCap.text}
            hint={capHint(limits?.documents ?? null, docsVsCap.over)}
            tone={docsVsCap.over ? "danger" : undefined}
          />
          <StatTile
            label="Archived docs"
            value={fmtCount(content?.archivedDocs)}
            hint={`${fmtCount(content?.totalDocs)} docs in total`}
          />
          <StatTile
            label="Projects"
            value={projectsVsCap.text}
            hint={capHint(limits?.projects ?? null, projectsVsCap.over)}
            tone={projectsVsCap.over ? "danger" : undefined}
          />
          <StatTile
            label="Doc links"
            value={fmtCount(content?.docLinks)}
            hint={`${fmtCount(content?.projectLinks)} project links`}
          />
          <StatTile label="Viewers" value={fmtCount(content?.viewers)} hint="unique per link, previews excluded" />
          <StatTile
            label="Members"
            value={fmtCount(content?.members)}
            hint={limits ? `${limits.collaborators} collaborator(s) included` : undefined}
          />
          {/* Counted from the listed rows, which the route caps at 20 — say so rather than imply a total. */}
          <StatTile
            label="API keys"
            value={fmtCount(apiKeys.filter((k) => !k.revokedAt).length)}
            hint={`live, of ${fmtCount(apiKeys.length)} newest listed`}
          />
        </div>

        {/* Credits. Read straight from the balance row: computing a snapshot here would seed one. */}
        <DetailPanel
          className="mt-3"
          title="Credits"
          description={
            credits.hasRow
              ? "The stored balance row, bucket by bucket."
              : "No balance row yet — one is written the first time this workspace runs or opens credits."
          }
        >
          <DetailGrid columns={2}>
            <DetailRow label={creditRules ? `Starter (free ${fmtCount(creditRules.starterGrant)})` : "Starter"}>
              <span className="tabular-nums">{fmtCount(credits.starter)}</span>
            </DetailRow>
            <DetailRow
              label={creditRules ? `Included (Pro ${fmtCount(creditRules.includedPerCycle)}/cycle)` : "Included (Pro)"}
            >
              <span className="tabular-nums">{fmtCount(credits.included)}</span>
            </DetailRow>
            <DetailRow label="Purchased (packs)">
              <span className="tabular-nums">{fmtCount(credits.purchased)}</span>
            </DetailRow>
            <DetailRow label="Total remaining">
              <span className="font-medium tabular-nums">{fmtCount(credits.total)}</span>
            </DetailRow>
            <DetailRow label="Daily cap">
              <span className="tabular-nums">{credits.hasRow ? fmtCap(credits.dailyCap) : null}</span>
            </DetailRow>
            <DetailRow label="Monthly cap">
              <span className="tabular-nums">{credits.hasRow ? fmtCap(credits.monthlyCap) : null}</span>
            </DetailRow>
            {/* Plain values like every other row here; the chip is kept for the one reading
                that is a contradiction — the toggle is on for a workspace that cannot spend. */}
            <DetailRow label="On-demand">
              {credits.onDemandEligible ? (
                `Up to ${fmtCents(credits.onDemandMonthlyLimitCents)}/cycle`
              ) : credits.onDemandStored ? (
                <StatusPill tone="warning">Toggle on, but Pro-only</StatusPill>
              ) : (
                "Off"
              )}
            </DetailRow>
            <DetailRow label="Balance cycle">
              {hub?.balance?.currentPeriodStart || hub?.balance?.currentPeriodEnd
                ? `${fmtAdminDate(hub?.balance?.currentPeriodStart ?? null) || ADMIN_DASH} → ${
                    fmtAdminDate(hub?.balance?.currentPeriodEnd ?? null) || ADMIN_DASH
                  }`
                : null}
            </DetailRow>
          </DetailGrid>
        </DetailPanel>

        {/* Ledger tail. Newest first, capped server-side. */}
        <DetailSection className="mt-5" title="Recent credit ledger" description="The newest 20 rows, newest first." />
        <AdminTable
          className="mt-2"
          ariaLabel="Recent credit ledger"
          head={
            <>
              {/* `When` is sized to its own content and one text column takes the slack;
                  without that the auto table gave the first column the leftover width and
                  every row started 65px in from the panel edge. */}
              <AdminTh align="right" width={WHEN_COL}>
                When
              </AdminTh>
              <AdminTh>Event</AdminTh>
              <AdminTh>Action</AdminTh>
              <AdminTh>Tier</AdminTh>
              <AdminTh align="right">Credits</AdminTh>
              <AdminTh>Paid from</AdminTh>
              <AdminTh>Status</AdminTh>
              <AdminTh width={SLACK_COL}>Source</AdminTh>
            </>
          }
        >
          {loading && ledger.length === 0 ? (
            <AdminTableMessage colSpan={LEDGER_COLUMNS}>Loading ledger…</AdminTableMessage>
          ) : ledger.length === 0 ? (
            <AdminTableEmpty
              colSpan={LEDGER_COLUMNS}
              title="No credit ledger rows"
              hint="Nothing has spent or granted credits in this workspace yet."
            />
          ) : (
            ledger.map((r) => {
              const credit = ledgerCredits(r);
              return (
                <AdminTr key={r.id}>
                  <AdminTd align="right" numeric>
                    <TimeCell value={r.createdDate} />
                  </AdminTd>
                  <AdminTd primary truncate="max-w-[180px]">
                    <span title={r.eventType ?? undefined}>{r.eventType ?? ADMIN_DASH}</span>
                  </AdminTd>
                  <AdminTd truncate="max-w-[140px]">
                    <span title={r.actionType ?? undefined}>{r.actionType ?? ADMIN_DASH}</span>
                  </AdminTd>
                  <AdminTd>{r.qualityTier ?? ADMIN_DASH}</AdminTd>
                  {/* The figure alone. Which column it came from is the Status cell's job —
                      printing "1 charged" here made the row say "charged" twice. */}
                  <AdminTd align="right" numeric className="text-[var(--fg)]" title={`${credit.basis} credits`}>
                    {fmtCount(credit.value)}
                  </AdminTd>
                  {/* The bucket, not the amount again. The counted split stays in the title. */}
                  <AdminTd truncate="max-w-[200px]">
                    <span title={ledgerBucketLabel(r)}>{ledgerBucketNames(r)}</span>
                  </AdminTd>
                  <AdminTd>
                    {/* "charged" is every other row: only a state worth acting on gets a chip. */}
                    {!r.status ? (
                      ADMIN_DASH
                    ) : ledgerStatusTone(r.status) === "quiet" ? (
                      r.status
                    ) : (
                      <StatusPill tone={ledgerStatusTone(r.status)}>{r.status}</StatusPill>
                    )}
                  </AdminTd>
                  <AdminTd>{r.source ?? ADMIN_DASH}</AdminTd>
                </AdminTr>
              );
            })
          )}
        </AdminTable>

        {/* Agents. The support question is which key an agent is using and when it last worked. */}
        <DetailSection
          className="mt-5"
          title="Agent keys"
          description="The newest 20 keys. Revoked keys stay listed so a support trail survives."
        />
        <AdminTable
          className="mt-2"
          ariaLabel="Agent keys"
          head={
            <>
              <AdminTh width={SLACK_COL}>Name</AdminTh>
              <AdminTh>Prefix</AdminTh>
              <AdminTh>Scopes</AdminTh>
              <AdminTh>Client</AdminTh>
              <AdminTh align="right">Uses</AdminTh>
              <AdminTh align="right">Created</AdminTh>
              <AdminTh align="right">Last used</AdminTh>
              <AdminTh>State</AdminTh>
            </>
          }
        >
          {loading && apiKeys.length === 0 ? (
            <AdminTableMessage colSpan={KEY_COLUMNS}>Loading keys…</AdminTableMessage>
          ) : apiKeys.length === 0 ? (
            <AdminTableEmpty
              colSpan={KEY_COLUMNS}
              title="No API keys"
              hint="No agent has been connected to this workspace yet."
            />
          ) : (
            apiKeys.map((k) => (
              <AdminTr key={k.id}>
                <AdminTd primary truncate="max-w-[220px]">
                  <span title={k.name ?? undefined}>{k.name ?? ADMIN_DASH}</span>
                </AdminTd>
                <AdminTd mono>{k.prefix ?? ADMIN_DASH}</AdminTd>
                <AdminTd truncate="max-w-[160px]">
                  <span title={k.scopes.join(", ")}>{k.scopes.length ? k.scopes.join(", ") : ADMIN_DASH}</span>
                </AdminTd>
                <AdminTd truncate="max-w-[160px]">
                  <span title={k.lastUsedClient ?? undefined}>{k.lastUsedClient ?? ADMIN_DASH}</span>
                </AdminTd>
                <AdminTd align="right" numeric>
                  {fmtCount(k.useCount)}
                </AdminTd>
                <AdminTd align="right" numeric>
                  <TimeCell value={k.createdDate} />
                </AdminTd>
                <AdminTd align="right" numeric>
                  <TimeCell value={k.lastUsedAt} />
                </AdminTd>
                <AdminTd>
                  {keyStateLabel(k) === "revoked" ? (
                    <StatusPill tone="danger" title={`Revoked ${fmtAdminDate(k.revokedAt)}`.trim()}>
                      Revoked
                    </StatusPill>
                  ) : (
                    <StatusPill tone="quiet" dot>
                      Live
                    </StatusPill>
                  )}
                </AdminTd>
              </AdminTr>
            ))
          )}
        </AdminTable>

        {/* Activity tail. `title` is denormalised at write time, so no joins are needed. */}
        <DetailSection className="mt-5" title="Recent activity" description="The newest 20 events, newest first." />
        <AdminTable
          className="mt-2"
          ariaLabel="Recent activity"
          head={
            <>
              <AdminTh align="right" width={WHEN_COL}>
                When
              </AdminTh>
              <AdminTh>Type</AdminTh>
              <AdminTh width={SLACK_COL}>Title</AdminTh>
              <AdminTh>Actor</AdminTh>
              <AdminTh>Agent</AdminTh>
            </>
          }
        >
          {loading && activity.length === 0 ? (
            <AdminTableMessage colSpan={ACTIVITY_COLUMNS}>Loading activity…</AdminTableMessage>
          ) : activity.length === 0 ? (
            <AdminTableEmpty
              colSpan={ACTIVITY_COLUMNS}
              title="No activity"
              hint="Nothing has happened in this workspace yet."
            />
          ) : (
            activity.map((a) => (
              <AdminTr key={a.id}>
                <AdminTd align="right" numeric>
                  <TimeCell value={a.createdDate} />
                </AdminTd>
                <AdminTd mono truncate="max-w-[236px]">
                  <span title={a.type ?? undefined}>{a.type ?? ADMIN_DASH}</span>
                </AdminTd>
                <AdminTd primary truncate="max-w-[320px]">
                  <span title={a.title ?? undefined}>{a.title ?? ADMIN_DASH}</span>
                </AdminTd>
                <AdminTd>{a.actorKind ?? ADMIN_DASH}</AdminTd>
                <AdminTd truncate="max-w-[180px]">
                  <span title={a.agentClient ?? undefined}>{a.agentClient ?? ADMIN_DASH}</span>
                </AdminTd>
              </AdminTr>
            ))
          )}
        </AdminTable>

        <DetailSection className="mt-5" title="Members" description="Everyone with access, and how they signed in." />
        <AdminTable
          className="mt-2"
          ariaLabel="Members"
          head={
            <>
              <AdminTh width={SLACK_COL}>Email</AdminTh>
              <AdminTh>Name</AdminTh>
              <AdminTh>Member role</AdminTh>
              <AdminTh>User role</AdminTh>
              <AdminTh>Status</AdminTh>
              <AdminTh align="right">Last login</AdminTh>
              <AdminTh>User ID</AdminTh>
            </>
          }
        >
          {loading && members.length === 0 ? (
            <AdminTableMessage colSpan={MEMBER_COLUMNS}>Loading members…</AdminTableMessage>
          ) : members.length === 0 ? (
            <AdminTableEmpty
              colSpan={MEMBER_COLUMNS}
              title="No members"
              hint="Nobody belongs to this workspace yet."
            />
          ) : (
            members.map((m) => (
              <AdminTr key={m.userId}>
                <AdminTd primary truncate="max-w-[260px]">
                  <Link
                    href={`/a/data/users/${encodeURIComponent(m.userId)}`}
                    className="rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]"
                    title={m.email ?? "View user details"}
                  >
                    {m.email ?? ADMIN_DASH}
                  </Link>
                </AdminTd>
                <AdminTd truncate="max-w-[180px]">
                  <span title={m.name ?? undefined}>{m.name ?? ADMIN_DASH}</span>
                </AdminTd>
                <AdminTd>
                  {m.memberRole ? <span className="capitalize">{m.memberRole}</span> : ADMIN_DASH}
                </AdminTd>
                <AdminTd>
                  {m.userRole === "admin" ? (
                    <StatusPill tone="accent">Admin</StatusPill>
                  ) : m.userRole ? (
                    <span className="capitalize">{m.userRole}</span>
                  ) : (
                    ADMIN_DASH
                  )}
                </AdminTd>
                <AdminTd>
                  <span className="inline-flex items-center gap-1.5">
                    {m.isActive === false ? (
                      <StatusPill tone="danger">Inactive</StatusPill>
                    ) : (
                      <StatusPill tone="quiet" dot>
                        Active
                      </StatusPill>
                    )}
                    {m.isTemp ? <StatusPill tone="warning">Temp</StatusPill> : null}
                  </span>
                </AdminTd>
                <AdminTd align="right" numeric>
                  <TimeCell value={m.lastLoginAt} />
                </AdminTd>
                <AdminTd>
                  <IdCell
                    value={m.userId}
                    label="user id"
                    href={`/a/data/users/${encodeURIComponent(m.userId)}`}
                  />
                </AdminTd>
              </AdminTr>
            ))
          )}
        </AdminTable>

      </div>
    </div>
  );
}
