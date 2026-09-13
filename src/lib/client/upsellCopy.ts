/**
 * Upsell copy registry — the single source of Free → Pro prompt copy for every client surface.
 *
 * Two modes read from it: the blocking `UpgradeModal` (opened via `useUpgradeModal()` when an
 * action is refused or a Pro-only control is tapped) and the quiet inline `PlanLimitNotice`
 * (passive states such as the sidebar fallback nudge). Facts mirror `/pricing` and
 * `src/lib/billing/planLimits.ts`: Free = 3 active links, 1 project, 7-day analytics, single user,
 * no version history / AI compare; Pro = unlimited links and projects, full analytics history,
 * version history + AI compare, 300 credits a month, 1 collaborator included (more on request),
 * agents never take a seat.
 */
import type { PlanLimitKey } from "@/lib/client/planLimit";

/** Which upsell to show. The first four mirror API limit keys; the last two are passive surfaces. */
export type UpsellKey = "version_history" | "active_links" | "projects" | "collaborators" | "analytics_history" | "credits";

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

/** Copy per upsell key. Keep numbers in sync with `/pricing`. */
export const UPSELL_COPY: Record<UpsellKey, UpsellCopy> = {
  version_history: {
    title: "Version history is a Pro feature",
    reason: "Free workspaces keep only the latest file. Pro keeps every version, shows who changed it, and explains what changed.",
    bullets: [
      "Every version kept, with who uploaded it, collaborator or agent",
      "AI compare of what changed between two versions",
      "A version history recipients can browse",
    ],
    secondaryLabel: "Compare plans",
  },
  active_links: {
    title: "You're at the Free link limit",
    reason: "Free workspaces can have 3 active share links; Pro removes the cap.",
    bullets: [
      "Unlimited active share links",
      "Unlimited projects to keep them organised",
      "Full analytics history on every link",
    ],
    secondaryLabel: "Manage links",
  },
  projects: {
    title: "Projects are limited to 1 on Free",
    reason: "Free workspaces get one project; Pro lets you create as many as you need.",
    bullets: [
      "Unlimited projects",
      "Unlimited active share links",
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
      "Unlimited links and projects for the whole workspace",
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
  credits: {
    title: "Credits power AI compare on Pro",
    reason: "AI compare runs on credits, which are included with Pro.",
    bullets: [
      "300 credits a month, more at $0.10 each",
      "AI compare of what changed between versions",
      "Version history for every link",
    ],
    secondaryLabel: "Compare plans",
  },
};

/**
 * Map an API limit key (`402 plan_limit` body, `LimitKey` on the server) to an upsell key.
 *
 * Unknown strings fall back to `active_links`, the most common cap.
 */
export function upsellKeyForLimit(limit: string): UpsellKey {
  switch (limit as PlanLimitKey) {
    case "active_links":
    case "projects":
    case "collaborators":
    case "version_history":
    case "analytics_history":
      return limit as UpsellKey;
    default:
      return "active_links";
  }
}
