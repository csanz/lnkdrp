/**
 * Client-side helpers for plan-limit (`402 plan_limit`) responses.
 *
 * The server side lives in `src/lib/billing/planLimits.ts` (`checkLimit` / `planLimitResponse`);
 * that module pulls in Mongoose models so it must not be imported from client bundles. This file
 * mirrors only what the browser needs: the 402 body shape, prompt copy per limit, and a tiny
 * session flag so the sidebar can nudge once a limit has been hit.
 */
import { UPSELL_COPY, upsellKeyForLimit } from "@/lib/client/upsellCopy";
import { CREDITS_COPY } from "@/lib/client/planNumbers";
import { CREDIT_PACKS, formatPackPrice } from "@/lib/credits/packs";

/**
 * Which Free-plan limit was hit. Mirrors `LimitKey` in `src/lib/billing/planLimits.ts`.
 * `version_history`, `analytics_history` (deep analytics: viewer identities, per-page time,
 * visit timelines) and `project_links` (a second share link on a project) are Pro feature gates
 * (no count; `used`/`max` are 0).
 */
export type PlanLimitKey =
  | "documents"
  | "projects"
  | "collaborators"
  | "version_history"
  | "analytics_history"
  | "project_links";

/** Grace window for workspaces that were over the limits at launch (ISO strings). */
export type PlanLimitGrace = { startedAt: string; endsAt: string; blockedAt: string | null } | null;

/** Parsed body of a `402 { code: "plan_limit" }` response. */
export type PlanLimitError = {
  limit: PlanLimitKey;
  used: number;
  max: number;
  message: string;
  upgradeUrl: string;
  grace: PlanLimitGrace;
};

// The numbers themselves live in `planNumbers.ts`: `upsellCopy.ts` needs them too and already
// imports this module, so defining them here would make that a runtime cycle. Re-exported so the
// ten surfaces that read them from here keep working.
export { CREDITS_COPY, FREE_PLAN_LIMITS_COPY, comparesFor } from "@/lib/client/planNumbers";

/**
 * The clause that used to be six copies of "topped up every month" scattered across the hero,
 * login, pricing, ToS and two dashboard cards — one of them went stale for a full day after the
 * monthly floor was removed, because nothing pointed the others back at it. A lowercase clause,
 * not a sentence: callers compose it into their own sentence so it reads as part of the
 * surrounding copy rather than a pasted disclaimer.
 */
export function whatHappensAfterFreeCredits(): string {
  return `buy a credit pack from ${formatPackPrice(CHEAPEST_PACK.priceCents)}, or upgrade to Pro for ${CREDITS_COPY.proPerMonth} credits a month`;
}

/** The smallest pack, for "from $5" copy. */
const CHEAPEST_PACK = CREDIT_PACKS.reduce((min, p) => (p.priceCents < min.priceCents ? p : min));

/**
 * Launch flag: credit surfaces (dashboard credits pill, Usage/Limits cards, spend-limit editor) are on
 * by default and hidden only when `NEXT_PUBLIC_FEATURE_CREDITS=0`. Routes keep working either way.
 */
export const FEATURE_CREDITS_ENABLED = process.env.NEXT_PUBLIC_FEATURE_CREDITS !== "0";

/** `sessionStorage` key set once a plan-limit 402 has been seen in this browser session. */
export const PLAN_LIMIT_HIT_STORAGE_KEY = "lnkdrp_plan_limit_hit";

/** Window event fired when a plan-limit 402 is seen (lets the sidebar nudge appear without a reload). */
export const PLAN_LIMIT_HIT_EVENT = "lnkdrp:plan-limit-hit";

const LIMIT_KEYS: ReadonlySet<string> = new Set([
  "documents",
  "projects",
  "collaborators",
  "version_history",
  "analytics_history",
  "project_links",
]);

/** Coerce an unknown value to a non-negative integer, or `null` when it is not a finite number. */
function asFiniteInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : null;
}

/** Parse the `grace` field of a 402 body; anything malformed reads as "no grace". */
function parseGrace(v: unknown): PlanLimitGrace {
  if (!v || typeof v !== "object") return null;
  const g = v as { startedAt?: unknown; endsAt?: unknown; blockedAt?: unknown };
  if (typeof g.startedAt !== "string" || typeof g.endsAt !== "string") return null;
  return {
    startedAt: g.startedAt,
    endsAt: g.endsAt,
    blockedAt: typeof g.blockedAt === "string" ? g.blockedAt : null,
  };
}

/**
 * Parse a JSON body as a plan-limit error.
 *
 * Returns `null` unless the body carries `code: "plan_limit"` with a known `limit`. Callers should
 * check `res.status === 402` first, but the parser is defensive either way.
 */
export function parsePlanLimitError(json: unknown): PlanLimitError | null {
  if (!json || typeof json !== "object") return null;
  const body = json as Record<string, unknown>;
  if (body.code !== "plan_limit") return null;
  const limit = typeof body.limit === "string" && LIMIT_KEYS.has(body.limit) ? (body.limit as PlanLimitKey) : null;
  if (!limit) return null;
  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim()
      : typeof body.error === "string" && body.error.trim()
        ? body.error.trim()
        : planLimitPrompt(limit).message;
  return {
    limit,
    used: asFiniteInt(body.used) ?? 0,
    max: asFiniteInt(body.max) ?? 0,
    message,
    upgradeUrl: typeof body.upgradeUrl === "string" && body.upgradeUrl ? body.upgradeUrl : "/pricing",
    grace: parseGrace(body.grace),
  };
}

/** Copy for an upgrade prompt: a short title, a fallback message, and the secondary action label. */
export type PlanLimitPrompt = { title: string; message: string; secondaryLabel: string };

/**
 * Format a "{used} of {max} used." suffix for counted limits; empty for feature gates (`max` 0).
 */
export function planLimitUsageSuffix(opts: { used?: number; max?: number } = {}): string {
  const max = typeof opts.max === "number" && Number.isFinite(opts.max) ? Math.max(0, Math.floor(opts.max)) : 0;
  const used = typeof opts.used === "number" && Number.isFinite(opts.used) ? Math.max(0, Math.floor(opts.used)) : null;
  if (max <= 0 || used === null) return "";
  return `${used} of ${max} used.`;
}

/**
 * Build the prompt copy for a given limit (hook-free so it works in handlers and render alike).
 *
 * Title and reason come from the shared `UPSELL_COPY` registry so the inline notice and the
 * upgrade modal never drift. `used`/`max` are optional; when present they are folded into the
 * message. The one non-Free case (Pro with its included collaborator already in place) keeps its
 * own "contact us for seats" copy. `analytics_history` (a `402` from the deep-analytics routes)
 * reads the registry's `analytics_history` entry directly, since it is a feature gate and not
 * a counted cap.
 */
export function planLimitPrompt(limit: PlanLimitKey, opts: { used?: number; max?: number } = {}): PlanLimitPrompt {
  const max = typeof opts.max === "number" && Number.isFinite(opts.max) ? Math.max(0, Math.floor(opts.max)) : null;
  if (limit === "collaborators" && max && max > 0) {
    return {
      title: "This workspace includes one collaborator",
      message: "Pro includes 1 collaborator. Want more seats? Contact us and we will add them to your workspace.",
      secondaryLabel: "Manage members",
    };
  }
  const copy = limit === "analytics_history" ? UPSELL_COPY.analytics_history : UPSELL_COPY[upsellKeyForLimit(limit)];
  const suffix = planLimitUsageSuffix(opts);
  return {
    title: copy.title,
    message: suffix ? `${copy.reason} ${suffix}` : copy.reason,
    secondaryLabel: copy.secondaryLabel ?? "Compare plans",
  };
}

/**
 * Format the launch grace-period hint for a parsed 402, when the workspace is still inside its
 * unblocked window; `null` otherwise. Hook-free so open-modal handlers can use it.
 */
export function planLimitGraceHint(error: PlanLimitError | null | undefined): string | null {
  const g = error?.grace;
  if (!g || g.blockedAt) return null;
  const ends = Date.parse(g.endsAt);
  if (!Number.isFinite(ends)) return null;
  const daysLeft = Math.max(0, Math.ceil((ends - Date.now()) / 86_400_000));
  if (daysLeft <= 0) return null;
  return `Grace period: ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left.`;
}

/**
 * Remember (for this browser session) that a plan limit was hit and notify listeners.
 *
 * Best-effort: storage failures are ignored. The sidebar uses this to show its upgrade nudge.
 */
export function markPlanLimitHit(limit: PlanLimitKey): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(PLAN_LIMIT_HIT_STORAGE_KEY, limit);
  } catch {
    // ignore
  }
  try {
    window.dispatchEvent(new CustomEvent(PLAN_LIMIT_HIT_EVENT, { detail: { limit } }));
  } catch {
    // ignore
  }
}

/** Read the limit recorded by `markPlanLimitHit` for this session, if any. */
export function readPlanLimitHit(): PlanLimitKey | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(PLAN_LIMIT_HIT_STORAGE_KEY);
    return raw && LIMIT_KEYS.has(raw) ? (raw as PlanLimitKey) : null;
  } catch {
    return null;
  }
}

/** Clear the session flag (e.g. once the workspace is known to be on Pro). */
export function clearPlanLimitHit(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PLAN_LIMIT_HIT_STORAGE_KEY);
  } catch {
    // ignore
  }
  try {
    window.dispatchEvent(new CustomEvent(PLAN_LIMIT_HIT_EVENT, { detail: { limit: null } }));
  } catch {
    // ignore
  }
}
