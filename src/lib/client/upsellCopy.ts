/**
 * Upsell copy registry — the single source of Free → Pro prompt copy for every client surface.
 *
 * Two modes read from it: the blocking `UpgradeModal` (opened via `useUpgradeModal()` when an
 * action is refused or a Pro-only control is tapped) and the quiet inline `PlanLimitNotice`
 * (passive states such as the sidebar fallback nudge). Facts mirror `/pricing` and
 * `src/lib/billing/planLimits.ts`: Free = 10 shared documents (links are unlimited), 2 projects, 7-day analytics, single user,
 * version history and AI compare on credits; Pro = unlimited links and projects, full analytics
 * history, a version list recipients can browse, 500 credits a month, 1 collaborator included (more on
 * request), agents never take a seat.
 */
import type { PlanLimitKey } from "@/lib/client/planLimit";
import { CREDITS_COPY, FREE_PLAN_LIMITS_COPY, comparesFor } from "@/lib/client/planNumbers";

/** Which upsell to show. `pro` is the generic pitch (sidebar link, no wall hit); the next five mirror API limit keys; `credits` is passive. */
export type UpsellKey =
  | "pro"
  | "version_history"
  | "documents"
  | "projects"
  | "collaborators"
  | "analytics_history"
  | "project_links"
  | "credits";

/** Copy for one upsell: title, one-sentence reason, and three concrete Pro benefits. */
export type UpsellCopy = {
  title: string;
  reason: string;
  /** Three Pro benefits; the first is always the thing the user was trying to do. */
  bullets: [string, string, string];
  /** Primary action label; defaults to "Upgrade to Pro". */
  primaryLabel?: string;
  /** Secondary action label; the modal defaults to "Not now", the inline notice to this value. */
  secondaryLabel?: string;
};

/** Shown in the modal price line when `/api/billing/status` has no `proPriceLabel` (or is unavailable). */
export const PRO_PRICE_FALLBACK = "$29/mo";

/**
 * Copy per upsell key.
 *
 * Every plan number here is interpolated from `planNumbers.ts` rather than written out.
 * `tests/lib/planCopyMirror.test.ts` keeps that module equal to the server constants, but it could
 * not see this file: the numbers lived inside prose, so raising the Free cap to 10 documents and
 * Pro to 500 credits left the upgrade modal telling people they had 3 documents and 300 credits —
 * the one screen whose whole job is explaining what they get for paying.
 */
export const UPSELL_COPY: Record<UpsellKey, UpsellCopy> = {
  pro: {
    title: "Pro is for sending every day",
    reason: "Free covers a few documents. Pro removes the caps and shows you who actually read what you sent.",
    bullets: [
      "Unlimited documents, share links and projects",
      "Deep analytics: who opened it, time per page, full history",
      `${CREDITS_COPY.proPerMonth} AI credits a month, and a version list recipients can browse`,
    ],
    secondaryLabel: "Compare plans",
  },
  version_history: {
    title: "Letting recipients browse versions is a Pro feature",
    reason: "Your own version history and AI compare work on every plan. On Pro, the people you share with can open earlier versions and see what changed.",
    bullets: [
      "A version list on the share page, with what changed in each",
      `${CREDITS_COPY.proPerMonth} AI credits a month for summaries and compares`,
      "Unlimited documents, projects and deep analytics",
    ],
    secondaryLabel: "Compare plans",
  },
  documents: {
    title: "You're at the Free document limit",
    reason: `Free workspaces can share ${FREE_PLAN_LIMITS_COPY.documents} documents. Each one can carry as many links as you need. Pro removes the cap on documents.`,
    bullets: [
      "Unlimited links per document, one per investor",
      "Unlimited shared documents and projects across the workspace",
      "Full analytics history on every link",
    ],
    secondaryLabel: "Manage documents",
  },
  projects: {
    title: `Projects are limited to ${FREE_PLAN_LIMITS_COPY.projects} on Free`,
    reason: `Free workspaces get ${FREE_PLAN_LIMITS_COPY.projects} projects; Pro lets you create as many as you need.`,
    bullets: [
      "Unlimited projects",
      "Unlimited shared documents",
      "Version history and AI compare on every doc",
    ],
    secondaryLabel: "Manage projects",
  },
  collaborators: {
    title: "Collaborators are a Pro feature",
    reason: "Free workspaces are single-user; Pro includes a collaborator, with more seats on request.",
    bullets: [
      "1 collaborator included, more on request",
      "Agents never take a seat",
      "Unlimited documents and projects for the whole workspace",
    ],
    secondaryLabel: "Compare plans",
  },
  analytics_history: {
    title: "Deep analytics are a Pro feature",
    reason: "Free shows how many people opened a document in the last 7 days. Pro shows who they were and what they did.",
    bullets: [
      "Who opened it, with names and emails",
      "Time on each page and return visits",
      "The full history, not just 7 days",
    ],
    secondaryLabel: "Compare plans",
  },
  project_links: {
    title: "A second link on a project is a Pro feature",
    reason:
      "Free gives every project one public link. Pro gives each audience a link of its own, with its own password, expiry and analytics, so revoking one fund does not revoke the other.",
    bullets: [
      "A separate link per audience, each with its own password and expiry",
      "See who came, what they opened and how long they read, per link",
      "Unlimited projects, documents and links across the workspace",
    ],
    secondaryLabel: "Compare plans",
  },
  credits: {
    title: "More credits on Pro",
    reason: "Credits pay for AI runs: the summary on each upload and AI compare. Links, uploads and stats never need credits.",
    bullets: [
      `${CREDITS_COPY.proPerMonth} credits a month, about ${comparesFor(CREDITS_COPY.proPerMonth)} standard AI compares`,
      "On-demand credits at $0.10 each, under a spend limit you set",
      "Recipients can browse every version of what you share",
    ],
    secondaryLabel: "Compare plans",
  },
};

/**
 * Map an API limit key (`402 plan_limit` body, `LimitKey` on the server) to an upsell key.
 *
 * Unknown strings fall back to `documents`, the most common cap.
 */
export function upsellKeyForLimit(limit: string): UpsellKey {
  switch (limit as PlanLimitKey) {
    case "documents":
    case "projects":
    case "collaborators":
    case "version_history":
    case "analytics_history":
    case "project_links":
      return limit as UpsellKey;
    default:
      return "documents";
  }
}
