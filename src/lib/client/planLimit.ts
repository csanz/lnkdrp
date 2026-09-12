/**
 * Client-side helpers for plan-limit (`402 plan_limit`) responses.
 *
 * The server side lives in `src/lib/billing/planLimits.ts` (`checkLimit` / `planLimitResponse`);
 * that module pulls in Mongoose models so it must not be imported from client bundles. This file
 * mirrors only what the browser needs: the 402 body shape, prompt copy per limit, and a tiny
 * session flag so the sidebar can nudge once a limit has been hit.
 */

/** Which Free-plan limit was hit. Mirrors `LimitKey` in `src/lib/billing/planLimits.ts`. */
export type PlanLimitKey = "active_links" | "projects" | "collaborators";

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

/** Free-plan numbers, mirrored from `src/lib/billing/planLimits.ts` for copy on client surfaces. */
export const FREE_PLAN_LIMITS_COPY = {
  activeLinks: 3,
  projects: 1,
  analyticsDays: 7,
} as const;

/**
 * Launch flag: AI is free at launch, so credit surfaces (dashboard credits pill, Usage/Limits cards,
 * spend-limit editor) are hidden unless `NEXT_PUBLIC_FEATURE_CREDITS=1`. Routes keep working.
 */
export const FEATURE_CREDITS_ENABLED = process.env.NEXT_PUBLIC_FEATURE_CREDITS === "1";

/** `sessionStorage` key set once a plan-limit 402 has been seen in this browser session. */
export const PLAN_LIMIT_HIT_STORAGE_KEY = "lnkdrp_plan_limit_hit";

/** Window event fired when a plan-limit 402 is seen (lets the sidebar nudge appear without a reload). */
export const PLAN_LIMIT_HIT_EVENT = "lnkdrp:plan-limit-hit";

const LIMIT_KEYS: ReadonlySet<string> = new Set(["active_links", "projects", "collaborators"]);

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
 * Build the prompt copy for a given limit (hook-free so it works in handlers and render alike).
 *
 * `used`/`max` are optional; when present they are folded into the message.
 */
export function planLimitPrompt(limit: PlanLimitKey, opts: { used?: number; max?: number } = {}): PlanLimitPrompt {
  const max = typeof opts.max === "number" && Number.isFinite(opts.max) ? Math.max(0, Math.floor(opts.max)) : null;
  switch (limit) {
    case "active_links": {
      const n = max ?? FREE_PLAN_LIMITS_COPY.activeLinks;
      return {
        title: "Link limit reached",
        message: `Free workspaces can have ${n} active share ${n === 1 ? "link" : "links"}. Disable one or upgrade to Pro.`,
        secondaryLabel: "Manage links",
      };
    }
    case "projects": {
      const n = max ?? FREE_PLAN_LIMITS_COPY.projects;
      return {
        title: "Project limit reached",
        message: `Free workspaces can have ${n} ${n === 1 ? "project" : "projects"}. Delete one or upgrade to Pro.`,
        secondaryLabel: "Manage projects",
      };
    }
    case "collaborators":
      return max && max > 0
        ? {
            title: "This workspace includes one collaborator",
            message: "Pro includes 1 collaborator. Want more seats? Contact us and we will add them to your workspace.",
            secondaryLabel: "Manage members",
          }
        : {
            title: "Collaborators are a Pro feature",
            message: "Free workspaces are single-user. Upgrade to Pro to invite a collaborator.",
            secondaryLabel: "Manage members",
          };
    default:
      return { title: "Plan limit reached", message: "Upgrade to Pro to keep going.", secondaryLabel: "Manage" };
  }
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
