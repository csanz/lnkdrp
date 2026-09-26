/**
 * End-to-end harness for the lnkdrp MCP server (`mcp/`, see docs/MCP.md).
 *
 * Drives the real stack over the wire: mints a temporary API key straight in Mongo, connects an
 * MCP client to the running server, exercises every tool in the order an agent would use
 * them (including both link lifecycles: a second link on a document, and a project link on a
 * throwaway project — create, list, update, refuse an unconfirmed delete, delete), checks that a bad key is rejected at `initialize`, and revokes the key again.
 *
 * Prerequisites (three terminals):
 *   npm run dev        # Next app on :3001 (the MCP server calls its REST API)
 *   npm run mcp        # MCP server on :8787
 *   npm run realtime   # optional; lets share_pdf return on the `doc` ready frame instead of polling
 *
 * Run:
 *   npx tsx --env-file=.env.local tests/mcp/e2e.ts
 *
 * Env:
 *   MONGODB_URI              from .env.local; used only to create and revoke the temporary key
 *   MCP_URL                  MCP endpoint (default http://localhost:8787/mcp)
 *   E2E_ORG_ID, E2E_USER_ID  workspace the key is minted for. Both optional: an unset or unusable pair
 *                            is replaced by a workspace discovered in the database (printed at step 1)
 *   E2E_PDF_URL              public PDF to import (default: the W3C dummy.pdf)
 *   E2E_TIMEOUT_SECONDS      share_pdf waitForReady timeout, 5..120 (default 90)
 *   E2E_CLIENT_NAME/_VERSION MCP client identity sent at initialize (default lnkdrp-e2e / 1.0)
 *
 * Pacing: steps are spaced 1.5-5s apart by default so the activity rows this run writes land at
 * believable intervals instead of all on one timestamp. `--fast` removes the gaps (use it in CI);
 * `--pace 3-12` widens them when you want the feed to look like a working morning.
 *
 * Prints one line per step with its duration, then a one-line JSON summary. Exits 1 on the first
 * failed assertion (the key is still revoked). The docs it creates ("MCP e2e", "MCP e2e agent
 * summary") are deleted again at the end so the Free active-link cap is not consumed; set
 * E2E_KEEP_DOCS=1 to keep them and see the "Lnkdrp E2e" attribution on /activity.
 *
 * No test framework on purpose: a single readable script that mirrors what an agent does.
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Types } from "mongoose";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { describePacing, pause, resolvePacing } from "../pace";
import { connectMongo } from "@/lib/mongodb";
import { apiKeyPrefix, createApiKey, revokeApiKey } from "@/lib/agents/apiKeys";
import { creditsForRun } from "@/lib/credits/schedule";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { DocModel } from "@/lib/models/Doc";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UploadModel } from "@/lib/models/Upload";
import { TagModel } from "@/lib/models/Tag";
import { TagAssignmentModel } from "@/lib/models/TagAssignment";

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

const MCP_URL = process.env.MCP_URL ?? "http://localhost:8787/mcp";
/**
 * Local dev workspace (org + the member who owns the key). Override with E2E_ORG_ID / E2E_USER_ID.
 *
 * A starting point, not the answer: `resolveWorkspace()` checks the pair against the database before
 * the key is minted and discovers a usable one when it is not there. Hardcoded ids are per-database
 * facts, so this default has been wrong twice - once pointing at a workspace its owner had left, and
 * again on every machine whose dev database was seeded separately. Both failed the same way, at
 * `initialize` with `owner_removed`, which reads as a broken server rather than a stale constant.
 *
 * Reassigned there, which is why these are `let`: every later step asserts against the workspace the
 * key actually belongs to.
 */
let ORG_ID = process.env.E2E_ORG_ID ?? "6ab2d81f33802709c6aaa173";
let USER_ID = process.env.E2E_USER_ID ?? "6ab2d81f55068178c044f084";
const PDF_URL = process.env.E2E_PDF_URL ?? "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";
const TIMEOUT_SECONDS = clamp(Number(process.env.E2E_TIMEOUT_SECONDS ?? 90), 5, 120);
/** MCP client identity sent at `initialize`; the server records it as the activity agent. Override
 *  with E2E_CLIENT_NAME / E2E_CLIENT_VERSION (e.g. `claude-code` / `2.1.0`) to see real attribution. */
const CLIENT_INFO = {
  name: process.env.E2E_CLIENT_NAME ?? "lnkdrp-e2e",
  version: process.env.E2E_CLIENT_VERSION ?? "1.0",
} as const;

const EXPECTED_TOOLS = [
  "lnkdrp_whoami",
  "lnkdrp_list_docs",
  "lnkdrp_get_activity",
  "lnkdrp_share_pdf",
  "lnkdrp_replace_pdf",
  "lnkdrp_get_share",
  "lnkdrp_set_share_access",
  "lnkdrp_get_share_stats",
  "lnkdrp_create_share_link",
  "lnkdrp_list_share_links",
  "lnkdrp_find_share_link",
  "lnkdrp_get_share_link_password",
  "lnkdrp_verify_share_password",
  "lnkdrp_update_share_link",
  "lnkdrp_delete_share_link",
  "lnkdrp_archive_doc",
  "lnkdrp_delete_doc",
  // Containment: keep a document inside its data room, or list it in the workspace again.
  "lnkdrp_set_doc_visibility",
  "lnkdrp_create_project",
  "lnkdrp_list_projects",
  "lnkdrp_get_project",
  "lnkdrp_add_docs_to_project",
  "lnkdrp_remove_doc_from_project",
  "lnkdrp_update_project",
  "lnkdrp_delete_project",
  "lnkdrp_create_project_link",
  "lnkdrp_list_project_links",
  "lnkdrp_update_project_link",
  "lnkdrp_delete_project_link",
  "lnkdrp_star_docs",
  "lnkdrp_list_starred",
  // The tag tools shipped in 31b296b and were never added here, so the harness reported "30 tools"
  // against a server exposing 33 and passed - the assertion below only ran one way.
  "lnkdrp_list_tags",
  "lnkdrp_tag",
  "lnkdrp_untag",
  // Contacts: who the workspace has heard from, read-only (2026-09-25).
  "lnkdrp_list_contacts",
  "lnkdrp_get_contact",
  // Revisions: what changed, when, by whom, and the diff (2026-09-24).
  "lnkdrp_list_revisions",
  "lnkdrp_get_revision",
  "lnkdrp_revision_contributors",
] as const;

/**
 * Set from `/healthz`: false when the server runs with LNKDRP_SKIP_CONFIRMATIONS against a dev
 * database, in which case the confirmation-gate steps are skipped rather than failed.
 */
let confirmationsEnforced = true;

/** A syntactically valid key (`lnk_` + 32 base62 chars) that was never minted. */
const BAD_KEY = `lnk_${"0".repeat(32)}`;

// ---------------------------------------------------------------------------------------------
// Tiny harness: assert + timed steps
// ---------------------------------------------------------------------------------------------

class AssertionError extends Error {}

/** Throw `AssertionError` (reported as a failed step) unless `condition` is truthy. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

/** Clamp `n` into [min, max]; non-numbers fall back to `max`. */
function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : max;
}

/** Elapsed time since `from` (a `performance.now()` mark) as "123ms". */
function ms(from: number): string {
  return `${Math.round(performance.now() - from)}ms`;
}

type StepRecord = { name: string; ms: number; ok: boolean };
const steps: StepRecord[] = [];

/** Run `fn` as a numbered step, printing its outcome and duration. Rethrows so the run stops. */
/**
 * Spacing between steps. On by default so the activity feed this run produces reads as a sequence
 * of things that happened rather than twenty rows sharing one timestamp — see `./pace.ts`. Pass
 * `--fast` in CI.
 */
const PACING = resolvePacing();

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const n = steps.length + 1;
  // Before the step, not after: the gap belongs between two actions, and pausing after the last
  // one would only delay the summary.
  if (steps.length) await pause(PACING);
  const t0 = performance.now();
  process.stdout.write(`[${String(n).padStart(2, " ")}] ${name} … `);
  try {
    const out = await fn();
    const took = Math.round(performance.now() - t0);
    steps.push({ name, ms: took, ok: true });
    console.log(`ok (${took}ms)`);
    return out;
  } catch (err) {
    const took = Math.round(performance.now() - t0);
    steps.push({ name, ms: took, ok: false });
    console.log(`FAIL (${took}ms)`);
    throw err;
  }
}

/** Print an indented detail line under the current step. */
function info(label: string, value: unknown): void {
  console.log(`     ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------------------------
// MCP result envelope helpers (contract: success carries structuredContent + JSON text;
// errors carry isError:true and `{ error: { code, message, details? } }` as text)
// ---------------------------------------------------------------------------------------------

type ToolError = { code: string; message: string; details?: unknown };

class ToolCallError extends Error {
  readonly tool: string;
  readonly code: string;
  readonly details: unknown;
  constructor(tool: string, e: ToolError) {
    super(`${tool} -> ${e.code}: ${e.message}`);
    this.tool = tool;
    this.code = e.code;
    this.details = e.details;
  }
}

type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;

/** The first `text` content block of a tool result, or null. */
function firstText(result: CallToolResult): string | null {
  const block = Array.isArray(result.content) ? result.content.find((c) => c.type === "text") : undefined;
  return block && block.type === "text" ? block.text : null;
}

/** Call a tool and return its structured result, or throw `ToolCallError` for an `isError` envelope. */
async function callTool<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const text = firstText(result);
  if (result.isError) {
    let parsed: { error?: ToolError } = {};
    try {
      parsed = text ? (JSON.parse(text) as { error?: ToolError }) : {};
    } catch {
      /* non-JSON error text; fall through */
    }
    throw new ToolCallError(name, parsed.error ?? { code: "unknown", message: text ?? "tool returned isError without text" });
  }
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent as T;
  assert(text, `${name}: result has neither structuredContent nor a text block`);
  return JSON.parse(text) as T;
}

/** Shape of an `untrusted()`-wrapped string in tool output. */
type Untrusted = { _source: "document" | "viewer"; _note: string; text: string };

/** Whether `v` has the `{ _source, _note, text }` shape the server uses for document/viewer text. */
function isUntrusted(v: unknown): v is Untrusted {
  return Boolean(v) && typeof v === "object" && typeof (v as Untrusted).text === "string" && typeof (v as Untrusted)._source === "string";
}

type DocsPage = { total: number; page: number; limit: number; hasMore: boolean; docs: Array<{ docId: string; shareId: string | null; status: string; title: unknown }> };
type ActivityPage = { nextCursor: string | null; items: Array<{ id: string; type: string; at: string; actor: { kind: string }; agent: { client: string } | null; doc: { docId: string } | null }> };
type WhoAmI = { ok: boolean; userId: string; orgId: string; orgName: string | null; plan: string; keyPrefix: string; scopes: string[]; client: string; costs?: unknown; mcpVersion?: string };
type SharePdfResult = { docId: string; shareId: string; shareUrl: string; replaceUrl: null; status: string; version: number; uploadId: string; title: string; planWarning?: unknown };
type GetShareResult = { docId: string; shareId: string; title: Untrusted; status: string; shareEnabled: boolean; shareAllowPdfDownload: boolean; sharePasswordEnabled: boolean; shareAllowRevisionHistory: boolean; shareUrl: string; previewImageUrl: string | null; oneLiner: Untrusted | null; summary: Untrusted | null; isArchived: boolean };
/** One share link as the link tools return it (the DTO plus its public URL). */
type ShareLinkDTO = {
  id: string;
  docId: string;
  shareId: string;
  shareUrl: string;
  label: string;
  audience: string | null;
  isDefault: boolean;
  enabled: boolean;
  allowDownload: boolean;
  status: string;
  active: boolean;
  viewCount: number;
  downloadCount: number;
};
type CreateShareLinkResult = { link: ShareLinkDTO; shareUrl: string; planWarning?: unknown; planNote?: string };
/** One project link: the document DTO minus docId and allowRevisionHistory, resolving at /p/. */
type ProjectLinkDTO = {
  id: string;
  projectId: string;
  shareId: string;
  shareUrl: string;
  label: string;
  audience: string | null;
  isDefault: boolean;
  enabled: boolean;
  allowDownload: boolean;
  passwordEnabled: boolean;
  expiresAt: string | null;
  active: boolean;
  status: string;
  createdVia: string;
  viewCount: number;
  downloadCount: number;
};
type ProjectRefResult = { projectId: string; slug: string; name: unknown };
type CreateProjectLinkResult = { project: ProjectRefResult; link: ProjectLinkDTO; shareUrl: string; warnings?: string[] };
type ListProjectLinksResult = { project: ProjectRefResult; publicPageEnabled: boolean | null; links: ProjectLinkDTO[] };
type CreateProjectResult = { project: { projectId: string; slug: string; name: unknown; publicUrl?: string | null } };

/** Project tools answer with the project nested under `project`; `get_project` also carries docs. */
type ProjectEnvelope = { project?: ProjectFields } & Partial<ProjectFields>;
type ProjectFields = { projectId?: string; slug?: string; publicUrl?: string | null; publicPageEnabled?: boolean };

/** The project from either shape, so an assertion never silently reads `undefined`. */
function projectOf(res: ProjectEnvelope): ProjectFields {
  return res.project ?? res;
}
type ListShareLinksResult = { docId: string; links: ShareLinkDTO[] };
// `docTitle` is wrapped as untrusted content like every other document title (c20c4bb); this type
// said `string` and the assertion below compared the wrapper object to one, so it read
// "[object Object]" !== "MCP e2e" long after the tool started doing the right thing.
type FindShareLinkHit = { docId: string; docTitle: Untrusted | null; docShareId: string | null; linkId: string; shareId: string; shareUrl: string; label: string; audience: string | null; isDefault: boolean };
type FindShareLinkResult = { query: string; links: FindShareLinkHit[] };

/** Credit/AI fields added to whoami and share_pdf (agent-written summaries, warnings). */
type Capabilities = {
  links?: { limited?: boolean };
  projectLinks?: { proOnly?: boolean; available?: boolean };
  documents?: { limit: number | null; used: number; remaining: number | null } | null;
  projects?: { limit: number | null; used: number; remaining: number | null } | null;
  collaborators?: { limit: number | null; used: number } | null;
  analyticsDaysLimit?: number | null;
  deepAnalytics?: boolean;
  recipientsCanBrowseVersions?: boolean;
  notMcpAccessible?: Array<{ feature?: string; reason?: string }>;
};
/** One `costs` row: `levels` is what can be picked (empty = one price), `credits` that one price. */
type AdvertisedCost = { levels?: string[]; perLevel?: Record<string, number>; credits?: number | null };
type WhoAmICredits = { costs?: { summary?: AdvertisedCost; compare?: AdvertisedCost; brief?: AdvertisedCost }; creditsRemaining?: number | null; creditsResetAt?: string | null; onDemand?: boolean; capabilities?: Capabilities };
type SharePdfAiFields = { warnings?: unknown; creditsRemaining?: number };
type ReplacePdfResult = { docId: string; shareId: string; shareUrl: string; status: string; version: number; uploadId: string; title: string | null };
/** Documents this run created; deleted in `finally` so the Free active-link cap is not consumed. */
const createdDocs: Array<{ docId: string; origin: string }> = [];
/** Throwaway projects the project-link steps create, deleted in `finally` even after a failure. */
const createdProjects: Array<{ projectId: string; origin: string }> = [];
/** Set E2E_KEEP_DOCS=1 to keep the created documents (e.g. to inspect attribution on /activity). */
const KEEP_DOCS = process.env.E2E_KEEP_DOCS === "1";

type ShareStatsResult = { docId: string; shareId: string; days: number; analyticsTier: string; viewerCount: number; totals: { views: number; downloads: number; pagesViewed: number; timeSpentMs: number; authenticatedViewers: number; anonymousViewers: number }; series: Array<{ date: string; views: number; downloads?: number }>; viewers?: unknown[] };

// ---------------------------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------------------------

/** An MCP client + Streamable HTTP transport that sends `Authorization: Bearer <apiKey>` on every request. */
function makeClient(apiKey: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  const client = new Client(CLIENT_INFO);
  return { client, transport };
}

/** End the server session (DELETE /mcp) and close the client, swallowing errors. */
async function closeQuietly(client: Client, transport: StreamableHTTPClientTransport): Promise<void> {
  try {
    await transport.terminateSession();
  } catch {
    /* server may not support DELETE; fine */
  }
  try {
    await client.close();
  } catch {
    /* already closed */
  }
}

// ---------------------------------------------------------------------------------------------
// The workspace the key is minted for
// ---------------------------------------------------------------------------------------------

/**
 * The workspace this run will act in, checked against the database rather than assumed.
 *
 * `createApiKey` writes a row for any pair of ids, valid or not, so a key minted for a workspace
 * nobody is a member of looks fine here and fails three steps later at `initialize` with
 * `owner_removed` - the one error whose remedy ("mint a new key") cannot help. The pair is therefore
 * verified the same way `verifyBearer` will verify it (`isActiveMember`: a membership row that is not
 * `isDeleted`), and a pair that does not hold is replaced instead of being minted anyway.
 *
 * The configured pair always wins when it is real, so `E2E_ORG_ID`/`E2E_USER_ID` still mean what they
 * say. Otherwise an owner membership is discovered: the configured *org* first, in case only the user
 * half is stale, then the workspace holding the most live documents, because a database seeded on a
 * developer's machine holds dozens of empty "Personal" workspaces beside the one somebody actually
 * uses, and the run needs a workspace with room for a document rather than the first row Mongo returns.
 */
async function resolveWorkspace(): Promise<{ orgId: string; userId: string; orgName: string | null; discovered: boolean }> {
  const orgName = async (orgId: string): Promise<string | null> => {
    const org = (await OrgModel.findById(orgId).select({ name: 1 }).lean()) as { name?: unknown } | null;
    return typeof org?.name === "string" ? org.name : null;
  };

  const configuredPairIsReal =
    Types.ObjectId.isValid(ORG_ID) &&
    Types.ObjectId.isValid(USER_ID) &&
    Boolean(
      await OrgMembershipModel.exists({
        orgId: new Types.ObjectId(ORG_ID),
        userId: new Types.ObjectId(USER_ID),
        isDeleted: { $ne: true },
      }),
    );
  if (configuredPairIsReal) return { orgId: ORG_ID, userId: USER_ID, orgName: await orgName(ORG_ID), discovered: false };

  const owners = (await OrgMembershipModel.find({ role: "owner", isDeleted: { $ne: true } })
    .select({ orgId: 1, userId: 1 })
    .lean()) as Array<{ orgId: Types.ObjectId; userId: Types.ObjectId }>;
  // A membership can outlive its workspace, and a deleted workspace is not one to test in.
  const liveOrgs = (await OrgModel.find({ _id: { $in: owners.map((o) => o.orgId) }, isDeleted: { $ne: true } })
    .select({ _id: 1, name: 1 })
    .lean()) as Array<{ _id: Types.ObjectId; name?: unknown }>;
  const nameById = new Map(liveOrgs.map((o) => [String(o._id), typeof o.name === "string" ? o.name : null]));
  const candidates = owners.filter((o) => nameById.has(String(o.orgId)));
  assert(
    candidates.length > 0,
    "no workspace in this database has an active owner membership, so no key can be minted. Seed one, or point E2E_ORG_ID / E2E_USER_ID at a workspace that exists.",
  );

  const counts = await DocModel.aggregate<{ _id: Types.ObjectId; docs: number }>([
    { $match: { orgId: { $in: candidates.map((c) => c.orgId) }, isDeleted: { $ne: true } } },
    { $group: { _id: "$orgId", docs: { $sum: 1 } } },
  ]);
  const docsByOrg = new Map(counts.map((c) => [String(c._id), c.docs]));
  const configuredOrg = candidates.find((c) => String(c.orgId) === ORG_ID);
  const busiest = [...candidates].sort((a, b) => (docsByOrg.get(String(b.orgId)) ?? 0) - (docsByOrg.get(String(a.orgId)) ?? 0))[0];
  const pick = configuredOrg ?? busiest;
  return { orgId: String(pick.orgId), userId: String(pick.userId), orgName: nameById.get(String(pick.orgId)) ?? null, discovered: true };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

/** Run every step in order; the `finally` block revokes the key no matter where it stops. */
async function main(): Promise<void> {
  const t0 = performance.now();
  console.log(
    `lnkdrp MCP e2e -> ${MCP_URL} (configured org ${ORG_ID}, client ${CLIENT_INFO.name}/${CLIENT_INFO.version}) · ${describePacing(PACING)}`,
  );

  let keyId: string | null = null;
  let plaintext: string | null = null;
  let client: Client | null = null;
  let transport: StreamableHTTPClientTransport | null = null;
  let docId: string | null = null;
  let shareUrl: string | null = null;
  let status: string | null = null;
  /**
   * Tags this run creates, deleted in `finally`. No API deletes a tag for a bearer credential
   * (`DELETE /api/tags/:id` refuses keys), so every run used to leave a zero-count "E2E <stamp>"
   * tag in the workspace; the coverage doc counted thirty of them. The rows go straight out of
   * Mongo, the same way the key is minted and revoked.
   */
  const createdTags: string[] = [];

  try {
    // 0. Fail fast with a useful message when the server is not running (before minting a key).
    await step("MCP server is reachable (GET /healthz)", async () => {
      const healthz = new URL(MCP_URL);
      healthz.pathname = healthz.pathname.replace(/\/mcp\/?$/, "") + "/healthz";
      let res: Response;
      try {
        res = await fetch(healthz, { signal: AbortSignal.timeout(5_000) });
      } catch (err) {
        throw new AssertionError(`cannot reach ${healthz} (${err instanceof Error ? err.message : String(err)}); start it with \`npm run mcp\` or set MCP_URL`);
      }
      assert(res.ok, `GET ${healthz} returned HTTP ${res.status}`);
      const body = (await res.json().catch(() => null)) as { ok?: boolean; sessions?: number; confirmations?: string } | null;
      assert(body?.ok === true, `healthz body is not { ok: true }: ${JSON.stringify(body)}`);
      /**
       * Whether this server will stop and ask before a destructive call.
       *
       * LNKDRP_SKIP_CONFIRMATIONS turns the gate off against a dev database, which is the right
       * setting for a testing machine and the wrong one for asserting that the gate works. Without
       * reading it here, the two confirmation steps below fail with "the confirmation gate is not
       * enforced" - which is true, and says nothing about the code under test.
       */
      confirmationsEnforced = body?.confirmations !== "skipped";
      info("healthz", body);
    });

    // 1. Temporary key straight from the service layer (never printed).
    plaintext = await step("connect to Mongo and mint a temporary API key", async () => {
      await connectMongo();
      // Which workspace, decided against the database before anything is written for it. Printed
      // because the answer can differ from the header line above: that one names what was configured,
      // this one names what the run is actually acting in.
      const workspace = await resolveWorkspace();
      ORG_ID = workspace.orgId;
      USER_ID = workspace.userId;
      info(
        "workspace",
        `${workspace.orgName ?? "(unnamed)"} · org ${ORG_ID} · owner ${USER_ID}` +
          (workspace.discovered ? " (discovered: the configured ids are not an active membership in this database)" : ""),
      );
      const created = await createApiKey({ orgId: ORG_ID, userId: USER_ID, name: `e2e ${new Date().toISOString()}`, scopes: ["read", "write"] });
      keyId = created.key.id;
      info("key", `${created.key.prefix}… (id ${created.key.id})`);
      return created.plaintext;
    });
    const keyPrefix = apiKeyPrefix(plaintext);

    // Headroom before anything else: this run creates two documents (the second only after the
    // first is released), and the Free cap counts shared documents. Failing here with the number
    // is worth more than failing at step 20 with a plan_limit that reads like a broken tool.
    await step("the workspace has room for a document", async () => {
      const health = await fetch(new URL(MCP_URL).origin + "/healthz", { signal: AbortSignal.timeout(10_000) })
        .then((r) => (r.ok ? (r.json() as Promise<{ apiUrl?: string }>) : null))
        .catch(() => null);
      const apiUrl = (health?.apiUrl ?? "").replace(/\/+$/, "");
      if (!apiUrl) return info("plan", "MCP server did not report its apiUrl; continuing");
      const res = await fetch(`${apiUrl}/api/plan`, {
        headers: { Authorization: `Bearer ${plaintext}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return info("plan", `could not read (HTTP ${res.status}); continuing`);
      const plan = (await res.json()) as { plan?: string; usage?: { documents?: number }; limits?: { documents?: number | null } };
      const used = plan.usage?.documents ?? 0;
      const max = plan.limits?.documents ?? null;
      info("documents", `${used}${max === null ? " (no cap)" : ` of ${max}`} · plan ${plan.plan ?? "?"}`);
      assert(
        max === null || used < max,
        `this workspace is already sharing ${used} of ${max} documents, so the run cannot create one. ` +
          `Archive a document, or point E2E_ORG_ID at a workspace with a free slot.`,
      );
    });

    // 2. Bad key first: the server must reject the session at initialize with HTTP 401.
    await step("initialize with an unknown key is rejected with HTTP 401", async () => {
      const bad = makeClient(BAD_KEY);
      let thrown: unknown = null;
      try {
        await bad.client.connect(bad.transport);
      } catch (err) {
        thrown = err;
      } finally {
        await closeQuietly(bad.client, bad.transport);
      }
      assert(thrown, "connect() with a bad key resolved instead of throwing");
      const is401 = (thrown instanceof StreamableHTTPError && thrown.code === 401) || /\b401\b/.test(String((thrown as Error).message ?? thrown));
      assert(is401, `expected an HTTP 401 error, got: ${String((thrown as Error).message ?? thrown)}`);
    });

    // 3. Real session.
    ({ client, transport } = makeClient(plaintext));
    const live = client;
    await step("initialize (Streamable HTTP, bearer key)", async () => {
      await live.connect(transport as StreamableHTTPClientTransport);
      const server = live.getServerVersion();
      assert(server?.name, "server did not report its name in initialize");
      info("server", `${server.name}@${server.version ?? "?"} session ${transport?.sessionId ?? "(stateless)"}`);
    });

    // 4. Tool catalogue.
    await step(`listTools exposes the ${EXPECTED_TOOLS.length} lnkdrp tools`, async () => {
      const { tools } = await live.listTools();
      const names = tools.map((t) => t.name);
      for (const expected of EXPECTED_TOOLS) assert(names.includes(expected), `missing tool ${expected}; got ${names.join(", ")}`);
      /**
       * Both directions, which is the half that was missing.
       *
       * The old check only asked whether every expected tool was present, so three tag tools
       * shipped, the list stayed at thirty, and this step passed while announcing the wrong count -
       * and skipped the description and schema assertions for exactly the tools nobody had listed.
       * A new tool with no description now fails here instead of arriving unnoticed.
       */
      const unexpected = names.filter((n) => !EXPECTED_TOOLS.includes(n as (typeof EXPECTED_TOOLS)[number]));
      assert(
        unexpected.length === 0,
        `the server exposes ${names.length} tools but EXPECTED_TOOLS lists ${EXPECTED_TOOLS.length}; add these: ${unexpected.join(", ")}`,
      );
      for (const t of tools) {
        assert(t.description && t.description.length > 0, `${t.name} has no description`);
        assert(t.inputSchema, `${t.name} has no inputSchema`);
      }
      info("tools", names);
    });

    // 5. whoami: the key maps to our org and the client name from initialize is attributed.
    await step("lnkdrp_whoami reports our workspace and client", async () => {
      const me = await callTool<WhoAmI>(live, "lnkdrp_whoami", {});
      assert(me.orgId === ORG_ID, `whoami.orgId ${me.orgId} !== ${ORG_ID}`);
      assert(me.userId === USER_ID, `whoami.userId ${me.userId} !== ${USER_ID}`);
      assert(me.keyPrefix === keyPrefix, `whoami.keyPrefix ${me.keyPrefix} !== ${keyPrefix}`);
      // The API title-cases the client id ("lnkdrp-e2e" -> "Lnkdrp E2e"); compare loosely.
      const clientId = String(me.client ?? "").toLowerCase().replace(/\s+/g, "-");
      assert(clientId === CLIENT_INFO.name, `whoami.client "${me.client}" does not identify ${CLIENT_INFO.name}`);
      info("workspace", `${me.orgName ?? "(unnamed)"} plan=${me.plan} scopes=${me.scopes?.join(",")} client="${me.client}" mcpVersion=${me.mcpVersion ?? "?"}`);
    });

    // 5b. whoami costs come from the app's credit schedule, not a copy - and each row advertises
    // only the levels the product can actually run it at. The summary is pinned to basic by every
    // path that runs one, so three summary prices on the wire is three prices an agent can budget
    // against and be charged something else for; that is what `levels: []` rules out.
    await step("lnkdrp_whoami costs equal creditsForRun, with only pickable levels advertised", async () => {
      const me = await callTool<WhoAmICredits>(live, "lnkdrp_whoami", {});
      const tiers = ["basic", "standard", "advanced"] as const;
      const perTier = (actionType: "summary" | "history" | "brief") =>
        Object.fromEntries(tiers.map((qualityTier) => [qualityTier, creditsForRun({ actionType, qualityTier })]));
      const summaryBasic = creditsForRun({ actionType: "summary", qualityTier: "basic" });
      const briefBasic = creditsForRun({ actionType: "brief", qualityTier: "basic" });
      const flat = (credits: number) => ({ basic: credits, standard: credits, advanced: credits });
      const rows: Array<[string, AdvertisedCost | undefined, AdvertisedCost]> = [
        ["summary", me.costs?.summary, { levels: [], perLevel: flat(summaryBasic), credits: summaryBasic }],
        ["compare", me.costs?.compare, { levels: [...tiers], perLevel: perTier("history"), credits: null }],
        ["brief", me.costs?.brief, { levels: [], perLevel: flat(briefBasic), credits: briefBasic }],
      ];
      for (const [name, got, want] of rows) {
        assert(JSON.stringify(got) === JSON.stringify(want), `whoami.costs.${name} ${JSON.stringify(got)} !== ${JSON.stringify(want)}`);
      }
      assert(me.creditsRemaining === null || typeof me.creditsRemaining === "number", "whoami.creditsRemaining is neither a number nor null");
      assert(typeof me.onDemand === "boolean", "whoami.onDemand is not a boolean");
      info("credits", `costs=${JSON.stringify(me.costs)} remaining=${String(me.creditsRemaining)} resetAt=${String(me.creditsResetAt)} onDemand=${String(me.onDemand)}`);
    });

    // 5c. capabilities: "what can I do here", answerable without triggering a single plan_limit.
    await step("lnkdrp_whoami.capabilities answers 'what can I do here' up front", async () => {
      const me = await callTool<WhoAmICredits>(live, "lnkdrp_whoami", {});
      const caps = me.capabilities;
      assert(caps && typeof caps === "object", "whoami.capabilities missing");
      assert(caps!.links?.limited === false, "capabilities.links.limited must be false — links are never capped");
      // Project links are the one link-create a plan can refuse, so the agent must be able to learn
      // that before it tries: a missing key is indistinguishable from "not gated".
      assert(caps!.projectLinks?.proOnly === true, "capabilities.projectLinks.proOnly must be true — project links are Pro only");
      assert(typeof caps!.projectLinks?.available === "boolean", "capabilities.projectLinks.available is not a boolean");
      for (const key of ["documents", "projects"] as const) {
        const c = caps![key];
        assert(c === null || (c && typeof c.used === "number" && (c.limit === null || typeof c.limit === "number")), `capabilities.${key} malformed: ${JSON.stringify(c)}`);
        if (c && typeof c.limit === "number") assert(c.remaining === Math.max(0, c.limit - c.used), `capabilities.${key}.remaining does not match limit - used`);
      }
      assert(typeof caps!.deepAnalytics === "boolean", "capabilities.deepAnalytics is not a boolean");
      assert(typeof caps!.recipientsCanBrowseVersions === "boolean", "capabilities.recipientsCanBrowseVersions is not a boolean");
      assert(Array.isArray(caps!.notMcpAccessible) && caps!.notMcpAccessible!.length > 0, "capabilities.notMcpAccessible is empty or missing");
      for (const f of caps!.notMcpAccessible!) assert(typeof f.feature === "string" && typeof f.reason === "string", `notMcpAccessible entry malformed: ${JSON.stringify(f)}`);
      const named = new Set(caps!.notMcpAccessible!.map((f) => f.feature));
      assert(named.has("requestRepos") && named.has("downloadAccessRequests"), `notMcpAccessible missing an expected feature: ${JSON.stringify([...named])}`);
      // The project tools exist now, so listing project management as uncovered would be a lie.
      assert(!named.has("projectManagement"), `notMcpAccessible still names projectManagement: ${JSON.stringify([...named])}`);
      info("capabilities", caps);
    });

    // 5c. Discovery, before anything is created: the list and the feed both answer with the
    // route's shape, and the feed's `who: "agents"` filter returns only API/MCP-attributed rows.
    await step("lnkdrp_list_docs pages the workspace and honours ids", async () => {
      const first = await callTool<DocsPage>(live, "lnkdrp_list_docs", { limit: 2 });
      assert(first.page === 1 && first.limit === 2, `list_docs page/limit ${first.page}/${first.limit}`);
      assert(Array.isArray(first.docs) && first.docs.length <= 2, "list_docs returned more than limit");
      assert(first.total >= first.docs.length, "list_docs total < docs on page");
      assert(first.hasMore === (first.docs.length > 0 && first.total > 2), `list_docs hasMore=${first.hasMore} with total=${first.total}`);
      if (first.docs.length > 0) {
        const one = first.docs[0]!;
        const byId = await callTool<DocsPage>(live, "lnkdrp_list_docs", { ids: [one.docId] });
        assert(byId.docs.length === 1 && byId.docs[0]!.docId === one.docId, "list_docs ids lookup did not return exactly that doc");
        const t = one.title as { _source?: string } | null;
        assert(t === null || t._source === "document", "list_docs title is not wrapped as untrusted document text");
      }
      info("docs", `total=${first.total} first=${first.docs.map((d) => d.docId).join(",")}`);
    });

    await step("lnkdrp_get_activity pages the feed and who=agents is attributed", async () => {
      const page = await callTool<ActivityPage>(live, "lnkdrp_get_activity", { limit: 5 });
      assert(Array.isArray(page.items) && page.items.length <= 5, "get_activity returned more than limit");
      for (const it of page.items) assert(typeof it.type === "string" && typeof it.at === "string", `activity row ${it.id} lacks type/at`);
      // whoami above was recorded as agent.connected by this very key, so the agents filter cannot be empty.
      const agents = await callTool<ActivityPage>(live, "lnkdrp_get_activity", { who: "agents", limit: 5 });
      assert(agents.items.length > 0, "who=agents returned nothing although this client just connected");
      for (const it of agents.items) assert(it.agent !== null, `who=agents row ${it.id} (${it.type}) has no agent attribution`);
      const typed = await callTool<ActivityPage>(live, "lnkdrp_get_activity", { types: ["agent.connected"], limit: 3 });
      for (const it of typed.items) assert(it.type === "agent.connected", `types filter leaked ${it.type}`);
      if (page.nextCursor) {
        const next = await callTool<ActivityPage>(live, "lnkdrp_get_activity", { limit: 5, cursor: page.nextCursor });
        const seen = new Set(page.items.map((i) => i.id));
        for (const it of next.items) assert(!seen.has(it.id), `cursor page repeated ${it.id}`);
      }
      info("activity", `first=${page.items.map((i) => i.type).join(",")} agents=${agents.items.length} cursor=${page.nextCursor ? "yes" : "none"}`);
    });

    // 6. share_pdf: create doc + upload + import + process, wait for ready.
    const idempotencyKey = `e2e-${randomUUID()}`;
    const shared = await step(`lnkdrp_share_pdf (waitForReady, timeout ${TIMEOUT_SECONDS}s)`, async () => {
      const t = performance.now();
      const res = await callTool<SharePdfResult>(live, "lnkdrp_share_pdf", {
        idempotencyKey,
        title: "MCP e2e",
        sourceUrl: PDF_URL,
        waitForReady: true,
        timeoutSeconds: TIMEOUT_SECONDS,
      });
      assert(typeof res.docId === "string" && res.docId.length > 0, "share_pdf returned no docId");
      assert(typeof res.shareId === "string" && res.shareId.length > 0, "share_pdf returned no shareId");
      assert(typeof res.shareUrl === "string" && res.shareUrl.endsWith(`/s/${res.shareId}`), `share_pdf.shareUrl "${res.shareUrl}" does not end with /s/${res.shareId}`);
      assert(res.replaceUrl === null, "share_pdf.replaceUrl must be null (not minted by the MCP server)");
      assert(typeof res.status === "string", "share_pdf returned no status");
      docId = res.docId;
      shareUrl = res.shareUrl;
      status = res.status;
      info("doc", `${res.docId} share ${res.shareId} upload ${res.uploadId} v${res.version}`);
      info("status", `${res.status} after ${ms(t)}${res.status === "ready" ? "" : "  <-- not ready; processing may be slow or failed locally"}`);
      info("shareUrl", res.shareUrl);
      if (res.planWarning) info("planWarning", res.planWarning);
      return res;
    });
    createdDocs.push({ docId: shared.docId, origin: new URL(shared.shareUrl).origin });

    // 6b. share_pdf always reports AI outcome warnings (possibly empty) once processing finished.
    await step("lnkdrp_share_pdf result has a warnings array", async () => {
      const ai = shared as unknown as SharePdfAiFields;
      assert(Array.isArray(ai.warnings), `share_pdf.warnings is not an array: ${JSON.stringify(ai.warnings)}`);
      assert(ai.warnings.every((w) => typeof w === "string"), "share_pdf.warnings contains a non-string");
      assert(ai.creditsRemaining === undefined || typeof ai.creditsRemaining === "number", "share_pdf.creditsRemaining is not a number");
      info("warnings", ai.warnings);
      if (ai.creditsRemaining !== undefined) info("creditsRemaining", ai.creditsRemaining);
    });

    // 7. get_share by docId.
    await step("lnkdrp_get_share by docId", async () => {
      const s = await callTool<GetShareResult>(live, "lnkdrp_get_share", { docId: shared.docId });
      assert(s.docId === shared.docId, `get_share.docId ${s.docId} !== ${shared.docId}`);
      assert(s.shareId === shared.shareId, `get_share.shareId ${s.shareId} !== ${shared.shareId}`);
      assert(s.shareUrl === shared.shareUrl, `get_share.shareUrl ${s.shareUrl} !== ${shared.shareUrl}`);
      assert(isUntrusted(s.title), "get_share.title is not wrapped as untrusted content");
      assert(s.title.text === "MCP e2e", `get_share.title.text "${s.title.text}" !== "MCP e2e"`);
      assert(s.title._source === "document", `get_share.title._source "${s.title._source}" !== "document"`);
      assert(typeof s.shareEnabled === "boolean", "get_share.shareEnabled missing");
      assert(typeof s.shareAllowPdfDownload === "boolean", "get_share.shareAllowPdfDownload missing");
      assert(typeof s.sharePasswordEnabled === "boolean", "get_share.sharePasswordEnabled missing");
      assert(!("sharePasswordHash" in s), "get_share leaks sharePasswordHash");
      status = s.status;
      info("share", `status=${s.status} enabled=${s.shareEnabled} download=${s.shareAllowPdfDownload} password=${s.sharePasswordEnabled} history=${s.shareAllowRevisionHistory} oneLiner=${s.oneLiner ? JSON.stringify(s.oneLiner.text.slice(0, 80)) : "null"}`);
    });

    // 8. set_share_access: turn downloads on.
    await step("lnkdrp_set_share_access { allowDownload: true }", async () => {
      const s = await callTool<GetShareResult>(live, "lnkdrp_set_share_access", {
        idempotencyKey: `e2e-access-${randomUUID()}`,
        docId: shared.docId,
        allowDownload: true,
      });
      assert(s.docId === shared.docId, `set_share_access.docId ${s.docId} !== ${shared.docId}`);
      assert(s.shareAllowPdfDownload === true, `set_share_access.shareAllowPdfDownload is ${String(s.shareAllowPdfDownload)}, expected true`);
      info("share", `download=${s.shareAllowPdfDownload} enabled=${s.shareEnabled}`);
    });

    // 9. get_share_stats.
    await step("lnkdrp_get_share_stats { docId }", async () => {
      const st = await callTool<ShareStatsResult>(live, "lnkdrp_get_share_stats", { docId: shared.docId });
      assert(st.docId === shared.docId, `stats.docId ${st.docId} !== ${shared.docId}`);
      assert(st.shareId === shared.shareId, `stats.shareId ${st.shareId} !== ${shared.shareId}`);
      assert(typeof st.days === "number" && st.days >= 1, `stats.days invalid: ${String(st.days)}`);
      assert(st.totals && typeof st.totals === "object", "stats.totals missing");
      for (const k of ["views", "downloads", "pagesViewed", "authenticatedViewers", "anonymousViewers"] as const) {
        assert(typeof st.totals[k] === "number", `stats.totals.${k} is not a number`);
      }
      assert(Array.isArray(st.series), "stats.series is not an array");
      assert(typeof st.analyticsTier === "string", "stats.analyticsTier missing");
      assert(!("viewers" in st) || Array.isArray(st.viewers), "stats.viewers present but not an array");
      info("stats", `days=${st.days} tier=${st.analyticsTier} views=${st.totals.views} downloads=${st.totals.downloads} viewerCount=${st.viewerCount} series=${st.series.length}`);
    });

    // 9b. The stored visit briefs, on request. A document shared seconds ago has no finished
    // sittings, so the assertion is about the shape and the tier rule: an array on Pro (possibly
    // empty), and the key absent — never `[]` — on Free, so an agent can tell the two apart.
    await step("lnkdrp_get_share_stats { docId, includeVisits } returns recentVisits on the deep tier only", async () => {
      const st = await callTool<ShareStatsResult & { recentVisits?: unknown }>(live, "lnkdrp_get_share_stats", {
        docId: shared.docId,
        includeVisits: true,
        visitsLimit: 5,
      });
      if (st.analyticsTier === "deep") {
        assert(Array.isArray(st.recentVisits), "recentVisits missing on the deep tier with includeVisits");
        for (const raw of st.recentVisits as unknown[]) {
          const v = raw as Record<string, unknown>;
          assert(typeof v.id === "string", "recentVisits[].id missing");
          assert(v.status === "briefed" || v.status === "recap" || v.status === "failed", `recentVisits[].status unexpected: ${String(v.status)}`);
          assert(typeof v.timeSpentMs === "number", "recentVisits[].timeSpentMs is not a number");
          assert(v.brief === null || (typeof v.brief === "object" && v.brief !== null), "recentVisits[].brief is neither null nor an object");
        }
        info("recentVisits", `${(st.recentVisits as unknown[]).length} finished sittings on a document shared this run`);
      } else {
        assert(!("recentVisits" in st), "recentVisits must be absent on the basic tier, not an empty array");
        info("recentVisits", "absent on the basic tier, as specified");
      }
    });

    // 10. Idempotent replay: same key => same doc, nothing new created.
    await step("lnkdrp_share_pdf replay with the same idempotencyKey returns the same doc", async () => {
      const again = await callTool<SharePdfResult>(live, "lnkdrp_share_pdf", {
        idempotencyKey,
        title: "MCP e2e",
        sourceUrl: PDF_URL,
        waitForReady: false,
      });
      assert(again.docId === shared.docId, `replay created a different doc: ${again.docId} !== ${shared.docId}`);
      assert(again.shareId === shared.shareId, `replay returned a different shareId: ${again.shareId} !== ${shared.shareId}`);
      info("docId", again.docId);
    });

    // 10b. replace_pdf: a new version on the same document, same shareId, same link.
    const replaceKey = `e2e-replace-${randomUUID()}`;
    const replaced = await step(`lnkdrp_replace_pdf (waitForReady, timeout ${TIMEOUT_SECONDS}s)`, async () => {
      const t = performance.now();
      const res = await callTool<ReplacePdfResult>(live, "lnkdrp_replace_pdf", {
        idempotencyKey: replaceKey,
        docId: shared.docId,
        sourceUrl: PDF_URL,
        waitForReady: true,
        timeoutSeconds: TIMEOUT_SECONDS,
      });
      assert(res.docId === shared.docId, `replace_pdf created or targeted a different doc: ${res.docId} !== ${shared.docId}`);
      assert(res.shareId === shared.shareId, `replace_pdf changed the shareId: ${res.shareId} !== ${shared.shareId}`);
      assert(res.shareUrl === shared.shareUrl, `replace_pdf changed the shareUrl: ${res.shareUrl} !== ${shared.shareUrl}`);
      assert(res.version > shared.version, `replace_pdf.version ${res.version} is not greater than the original ${shared.version}`);
      assert(typeof res.status === "string", "replace_pdf returned no status");
      info("doc", `${res.docId} share ${res.shareId} upload ${res.uploadId} v${res.version} (was v${shared.version})`);
      info("status", `${res.status} after ${ms(t)}`);
      return res;
    });

    // 10c. Idempotent replay: same key => same result, no second replacement.
    await step("lnkdrp_replace_pdf replay with the same idempotencyKey returns the same result", async () => {
      const again = await callTool<ReplacePdfResult>(live, "lnkdrp_replace_pdf", {
        idempotencyKey: replaceKey,
        docId: shared.docId,
        sourceUrl: PDF_URL,
        waitForReady: false,
      });
      assert(again.version === replaced.version, `replay produced a different version: ${again.version} !== ${replaced.version}`);
      assert(again.uploadId === replaced.uploadId, `replay produced a different upload: ${again.uploadId} !== ${replaced.uploadId}`);
    });

    // 10d. An unknown docId refuses with not_found, and creates nothing.
    await step("lnkdrp_replace_pdf with an unknown docId refuses with not_found", async () => {
      let thrown: unknown = null;
      try {
        await callTool<ReplacePdfResult>(live, "lnkdrp_replace_pdf", {
          idempotencyKey: `e2e-replace-404-${randomUUID()}`,
          docId: "c".repeat(24),
          sourceUrl: PDF_URL,
          waitForReady: false,
        });
      } catch (err) {
        thrown = err;
      }
      assert(thrown instanceof ToolCallError, "expected a ToolCallError for an unknown docId");
      assert((thrown as ToolCallError).code === "not_found", `expected code not_found, got ${(thrown as ToolCallError).code}`);
    });

    // 10e. fileBase64: mt_bJwX4CtmhU. Through replace_pdf, not share_pdf — it exercises the same
    // shared resolvePdfSource() and costs no document slot on a workspace already at its cap.
    await step("lnkdrp_replace_pdf accepts fileBase64 instead of sourceUrl", async () => {
      const pdfBytes = Buffer.from(await (await fetch(PDF_URL)).arrayBuffer());
      const res = await callTool<ReplacePdfResult>(live, "lnkdrp_replace_pdf", {
        idempotencyKey: `e2e-replace-bytes-${randomUUID()}`,
        docId: shared.docId,
        fileBase64: pdfBytes.toString("base64"),
        fileName: "e2e-inline.pdf",
        waitForReady: true,
        timeoutSeconds: TIMEOUT_SECONDS,
      });
      assert(res.docId === shared.docId, `fileBase64 replace targeted a different doc: ${res.docId} !== ${shared.docId}`);
      assert(res.version > replaced.version, `fileBase64 replace version ${res.version} is not greater than the prior ${replaced.version}`);
      info("doc", `${res.docId} upload ${res.uploadId} v${res.version} status ${res.status}`);
    });

    // 10f. sourceUrl and fileBase64 are mutually exclusive; neither given is equally invalid.
    await step("lnkdrp_replace_pdf refuses both or neither of sourceUrl/fileBase64", async () => {
      for (const args of [
        { sourceUrl: PDF_URL, fileBase64: "AAAA" },
        {},
      ]) {
        let thrown: unknown = null;
        try {
          await callTool<ReplacePdfResult>(live, "lnkdrp_replace_pdf", {
            idempotencyKey: `e2e-replace-exclusivity-${randomUUID()}`,
            docId: shared.docId,
            waitForReady: false,
            ...args,
          });
        } catch (err) {
          thrown = err;
        }
        assert(thrown instanceof ToolCallError, `expected a ToolCallError for args ${JSON.stringify(args)}`);
        assert((thrown as ToolCallError).code === "validation", `expected code validation, got ${(thrown as ToolCallError).code} for ${JSON.stringify(args)}`);
      }
    });

    // 11. A second link on the same document, labelled for one recipient, with downloads on.
    // An invented firm, like the seeds use: this harness writes into a real workspace and its
    // labels surface in the activity feed, which is what the product screenshots photograph.
    // It is also deliberately not one of the seed corpus's firms, so the workspace-wide
    // `find_share_link` query below has exactly one thing it can match.
    // 10f. Revisions: the replacement above must now be readable as history, as a diff, and as a tally.
    await step("lnkdrp_list_revisions { docId } lists the replacement, newest first", async () => {
      const page = await callTool<{ items: Array<{ docId: string; toVersion: number | null; fromVersion: number | null; by: { userId: string } | null; summary: unknown }>; nextCursor: string | null; since: string | null }>(
        live,
        "lnkdrp_list_revisions",
        { docId: shared.docId, since: "24h" },
      );
      assert(Array.isArray(page.items) && page.items.length >= 1, "list_revisions returned no rows for a document that was just replaced");
      const top = page.items[0]!;
      assert(top.docId === shared.docId, `list_revisions row is about ${top.docId}, not ${shared.docId}`);
      // The fileBase64 step (10e) replaced once more after `replaced`, so the newest row is a later
      // version; what must hold is the order and that the replacement above is in the list.
      assert((top.toVersion ?? 0) >= replaced.version, `newest revision is v${top.toVersion}, older than the v${replaced.version} replacement`);
      const versions = page.items.map((it) => it.toVersion ?? 0);
      assert(versions.every((v, i) => i === 0 || v < versions[i - 1]!), `rows are not newest first: ${versions.join(",")}`);
      assert(versions.includes(replaced.version), `the v${replaced.version} replacement is missing from ${versions.join(",")}`);
      assert(top.by?.userId === USER_ID, `revision is attributed to ${top.by?.userId ?? "nobody"}, expected the key owner`);
      assert(typeof page.since === "string", "since was not echoed back");
      // Workspace-wide, the same row must appear without a docId.
      const all = await callTool<{ items: Array<{ docId: string; toVersion: number | null }> }>(live, "lnkdrp_list_revisions", { since: "24h", limit: 50 });
      assert(all.items.some((it) => it.docId === shared.docId && it.toVersion === replaced.version), "the workspace-wide list does not include this replacement");
      info("revisions", `${page.items.length} for the doc, ${all.items.length} in the workspace since 24h`);
    });

    await step("lnkdrp_get_revision { docId, version } explains the diff, and v1 has no record", async () => {
      const rev = await callTool<{ toVersion: number; fromVersion: number | null; summary: unknown; changes: unknown[]; pagesThatChanged: unknown[]; compare: { state: string | null; unchangedFromPrevious: boolean }; file: { toPages: number | null } }>(
        live,
        "lnkdrp_get_revision",
        { docId: shared.docId, version: replaced.version },
      );
      assert(rev.toVersion === replaced.version, `get_revision returned v${rev.toVersion}`);
      assert(Array.isArray(rev.changes) && Array.isArray(rev.pagesThatChanged), "get_revision is missing changes/pagesThatChanged arrays");
      assert(rev.compare && typeof rev.compare.unchangedFromPrevious === "boolean", "get_revision.compare is missing");
      // The same file was uploaded twice, so the compare either found nothing or was skipped as unchanged; both are honest.
      info("revision", `v${rev.fromVersion}->v${rev.toVersion} compare=${rev.compare.state ?? "-"} unchanged=${rev.compare.unchangedFromPrevious} changes=${rev.changes.length}`);
      let thrown: unknown = null;
      try {
        await callTool(live, "lnkdrp_get_revision", { docId: shared.docId, version: 2, includeText: false });
        // v2 exists here; ask for a version that cannot: one past the current.
        await callTool(live, "lnkdrp_get_revision", { docId: shared.docId, version: replaced.version + 50 });
      } catch (err) {
        thrown = err;
      }
      assert(thrown instanceof ToolCallError && thrown.code === "not_found", "a version that does not exist should be not_found");
    });

    await step("lnkdrp_revision_contributors names the key owner as the one who replaced it", async () => {
      const who = await callTool<{ totalReplacements: number; contributors: Array<{ userId: string | null; replacements: number }>; agents: Array<{ client: string; replacements: number }> }>(
        live,
        "lnkdrp_revision_contributors",
        { docId: shared.docId, since: "24h" },
      );
      assert(who.totalReplacements >= 1, "no replacements counted for a document that was just replaced");
      const me = who.contributors.find((c) => c.userId === USER_ID);
      assert(me && me.replacements >= 1, "the key owner is not among the contributors");
      assert(Array.isArray(who.agents), "agents tally missing");
      info("contributors", `${who.contributors.length} member(s), agents: ${who.agents.map((a) => `${a.client}:${a.replacements}`).join(", ") || "none"}`);
    });

    const extra = await step('lnkdrp_create_share_link { label: "Vantridge", allowDownload: true }', async () => {
      const res = await callTool<CreateShareLinkResult>(live, "lnkdrp_create_share_link", {
        docId: shared.docId,
        label: "Vantridge",
        audience: "Vantridge · Pike",
        allowDownload: true,
      });
      assert(res.link && typeof res.link.id === "string", "create_share_link returned no link");
      assert(res.link.shareId !== shared.shareId, "create_share_link reused the default link's shareId");
      assert(res.link.label === "Vantridge", `create_share_link.label "${res.link.label}" !== "Vantridge"`);
      assert(res.link.allowDownload === true, "create_share_link ignored allowDownload");
      assert(res.link.isDefault === false, "create_share_link marked the new link as the default one");
      assert(res.shareUrl.endsWith(`/s/${res.link.shareId}`), `create_share_link.shareUrl "${res.shareUrl}" does not end with /s/${res.link.shareId}`);
      if (res.planWarning) info("planWarning", res.planWarning);
      info("link", `${res.link.id} ${res.link.shareId} status=${res.link.status}`);
      info("shareUrl", res.shareUrl);
      return res;
    });

    // 12b. Links are not plan-capped (1ce4413): a Free workspace may carry any number of links per
    // document, so `lnkdrp_create_share_link` always returns the link enabled and `planWarning` can
    // only be a heads-up that the workspace is near its *document* cap. This branch therefore does
    // not fire from a cap any more. It stays as a guard against a future regression: if a link ever
    // comes back disabled with a planWarning again, the lifecycle below would otherwise run on a
    // dead link and pass, and this is the step that would make it fail loudly instead.
    //
    // It used to read "the active-link cap counts every enabled link" — the wording of the bug
    // that made a two-document workspace report "11 of 3". A comment that still says links are
    // capped is how that cap gets wired back in.
    let defaultLinkLive = true;
    if (extra.planWarning && extra.link.enabled === false) {
      await step("REGRESSION: a link came back disabled at a plan cap; links must never be capped", async () => {
        const list = await callTool<ListShareLinksResult>(live, "lnkdrp_list_share_links", { docId: shared.docId });
        const def = list.links.find((l) => l.isDefault);
        assert(def, "the document has no default link");
        await callTool<CreateShareLinkResult>(live, "lnkdrp_update_share_link", { docId: shared.docId, linkId: def.id, enabled: false });
        defaultLinkLive = false;
        const on = await callTool<CreateShareLinkResult>(live, "lnkdrp_update_share_link", { docId: shared.docId, linkId: extra.link.id, enabled: true });
        assert(on.link.enabled === true, "the new link could not be enabled after freeing a slot");
        info("links", `default=off ${on.link.label}=${on.link.status}`);
      });
    }

    // 13. The document now lists two links, the default one first.
    await step("lnkdrp_list_share_links shows both links, default first", async () => {
      const res = await callTool<ListShareLinksResult>(live, "lnkdrp_list_share_links", { docId: shared.docId });
      assert(Array.isArray(res.links), "list_share_links.links is not an array");
      assert(res.links.length === 2, `expected 2 links, got ${res.links.length}`);
      assert(res.links[0]?.isDefault === true, "the default link is not listed first");
      assert(res.links.some((l) => l.id === extra.link.id), "the new link is missing from the list");
      info("links", res.links.map((l) => `${l.label}${l.isDefault ? " (default)" : ""}=${l.status}`).join(", "));
    });

    // 13b. lnkdrp_list_share_links's query scopes the search to this document — mt_9ceLy7DqEr.
    await step('lnkdrp_list_share_links { query: "Vantridge" } returns only that link', async () => {
      const res = await callTool<ListShareLinksResult>(live, "lnkdrp_list_share_links", { docId: shared.docId, query: "Vantridge" });
      assert(res.links.length === 1, `expected exactly 1 match for "Vantridge", got ${res.links.length}`);
      assert(res.links[0]?.id === extra.link.id, "the scoped search matched the wrong link");
    });

    // 13c. lnkdrp_find_share_link: the actual gap this closes — find the link without already
    // knowing which document it is on. Full-text, so this only works after the write above is
    // visible to the sharelinks text index, which Mongo updates synchronously with the write.
    await step('lnkdrp_find_share_link { query: "Vantridge" } finds it without a docId', async () => {
      const res = await callTool<FindShareLinkResult>(live, "lnkdrp_find_share_link", { query: "Vantridge" });
      assert(Array.isArray(res.links), "find_share_link.links is not an array");
      const hit = res.links.find((l) => l.linkId === extra.link.id);
      assert(hit, `"Vantridge" did not surface the link just created (got ${res.links.map((l) => l.label).join(", ")})`);
      assert(hit.docId === shared.docId, `find_share_link matched the right link on the wrong doc: ${hit.docId} !== ${shared.docId}`);
      assert(isUntrusted(hit.docTitle), "find_share_link.docTitle is not wrapped as untrusted content");
      assert(hit.docTitle.text === "MCP e2e", `find_share_link.docTitle.text "${hit.docTitle.text}" !== "MCP e2e"`);
      assert(hit.shareUrl.endsWith(`/s/${hit.shareId}`), `find_share_link.shareUrl "${hit.shareUrl}" does not end with /s/${hit.shareId}`);
      info("hit", `${hit.docTitle?.text ?? "null"} / ${hit.label} (${hit.audience})`);
    });

    // 13d. A word that matches nothing returns [], never an error.
    await step("lnkdrp_find_share_link with no match returns an empty array, not an error", async () => {
      const res = await callTool<FindShareLinkResult>(live, "lnkdrp_find_share_link", { query: `nomatch${randomUUID().replace(/-/g, "")}` });
      assert(Array.isArray(res.links) && res.links.length === 0, `expected [], got ${JSON.stringify(res.links)}`);
    });

    // 13e. mt_GOKLLvF4-v: an agent that sets a password must be able to confirm it afterwards.
    // The password is deliberately short — the 8-char minimum is gone, and a tool that refuses
    // "jeff" is the bug that locked the owner out of their own link.
    await step("lnkdrp_verify_share_password and lnkdrp_get_share_link_password confirm a password", async () => {
      await callTool(live, "lnkdrp_update_share_link", { docId: shared.docId, linkId: extra.link.id, password: "jeff" });

      /**
       * Reading a password back is forbidden to an API key since the security pass in fccecc3, and
       * every MCP connection is an API key - so this is the refusal, not the plaintext. The step
       * asserted the old contract long after the tool stopped honouring it, which is what a harness
       * nobody runs to completion looks like.
       */
      let refused: unknown = null;
      try {
        await callTool(live, "lnkdrp_get_share_link_password", { docId: shared.docId, linkId: extra.link.id });
      } catch (err) {
        refused = err;
      }
      assert(refused instanceof ToolCallError, "get_share_link_password should be forbidden to an API key");
      assert(
        (refused as ToolCallError).code === "forbidden",
        `expected code forbidden, got ${(refused as ToolCallError).code}`,
      );
      // The refusal names "a connected agent", not "an API key": the same guard answers an OAuth
      // agent, and the old wording blamed a credential the caller was not using.
      assert(
        /connected agent/.test((refused as ToolCallError).message),
        `refusal should name a connected agent, got: ${(refused as ToolCallError).message}`,
      );

      const ok = await callTool<{ matches: boolean }>(live, "lnkdrp_verify_share_password", {
        docId: shared.docId,
        linkId: extra.link.id,
        password: "jeff",
      });
      assert(ok.matches === true, "verify_share_password said the correct password does not match");

      const bad = await callTool<{ matches: boolean }>(live, "lnkdrp_verify_share_password", {
        docId: shared.docId,
        linkId: extra.link.id,
        password: "jeff-usavx-2026",
      });
      assert(bad.matches === false, "verify_share_password said a wrong password matches");

      // Leave the link open: later steps fetch it publicly and a password would 401 them.
      await callTool(live, "lnkdrp_update_share_link", { docId: shared.docId, linkId: extra.link.id, password: null });
      // Confirmed through verify, which an API key may call, rather than through the read-back it may not.
      const after = await callTool<{ passwordEnabled: boolean; opensLink: boolean }>(live, "lnkdrp_verify_share_password", {
        docId: shared.docId,
        linkId: extra.link.id,
        password: "jeff",
      });
      assert(after.passwordEnabled === false, "clearing the password did not take");
      assert(after.opensLink === true, "an open link should open for anyone once the password is cleared");
    });

    // 14. The new link resolves publicly, straight away.
    //
    // The share *page* streams, so `notFound()` reaches the client as a 200 with the not-found UI;
    // `/s/<shareId>/pdf` is a route handler and answers with a real status, so that is what the
    // refusal assertions use (both links here have downloads enabled).
    await step("GET /s/<new shareId> serves the document", async () => {
      const page = await fetch(extra.shareUrl, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
      await page.arrayBuffer();
      assert(page.status === 200, `GET ${extra.shareUrl} returned HTTP ${page.status} (expected 200)`);
      const pdf = await fetch(`${extra.shareUrl}/pdf`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      await pdf.arrayBuffer();
      assert(pdf.status === 200, `GET ${extra.shareUrl}/pdf returned HTTP ${pdf.status} (expected 200)`);
    });

    // 15b. Per-link analytics: docId + shareId reads that link alone (`?shareId=` on shareviews).
    await step("lnkdrp_get_share_stats { docId, shareId } reports the link alone", async () => {
      const st = await callTool<ShareStatsResult & { perLink?: boolean }>(live, "lnkdrp_get_share_stats", {
        docId: shared.docId,
        shareId: extra.link.shareId,
      });
      assert(st.perLink === true, "stats did not report perLink for a shareId-scoped read");
      assert(st.shareId === extra.link.shareId, `stats.shareId ${st.shareId} !== ${extra.link.shareId}`);
      assert(st.totals && typeof st.totals.views === "number", "per-link stats.totals.views missing");
      assert(Array.isArray(st.series), "per-link stats.series is not an array");
      info("stats", `perLink views=${st.totals.views} downloads=${st.totals.downloads} series=${st.series.length}`);
    });

    // 16. Disabling one link revokes that recipient only; the document's other links are untouched.
    /**
     * Settings are toggled, not merely set.
     *
     * Everything above proves a link HONOURS the value it was created with. That is a different
     * claim from "changing it takes effect", and the second is the one an owner leans on when they
     * revoke something after sending the link. Each flip below is made through the MCP and then
     * checked twice: what the tools report, and what a recipient holding the URL actually gets.
     */
    await step("allowDownload off and on again, with the download actually counted", async () => {
      const setDownload = async (allowDownload: boolean) =>
        callTool<CreateShareLinkResult>(live, "lnkdrp_update_share_link", { docId: shared.docId, linkId: extra.link.id, allowDownload });

      await setDownload(false);
      // `?download=1` with a botId is the form the viewer sends and the only one the route counts;
      // the bare path serves the file and records nothing, which once looked like a broken counter.
      const bot = randomUUID().replace(/-/g, "").slice(0, 32);
      const refused = await fetch(`${extra.shareUrl}/pdf?download=1&botId=${bot}`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      await refused.arrayBuffer();
      assert(refused.status === 403, `downloads are off but /pdf?download=1 answered ${refused.status}, expected 403`);
      const offStats = await callTool<{ downloadsEnabled?: boolean }>(live, "lnkdrp_get_share_stats", { docId: shared.docId, shareId: extra.link.shareId, days: 7 });
      assert(offStats.downloadsEnabled === false, "get_share_stats.downloadsEnabled stayed true for a link with downloads off");

      await setDownload(true);
      const served = await fetch(`${extra.shareUrl}/pdf?download=1&botId=${bot}`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      await served.arrayBuffer();
      assert(served.status === 200, `downloads are on but /pdf?download=1 answered ${served.status}, expected 200`);
      const onStats = await callTool<{ downloadsEnabled?: boolean; totals?: { downloads?: number } }>(live, "lnkdrp_get_share_stats", { docId: shared.docId, shareId: extra.link.shareId, days: 7 });
      assert(onStats.downloadsEnabled === true, "get_share_stats.downloadsEnabled stayed false after turning downloads on");
      assert((onStats.totals?.downloads ?? 0) >= 1, `the download was served but not counted (totals.downloads ${String(onStats.totals?.downloads)})`);
      info("downloads", `counted ${String(onStats.totals?.downloads)}`);
    });

    await step("a password can be set and cleared, and verify_share_password follows both ways", async () => {
      await callTool(live, "lnkdrp_update_share_link", { docId: shared.docId, linkId: extra.link.id, password: "matrix-pw" });
      const locked = await callTool<{ passwordEnabled: boolean; matches: boolean; opensLink: boolean }>(live, "lnkdrp_verify_share_password", {
        docId: shared.docId, linkId: extra.link.id, password: "matrix-pw",
      });
      assert(locked.passwordEnabled === true && locked.matches === true && locked.opensLink === true, `right password: ${JSON.stringify(locked)}`);
      const wrong = await callTool<{ matches: boolean; opensLink: boolean }>(live, "lnkdrp_verify_share_password", {
        docId: shared.docId, linkId: extra.link.id, password: "not-it",
      });
      assert(wrong.matches === false && wrong.opensLink === false, `wrong password: ${JSON.stringify(wrong)}`);
      // A gated link still answers 200 - it serves the gate, not the document.
      const gate = await fetch(extra.shareUrl, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      await gate.arrayBuffer();
      assert(gate.status === 200, `a password-gated link answered ${gate.status}, expected the gate at 200`);

      await callTool(live, "lnkdrp_update_share_link", { docId: shared.docId, linkId: extra.link.id, password: null });
      const open = await callTool<{ passwordEnabled: boolean; opensLink: boolean }>(live, "lnkdrp_verify_share_password", {
        docId: shared.docId, linkId: extra.link.id, password: "anything",
      });
      assert(open.passwordEnabled === false && open.opensLink === true, `cleared password: ${JSON.stringify(open)}`);
    });

    await step("allowRevisionHistory on and off changes what /changes serves", async () => {
      /**
       * The per-link lever, not the document one.
       *
       * `/changes` gates on `link.allowRevisionHistory`, and `lnkdrp_set_share_access` says in its
       * own description that its copy of this setting "applies to the default link only". Driving
       * the document-wide default at a link created separately therefore changes nothing the
       * recipient can see, and this step quietly fell through to its Free-plan branch instead of
       * testing anything.
       */
      const setHistory = async (allowRevisionHistory: boolean) =>
        callTool(live, "lnkdrp_update_share_link", { docId: shared.docId, linkId: extra.link.id, allowRevisionHistory });
      const changes = async () => {
        const r = await fetch(`${extra.shareUrl}/changes?limit=5`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
        await r.arrayBuffer();
        return r.status;
      };

      /**
       * On Free the write itself is refused, not merely ineffective: `version_history` is a plan
       * feature gate (planLimits.ts), so `update_share_link { allowRevisionHistory: true }` answers
       * `plan_limit` with `limit: "version_history"`. The step assumed the flag could always be set
       * and only the route would withhold, and failed on every Free workspace as soon as the gate
       * shipped. A refusal with exactly that limit is the Free branch; any other error is real.
       */
      let sharePro = true;
      try {
        await setHistory(true);
        sharePro = (await changes()) === 200;
      } catch (err) {
        const limit = (err as ToolCallError | null)?.details && ((err as ToolCallError).details as { limit?: unknown }).limit;
        if (!(err instanceof ToolCallError && err.code === "plan_limit" && limit === "version_history")) throw err;
        sharePro = false;
        info("history", "plan_limit version_history: this workspace is Free, the setting cannot be turned on");
      }
      // `ownerIsPro` is ANDed in, so on a Free workspace the route answers 403 whether the setting
      // is on or off - deliberately, so the setting and the plan are indistinguishable to a
      // recipient. The off-assertion therefore holds on every plan; the on-assertion only where
      // the plan allows it.
      await setHistory(false);
      assert(await changes() === 403, "history is off but /changes did not answer 403");
      if (sharePro) {
        await setHistory(true);
        assert(await changes() === 200, "history was turned back on but /changes stopped serving");
      } else {
        info("history", "this workspace plan withholds version history; only the off case is asserted");
      }
      await setHistory(false);
    });

    await step("set_share_access shareEnabled false takes every link down, and true brings them back", async () => {
      await callTool(live, "lnkdrp_set_share_access", { idempotencyKey: `e2e-off-${randomUUID()}`, docId: shared.docId, shareEnabled: false });
      const off = await callTool<GetShareResult & { anyLinkActive?: boolean }>(live, "lnkdrp_get_share", { docId: shared.docId });
      assert(off.anyLinkActive === false, "anyLinkActive stayed true after the document-wide switch went off");
      const down = await fetch(extra.shareUrl, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      await down.arrayBuffer();
      assert(down.status === 404, `the document-wide switch is off but the link answered ${down.status}`);

      await callTool(live, "lnkdrp_set_share_access", { idempotencyKey: `e2e-on-${randomUUID()}`, docId: shared.docId, shareEnabled: true });
      const back = await fetch(extra.shareUrl, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      await back.arrayBuffer();
      assert(back.status === 200, `the switch went back on but the link answered ${back.status}`);
    });

    await step("lnkdrp_update_share_link { enabled: false } stops the link resolving", async () => {
      const res = await callTool<CreateShareLinkResult>(live, "lnkdrp_update_share_link", {
        docId: shared.docId,
        linkId: extra.link.id,
        enabled: false,
      });
      assert(res.link.enabled === false, "update_share_link did not disable the link");
      assert(res.link.status === "disabled", `update_share_link.status is "${res.link.status}", expected "disabled"`);
      const pdf = await fetch(`${extra.shareUrl}/pdf`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      await pdf.arrayBuffer();
      assert(pdf.status === 404, `a disabled link still served ${extra.shareUrl}/pdf (HTTP ${pdf.status}, expected 404)`);
      if (defaultLinkLive) {
        const still = await fetch(`${shareUrl as string}/pdf`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
        await still.arrayBuffer();
        assert(still.status === 200, `the default link broke when the extra link was disabled (HTTP ${still.status})`);
      }
    });

    // 17a. Destructive tools confirm with the human first. This Client declares no elicitation
    // capability, so the server cannot prompt the user itself and must fall back to demanding an
    // explicit `confirm: true`. An unconfirmed call therefore has to be REFUSED — with a preview the
    // agent can show the user — and must delete nothing. This is the property that stops an agent
    // deleting a link with 30 views because it thought that was what "clean up" meant.
    await step("lnkdrp_delete_share_link without confirm is refused with a preview and deletes nothing", async () => {
      if (!confirmationsEnforced) {
        info("skipped", "this server runs with LNKDRP_SKIP_CONFIRMATIONS; the gate cannot be asserted here");
        return;
      }
      let refused: ToolCallError | null = null;
      try {
        await callTool(live, "lnkdrp_delete_share_link", { docId: shared.docId, linkId: extra.link.id });
      } catch (e) {
        if (!(e instanceof ToolCallError)) throw e;
        refused = e;
      }
      assert(refused, "an unconfirmed delete went through — the confirmation gate is not enforced");
      const d = (refused.details ?? {}) as { requiresConfirmation?: unknown; preview?: { headline?: unknown; facts?: unknown; severity?: unknown }; reversible?: unknown };
      assert(d.requiresConfirmation === true, "refusal did not carry requiresConfirmation: true");
      assert(typeof d.preview?.headline === "string" && d.preview.headline.includes(extra.link.label), "preview does not name the link");
      assert(Array.isArray(d.preview?.facts) && d.preview.facts.length > 0, "preview carries no facts for the user to weigh");
      assert(d.preview?.severity === "low", `a never-opened link should be severity low, got ${String(d.preview?.severity)}`);
      assert(d.reversible === false, "delete must be reported as irreversible");
      const still = await callTool<ListShareLinksResult>(live, "lnkdrp_list_share_links", { docId: shared.docId });
      assert(still.links.length === 2, `the refused delete removed something: ${still.links.length} links remain`);
      info("preview", `${d.preview?.headline} · severity ${String(d.preview?.severity)}`);
    });

    // 17b. With the human's yes relayed as confirm: true, the same call proceeds.
    await step("lnkdrp_delete_share_link with confirm: true leaves one link", async () => {
      const res = await callTool<{ ok: boolean; deleted?: { label?: string } }>(live, "lnkdrp_delete_share_link", {
        docId: shared.docId,
        linkId: extra.link.id,
        confirm: true,
      });
      assert(res.ok === true, "delete_share_link did not return ok");
      assert(res.deleted?.label === extra.link.label, "response does not echo what was deleted");
      const list = await callTool<ListShareLinksResult>(live, "lnkdrp_list_share_links", { docId: shared.docId });
      assert(list.links.length === 1, `expected 1 link after delete, got ${list.links.length}`);
      assert(list.links[0]?.isDefault === true, "the surviving link is not the default one");
    });

    // 17c-17h. The project-link lifecycle (docs/prds/lnkdrp-project-links.md, M5). Same shape as the
    // document-link steps above, on a throwaway project holding the document this run created, so
    // the delete preview has real contents to describe. Everything asserted here was observed
    // against the live dev API on 2026-09-17 before the steps were written.
    //
    // This is also the first live exercise of *any* project tool in this harness: the seven project
    // tools have been in EXPECTED_TOOLS (and so asserted present) since they shipped, with nothing
    // ever calling one.
    const proj = await step("lnkdrp_create_project + add the document (a throwaway data room)", async () => {
      const res = await callTool<CreateProjectResult>(live, "lnkdrp_create_project", {
        idempotencyKey: `e2e-project-${randomUUID()}`,
        name: `MCP e2e data room ${new Date().toISOString()}`,
        description: "Created by the MCP e2e run; deleted again at the end.",
      });
      assert(typeof res.project?.projectId === "string", "create_project returned no projectId");
      createdProjects.push({ projectId: res.project.projectId, origin: new URL(shared.shareUrl).origin });
      const added = await callTool<{ added: string[] }>(live, "lnkdrp_add_docs_to_project", {
        projectId: res.project.projectId,
        docIds: [shared.docId],
      });
      assert(added.added.includes(shared.docId), `the document was not added to the project: ${JSON.stringify(added)}`);
      info("project", `${res.project.projectId} (${res.project.slug})`);
      return res.project;
    });

    await step("lnkdrp_list_project_links shows the default link, materialised from the project's own shareId", async () => {
      const res = await callTool<ListProjectLinksResult>(live, "lnkdrp_list_project_links", { projectId: proj.projectId });
      assert(res.links.length === 1, `a new project should have exactly its default link, got ${res.links.length}`);
      const def = res.links[0] as ProjectLinkDTO;
      assert(def.isDefault === true, "the only link on a new project is not marked default");
      // A project link opens the project page, not a document: /p/, never /s/.
      assert(def.shareUrl.endsWith(`/p/${def.shareId}`), `project link shareUrl "${def.shareUrl}" does not end with /p/${def.shareId}`);
      assert(res.publicPageEnabled === true, "a new project's public page should be on");
      info("default link", `${def.id} ${def.shareId} status=${def.status}`);
    });

    /**
     * A second link on a project is Pro-only (`capabilities.projectLinks.available`; the gate is
     * `project_links` in planLimits.ts). The five steps below create, duplicate, update and delete
     * such a link, so on a Free workspace they are skipped as a block rather than failing at the
     * first `plan_limit`; the refusal itself is what tests/mcp/freeplan.ts asserts. Read live, not
     * from step 5c's local, so a plan change between the two is seen.
     */
    const meNow = await callTool<WhoAmI & { capabilities?: { projectLinks?: { available?: boolean } } }>(live, "lnkdrp_whoami", {});
    const projectLinksAvailable = meNow.capabilities?.projectLinks?.available === true;
    if (!projectLinksAvailable) {
      info("project links", "capabilities.projectLinks.available is false on this plan; the five second-link steps are skipped");
    } else {
    const projLink = await step('lnkdrp_create_project_link { label: "Vantridge", allowDownload: true, password }', async () => {
      const res = await callTool<CreateProjectLinkResult>(live, "lnkdrp_create_project_link", {
        projectId: proj.projectId,
        label: "Vantridge",
        audience: "Vantridge · Pike",
        allowDownload: true,
        password: "x",
      });
      assert(res.link && typeof res.link.id === "string", "create_project_link returned no link");
      assert(res.link.isDefault === false, "create_project_link marked the new link as the default one");
      assert(res.link.allowDownload === true, "create_project_link ignored allowDownload");
      // A one-character password is the owner's call and must be used verbatim (share-password-no-minimum).
      assert(res.link.passwordEnabled === true, "create_project_link did not set the password");
      assert(res.link.createdVia === "mcp", `createdVia is "${res.link.createdVia}", expected "mcp"`);
      assert(res.shareUrl.endsWith(`/p/${res.link.shareId}`), `create_project_link.shareUrl "${res.shareUrl}" is not the project page`);
      assert(!("allowRevisionHistory" in res.link), "a project link must not carry allowRevisionHistory: it has no single document");
      info("link", `${res.link.id} ${res.link.shareId} status=${res.link.status}`);
      return res.link;
    });

    await step("a duplicate label warns instead of refusing, and projectSlug resolves the same project", async () => {
      const res = await callTool<CreateProjectLinkResult>(live, "lnkdrp_create_project_link", {
        projectSlug: proj.slug,
        label: "Vantridge",
      });
      assert(res.project.projectId === proj.projectId, "projectSlug resolved to a different project than projectId did");
      assert(res.link.shareId !== projLink.shareId, "the second link reused the first one's shareId");
      assert(
        Array.isArray(res.warnings) && res.warnings.some((w) => w.includes("already has")),
        `a duplicate label should warn: ${JSON.stringify(res.warnings)}`,
      );
      // Tidy up straight away: the rest of the block reasons about a known link count.
      await callTool(live, "lnkdrp_delete_project_link", { projectId: proj.projectId, linkId: res.link.id, confirm: true });
      info("warnings", res.warnings);
    });

    await step("lnkdrp_update_project_link renames, clears the password and disables one link", async () => {
      const res = await callTool<CreateProjectLinkResult>(live, "lnkdrp_update_project_link", {
        projectId: proj.projectId,
        linkId: projLink.id,
        label: "Vantridge · diligence",
        password: null,
        enabled: false,
      });
      assert(res.link.label === "Vantridge · diligence", `update_project_link.label is "${res.link.label}"`);
      assert(res.link.passwordEnabled === false, "password: null did not clear the password");
      assert(res.link.status === "disabled", `update_project_link.status is "${res.link.status}", expected "disabled"`);
      // The project's other links are untouched: the default link still resolves.
      const list = await callTool<ListProjectLinksResult>(live, "lnkdrp_list_project_links", { projectId: proj.projectId });
      assert(list.links.find((l) => l.isDefault)?.status === "active", "disabling one link took the default link down with it");

      let refused: ToolCallError | null = null;
      try {
        await callTool(live, "lnkdrp_update_project_link", { projectId: proj.projectId, linkId: projLink.id });
      } catch (e) {
        if (!(e instanceof ToolCallError)) throw e;
        refused = e;
      }
      assert(refused?.code === "validation", "an update with no settings should be a validation error");
    });

    await step("the project's default link cannot be deleted, even with confirm: true", async () => {
      const list = await callTool<ListProjectLinksResult>(live, "lnkdrp_list_project_links", { projectId: proj.projectId });
      const def = list.links.find((l) => l.isDefault);
      assert(def, "the project has no default link");
      let refused: ToolCallError | null = null;
      try {
        await callTool(live, "lnkdrp_delete_project_link", { projectId: proj.projectId, linkId: def.id, confirm: true });
      } catch (e) {
        if (!(e instanceof ToolCallError)) throw e;
        refused = e;
      }
      // /p/<shareId> is the URL every earlier recipient already holds: it is disabled, never deleted.
      assert(refused?.code === "validation", `deleting the default project link should be refused, got ${String(refused?.code)}`);
      const still = await callTool<ListProjectLinksResult>(live, "lnkdrp_list_project_links", { projectId: proj.projectId });
      assert(still.links.some((l) => l.isDefault), "the refused delete removed the default link anyway");
    });

    await step("lnkdrp_delete_project_link without confirm is refused with a preview, then proceeds with it", async () => {
      if (!confirmationsEnforced) {
        info("skipped", "this server runs with LNKDRP_SKIP_CONFIRMATIONS; the gate cannot be asserted here");
        return;
      }
      let refused: ToolCallError | null = null;
      try {
        await callTool(live, "lnkdrp_delete_project_link", { projectId: proj.projectId, linkId: projLink.id });
      } catch (e) {
        if (!(e instanceof ToolCallError)) throw e;
        refused = e;
      }
      assert(refused, "an unconfirmed project-link delete went through — the confirmation gate is not enforced");
      const d = (refused.details ?? {}) as { requiresConfirmation?: unknown; preview?: { headline?: unknown; facts?: unknown; severity?: unknown }; reversible?: unknown };
      assert(d.requiresConfirmation === true, "refusal did not carry requiresConfirmation: true");
      assert(typeof d.preview?.headline === "string" && d.preview.headline.includes("Vantridge · diligence"), "preview does not name the link");
      // The preview has to say the recipient loses the *project*, not one document.
      assert(
        Array.isArray(d.preview?.facts) && d.preview.facts.some((f) => typeof f === "string" && f.includes("the whole project")),
        `preview does not say the holder loses the whole project: ${JSON.stringify(d.preview?.facts)}`,
      );
      assert(d.reversible === false, "delete must be reported as irreversible");
      const still = await callTool<ListProjectLinksResult>(live, "lnkdrp_list_project_links", { projectId: proj.projectId });
      assert(still.links.length === 2, `the refused delete removed something: ${still.links.length} links remain`);

      const done = await callTool<{ ok: boolean; deleted?: { label?: string }; severity?: string }>(live, "lnkdrp_delete_project_link", {
        projectId: proj.projectId,
        linkId: projLink.id,
        confirm: true,
      });
      assert(done.ok === true, "delete_project_link did not return ok");
      assert(done.deleted?.label === "Vantridge · diligence", "response does not echo what was deleted");
      const after = await callTool<ListProjectLinksResult>(live, "lnkdrp_list_project_links", { projectId: proj.projectId });
      assert(after.links.length === 1 && after.links[0]?.isDefault === true, `expected only the default link left, got ${after.links.length}`);
      info("preview", `${d.preview?.headline} · severity ${String(d.preview?.severity)}`);
    });

    }

    /**
     * The eleven tools the 2026-09-21 coverage audit found in no harness at all, two of which
     * (`update_project`, `remove_doc_from_project`) had never been invoked by anything anywhere.
     * Both are writes that change what a recipient can open, so they are exercised here against the
     * throwaway project before it is deleted.
     */
    await step("lnkdrp_update_project renames without moving the slug or any URL", async () => {
      const renamed = `MCP e2e renamed ${Date.now()}`;
      const res = await callTool<ProjectEnvelope>(live, "lnkdrp_update_project", {
        projectId: proj.projectId,
        name: renamed,
      });
      const after = projectOf(res);
      assert(after.slug === proj.slug, `rename moved the slug: ${proj.slug} -> ${String(after.slug)}`);
      info("renamed", `${proj.slug} keeps its slug and URLs`);
    });

    await step("lnkdrp_update_project public page off and on again keeps the same shareId", async () => {
      // The one that would hurt: a recipient holds /p/<shareId>. If the toggle minted a new id,
      // every link already sent would be dead and nothing in the response would say so.
      const original = projectOf(await callTool<ProjectEnvelope>(live, "lnkdrp_get_project", { projectId: proj.projectId })).publicUrl;
      assert(typeof original === "string" && original.length > 0, "the project has no public URL to begin with");
      const offUrl = projectOf(
        await callTool<ProjectEnvelope>(live, "lnkdrp_update_project", { projectId: proj.projectId, publicPageEnabled: false }),
      ).publicUrl;
      assert(offUrl === null, `public page off should null the URL, got ${String(offUrl)}`);
      const onUrl = projectOf(
        await callTool<ProjectEnvelope>(live, "lnkdrp_update_project", { projectId: proj.projectId, publicPageEnabled: true }),
      ).publicUrl;
      assert(onUrl === original, `the public URL changed across an off/on cycle: ${String(original)} -> ${String(onUrl)}`);
      info("public page", "off and on, same shareId");
    });

    await step("lnkdrp_update_project with no fields is refused rather than silently doing nothing", async () => {
      let thrown: unknown = null;
      try {
        await callTool(live, "lnkdrp_update_project", { projectId: proj.projectId });
      } catch (err) {
        thrown = err;
      }
      assert(thrown instanceof ToolCallError, "update_project with no fields should be refused");
      assert(
        (thrown as ToolCallError).code === "validation",
        `expected code validation, got ${(thrown as ToolCallError).code}`,
      );
    });

    await step("lnkdrp_remove_doc_from_project takes the document out and says so once", async () => {
      const out = await callTool<{ removed: boolean; wasInProject: boolean }>(live, "lnkdrp_remove_doc_from_project", {
        projectId: proj.projectId,
        docId: shared.docId,
      });
      assert(out.removed === true && out.wasInProject === true, `first removal should report both true: ${JSON.stringify(out)}`);
      const again = await callTool<{ removed: boolean; wasInProject: boolean }>(live, "lnkdrp_remove_doc_from_project", {
        projectId: proj.projectId,
        docId: shared.docId,
      });
      assert(again.removed === false && again.wasInProject === false, `repeat removal should be a no-op: ${JSON.stringify(again)}`);
      // The document keeps its own links: removal is a membership change, not a delete.
      const doc = await callTool<GetShareResult>(live, "lnkdrp_get_share", { docId: shared.docId });
      assert(doc.docId === shared.docId, "removing from a project lost the document");
      // Put it back so the delete_project step below still has one document to detach.
      await callTool(live, "lnkdrp_add_docs_to_project", { projectId: proj.projectId, docIds: [shared.docId] });
    });

    await step("lnkdrp_tag, lnkdrp_list_tags and lnkdrp_untag file the document and unfile it", async () => {
      const name = `E2E ${Date.now()}`;
      createdTags.push(name);
      const tagged = await callTool<{ tags: Array<{ name: string; slug: string }>; createdTags: string[] }>(live, "lnkdrp_tag", {
        docId: shared.docId,
        // The same name three ways: folding means one tag, not three.
        tags: [name, name.toUpperCase(), `  ${name}  `],
      });
      assert(tagged.createdTags.length === 1, `case and spacing should fold to one tag, got ${JSON.stringify(tagged.createdTags)}`);
      const listed = await callTool<{ tags: Array<{ name: string }> }>(live, "lnkdrp_list_tags", {});
      assert(listed.tags.some((t) => t.name === name), "list_tags does not show the tag just created");
      const filtered = await callTool<DocsPage & { tagMatched?: boolean }>(live, "lnkdrp_list_docs", { tag: name.toLowerCase() });
      assert(filtered.tagMatched === true, "the tag filter did not match the tag by a different casing");
      const off = await callTool<{ removed: string[]; notTagged: string[] }>(live, "lnkdrp_untag", {
        docId: shared.docId,
        tags: [name.toLowerCase(), "a tag that was never applied"],
      });
      assert(off.removed.includes(name), `untag should report the stored name, got ${JSON.stringify(off.removed)}`);
      // notTagged echoes what the caller typed, not the fold it matched on.
      assert(off.notTagged.includes("a tag that was never applied"), `notTagged should echo the caller: ${JSON.stringify(off.notTagged)}`);
    });

    await step("lnkdrp_star_docs and lnkdrp_list_starred agree, including on a mixed-case id", async () => {
      const upper = shared.docId.toUpperCase();
      const on = await callTool<{ changed: string[]; unchanged: string[] }>(live, "lnkdrp_star_docs", { docIds: [upper], starred: true });
      assert(on.changed.includes(shared.docId), `starring by an upper-case id reported no change: ${JSON.stringify(on)}`);
      const again = await callTool<{ changed: string[]; unchanged: string[] }>(live, "lnkdrp_star_docs", { docIds: [upper], starred: true });
      assert(again.unchanged.includes(shared.docId), `re-starring should be a no-op: ${JSON.stringify(again)}`);
      const list = await callTool<{ starredDocs: Array<{ docId: string }> }>(live, "lnkdrp_list_starred", {});
      assert(list.starredDocs.some((d) => d.docId === shared.docId), "list_starred does not show the document just starred");
      await callTool(live, "lnkdrp_star_docs", { docIds: [upper], starred: false });
    });

    await step("lnkdrp_list_projects and lnkdrp_get_project find the room by id and by slug", async () => {
      const all = await callTool<{ total: number; projects: Array<{ projectId: string }> }>(live, "lnkdrp_list_projects", { limit: 50 });
      assert(all.projects.some((p) => p.projectId === proj.projectId), "list_projects does not include the project just created");
      const bySlug = await callTool<ProjectEnvelope>(live, "lnkdrp_get_project", { projectSlug: proj.slug });
      assert(projectOf(bySlug).projectId === proj.projectId, "get_project by slug resolved a different project");
    });

    await step("lnkdrp_delete_project removes the throwaway project and leaves the document alone", async () => {
      const res = await callTool<{ ok: boolean; deleted?: { documentsDetached?: number } }>(live, "lnkdrp_delete_project", {
        projectId: proj.projectId,
        confirm: true,
      });
      assert(res.ok === true, "delete_project did not return ok");
      assert(res.deleted?.documentsDetached === 1, `expected 1 document to leave the project, got ${String(res.deleted?.documentsDetached)}`);
      const idx = createdProjects.findIndex((p) => p.projectId === proj.projectId);
      if (idx >= 0) createdProjects.splice(idx, 1);
      // The document itself survives: the next steps still use it.
      const doc = await callTool<GetShareResult>(live, "lnkdrp_get_share", { docId: shared.docId });
      assert(doc.docId === shared.docId, "deleting the project took the document with it");
    });

    // Free the first document's slot before creating the second. The Free cap counts *shared
    // documents*, and this run needs two — so on a workspace with one slot free it used to sail
    // through nineteen steps and fail on the last one with a plan_limit that looked like a bug in
    // the tool rather than a shortage of room. Everything the first document was for is done by
    // here: its links were created, listed, disabled and deleted in steps 14 to 19.
    /**
     * Archive, unarchive, then delete - through the tools, not around them.
     *
     * This step used to free the slot with a raw `DELETE /api/docs/:id` carrying the bearer key,
     * which is why `lnkdrp_archive_doc` and `lnkdrp_delete_doc` were the last two tools appearing
     * only in `EXPECTED_TOOLS`. Both are the ones an agent reaches for when a human says "get rid
     * of this", and neither had a single assertion behind it.
     *
     * The round trip is the part worth having: archiving is sold as reversible - the links stop
     * resolving, the analytics are kept, the Free slot is released - and "reversible" is a claim
     * nothing checked. So the document goes away, comes back with its link live again, and only
     * then is deleted for real.
     */
    await step("archive_doc takes the links down and gives them back, then delete_doc ends it", async () => {
      const first = createdDocs[0];
      assert(first, "no document to release");
      const link = `${first.origin}/s/${String(shared.shareId)}`;
      const reachable = async () => {
        const r = await fetch(link, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
        await r.arrayBuffer();
        return r.status;
      };

      const archived = await callTool<{ ok: boolean; isArchived: boolean; linksAffected?: number }>(live, "lnkdrp_archive_doc", {
        docId: first.docId,
        archived: true,
        confirm: true,
      });
      assert(archived.isArchived === true, `archive_doc did not archive: ${JSON.stringify(archived)}`);
      const gone = await callTool<GetShareResult & { anyLinkActive?: boolean }>(live, "lnkdrp_get_share", { docId: first.docId });
      assert(gone.isArchived === true && gone.anyLinkActive === false, `an archived document still reports live links: ${JSON.stringify({ a: gone.isArchived, b: gone.anyLinkActive })}`);
      assert(await reachable() === 404, "an archived document still served its link");
      // It leaves the live listing but is still findable in the archive, which is the difference
      // between archiving and deleting.
      const live1 = await callTool<DocsPage & { notFound?: string[] }>(live, "lnkdrp_list_docs", { ids: [first.docId] });
      assert((live1.notFound ?? []).includes(first.docId), "an archived document was still listed as live");
      const arch = await callTool<DocsPage>(live, "lnkdrp_list_docs", { ids: [first.docId], archived: true });
      assert(arch.docs.some((d) => d.docId === first.docId), "an archived document was not in the archive listing");

      const back = await callTool<{ isArchived: boolean }>(live, "lnkdrp_archive_doc", { docId: first.docId, archived: false });
      assert(back.isArchived === false, "archive_doc could not bring the document back");
      assert(await reachable() === 200, "unarchiving did not restore the link");

      const deleted = await callTool<{ ok: boolean; deleted?: { docId?: string; links?: number } }>(live, "lnkdrp_delete_doc", {
        docId: first.docId,
        confirm: true,
      });
      assert(deleted.ok === true && deleted.deleted?.docId === first.docId, `delete_doc did not echo what it removed: ${JSON.stringify(deleted)}`);
      assert(await reachable() === 404, "a deleted document still served its link");
      const after = await callTool<DocsPage & { notFound?: string[] }>(live, "lnkdrp_list_docs", { ids: [first.docId], archived: true });
      assert((after.notFound ?? []).includes(first.docId), "a deleted document still appears in the archive");

      createdDocs.shift();
      info("lifecycle", `${first.docId} archived, restored, deleted`);
    });

    // 17. Agent-written summary: no AI summary run, 0 credits, attributed to the calling client.
    await step("lnkdrp_share_pdf with summary + keyPoints charges 0 credits and records the agent", async () => {
      const res = await callTool<SharePdfResult & SharePdfAiFields>(live, "lnkdrp_share_pdf", {
        idempotencyKey: `e2e-agent-summary-${randomUUID()}`,
        title: "MCP e2e agent summary",
        sourceUrl: PDF_URL,
        summary: "A one-page placeholder PDF used by the W3C accessibility test suite; it contains the words Dummy PDF file and nothing else.",
        keyPoints: ["Single page with a short line of placeholder text", "Used as a fixture in W3C accessibility tests"],
        waitForReady: true,
        timeoutSeconds: TIMEOUT_SECONDS,
      });
      createdDocs.push({ docId: res.docId, origin: new URL(res.shareUrl).origin });
      info("doc", `${res.docId} upload ${res.uploadId} status=${res.status}`);
      info("warnings", res.warnings);
      assert(Array.isArray(res.warnings), "share_pdf.warnings is not an array");
      assert(
        !(res.warnings as unknown[]).some((w) => typeof w === "string" && /AI summary (skipped|failed)/.test(w)),
        `share_pdf with an agent summary still reports a skipped/failed AI summary: ${JSON.stringify(res.warnings)}`,
      );
      assert(res.status === "ready", `agent-summary doc status is "${res.status}", expected ready`);

      const rows = await CreditLedgerModel.find({ workspaceId: ORG_ID, docId: res.docId, actionType: "summary" })
        .select({ creditsCharged: 1, source: 1, status: 1, idempotencyKey: 1 })
        .lean();
      info("ledger", rows.map((r) => ({ key: r.idempotencyKey, status: r.status, creditsCharged: r.creditsCharged, source: r.source })));
      assert(rows.length >= 1, `no summary ledger row for doc ${res.docId}`);
      assert(rows.every((r) => (r.creditsCharged ?? 0) === 0), `summary ledger charged credits: ${JSON.stringify(rows.map((r) => r.creditsCharged))}`);
      assert(rows.some((r) => String(r.source) === "agent"), `no summary ledger row with source "agent": ${JSON.stringify(rows.map((r) => r.source))}`);

      const upload = await UploadModel.findById(res.uploadId).select({ ai: 1 }).lean();
      const ai = (upload as { ai?: { summaryBy?: { kind?: string; client?: string } } } | null)?.ai ?? null;
      info("upload.ai", ai);
      assert(ai?.summaryBy?.client, `upload.ai.summaryBy.client is not set: ${JSON.stringify(ai)}`);
    });
  } finally {
    // Always: close the session and revoke the temporary key, even after a failed assertion.
    if (client && transport) await closeQuietly(client, transport);
    // Delete the documents this run created (soft delete via the REST API, with the temporary key).
    if (plaintext && !KEEP_DOCS) {
      for (const { docId: id, origin } of createdDocs) {
        const res = await fetch(`${origin}/api/docs/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${plaintext}` },
          signal: AbortSignal.timeout(15_000),
        }).catch(() => null);
        console.log(`[--] delete doc ${id} ${res?.ok ? "ok" : `FAILED (${res ? `HTTP ${res.status}` : "network"})`}`);
      }
      // Projects are cleaned up whatever happened: a leaked one holds a slot on Free and leaves a
      // stray public page behind. Deleting a project never touches its documents.
      for (const { projectId: id, origin } of createdProjects) {
        const res = await fetch(`${origin}/api/projects/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${plaintext}` },
          signal: AbortSignal.timeout(15_000),
        }).catch(() => null);
        console.log(`[--] delete project ${id} ${res?.ok ? "ok" : `FAILED (${res ? `HTTP ${res.status}` : "network"})`}`);
      }
    }
    if (createdTags.length) {
      try {
        const orgId = new Types.ObjectId(ORG_ID);
        const tags = (await TagModel.find({ orgId, name: { $in: createdTags } }).select({ _id: 1 }).lean()) as Array<{ _id: Types.ObjectId }>;
        const tagIds = tags.map((t) => t._id);
        if (tagIds.length) {
          await TagAssignmentModel.deleteMany({ tagId: { $in: tagIds } });
          await TagModel.deleteMany({ _id: { $in: tagIds } });
        }
        console.log(`[--] delete ${tagIds.length} test tag(s) ok`);
      } catch (err) {
        console.log(`[--] delete test tags FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (keyId) {
      const id = keyId;
      const t = performance.now();
      const revoked = await revokeApiKey({ orgId: ORG_ID, keyId: id }).catch((err: unknown) => {
        console.log(`     revoke failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      console.log(`[--] revoke temporary key ${revoked ? "ok" : "NOT revoked (revoke it from /connect)"} (${ms(t)})`);
    }
    plaintext = null;
  }

  const summary = {
    ok: true,
    steps: steps.length,
    failed: steps.filter((s) => !s.ok).length,
    docId,
    shareUrl,
    status,
    totalMs: Math.round(performance.now() - t0),
  };
  console.log(JSON.stringify(summary));
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const failedStep = steps.find((s) => !s.ok)?.name ?? null;
    if (err instanceof ToolCallError) {
      console.error(`\n${err.message}${err.details ? `\n     details: ${JSON.stringify(err.details)}` : ""}`);
    } else if (err instanceof AssertionError) {
      console.error(`\nassertion failed: ${err.message}`);
    } else {
      console.error(`\nunexpected error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
      if (err instanceof Error && err.stack) console.error(err.stack.split("\n").slice(1, 6).join("\n"));
    }
    console.log(JSON.stringify({ ok: false, failedStep, steps: steps.length, failed: steps.filter((s) => !s.ok).length || 1 }));
    process.exit(1);
  });
