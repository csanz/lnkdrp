/**
 * Plain customer cards for lnkdrp (https://www.plain.com/docs/customer-cards).
 *
 * When a support thread opens in Plain, Plain asks this app about the customer by email and
 * renders what comes back beside the conversation. Two cards:
 *
 * - `lnkdrp-account`: the account row, then one block per workspace the person belongs to —
 *   plan, grace/blocked state, credits, documents and projects against the plan caps, whether an
 *   agent is connected, and a button into the admin workspace hub.
 * - `lnkdrp-errors`: the last few logged errors attributed to this person or their workspaces,
 *   so "it just fails" tickets start with the code and route already in view.
 *
 * The builders are pure functions over a `CustomerContext` so the shape of the card can be tested
 * without a database; `loadCustomerContext` is the only thing that reads Mongo.
 *
 * Plain's contract: every key it asks for gets a card back, in the same response, within 15 s.
 * Unknown keys get `components: null` rather than an error, so one mistyped key in Plain's
 * settings cannot take the other card down with it.
 */
import { Types } from "mongoose";

import { getAgentStatus } from "@/lib/agents/apiKeys";
import { getWorkspaceGrace, getWorkspacePlan, getWorkspaceUsage, limitsForPlan } from "@/lib/billing/planLimits";
import type { GraceState, PlanId } from "@/lib/billing/planLimits";
import { getCreditsSnapshot } from "@/lib/credits/snapshot";
import { SITE_ORIGIN } from "@/lib/mcp/clientSetups";
import { connectMongo } from "@/lib/mongodb";
import { ErrorEventModel } from "@/lib/models/ErrorEvent";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";

export const CARD_KEYS = ["lnkdrp-account", "lnkdrp-errors"] as const;
export type CardKey = (typeof CARD_KEYS)[number];

/** Plain UI components, the subset a card uses. Field names and enums are Plain's. */
export type PlainComponent =
  | { componentText: { text: string; textSize?: "S" | "M" | "L"; textColor?: "NORMAL" | "MUTED" | "SUCCESS" | "WARNING" | "ERROR" } }
  | { componentBadge: { badgeLabel: string; badgeColor: "GREY" | "GREEN" | "YELLOW" | "RED" | "BLUE" } }
  | { componentRow: { rowMainContent: PlainComponent[]; rowAsideContent: PlainComponent[] } }
  | { componentSpacer: { spacerSize: "XS" | "S" | "M" | "L" | "XL" } }
  | { componentDivider: { dividerSpacingSize?: "XS" | "S" | "M" | "L" | "XL" } }
  | { componentLinkButton: { linkButtonLabel: string; linkButtonUrl: string } }
  | { componentCopyButton: { copyButtonValue: string; copyButtonTooltipLabel?: string } };

export type PlainCard = { key: string; timeToLiveSeconds: number | null; components: PlainComponent[] | null };

export type WorkspaceContext = {
  id: string;
  name: string;
  type: "personal" | "team";
  role: string;
  plan: PlanId;
  grace: GraceState;
  creditsRemaining: number;
  onDemandEnabled: boolean;
  usage: { documents: number; projects: number; members: number };
  limits: { documents: number | null; projects: number | null };
  agent: { connected: boolean; clients: string[]; lastUsedAt: string | null };
};

export type ErrorContext = {
  at: string;
  code: string;
  route: string | null;
  statusCode: number | null;
  message: string;
  workspaceName: string | null;
};

export type CustomerContext =
  | { found: false; email: string }
  | {
      found: true;
      email: string;
      userId: string;
      name: string | null;
      role: string;
      createdAt: string;
      lastLoginAt: string | null;
      deletionRequestedAt: string | null;
      workspaces: WorkspaceContext[];
      errors: ErrorContext[];
    };

/** Card responses are cached by Plain for this long; a ticket rarely needs fresher than a minute. */
const ACCOUNT_TTL_SECONDS = 60;
const ERRORS_TTL_SECONDS = 60;
const MAX_WORKSPACES = 6;
const MAX_ERRORS = 5;
const ERROR_WINDOW_DAYS = 30;

const text = (t: string, opts: { size?: "S" | "M" | "L"; color?: "NORMAL" | "MUTED" | "SUCCESS" | "WARNING" | "ERROR" } = {}): PlainComponent => ({
  componentText: { text: t, ...(opts.size ? { textSize: opts.size } : {}), ...(opts.color ? { textColor: opts.color } : {}) },
});
const badge = (label: string, color: "GREY" | "GREEN" | "YELLOW" | "RED" | "BLUE"): PlainComponent => ({
  componentBadge: { badgeLabel: label, badgeColor: color },
});
const row = (main: PlainComponent[], aside: PlainComponent[]): PlainComponent => ({
  componentRow: { rowMainContent: main, rowAsideContent: aside },
});
const spacer = (size: "XS" | "S" | "M" | "L" | "XL" = "S"): PlainComponent => ({ componentSpacer: { spacerSize: size } });
const divider = (): PlainComponent => ({ componentDivider: { dividerSpacingSize: "S" } });
const link = (label: string, url: string): PlainComponent => ({ componentLinkButton: { linkButtonLabel: label, linkButtonUrl: url } });
const copy = (value: string, tooltip: string): PlainComponent => ({
  componentCopyButton: { copyButtonValue: value, copyButtonTooltipLabel: tooltip },
});

/** `YYYY-MM-DD`, or a word when there is no date. */
function shortDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 10);
}

/** "12 / 10 shared" against a cap, "40 shared" without one. */
function usageLine(used: number, cap: number | null, noun: string): string {
  return cap === null ? `${used} ${noun}` : `${used} / ${cap} ${noun}`;
}

/** Blocked beats grace beats plan. */
function planBadge(ws: WorkspaceContext): PlainComponent {
  if (ws.grace?.blockedAt) return badge("Blocked", "RED");
  if (ws.grace) return badge(`Over limit · grace to ${shortDate(ws.grace.endsAt)}`, "YELLOW");
  return ws.plan === "pro" ? badge("Pro", "GREEN") : badge("Free", "GREY");
}

/** The components for one workspace inside the account card. */
function workspaceBlock(ws: WorkspaceContext): PlainComponent[] {
  const overDocs = ws.limits.documents !== null && ws.usage.documents > ws.limits.documents;
  const overProjects = ws.limits.projects !== null && ws.usage.projects > ws.limits.projects;
  const agentText = ws.agent.connected
    ? `Agent connected (${ws.agent.clients.join(", ") || "unknown client"})`
    : "No agent connected";
  return [
    row([text(ws.name, { size: "M" })], [planBadge(ws)]),
    text(`${ws.type === "personal" ? "Personal" : "Team"} · ${ws.role}`, { size: "S", color: "MUTED" }),
    spacer("XS"),
    row(
      [text("Credits", { color: "MUTED" })],
      [text(`${ws.creditsRemaining}${ws.onDemandEnabled ? " + on-demand" : ""}`, { color: ws.creditsRemaining === 0 && !ws.onDemandEnabled ? "WARNING" : "NORMAL" })],
    ),
    row([text("Documents", { color: "MUTED" })], [text(usageLine(ws.usage.documents, ws.limits.documents, "shared"), { color: overDocs ? "WARNING" : "NORMAL" })]),
    row([text("Projects", { color: "MUTED" })], [text(usageLine(ws.usage.projects, ws.limits.projects, ""), { color: overProjects ? "WARNING" : "NORMAL" })]),
    row([text("Members", { color: "MUTED" })], [text(String(ws.usage.members))]),
    row(
      [text(agentText, { size: "S", color: ws.agent.connected ? "SUCCESS" : "MUTED" })],
      [ws.agent.lastUsedAt ? text(`last ${shortDate(ws.agent.lastUsedAt)}`, { size: "S", color: "MUTED" }) : spacer("XS")],
    ),
    spacer("XS"),
    row([link("Open in admin", `${SITE_ORIGIN}/a/data/workspaces/${ws.id}`)], [copy(ws.id, "Copy workspace id")]),
  ];
}

/** The `lnkdrp-account` card: who they are and every workspace they belong to. */
export function buildAccountCard(ctx: CustomerContext): PlainCard {
  if (!ctx.found) {
    return {
      key: "lnkdrp-account",
      timeToLiveSeconds: ACCOUNT_TTL_SECONDS,
      components: [text(`No lnkdrp account for ${ctx.email}.`, { color: "MUTED" }), text("They may sign in with a different Google address, or may only have viewed a shared link.", { size: "S", color: "MUTED" })],
    };
  }
  const components: PlainComponent[] = [
    row([text(ctx.name ?? ctx.email, { size: "L" })], [ctx.role === "admin" ? badge("lnkdrp admin", "BLUE") : badge("Account", "GREY")]),
    row([text(`Signed up ${shortDate(ctx.createdAt)} · last login ${shortDate(ctx.lastLoginAt)}`, { size: "S", color: "MUTED" })], [copy(ctx.userId, "Copy user id")]),
  ];
  if (ctx.deletionRequestedAt) {
    components.push(spacer("XS"), badge(`Deletion requested ${shortDate(ctx.deletionRequestedAt)}`, "RED"));
  }
  if (ctx.workspaces.length === 0) {
    components.push(divider(), text("No workspaces.", { color: "MUTED" }));
  }
  for (const ws of ctx.workspaces) {
    components.push(divider(), ...workspaceBlock(ws));
  }
  return { key: "lnkdrp-account", timeToLiveSeconds: ACCOUNT_TTL_SECONDS, components };
}

/** The `lnkdrp-errors` card: recent logged errors for this person or their workspaces. */
export function buildErrorsCard(ctx: CustomerContext): PlainCard {
  if (!ctx.found) {
    return { key: "lnkdrp-errors", timeToLiveSeconds: ERRORS_TTL_SECONDS, components: [text("No account, so no errors to show.", { color: "MUTED" })] };
  }
  if (ctx.errors.length === 0) {
    return { key: "lnkdrp-errors", timeToLiveSeconds: ERRORS_TTL_SECONDS, components: [text(`No errors logged for this account in the last ${ERROR_WINDOW_DAYS} days.`, { color: "SUCCESS" })] };
  }
  const components: PlainComponent[] = [];
  ctx.errors.forEach((e, i) => {
    if (i > 0) components.push(divider());
    components.push(
      row([badge(e.code, e.statusCode !== null && e.statusCode >= 500 ? "RED" : "YELLOW")], [text(e.at.replace("T", " ").slice(0, 16), { size: "S", color: "MUTED" })]),
      text(e.message.length > 160 ? `${e.message.slice(0, 157)}…` : e.message, { size: "S" }),
      text([e.route, e.statusCode !== null ? String(e.statusCode) : null, e.workspaceName].filter(Boolean).join(" · "), { size: "S", color: "MUTED" }),
    );
  });
  components.push(spacer("XS"), link("Error log", `${SITE_ORIGIN}/a/errors`));
  return { key: "lnkdrp-errors", timeToLiveSeconds: ERRORS_TTL_SECONDS, components };
}

/** One card per requested key. Keys we do not know come back with `components: null`, as Plain expects. */
export function buildCards(cardKeys: string[], ctx: CustomerContext): PlainCard[] {
  return cardKeys.map((key) => {
    if (key === "lnkdrp-account") return buildAccountCard(ctx);
    if (key === "lnkdrp-errors") return buildErrorsCard(ctx);
    return { key, timeToLiveSeconds: null, components: null };
  });
}

/** ISO string from a Date or string, null for anything else. */
function iso(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "string" && v) return v;
  return null;
}

/** Plan, grace, usage, credits and agent state for one workspace, fetched in parallel. */
async function loadWorkspace(orgId: Types.ObjectId, name: string, type: "personal" | "team", role: string): Promise<WorkspaceContext> {
  const [plan, grace, usage, credits, agent] = await Promise.all([
    getWorkspacePlan(orgId),
    getWorkspaceGrace(orgId),
    getWorkspaceUsage(orgId),
    getCreditsSnapshot({ workspaceId: orgId.toString(), fast: true }).catch(() => null),
    getAgentStatus(orgId).catch(() => null),
  ]);
  const limits = limitsForPlan(plan);
  return {
    id: orgId.toString(),
    name,
    type,
    role,
    plan,
    grace,
    creditsRemaining: credits?.creditsRemaining ?? 0,
    onDemandEnabled: credits?.onDemandEnabled ?? false,
    usage,
    limits: { documents: limits.documents, projects: limits.projects },
    agent: {
      connected: agent?.connected ?? false,
      clients: (agent?.clients ?? []).map((c) => c.client).filter((c): c is string => typeof c === "string" && c.length > 0),
      lastUsedAt: agent?.lastUsedAt ?? null,
    },
  };
}

/** Everything the two cards need for one customer email. Never throws for "not found". */
export async function loadCustomerContext(emailRaw: string): Promise<CustomerContext> {
  const email = emailRaw.trim().toLowerCase();
  await connectMongo();
  const user = await UserModel.findOne({ email, isTemp: { $ne: true } })
    .select({ _id: 1, email: 1, name: 1, role: 1, createdAt: 1, lastLoginAt: 1, deletionRequestedAt: 1 })
    .lean();
  if (!user) return { found: false, email };

  const userId = (user as { _id: Types.ObjectId })._id;
  const memberships = await OrgMembershipModel.find({ userId, isDeleted: { $ne: true } })
    .select({ orgId: 1, role: 1 })
    .lean();
  const orgIds = memberships.map((m) => (m as { orgId: Types.ObjectId }).orgId);
  const orgs = orgIds.length
    ? await OrgModel.find({ _id: { $in: orgIds }, isDeleted: { $ne: true } })
        .select({ _id: 1, name: 1, type: 1 })
        .lean()
    : [];
  const roleByOrg = new Map(memberships.map((m) => [(m as { orgId: Types.ObjectId }).orgId.toString(), String((m as { role?: unknown }).role ?? "member")]));

  // Personal workspace first, then teams, newest membership last.
  const ordered = [...orgs].sort((a, b) => {
    const at = (a as { type?: string }).type === "personal" ? 0 : 1;
    const bt = (b as { type?: string }).type === "personal" ? 0 : 1;
    return at - bt;
  });
  const workspaces = await Promise.all(
    ordered.slice(0, MAX_WORKSPACES).map((o) => {
      const id = (o as { _id: Types.ObjectId })._id;
      const type = (o as { type?: string }).type === "personal" ? "personal" : "team";
      return loadWorkspace(id, String((o as { name?: unknown }).name ?? "Workspace"), type, roleByOrg.get(id.toString()) ?? "member");
    }),
  );
  const nameByOrg = new Map(workspaces.map((w) => [w.id, w.name]));

  const since = new Date(Date.now() - ERROR_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const errorRows = await ErrorEventModel.find({
    severity: "error",
    createdAt: { $gte: since },
    $or: [{ userId }, ...(orgIds.length ? [{ workspaceId: { $in: orgIds } }] : [])],
  })
    .sort({ createdAt: -1 })
    .limit(MAX_ERRORS)
    .select({ createdAt: 1, code: 1, route: 1, statusCode: 1, message: 1, workspaceId: 1 })
    .lean();
  const errors: ErrorContext[] = errorRows.map((e) => {
    const r = e as { createdAt?: unknown; code?: unknown; route?: unknown; statusCode?: unknown; message?: unknown; workspaceId?: Types.ObjectId | null };
    return {
      at: iso(r.createdAt) ?? "",
      code: String(r.code ?? "UNHANDLED_EXCEPTION"),
      route: typeof r.route === "string" ? r.route : null,
      statusCode: typeof r.statusCode === "number" ? r.statusCode : null,
      message: String(r.message ?? ""),
      workspaceName: r.workspaceId ? (nameByOrg.get(r.workspaceId.toString()) ?? null) : null,
    };
  });

  const u = user as { email?: string; name?: string; role?: string; createdAt?: unknown; lastLoginAt?: unknown; deletionRequestedAt?: unknown };
  return {
    found: true,
    email: u.email ?? email,
    userId: userId.toString(),
    name: typeof u.name === "string" && u.name.trim() ? u.name.trim() : null,
    role: typeof u.role === "string" ? u.role : "user",
    createdAt: iso(u.createdAt) ?? "",
    lastLoginAt: iso(u.lastLoginAt),
    deletionRequestedAt: iso(u.deletionRequestedAt),
    workspaces,
    errors,
  };
}
