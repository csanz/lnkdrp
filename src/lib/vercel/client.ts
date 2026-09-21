/**
 * A very small, read-only client for the Vercel REST API.
 *
 * The admin area knows everything about the product and nothing about the deployment it runs on:
 * what built, what failed, how long a build took. Only Vercel knows that, so this reads it back.
 *
 * Four rules hold this file together, and each one exists because the alternative is worse:
 *
 * 1. **It never throws.** Deployment insight is a nice-to-have, not a dependency. A missing token,
 *    a 403, a network blip or a slow API must all come back as a value the caller renders, never as
 *    an exception that takes an admin page down with it. Everything public here returns a
 *    `VercelResult`, and the failure cases are part of the type.
 * 2. **It never retries.** A read that failed is reported as failed. A retry loop against someone
 *    else's rate limit is how an optional panel becomes the reason the admin area is slow.
 * 3. **Every call is bounded** by `AbortSignal.timeout`. Not "usually fast": bounded.
 * 4. **The token never leaves this module.** It travels in an `Authorization` header (never in a
 *    URL, so it cannot land in a log line), it is not part of any returned value, and every message
 *    that could conceivably carry it is scrubbed on the way out. Upstream JSON is never echoed
 *    wholesale into an admin payload either: each field below is picked by hand.
 *
 * Read-only by construction: the only HTTP method this file uses is GET.
 */

/* ------------------------------------------------------------------ configuration */

/** How long any one call may take before it is abandoned. Overridable for tests only. */
export const VERCEL_TIMEOUT_MS = 8_000;

/** The API origin. A constant, so no caller can point this client somewhere else. */
const VERCEL_API_ORIGIN = "https://api.vercel.com";

export type VercelConfig = {
  configured: boolean;
  /** Which of the required variables are absent. Names only, never values. */
  missing: string[];
  /** True when a team id is set. The id itself is not a secret but there is no reason to ship it. */
  teamScoped: boolean;
};

type ResolvedConfig = { token: string; projectId: string; teamId: string | null };

/** One environment variable, trimmed, with absent and blank treated the same. */
function readEnv(name: string): string {
  const raw = process.env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

/** The credentials, or null when this deployment has none. The only place the token is read. */
function resolveConfig(): ResolvedConfig | null {
  const token = readEnv("VERCEL_API_TOKEN");
  const projectId = readEnv("VERCEL_PROJECT_ID");
  if (!token || !projectId) return null;
  const teamId = readEnv("VERCEL_TEAM_ID");
  return { token, projectId, teamId: teamId || null };
}

/**
 * What is configured, in a form that is safe to put in an admin payload.
 *
 * `missing` holds variable names so the page can say what to set. No value of any of the three
 * variables is returned by this function, or by anything else in this module.
 */
export function vercelConfig(): VercelConfig {
  const token = readEnv("VERCEL_API_TOKEN");
  const projectId = readEnv("VERCEL_PROJECT_ID");
  const missing: string[] = [];
  if (!token) missing.push("VERCEL_API_TOKEN");
  if (!projectId) missing.push("VERCEL_PROJECT_ID");
  return { configured: missing.length === 0, missing, teamScoped: Boolean(readEnv("VERCEL_TEAM_ID")) };
}

/** True when this deployment can talk to the Vercel API at all. */
export function isVercelConfigured(): boolean {
  return vercelConfig().configured;
}

/* ----------------------------------------------------------------------- results */

export type VercelFailureReason =
  /** No token or no project id. Not an error: this deployment simply has no insight wired up. */
  | "not_configured"
  /** The call ran past `VERCEL_TIMEOUT_MS` and was abandoned. */
  | "timeout"
  /** DNS, TLS, socket. We never got an HTTP status back. */
  | "network"
  /** Vercel answered, with something other than 2xx. `status` carries what. */
  | "http"
  /** Vercel answered 2xx with a body this module could not read. */
  | "bad_response";

export type VercelFailure = {
  ok: false;
  reason: VercelFailureReason;
  /** Present only for `reason: "http"`. */
  status?: number;
  /** Safe to show an admin. Scrubbed of the token, and never the upstream body verbatim. */
  message: string;
};

export type VercelResult<T> = { ok: true; data: T } | VercelFailure;

/* ------------------------------------------------------------------- the deployment shape */

/**
 * One deployment, reduced to what an admin board can use.
 *
 * Read `docs` on each field before changing it: the list endpoint and the single-deployment
 * endpoint do not spell everything the same way, which is why the parser below looks at more than
 * one key for the state and for the commit.
 */
export type VercelDeployment = {
  /** `dpl_...`. The list endpoint calls it `uid`, the single-deployment endpoint calls it `id`. */
  id: string;
  /** The deployment's own hostname, without a scheme. */
  url: string | null;
  /** READY, ERROR, BUILDING, QUEUED, CANCELED, INITIALIZING. Uppercase, as Vercel sends it. */
  state: string | null;
  /** "production", "staging", or null for a preview. */
  target: string | null;
  /** Short sha, seven characters, or null when the deployment did not come from git. */
  commitSha: string | null;
  /** First line of the commit message, trimmed to something a table cell can hold. */
  commitMessage: string | null;
  /** Branch name. */
  commitRef: string | null;
  /** Who or what triggered it. A username, not an email address. */
  creator: string | null;
  /** Epoch ms. When the deployment was created. */
  createdAt: number | null;
  /** Epoch ms. When the build started, when Vercel reported it. */
  buildingAt: number | null;
  /** Epoch ms. When it went ready. Null while it is still building, and for a failed build. */
  readyAt: number | null;
  /**
   * Ready minus building, in ms, or null when either end is missing.
   *
   * Measured from `buildingAt` when it is present and from `createdAt` otherwise, so a queued
   * deployment does not report its queue time as build time.
   */
  durationMs: number | null;
  /** The vercel.com page for this deployment. Handy, and not a secret. */
  inspectorUrl: string | null;
};

export type VercelProject = {
  id: string;
  name: string | null;
  framework: string | null;
  /** Epoch ms. */
  createdAt: number | null;
};

/* --------------------------------------------------------------------- the transport */

/** Remove anything that looks like the configured token from a string bound for an admin screen. */
function scrub(message: string, token: string): string {
  if (!token) return message;
  return message.split(token).join("[redacted]");
}

/** The deadline for one call, in ms. */
function timeoutMs(): number {
  // Tests need a short deadline; nothing else should ever set this.
  const override = Number(readEnv("VERCEL_API_TIMEOUT_MS"));
  return Number.isFinite(override) && override > 0 ? override : VERCEL_TIMEOUT_MS;
}

/**
 * One bounded, unauthenticated-on-the-way-out GET.
 *
 * Returns the parsed JSON body, or a failure. Never throws, never retries, never puts the token
 * anywhere but the `Authorization` header.
 */
async function get(path: string, query: Record<string, string | number | undefined>, cfg: ResolvedConfig): Promise<VercelResult<unknown>> {
  const url = new URL(path, VERCEL_API_ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  if (cfg.teamId) url.searchParams.set("teamId", cfg.teamId);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
      // No retry, anywhere. One attempt, bounded.
      signal: AbortSignal.timeout(timeoutMs()),
      cache: "no-store",
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const aborted = name === "TimeoutError" || name === "AbortError";
    return {
      ok: false,
      reason: aborted ? "timeout" : "network",
      message: aborted
        ? `Vercel did not answer within ${timeoutMs()}ms`
        : scrub(e instanceof Error ? e.message : "Could not reach the Vercel API", cfg.token),
    };
  }

  if (!res.ok) {
    // Deliberately not the body: an upstream error body is someone else's JSON and has no business
    // being forwarded into an admin payload. The status plus a fixed sentence is the whole story.
    return { ok: false, reason: "http", status: res.status, message: describeStatus(res.status) };
  }

  try {
    return { ok: true, data: (await res.json()) as unknown };
  } catch {
    return { ok: false, reason: "bad_response", message: "Vercel answered with a body that was not JSON" };
  }
}

/** A sentence per status an admin can act on. Written from the API's documented auth behaviour. */
function describeStatus(status: number): string {
  if (status === 401) return "Vercel rejected the token (401). Check VERCEL_API_TOKEN.";
  if (status === 403) {
    return "Vercel refused the request (403). The token may lack access to this project, or VERCEL_TEAM_ID may be missing for a team-scoped project.";
  }
  if (status === 404) return "Vercel found no such project (404). Check VERCEL_PROJECT_ID.";
  if (status === 429) return "Vercel rate-limited the request (429). Try again shortly.";
  if (status >= 500) return `Vercel returned ${status}. This is upstream, not us.`;
  return `Vercel returned ${status}.`;
}

/* ----------------------------------------------------------------------- parsing */

/** A plain object, or null. Arrays are not objects for this purpose. */
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * A trimmed string, with the token taken out of it.
 *
 * The scrub is not theatre. A commit message is attacker-influenced text that this project puts on
 * an admin screen, and a token pasted into one (or into a project name, or a branch name) would
 * otherwise be picked up here and rendered back. Every string that comes out of an upstream body
 * goes through this function, so there is no field where that can happen.
 */
function str(v: unknown, token = ""): string | null {
  if (typeof v !== "string") return null;
  const trimmed = scrub(v, token).trim();
  return trimmed ? trimmed : null;
}

/** A positive epoch-ms number, however the upstream body spelled it. */
function epoch(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  // Some fields come back as numeric strings. Parsing them is cheap and costs nothing when they do not.
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Pull the commit out of `meta`, whichever git provider wrote it.
 *
 * Vercel namespaces these per provider: `githubCommitSha`, `gitlabCommitSha`, `bitbucketCommitSha`.
 * This project is on GitHub, but keying off one provider is the kind of thing that silently renders
 * an empty column on the day somebody migrates.
 */
function commitFromMeta(meta: Record<string, unknown> | null, suffix: string, token: string): string | null {
  if (!meta) return null;
  for (const provider of ["github", "gitlab", "bitbucket"]) {
    const value = str(meta[`${provider}${suffix}`], token);
    if (value) return value;
  }
  return null;
}

/** First line of a commit message, capped. A table cell cannot hold a paragraph. */
function firstLine(message: string | null, max = 140): string | null {
  if (!message) return null;
  const line = message.split("\n")[0].trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Turn one raw deployment object into the reduced shape above. Returns null if it has no id. */
function parseDeployment(raw: unknown, token: string): VercelDeployment | null {
  const d = obj(raw);
  if (!d) return null;
  // `uid` on the list endpoint, `id` on the single-deployment endpoint.
  const id = str(d.uid, token) ?? str(d.id, token);
  if (!id) return null;

  const meta = obj(d.meta);
  const creator = obj(d.creator);
  const createdAt = epoch(d.created) ?? epoch(d.createdAt);
  const buildingAt = epoch(d.buildingAt);
  const readyAt = epoch(d.ready) ?? epoch(d.readyAt);
  const startedAt = buildingAt ?? createdAt;

  return {
    id,
    url: str(d.url, token),
    // `readyState` is the field the list endpoint has always had; `state` is the newer spelling and
    // both appear depending on the version. Either is uppercase.
    state: str(d.state, token) ?? str(d.readyState, token),
    target: str(d.target, token),
    commitSha: commitFromMeta(meta, "CommitSha", token)?.slice(0, 7) ?? null,
    commitMessage: firstLine(commitFromMeta(meta, "CommitMessage", token)),
    commitRef: commitFromMeta(meta, "CommitRef", token),
    // A username, never the creator's email: this is an admin board, not a staff directory.
    creator: creator ? str(creator.username, token) : null,
    createdAt,
    buildingAt,
    readyAt,
    durationMs: readyAt && startedAt && readyAt >= startedAt ? readyAt - startedAt : null,
    inspectorUrl: str(d.inspectorUrl, token),
  };
}

/* --------------------------------------------------------------------- the reads */

/** The most a single call will ask Vercel for, whatever a caller passes. */
const MAX_LIMIT = 50;

/**
 * The project's most recent deployments, newest first.
 *
 * `GET /v6/deployments?projectId=...&limit=...`
 */
export async function listDeployments(limit = 20): Promise<VercelResult<VercelDeployment[]>> {
  const cfg = resolveConfig();
  if (!cfg) return notConfigured();

  const bounded = Math.min(Math.max(1, Math.floor(limit) || 1), MAX_LIMIT);
  const res = await get("/v6/deployments", { projectId: cfg.projectId, limit: bounded }, cfg);
  if (!res.ok) return res;

  const body = obj(res.data);
  const rows = body && Array.isArray(body.deployments) ? body.deployments : null;
  if (!rows) return { ok: false, reason: "bad_response", message: "Vercel returned no deployments array" };

  const parsed: VercelDeployment[] = [];
  for (const row of rows) {
    const d = parseDeployment(row, cfg.token);
    if (d) parsed.push(d);
  }
  return { ok: true, data: parsed };
}

/**
 * One deployment by id or by hostname.
 *
 * `GET /v13/deployments/{idOrUrl}`
 */
export async function getDeployment(idOrUrl: string): Promise<VercelResult<VercelDeployment>> {
  const cfg = resolveConfig();
  if (!cfg) return notConfigured();

  const id = typeof idOrUrl === "string" ? idOrUrl.trim() : "";
  if (!id) return { ok: false, reason: "bad_response", message: "No deployment id was given" };

  const res = await get(`/v13/deployments/${encodeURIComponent(id)}`, {}, cfg);
  if (!res.ok) return res;

  const parsed = parseDeployment(res.data, cfg.token);
  if (!parsed) return { ok: false, reason: "bad_response", message: "Vercel returned no deployment" };
  return { ok: true, data: parsed };
}

/**
 * The project itself: enough to confirm the admin is looking at the right one.
 *
 * `GET /v9/projects/{idOrName}`
 */
export async function getProject(): Promise<VercelResult<VercelProject>> {
  const cfg = resolveConfig();
  if (!cfg) return notConfigured();

  const res = await get(`/v9/projects/${encodeURIComponent(cfg.projectId)}`, {}, cfg);
  if (!res.ok) return res;

  const p = obj(res.data);
  const id = p ? str(p.id, cfg.token) : null;
  if (!p || !id) return { ok: false, reason: "bad_response", message: "Vercel returned no project" };

  return {
    ok: true,
    data: {
      id,
      name: str(p.name, cfg.token),
      framework: str(p.framework, cfg.token),
      createdAt: epoch(p.createdAt),
    },
  };
}

/** The one failure that is not a failure: nothing is wired up, and nothing is meant to be. */
function notConfigured(): VercelFailure {
  const { missing } = vercelConfig();
  return {
    ok: false,
    reason: "not_configured",
    message: `Vercel insight is not configured. Set ${missing.join(" and ")}.`,
  };
}
