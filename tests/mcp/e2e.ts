/**
 * End-to-end harness for the lnkdrp MCP server (`mcp/`, see docs/MCP.md).
 *
 * Drives the real stack over the wire: mints a temporary API key straight in Mongo, connects an
 * MCP client to the running server, exercises the five tools in the order an agent would use
 * them, checks that a bad key is rejected at `initialize`, and revokes the key again.
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
 *
 * Prints one line per step with its duration, then a one-line JSON summary. Exits 1 on the first
 * failed assertion (the key is still revoked). The doc it creates ("MCP e2e") is left in the
 * workspace so you can open it in the app and see the "Lnkdrp E2e" attribution on /activity.
 *
 * No test framework on purpose: a single readable script that mirrors what an agent does.
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { connectMongo } from "@/lib/mongodb";
import { apiKeyPrefix, createApiKey, revokeApiKey } from "@/lib/agents/apiKeys";

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

const MCP_URL = process.env.MCP_URL ?? "http://localhost:8787/mcp";
/** Local dev workspace (org + the member who owns the key). Override with E2E_ORG_ID / E2E_USER_ID. */
const ORG_ID = process.env.E2E_ORG_ID ?? "6aa4a3a4b0b9b3a1a769660a";
const USER_ID = process.env.E2E_USER_ID ?? "6aa4a3a455068178c0fdb804";
const PDF_URL = process.env.E2E_PDF_URL ?? "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";
const TIMEOUT_SECONDS = clamp(Number(process.env.E2E_TIMEOUT_SECONDS ?? 90), 5, 120);
const CLIENT_INFO = { name: "lnkdrp-e2e", version: "1.0" } as const;

const EXPECTED_TOOLS = [
  "lnkdrp_whoami",
  "lnkdrp_share_pdf",
  "lnkdrp_get_share",
  "lnkdrp_set_share_access",
  "lnkdrp_get_share_stats",
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
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const n = steps.length + 1;
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

type WhoAmI = { ok: boolean; userId: string; orgId: string; orgName: string | null; plan: string; keyPrefix: string; scopes: string[]; client: string; costs?: unknown; mcpVersion?: string };
type SharePdfResult = { docId: string; shareId: string; shareUrl: string; replaceUrl: null; status: string; version: number; uploadId: string; title: string; planWarning?: unknown };
type GetShareResult = { docId: string; shareId: string; title: Untrusted; status: string; shareEnabled: boolean; shareAllowPdfDownload: boolean; sharePasswordEnabled: boolean; shareAllowRevisionHistory: boolean; shareUrl: string; previewImageUrl: string | null; oneLiner: Untrusted | null; summary: Untrusted | null; isArchived: boolean };
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
  console.log(`lnkdrp MCP e2e -> ${MCP_URL} (org ${ORG_ID}, client ${CLIENT_INFO.name}/${CLIENT_INFO.version})`);

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
    await step("listTools exposes the five lnkdrp tools", async () => {
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
  } finally {
    // Always: close the session and revoke the temporary key, even after a failed assertion.
    if (client && transport) await closeQuietly(client, transport);
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
