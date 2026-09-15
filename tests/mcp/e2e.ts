/**
 * End-to-end harness for the lnkdrp MCP server (`mcp/`, see docs/MCP.md).
 *
 * Drives the real stack over the wire: mints a temporary API key straight in Mongo, connects an
 * MCP client to the running server, exercises the thirteen tools in the order an agent would use
 * them (including the share-link lifecycle: create a second link, fetch it, disable it, delete
 * it), checks that a bad key is rejected at `initialize`, and revokes the key again.
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
 *   E2E_ORG_ID, E2E_USER_ID  workspace the key is minted for (default: the local dev workspace)
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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { describePacing, pause, resolvePacing } from "../pace";
import { connectMongo } from "@/lib/mongodb";
import { apiKeyPrefix, createApiKey, revokeApiKey } from "@/lib/agents/apiKeys";
import { creditsForRun } from "@/lib/credits/schedule";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { UploadModel } from "@/lib/models/Upload";

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

const MCP_URL = process.env.MCP_URL ?? "http://localhost:8787/mcp";
/** Local dev workspace (org + the member who owns the key). Override with E2E_ORG_ID / E2E_USER_ID. */
const ORG_ID = process.env.E2E_ORG_ID ?? "6aa4a3a4b0b9b3a1a769660a";
const USER_ID = process.env.E2E_USER_ID ?? "6aa4a3a455068178c0fdb804";
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
  "lnkdrp_get_share",
  "lnkdrp_set_share_access",
  "lnkdrp_get_share_stats",
  "lnkdrp_create_share_link",
  "lnkdrp_list_share_links",
  "lnkdrp_update_share_link",
  "lnkdrp_delete_share_link",
  "lnkdrp_archive_doc",
  "lnkdrp_delete_doc",
] as const;

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
type ListShareLinksResult = { docId: string; links: ShareLinkDTO[] };

/** Credit/AI fields added to whoami and share_pdf (agent-written summaries, warnings). */
type WhoAmICredits = { costs?: { summary?: number[]; compare?: number[] }; creditsRemaining?: number | null; creditsResetAt?: string | null };
type SharePdfAiFields = { warnings?: unknown; creditsRemaining?: number };
/** Documents this run created; deleted in `finally` so the Free active-link cap is not consumed. */
const createdDocs: Array<{ docId: string; origin: string }> = [];
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
// Main
// ---------------------------------------------------------------------------------------------

/** Run every step in order; the `finally` block revokes the key no matter where it stops. */
async function main(): Promise<void> {
  const t0 = performance.now();
  console.log(
    `lnkdrp MCP e2e -> ${MCP_URL} (org ${ORG_ID}, client ${CLIENT_INFO.name}/${CLIENT_INFO.version}) · ${describePacing(PACING)}`,
  );

  let keyId: string | null = null;
  let plaintext: string | null = null;
  let client: Client | null = null;
  let transport: StreamableHTTPClientTransport | null = null;
  let docId: string | null = null;
  let shareUrl: string | null = null;
  let status: string | null = null;

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
      const body = (await res.json().catch(() => null)) as { ok?: boolean; sessions?: number } | null;
      assert(body?.ok === true, `healthz body is not { ok: true }: ${JSON.stringify(body)}`);
      info("healthz", body);
    });

    // 1. Temporary key straight from the service layer (never printed).
    plaintext = await step("connect to Mongo and mint a temporary API key", async () => {
      await connectMongo();
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
    await step("listTools exposes the thirteen lnkdrp tools", async () => {
      const { tools } = await live.listTools();
      const names = tools.map((t) => t.name);
      for (const expected of EXPECTED_TOOLS) assert(names.includes(expected), `missing tool ${expected}; got ${names.join(", ")}`);
      for (const t of tools) {
        if (!EXPECTED_TOOLS.includes(t.name as (typeof EXPECTED_TOOLS)[number])) continue;
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

    // 5b. whoami costs come from the app's credit schedule, not a copy.
    await step("lnkdrp_whoami costs equal creditsForRun (summary, history)", async () => {
      const me = await callTool<WhoAmICredits>(live, "lnkdrp_whoami", {});
      const tiers = ["basic", "standard", "advanced"] as const;
      const summary = tiers.map((qualityTier) => creditsForRun({ actionType: "summary", qualityTier }));
      const compare = tiers.map((qualityTier) => creditsForRun({ actionType: "history", qualityTier }));
      assert(JSON.stringify(me.costs?.summary) === JSON.stringify(summary), `whoami.costs.summary ${JSON.stringify(me.costs?.summary)} !== ${JSON.stringify(summary)}`);
      assert(JSON.stringify(me.costs?.compare) === JSON.stringify(compare), `whoami.costs.compare ${JSON.stringify(me.costs?.compare)} !== ${JSON.stringify(compare)}`);
      assert(me.creditsRemaining === null || typeof me.creditsRemaining === "number", "whoami.creditsRemaining is neither a number nor null");
      info("credits", `costs=${JSON.stringify(me.costs)} remaining=${String(me.creditsRemaining)} resetAt=${String(me.creditsResetAt)}`);
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

    // 11. A second link on the same document, labelled for one recipient, with downloads on.
    const extra = await step('lnkdrp_create_share_link { label: "Sequoia", allowDownload: true }', async () => {
      const res = await callTool<CreateShareLinkResult>(live, "lnkdrp_create_share_link", {
        docId: shared.docId,
        label: "Sequoia",
        audience: "Sequoia · Roelof",
        allowDownload: true,
      });
      assert(res.link && typeof res.link.id === "string", "create_share_link returned no link");
      assert(res.link.shareId !== shared.shareId, "create_share_link reused the default link's shareId");
      assert(res.link.label === "Sequoia", `create_share_link.label "${res.link.label}" !== "Sequoia"`);
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

    // Free the first document's slot before creating the second. The Free cap counts *shared
    // documents*, and this run needs two — so on a workspace with one slot free it used to sail
    // through nineteen steps and fail on the last one with a plan_limit that looked like a bug in
    // the tool rather than a shortage of room. Everything the first document was for is done by
    // here: its links were created, listed, disabled and deleted in steps 14 to 19.
    await step("release the first document's slot (the Free cap counts documents)", async () => {
      const first = createdDocs[0];
      assert(first, "no document to release");
      const res = await fetch(`${first.origin}/api/docs/${encodeURIComponent(first.docId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${plaintext}` },
        signal: AbortSignal.timeout(15_000),
      });
      assert(res.ok, `could not delete the first document (HTTP ${res.status})`);
      createdDocs.shift();
      info("released", first.docId);
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
