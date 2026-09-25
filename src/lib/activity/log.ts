/**
 * Activity logging.
 *
 * `recordActivity()` appends one `ActivityEvent` row per notable write. It is intentionally
 * best-effort: it never throws, never blocks the caller beyond the insert, and callers fire it as
 * `void recordActivity({...})` AFTER the primary write succeeds (never before, and never inside a
 * Mongo transaction, so a failed primary write is never reported as activity).
 *
 * Agent attribution: MCP/agent clients identify themselves with an `x-lnkdrp-agent` header of the
 * form `<client>/<version>` (e.g. `claude-code/1.2.3`). When the header is absent we sniff the
 * User-Agent for known agent clients; ordinary browsers resolve to `null`.
 */
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ActivityEventModel } from "@/lib/models/ActivityEvent";
import { debugError } from "@/lib/debug";

export type ActivityType =
  | "doc.created"
  | "doc.imported_url"
  | "upload.completed"
  | "doc.processed"
  | "doc.replaced"
  | "doc.deleted"
  | "doc.archived"
  | "doc.unarchived"
  | "share.updated"
  | "share_link.created"
  | "share_link.updated"
  | "share_link.revoked"
  | "share_link.password_revealed"
  | "share.password_set"
  | "share.password_cleared"
  | "project.created"
  | "project.updated"
  | "project.deleted"
  | "doc.added_to_project"
  | "doc.removed_from_project"
  // Filing. Worth a row because it is the one kind of housekeeping an agent keeps doing after a
  // person stops, and "Claude Code tagged the Series A deck as Fundraising" is the sentence that
  // makes that visible. The tag's name rides in `meta` rather than being looked up when rendered,
  // so a renamed or deleted tag leaves the history readable.
  | "tag.applied"
  | "tag.removed"
  | "request_repo.created"
  | "request.upload_received"
  | "download_request.created"
  | "download_request.approved"
  | "download_request.denied"
  | "share.viewed"
  | "share.downloaded"
  | "plan.limit_reached"
  | "plan.grace_started"
  | "plan.grace_reminder"
  | "plan.grace_blocked"
  | "plan.upgraded"
  // The workspace's Pro subscription was set to stop at the end of the paid period because the
  // person whose card paid for it asked for their account to be deleted. `meta.periodEnd` says
  // when; `meta.otherAdmins` says whether anyone else could have taken billing over.
  | "plan.subscription_ending"
  | "credits.exhausted"
  | "summary.generated"
  | "agent.key_created"
  | "agent.key_revoked"
  | "agent.connected"
  | "agent.key_verified"
  // An agent connected by signing in (OAuth) rather than with a key, and the person revoking that
  // from the Connect page. `meta.name` is the client's own name ("Claude Code").
  | "agent.authorized"
  | "agent.disconnected"
  | "account.deletion_requested"
  | "account.purged"
  // Who is in this workspace. A member arriving or leaving changes who can read every document in
  // it, which makes it the most consequential thing that can happen here and the one thing the feed
  // could not show: the Members page was the only record, and it only ever shows the present tense.
  | "member.invited"
  | "member.joined"
  | "member.removed"
  | "member.left"
  // A recipient reached a project link's file list. `share.viewed` covers opening a document; this
  // is the arrival, including the arrival that opens nothing — which on a data room is a signal in
  // its own right (see `landedWithoutOpening` in docs/METRICS.md).
  | "project.landed"
  // A recipient got past a share link's password. The one moment on a protected link where the
  // sender learns the password reached the right person and was used.
  | "share.unlocked"
  // A recipient put a name to their visit. Unlike the other recipient events this one is not
  // identity-gated: the name was volunteered *to* this workspace, and hiding it on Free would be
  // hiding a message its sender meant them to have.
  | "viewer.introduced"
  // A recipient's visit ended and the account of it is stored (`VisitBrief`); `meta.headline`
  // carries the model's one line when a brief was written, `meta.recapReason` says why not when
  // it was not. Written by the `visit-briefs` cron, never in the ingest path.
  | "share.visit_briefed"
  // A Slack channel wired up or removed (docs/prds/lnkdrp-slack.md). `meta.channelName` and
  // `meta.teamName`; never the webhook URL.
  | "integration.slack_connected"
  | "integration.slack_disconnected"
  // Funnel instrumentation (docs/reviews/pricing-upsell-fix-plan-2026-09-23.md, Phase 4). An
  // upgrade or out-of-credits modal opened (`meta.reason`, `meta.from`) and what was pressed on it
  // (`meta.cta`: upgrade | pack | compare | manage | dismiss). Written by `POST /api/funnel` from
  // the browser; hidden from the workspace feed (`src/lib/activity/feedVisibility.ts`).
  | "funnel.modal_shown"
  | "funnel.cta_clicked"
  // The Free analytics teaser was shown; `meta.uniqueViewers` / `identifiedViewers` are the
  // counts it showed, so the funnel can say how much a workspace was looking at when it did or
  // did not upgrade.
  | "funnel.teaser_shown"
  // A Stripe Checkout session was created: `meta.kind` is "pro" (with `meta.interval`) or
  // "credit_pack" (with `meta.pack`, `meta.credits`). `plan.upgraded` is the webhook's answer to
  // the one that completed. Hidden from the feed like the two above.
  | "checkout.started";

export type ActivityAgent = { client: string; version: string | null } | null;

export type ActivityActorKind = "user" | "temp" | "secret" | "api_key" | "viewer";

/** Header an agent/MCP client sends to identify itself: `<client>/<version>` or `<client>`. */
export const ACTIVITY_AGENT_HEADER = "x-lnkdrp-agent";

const CLIENT_MAX_LEN = 64;
const VERSION_MAX_LEN = 64;
const CLIENT_RE = /^[a-z0-9._-]+$/;

/**
 * Known agent clients we recognise from a User-Agent string when `x-lnkdrp-agent` is absent.
 *
 * Order matters: more specific ids first (`claude-code` before `claude`).
 * Each entry is `[client id, substring to look for (lowercase)]`.
 */
const KNOWN_UA_CLIENTS: ReadonlyArray<readonly [string, string]> = [
  ["claude-code", "claude-code"],
  ["claude-desktop", "claude-desktop"],
  ["claude", "claude"],
  ["cursor", "cursor"],
  ["codex", "codex"],
  ["gemini-cli", "gemini-cli"],
  ["grok", "grok"],
  ["windsurf", "windsurf"],
  ["cline", "cline"],
];

/** Human-readable labels for well-known client ids (others fall back to Title Case). */
const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  claude: "Claude",
  cursor: "Cursor",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  grok: "Grok",
  windsurf: "Windsurf",
  cline: "Cline",
};

/** Normalise a raw client id: lowercase, trimmed, length-capped; null when it contains disallowed chars. */
function normalizeClientId(raw: string): string | null {
  const client = raw.trim().toLowerCase().slice(0, CLIENT_MAX_LEN);
  if (!client || !CLIENT_RE.test(client)) return null;
  return client;
}

/** Normalise a raw version: trimmed, length-capped, printable ASCII only; null when empty. */
function normalizeVersion(raw: string | undefined): string | null {
  const v = (raw ?? "").trim().slice(0, VERSION_MAX_LEN);
  if (!v) return null;
  // Keep versions simple (semver-ish / build ids); drop anything with control chars or spaces.
  if (!/^[\x21-\x7e]+$/.test(v)) return null;
  return v;
}

/**
 * Parse the `x-lnkdrp-agent` header value (`<client>/<version>` or `<client>`).
 *
 * Returns null when the value is empty or the client id is not a valid `[a-z0-9._-]` token.
 */
function parseAgentHeader(value: string): ActivityAgent {
  const s = value.trim();
  if (!s) return null;
  const slash = s.indexOf("/");
  const clientRaw = slash >= 0 ? s.slice(0, slash) : s;
  const versionRaw = slash >= 0 ? s.slice(slash + 1) : undefined;
  const client = normalizeClientId(clientRaw);
  if (!client) return null;
  return { client, version: normalizeVersion(versionRaw) };
}

/** Sniff a User-Agent string for a known agent client. Ordinary browsers return null. */
function sniffUserAgent(ua: string): ActivityAgent {
  const s = ua.trim().toLowerCase();
  if (!s) return null;
  for (const [client, needle] of KNOWN_UA_CLIENTS) {
    if (s.includes(needle)) return { client, version: null };
  }
  return null;
}

/**
 * Resolve the agent/MCP client that issued `request`, or null for an ordinary browser.
 *
 * Pure: reads only the `x-lnkdrp-agent` and `user-agent` headers.
 */
export function agentFromRequest(request: Request | null | undefined): ActivityAgent {
  if (!request || typeof request.headers?.get !== "function") return null;
  const explicit = request.headers.get(ACTIVITY_AGENT_HEADER);
  if (typeof explicit === "string" && explicit.trim()) {
    const parsed = parseAgentHeader(explicit);
    if (parsed) return parsed;
  }
  const ua = request.headers.get("user-agent");
  return typeof ua === "string" ? sniffUserAgent(ua) : null;
}

/** Title Case a client id: `gemini-cli` -> `Gemini Cli`, `my_tool` -> `My Tool`. */
function titleCaseClientId(client: string): string {
  return client
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Human-readable label for an agent (`"claude-code"` -> `"Claude Code"`).
 *
 * Unknown client ids are Title Cased; `null` agents yield `null`.
 */
export function agentLabel(agent: ActivityAgent): string | null {
  if (!agent || typeof agent.client !== "string") return null;
  const client = agent.client.trim().toLowerCase();
  if (!client) return null;
  return AGENT_LABELS[client] ?? titleCaseClientId(client);
}

type IdLike = string | Types.ObjectId | null | undefined;

/** Coerce a string/ObjectId into an ObjectId, or null when missing/invalid. */
function toObjectId(v: IdLike): Types.ObjectId | null {
  if (!v) return null;
  if (v instanceof Types.ObjectId) return v;
  const s = String(v).trim();
  return Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
}

/** First hop of `x-forwarded-for` (or `x-real-ip`), or null. */
function ipFromRequest(request: Request | null | undefined): string | null {
  if (!request || typeof request.headers?.get !== "function") return null;
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = (xff.split(",")[0] ?? "").trim();
    if (first) return first.slice(0, 64);
  }
  const real = request.headers.get("x-real-ip");
  if (real && real.trim()) return real.trim().slice(0, 64);
  return null;
}

export type RecordActivityInput = {
  orgId: string | Types.ObjectId;
  userId?: string | Types.ObjectId | null;
  actorKind: ActivityActorKind;
  /** Explicit agent; when `undefined` it is derived from `request` via `agentFromRequest()`. */
  agent?: ActivityAgent;
  type: ActivityType;
  docId?: string | Types.ObjectId | null;
  projectId?: string | Types.ObjectId | null;
  uploadId?: string | Types.ObjectId | null;
  /** Denormalized doc/project title for fast rendering. */
  title?: string | null;
  meta?: Record<string, unknown>;
  /** Incoming request, used for agent attribution and client IP. */
  request?: Request | null;
};

/**
 * Append one activity row (best-effort).
 *
 * Never throws and never awaits anything beyond `connectMongo()` + the insert. Call it as
 * `void recordActivity({...})` after the primary write has succeeded.
 */
export async function recordActivity(input: RecordActivityInput): Promise<void> {
  try {
    const orgId = toObjectId(input.orgId);
    if (!orgId) {
      debugError(1, "[activity] recordActivity skipped: invalid orgId", { type: input.type });
      return;
    }
    const agent = typeof input.agent === "undefined" ? agentFromRequest(input.request) : input.agent;
    const title = typeof input.title === "string" ? input.title.trim().slice(0, 300) || null : null;

    await connectMongo();
    await ActivityEventModel.create({
      orgId,
      userId: toObjectId(input.userId),
      actorKind: input.actorKind,
      agent: agent ? { client: agent.client, version: agent.version ?? null } : null,
      type: input.type,
      docId: toObjectId(input.docId),
      projectId: toObjectId(input.projectId),
      uploadId: toObjectId(input.uploadId),
      title,
      meta: input.meta && typeof input.meta === "object" ? input.meta : {},
      ip: ipFromRequest(input.request),
      createdDate: new Date(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[activity] recordActivity failed", { type: input?.type, message });
  }
}
